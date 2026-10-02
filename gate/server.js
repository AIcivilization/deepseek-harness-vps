#!/usr/bin/env node
"use strict";

/*
 * dsh-gate — DeepSeek Harness (DSH) VPS 部署的零依赖登录网关。
 *
 * 职责（详见 dsh-vps-architecture-design.md 第 3、4 节）：
 *   1. 登录门：scrypt 口令 + HMAC 会话 Cookie + 登录限流
 *   2. 透明代理：Host 原样透传（域名已在 DSH --trusted-host 白名单），
 *      剥离客户端 dsh-auth-* Cookie，注入服务端持有的 DSH 会话 Cookie
 *   3. DSH 进程管理：spawn 子进程、从 stdout 捕获 launchToken、
 *      服务端身份做 token 兑换取得 DSH Cookie、退出自动重启
 *   4. WebSocket upgrade 透传（同样校验登录并注入 Cookie）
 *
 * 零依赖：仅使用 node 内置模块。
 */

const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
// 站点块模板与 gate 同源管理：install.sh、bin/dsh-vps 也调用它，只此一份
const { caddySiteBlock, readVpnEnv } = require("./site-block.js");

//#region 配置

const GATE_HOME = process.env.GATE_HOME || path.resolve(__dirname, "..");
const STATE_DIR = path.join(GATE_HOME, "state");
const GATE_HOST = process.env.GATE_HOST || "127.0.0.1";
const GATE_PORT = Number(process.env.GATE_PORT || 3100);
const DSH_BIN = process.env.DSH_BIN || path.join(GATE_HOME, "dsh", "current", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const DSH_HOST = "127.0.0.1"; // DSH 官方只允许绑回环
const DSH_PORT = Number(process.env.DSH_PORT || 3080);
// 向导（/setup）改域名时会在运行期更新，并同步写回 state/gate.env（供下次 systemd 启动）
let dshTrustedHost = process.env.DSH_TRUSTED_HOST || "";
// 登录有效期：勾「保持登录」30 天（手机桌面应用里不用老是重新登录）；不勾则是浏览器会话 Cookie，
// 关掉浏览器即失效，服务端也最多认 1 天
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 30) * 86_400_000;
const SESSION_SHORT_TTL_MS = 86_400_000;
const SESSION_COOKIE = "dshvps_session";
const DSH_COOKIE_PREFIX = "dsh-auth-";
const CONNECT_TIMEOUT_MS = 10_000;
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_FAILURES = 5;
const SETUP_WINDOW_MS = 10 * 60_000;
const SETUP_MAX_FAILURES = 10;
const CADDY_ADMIN = process.env.CADDY_ADMIN || "http://127.0.0.1:2019";
const CADDY_SITE_FILE = process.env.CADDY_SITE_FILE || "/etc/caddy/dsh-site.conf";
const DEEPSEEK_KEY_REF = "DEEPSEEK_API_KEY"; // DSH 约定：deriveKeyRef("deepseek")
// /setup 向导可选的常用插件（package 名即 `dsh plugin --profile web add <pkg>` 的入参）
const PLUGIN_OPTIONS = [
	// required：本产品自己的设置页（版本与一键升级、网关状态、安装/卸载到 VPS），必装，向导里勾选且不可取消
	{ id: "dsh-vps", pkg: "dsh-vps", name: "VPS 部署 dsh-vps（必装）", nameEn: "VPS Deploy dsh-vps (required)", desc: "本产品的设置页「设置 → VPS 部署」：DSH 版本与一键升级、网关状态，以及把 DSH 安装到 / 卸载出其他 VPS", descEn: "This project's settings page, Settings → VPS Deploy: DSH version and one-click upgrade, gateway status, and installing DSH on / removing it from other VPSs", required: true },
	{ id: "dshmarket", pkg: "dshmarket", name: "插件市场 dsh-market", nameEn: "Plugin market dsh-market", desc: "设置页内浏览/搜索/一键安装社区插件与主题，之后想装什么都在这里装", descEn: "Browse, search and install community plugins and themes from Settings — install anything else from here later" },
	{ id: "dsh-vps-manager", pkg: "dsh-vps-manager", name: "VPS 管理 dsh-vps-manager", nameEn: "VPS manager dsh-vps-manager", desc: "在 DSH 里直接管理这台 VPS：不花 token 的查询命令、对话内终端、按风险分级确认的 AI 操作、运维菜谱库", descEn: "Manage this VPS from inside DSH: token-free query commands, an in-conversation terminal, risk-graded AI operations and a recipe library" },
];
// pnpm 12 起默认带约 1 天的发布冷却期（minimumReleaseAge），`pnpm add <pkg>` 会装到一天前的旧版。
// 插件作者修 bug 后用户就该拿到修复，这里关掉冷却期：预装与插件市场安装都取真正的最新版。
const PLUGIN_ENV = { pnpm_config_minimum_release_age: "0" };
// 本产品仓库入口：放在 gate 自己的页面（登录 / 初始向导 / 启动等待），
// 不碰 DSH 原生界面，DSH 升级不受影响。
const REPO_URL = "https://github.com/AIcivilization/deepseek-harness-vps";
const REPO_LABEL = "AIcivilization/deepseek-harness-vps";
// 内联 GitHub 图标，不依赖外部 CDN，离线也能显示
const REPO_ICON =
	'<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
	'<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>';
const REPO_CSS =
	".repo{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:18px;" +
	"color:#7d8a9c;font-size:13px;text-decoration:none}" +
	".repo:hover{color:#93c5fd}";
function repoLink() {
	return `<a class="repo" href="${REPO_URL}" target="_blank" rel="noreferrer">${REPO_ICON}<span>${REPO_LABEL}</span></a>`;
}
// 无 <style> 的页面（启动等待页）直接内联样式
function repoLinkInline() {
	return `<a href="${REPO_URL}" target="_blank" rel="noreferrer" style="display:inline-flex;align-items:center;gap:7px;margin-top:22px;color:#7d8a9c;font-size:13px;text-decoration:none">${REPO_ICON}<span>${REPO_LABEL}</span></a>`;
}
const DOMAIN_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 64;

// 公网访问时页面 hostname 不是回环，DSH 前端会据此判定"这不是操作者自己的浏览器"，
// 进而把设置页降级为不可用：dsh-client-ui-settings 里
//   persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'
// 而 isLoopback 由浏览器端的 isLoopbackHostname(location.hostname) 决定（
// dsh-client-connection），--trusted-host 只打开了网络围栏，不改变这个判定。
// DSH 官方为"页面自己拥有 Host"的场景留了 __DSH_TRANSPORT__.ownsHost 声明，
// gate 作为已认证的本地代理注入该声明，即可让设置页/填 Key/权限策略全部恢复。
// 设 GATE_OWNS_HOST=0 可关闭注入（退回"设置页不可用"的官方默认行为）。
const OWNS_HOST_INJECT = process.env.GATE_OWNS_HOST !== "0";
// 与 bin/dsh-vps 的 ownshost 补丁共用同一标记：改前端静态文件是主机制，
// 这里的代理改写只是补丁缺失时的兜底，两者互相识别、绝不重复注入。
const OWNS_HOST_MARK = "dsh-vps:ownshost";
const OWNS_HOST_SNIPPET =
	`<script data-dsh-vps="ownshost">/* ${OWNS_HOST_MARK} */` +
	"window.__DSH_TRANSPORT__=Object.assign(window.__DSH_TRANSPORT__||{},{ownsHost:true});</script>";
let ownshostLogged = false;
// 升级提示条：同源脚本 /gate/ui.js。bin/dsh-vps 的静态补丁同样写入它，两边共用同一标记。
const UI_MARK = "dsh-vps:ui";
const UI_SNIPPET = `<script data-dsh-vps="${UI_MARK}" src="/gate/ui.js" defer></script>`;
// 添加到手机桌面：iPhone 不认 manifest 里的 SVG 图标，要一张 PNG 的 apple-touch-icon；
// 桌面上显示的名字用 DSH。登录页与 DSH 页面都带上（扫码后可能在登录前就添加）。
// 图标（180×180 PNG，源文件 assets/apple-touch-icon.png）以 base64 内嵌在本文件末尾：
// update-gate 只更新 server.js 也能带上图标，不多一个要下载的文件。
const ICON_MARK = "dsh-vps:icon";
const HOME_SCREEN_TAGS =
	`<link rel="apple-touch-icon" href="/gate/apple-touch-icon.png" data-dsh-vps="${ICON_MARK}">` +
	'<meta name="apple-mobile-web-app-title" content="DSH">' +
	'<meta name="apple-mobile-web-app-capable" content="yes">' +
	'<meta name="mobile-web-app-capable" content="yes">';


// DSH 版本检测：跟随官方最新版（npm latest 与 next 渠道中较新的一个）。页面上确认后，gate 只写 state/upgrade.request，
// 由 root 的 dsh-vps-upgrade.path/.service 执行升级（gate 自身无权改 /opt/dsh-vps/dsh）。
const DSH_PACKAGE = "@deepseek-ai/dsh";
const UPDATE_CHECK_INTERVAL_MS = 6 * 3_600_000;
// 冷静期：新版本发布满这么久才提示升级。上游多次出现「主包先发、子包几小时后才补齐」
// （0.1.5-rc.3 缺包约 7 小时；0.2.0-rc.2 发布一小时后仍 ETARGET），刚发布就升级只会装失败。
const UPGRADE_COOLDOWN_MS = Number(process.env.GATE_UPGRADE_COOLDOWN_HOURS || 12) * 3_600_000;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// DSH 的若干特权端点（dsh-market 的 restart / backup 导出 / self-uninstall）要求
// "直连回环"：只要出现 x-forwarded-for / x-real-ip / forwarded 任一头，
// 就认定回环对端是代理而非用户本人并 403。gate 是本机可信代理，转发前剥掉这些头。
// 设 GATE_STRIP_FORWARDING=0 可关闭剥离。
const STRIP_FORWARDING = process.env.GATE_STRIP_FORWARDING !== "0";
const FORWARDING_HEADERS = new Set(["forwarded", "x-forwarded-for", "x-real-ip"]);

// dsh-market 的"立即重启"端点。gate 必须接管它：让 dsh-market 自己重启会
// 在 gate 之外拉起一个新的 DSH 进程，抢占 3080 端口，gate 的子进程随后
// EADDRINUSE 且再也抓不到 launchToken → 永久"会话尚未就绪"。
const MARKET_RESTART_PATHS = new Set(["/dsh-market/restart", "/dsh-market/restart/"]);
// dshmarket 1.64+ 的 v1 接口：内部直接调用上面那个旧端点（不经 HTTP），必须一起接管
const MARKET_RESTART_V1_PATHS = new Set(["/dsh-market/api/v1/restart", "/dsh-market/api/v1/restart/"]);
const MARKET_V1_SCHEMA = "dsh-market/update-api/v1";

// dshmarket 的写操作（安装/更新/卸载/备份导出……）为防 DNS 重绑定，要求 Host 必须是回环地址，
// Origin 必须与 Host 一致；经 gate 转发时 Host 是公网域名，于是一律 403 "untrusted origin"。
// gate 已完成登录校验，这里替它做同样的同源检查（Origin 与公网 Host 一致、非跨站），
// 通过后把 Host/Origin 改写成 DSH 的回环地址再转发。设 GATE_MARKET_LOOPBACK=0 可关闭。
const MARKET_PREFIX = "/dsh-market/";
const MARKET_LOOPBACK = process.env.GATE_MARKET_LOOPBACK !== "0";
// 设 GATE_TAKEOVER_RESTART=0 则放行给 DSH 自己处理（会退回到上面那个坑，仅供对照排障）
const TAKEOVER_RESTART = process.env.GATE_TAKEOVER_RESTART !== "0";

// 逐跳头：代理时重建，不透传（请求侧 transfer-encoding 由 node 自动处理）
const HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"upgrade",
	"transfer-encoding",
]);

//#endregion

//#region 基础工具

function log(message) {
	process.stdout.write(`[gate ${new Date().toISOString()}] ${message}\n`);
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function b64u(buf) {
	return Buffer.from(buf).toString("base64url");
}

function timingSafeEqualStr(a, b) {
	const ab = Buffer.from(String(a), "utf8");
	const bb = Buffer.from(String(b), "utf8");
	if (ab.byteLength !== bb.byteLength) {
		crypto.timingSafeEqual(ab, ab); // 保持常量时间特征
		return false;
	}
	return crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header) {
	const out = Object.create(null);
	if (!header) return out;
	for (const part of String(header).split(";")) {
		const at = part.indexOf("=");
		if (at === -1) continue;
		const key = part.slice(0, at).trim();
		const value = part.slice(at + 1).trim();
		if (key && !(key in out)) out[key] = value;
	}
	return out;
}

/** 请求的规范 authority（与 DSH cookieName 的推导一致）。 */
function requestAuthority(headers) {
	const host = headers.host;
	if (typeof host !== "string" || host === "") return void 0;
	try {
		return new URL(`http://${host}`).host;
	} catch {
		return void 0;
	}
}

function authorityOf(host) {
	try {
		return new URL(`http://${host}`).host;
	} catch {
		return host;
	}
}

/** 剥掉 GET / 上的 token 查询参数（launchToken 不得经公网链路出现）。 */
function sanitizedPath(url) {
	const qIdx = url.indexOf("?");
	if (qIdx === -1) return url;
	const pathname = url.slice(0, qIdx);
	if (pathname !== "/") return url;
	const params = new URLSearchParams(url.slice(qIdx + 1));
	params.delete("token");
	const rest = params.toString();
	return rest ? `/?${rest}` : "/";
}

// gate 自己的页面一律带这组头。frame-ancestors 'none' 挡点击劫持，
// base-uri / form-action 限制在同源；页面用内联 style/script，故放行 unsafe-inline。
const SECURITY_HEADERS = {
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"referrer-policy": "no-referrer",
	"content-security-policy":
		"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function sendHtml(res, status, html, extraHeaders) {
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		...SECURITY_HEADERS,
		...extraHeaders,
	});
	res.end(html);
}

//#region 语言（网关自己的页面：登录、向导、等待页）
//
// 这些页面在进入 DSH 之前，读不到 DSH 的语言设置：先看 Cookie 里用户手动选过的语言，
// 再看浏览器 Accept-Language（中文显示中文，其余英文）。页面右上角可手动切换。

const LANG_COOKIE = "dshvps_lang";

/** 本次请求用的语言：zh 或 en */
function requestLang(req) {
	const chosen = parseCookies(req.headers.cookie)[LANG_COOKIE];
	if (chosen === "zh" || chosen === "en") return chosen;
	const ranges = String(req.headers["accept-language"] || "")
		.split(",")
		.map((part) => {
			const [tag, ...params] = part.trim().split(";");
			const q = params.map((x) => x.trim()).find((x) => x.startsWith("q="));
			return { tag: tag.trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
		})
		.filter((r) => r.tag && r.q > 0)
		.sort((a, b) => b.q - a.q);
	for (const r of ranges) {
		if (r.tag.startsWith("zh")) return "zh";
		if (r.tag !== "*") return "en";
	}
	return "en";
}

/** 按语言挑文案：L("中文", "English") */
function translator(lang) {
	return (zh, en) => (lang === "zh" ? zh : en);
}

/** 右上角「English / 中文」切换：带上当前地址的其余参数（向导链接里的令牌要保留） */
function langSwitch(req, lang) {
	const url = new URL(req.url || "/", "http://x");
	url.searchParams.set("lang", lang === "zh" ? "en" : "zh");
	const label = lang === "zh" ? "English" : "中文";
	return `<a class="lang" href="${esc(url.pathname + url.search)}">${label}</a>`;
}

const LANG_CSS = ".lang{position:fixed;top:14px;right:18px;color:#7d8a9c;font-size:13px;text-decoration:none}.lang:hover{color:#93c5fd}";

//#endregion

function sendText(res, status, text) {
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(text);
}

//#endregion

//#region 状态文件（session.key / admin.json）

function ensureStateDir() {
	fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function sessionKeyPath() {
	return path.join(STATE_DIR, "session.key");
}

function adminPath() {
	return path.join(STATE_DIR, "admin.json");
}

function loadOrCreateSessionKey() {
	const file = sessionKeyPath();
	try {
		const key = fs.readFileSync(file);
		if (key.byteLength === 32) return key;
	} catch {
		/* fallthrough：重新生成 */
	}
	const key = crypto.randomBytes(32);
	fs.writeFileSync(file, key, { mode: 0o600 });
	log("generated new session.key");
	return key;
}

function loadAdmin() {
	try {
		const admin = JSON.parse(fs.readFileSync(adminPath(), "utf8"));
		if (typeof admin.username === "string" && typeof admin.salt === "string" && typeof admin.hash === "string") return admin;
	} catch {
		/* 未配置 */
	}
	return void 0;
}

function hashPassword(password, salt) {
	return crypto.scryptSync(Buffer.from(password, "utf8"), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
}

function verifyAdmin(admin, username, password) {
	if (!admin || admin.username !== username) return false;
	const salt = Buffer.from(admin.salt, "hex");
	const expected = Buffer.from(admin.hash, "hex");
	const actual = hashPassword(password, salt);
	return expected.byteLength === actual.byteLength && crypto.timingSafeEqual(actual, expected);
}

//#endregion

//#region 会话 Cookie

let sessionKey = null; // main() 中初始化

// 会话 MAC 绑定当前管理员记录（盐值在每次设置/重置密码时重新生成）：
// reset-admin、改密码或删除 admin.json 后，所有旧会话立即作废，无需重启 gate。
function sessionMac(admin, body) {
	return b64u(crypto.createHmac("sha256", sessionKey).update(`${admin.salt}\n${admin.username}\n${body}`).digest());
}

function signSession(admin, expiresMs) {
	const body = `${b64u(Buffer.from(admin.username, "utf8"))}.${expiresMs}`;
	return `${body}.${sessionMac(admin, body)}`;
}

function sessionUser(req) {
	const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
	if (!value) return void 0;
	const parts = value.split(".");
	if (parts.length !== 3) return void 0;
	const [user64, expiresStr, mac] = parts;
	const admin = loadAdmin();
	if (!admin) return void 0;
	if (!timingSafeEqualStr(mac, sessionMac(admin, `${user64}.${expiresStr}`))) return void 0;
	const expiresMs = Number(expiresStr);
	if (!Number.isSafeInteger(expiresMs) || expiresMs <= Date.now()) return void 0;
	try {
		const username = Buffer.from(user64, "base64url").toString("utf8");
		return username === admin.username ? username : void 0;
	} catch {
		return void 0;
	}
}

function sessionCookieHeader(req, admin, remember = true) {
	const ttl = remember ? SESSION_TTL_MS : SESSION_SHORT_TTL_MS;
	const expiresMs = Date.now() + ttl;
	// 站点一律 HTTPS（Caddy 自动签发，或自签过渡），Secure 无条件加上。
	// 不读 x-forwarded-proto：那是个可被伪造的请求头，值得信任的只有"这里就是 HTTPS"这件事本身。
	const secure = process.env.GATE_COOKIE_SECURE !== "0";
	return [
		`${SESSION_COOKIE}=${signSession(admin, expiresMs)}`,
		...remember ? [`Max-Age=${Math.floor(ttl / 1000)}`] : [],
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		...secure ? ["Secure"] : [],
	].join("; ");
}

//#endregion

//#region 登录限流（内存）

const loginFailures = new Map(); // ip -> { count, resetAt }

function loginRateLimited(ip) {
	const entry = loginFailures.get(ip);
	return entry !== void 0 && entry.count >= LOGIN_MAX_FAILURES && Date.now() <= entry.resetAt;
}

function recordLoginFailure(ip) {
	const now = Date.now();
	let entry = loginFailures.get(ip);
	if (!entry || now > entry.resetAt) entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
	entry.count += 1;
	loginFailures.set(ip, entry);
}

function clearLoginFailures(ip) {
	loginFailures.delete(ip);
}

//#endregion

//#region DSH 进程管理：spawn / token 捕获 / 兑换 / 续期

const dsh = {
	child: null,
	token: null, // 当前进程的 launchToken
	cookie: null, // { name, value, expiresAt, authority }
	restarts: 0,
	cookieAcquired: false, // 当前子进程是否兑换成功过（区分"启动即崩"与"运行后退出"）
	startedAt: 0,
	shuttingDown: false,
	lastError: null, // 最近一次阻塞性故障（人类可读，供 /gate/health 与等待页展示）
	lastExchangeError: null, // 最近一次 token 兑换失败原因
	lastExit: null, // { code, signal, at, uptimeMs }
	crashStreak: 0, // 连续快速退出次数（用于退避）
	outputTail: "", // DSH 输出尾部（排障用）
};
let exchangeTimer = null;

/** DSH 输出是否显示端口被占用（常见于上一轮 DSH 残留进程 / 被外部拉起的 DSH）。 */
function looksLikePortConflict(text) {
	return /EADDRINUSE|address already in use|端口已被占用/i.test(text);
}

/** 启动前探一下 3080：已被占用说明有残留/外部 DSH，我们的子进程会拿不到端口。 */
function probePortBusy() {
	return new Promise((resolve) => {
		const socket = net.connect(DSH_PORT, DSH_HOST);
		const done = (busy) => {
			socket.destroy();
			resolve(busy);
		};
		socket.setTimeout(1500);
		socket.on("connect", () => done(true));
		socket.on("timeout", () => done(false));
		socket.on("error", () => done(false));
	});
}

/** 统一入口：重启 DSH 子进程（token/cookie 作废 → 自动重新捕获与兑换）。 */
function restartDsh(reason) {
	if (dsh.shuttingDown) return;
	log(`restarting dsh${reason ? ` (${reason})` : ""}`);
	dsh.token = null;
	dsh.cookie = null;
	dsh.lastError = null;
	dsh.lastExchangeError = null;
	clearTimeout(exchangeTimer);
	if (dsh.child) dsh.child.kill("SIGTERM"); // exit 处理器负责重新 spawn
	else spawnDsh();
}

function spawnDsh() {
	if (dsh.shuttingDown) return;
	const args = [DSH_BIN, "web", "--port", String(DSH_PORT), "--no-open", "--trusted-host", dshTrustedHost];
	log(`spawning dsh: node ${args.join(" ")}`);
	const child = spawn(process.execPath, args, {
		cwd: GATE_HOME,
		env: { ...process.env, ...PLUGIN_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	});
	dsh.child = child;
	dsh.startedAt = Date.now();
	dsh.token = null;
	dsh.cookie = null;
	dsh.cookieAcquired = false;

	let scanBuf = "";
	const scan = (chunk) => {
		process.stdout.write(chunk); // DSH 输出原样转发到 journal
		const text = chunk.toString();
		dsh.outputTail = (dsh.outputTail + text).slice(-2048);
		if (looksLikePortConflict(text)) {
			dsh.lastError = `${DSH_PORT} 端口被占用（残留或其他 DSH 进程），本进程无法监听：journal 见 EADDRINUSE。处理：sudo ss -ltnp | grep ${DSH_PORT} 查到 PID 后 kill，或 systemctl restart dsh-gate`;
			log(`dsh startup looks blocked: ${dsh.lastError}`);
		}
		scanBuf = scanForToken(scanBuf + text);
	};
	child.stdout.on("data", scan);
	child.stderr.on("data", scan);

	child.on("error", (err) => {
		log(`dsh spawn error: ${err.message}`);
	});
	child.on("exit", (code, signal) => {
		log(`dsh exited (code=${code} signal=${signal})`);
		if (dsh.child === child) {
			dsh.child = null;
			dsh.token = null;
			dsh.cookie = null;
			clearTimeout(exchangeTimer);
			if (!dsh.shuttingDown) {
				const uptimeMs = Date.now() - dsh.startedAt;
				dsh.lastExit = { code, signal, at: Date.now(), uptimeMs };
				dsh.restarts += 1;
				// 快速退出，或还没兑换到会话就退出：多半是端口/依赖/配置类硬故障，退避重启，避免空转打满 journal。
				// 不能只看存活时长——DSH 可能先打印 launchToken 再崩（如依赖不兼容），存活时间会超过 5s。
				const crashed = uptimeMs < 5000 || !dsh.cookieAcquired;
				dsh.crashStreak = crashed ? dsh.crashStreak + 1 : 0;
				const delay = dsh.crashStreak > 1 ? Math.min(2000 * 2 ** (dsh.crashStreak - 1), 30_000) : 2000;
				if (dsh.crashStreak >= 3) {
					const errLine = (dsh.outputTail.match(/^\s*(?:[A-Za-z]*Error|error):.*$/gm) || []).pop();
					if (errLine && !dsh.lastError) dsh.lastError = `DSH 连续 ${dsh.crashStreak} 次启动失败：${errLine.trim()}。详见 journalctl -u dsh-gate -n 100`;
					dsh.lastError = dsh.lastError || `DSH 连续 ${dsh.crashStreak} 次快速退出（最近一次 code=${code} signal=${signal}，存活 ${uptimeMs}ms）。常见原因：3080 端口被占用、DSH_BIN 路径失效、DSH_HOME 权限问题。详见 journalctl -u dsh-gate -n 100`;
				}
				setTimeout(spawnDsh, delay);
			}
		}
	});
}

/** 首次启动前先探端口，命中则把结论直接写进 lastError，等待页与 health 都能看到。 */
async function spawnDshWithPreflight() {
	const busy = await probePortBusy();
	if (busy) {
		dsh.lastError = `${DSH_HOST}:${DSH_PORT} 启动前已被占用：可能有残留的 DSH 进程（或 dsh-market 自行拉起的实例）。gate 只能从自己的子进程 stdout 捕获 launchToken，端口被别人占着就永远兑换不到会话。处理：sudo ss -ltnp | grep ${DSH_PORT} → kill 对应 PID，再 systemctl restart dsh-gate`;
		log(dsh.lastError);
	}
	spawnDsh();
}

/** 在 DSH 输出中捕获 `?token=<launchToken>`；命中即触发兑换。 */
function scanForToken(buf) {
	const match = buf.match(/[?&]token=([A-Za-z0-9_-]{16,})/);
	if (match) {
		if (dsh.token !== match[1]) {
			dsh.token = match[1];
			log("captured dsh launchToken from stdout");
			exchangeToken(0);
		}
		return "";
	}
	return buf.length > 8192 ? buf.slice(-1024) : buf;
}

/**
 * 服务端身份执行官方的 token 兑换：
 * GET /?token=<launchToken>，Host 头设为受信域名 → 303 + Set-Cookie。
 */
function exchangeToken(attempt) {
	clearTimeout(exchangeTimer);
	const token = dsh.token;
	if (!token || !dsh.child || dsh.shuttingDown) return;
	const req = http.request(
		{
			host: DSH_HOST,
			port: DSH_PORT,
			method: "GET",
			path: `/?token=${token}`,
			headers: { host: dshTrustedHost },
			timeout: 5000,
		},
		(res) => {
			res.resume();
			if (res.statusCode === 303 && dsh.token === token) {
				const line = (res.headers["set-cookie"] || []).find((c) => c.startsWith(DSH_COOKIE_PREFIX));
				if (line) {
					applyDshCookie(line);
					return;
				}
			}
			retryExchange(attempt, `unexpected status ${res.statusCode}`);
		},
	);
	req.on("timeout", () => req.destroy(new Error("exchange timeout")));
	req.on("error", (err) => retryExchange(attempt, err.message));
	req.end();
}

function retryExchange(attempt, why) {
	dsh.lastExchangeError = why;
	if (!dsh.token || !dsh.child || dsh.shuttingDown) return;
	const delay = Math.min(1000 * 2 ** attempt, 15_000);
	log(`token exchange failed (${why}); retry in ${delay}ms`);
	exchangeTimer = setTimeout(() => exchangeToken(attempt + 1), delay);
}

function applyDshCookie(setCookieLine) {
	const [pair, ...attrs] = setCookieLine.split(";");
	const eq = pair.indexOf("=");
	if (eq === -1) return;
	const name = pair.slice(0, eq).trim();
	const value = pair.slice(eq + 1).trim();
	let expiresAt = Date.now() + 30 * 86_400_000;
	for (const attr of attrs) {
		const at = attr.indexOf("=");
		if (at === -1) continue;
		const key = attr.slice(0, at).trim().toLowerCase();
		const val = attr.slice(at + 1).trim();
		if (key === "expires") {
			const t = Date.parse(val);
			if (Number.isFinite(t)) expiresAt = t;
		} else if (key === "max-age") {
			const n = Number(val);
			if (Number.isFinite(n)) expiresAt = Date.now() + n * 1000;
		}
	}
	dsh.cookie = { name, value, expiresAt, authority: authorityOf(dshTrustedHost) };
	dsh.cookieAcquired = true;
	dsh.lastExchangeError = null;
	dsh.lastError = null;
	dsh.crashStreak = 0;
	log(`dsh session cookie acquired (authority=${dsh.cookie.authority}, expires=${new Date(expiresAt).toISOString()})`);
}

/** 构造发往 DSH 的 Cookie 头：剥离客户端的 dsh-auth-*（防伪）与 gate 自身会话，注入服务端 DSH Cookie（仅 authority 匹配时）。 */
function upstreamCookieHeader(clientCookieHeader, authority) {
	const parts = [];
	for (const [key, value] of Object.entries(parseCookies(clientCookieHeader))) {
		if (key === SESSION_COOKIE || key.startsWith(DSH_COOKIE_PREFIX)) continue;
		parts.push(`${key}=${value}`);
	}
	if (dsh.cookie && authority !== void 0 && dsh.cookie.authority === authority && dsh.cookie.expiresAt > Date.now()) {
		parts.push(`${dsh.cookie.name}=${dsh.cookie.value}`);
	}
	return parts.length ? parts.join("; ") : void 0;
}

//#endregion

//#region 登录页

function loginPage({ error, notice, next, lang = "zh", req }) {
	const L = translator(lang);
	return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>dsh-vps · ${L("登录", "Sign in")}</title>
${HOME_SCREEN_TAGS}
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0b0e14;color:#dbe2ea;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(360px,92vw);padding:32px 28px;border:1px solid #1f2733;border-radius:12px;background:#11161f}
h1{margin:0 0 4px;font-size:20px;letter-spacing:.5px}
.sub{margin:0 0 20px;color:#7d8a9c;font-size:13px}
label{display:block;margin:12px 0 4px;font-size:13px;color:#9aa7b8}
input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #2a3547;border-radius:8px;
background:#0d1219;color:#e6edf5;font-size:15px}
input:focus{outline:none;border-color:#3b82f6}
button{margin-top:20px;width:100%;padding:10px;border:0;border-radius:8px;background:#2563eb;
color:#fff;font-size:15px;cursor:pointer}
button:hover{background:#1d4fd8}
.err{margin:0 0 12px;padding:8px 10px;border-radius:8px;background:#2a1215;color:#f87171;font-size:13px}
.notice{margin:0 0 12px;padding:8px 10px;border-radius:8px;background:#101c2e;color:#93c5fd;font-size:13px}
.remember{display:flex;align-items:center;gap:8px;margin:14px 0 0;font-size:13px;color:#9aa7b8;cursor:pointer}
.remember input{width:auto;margin:0;accent-color:#2563eb}
${REPO_CSS}
${LANG_CSS}
</style>
</head>
<body>
${req ? langSwitch(req, lang) : ""}
<main>
<h1>dsh-vps</h1>
<p class="sub">${L("DeepSeek Harness 登录门", "DeepSeek Harness sign-in")}</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next || "/")}">
<label for="u">${L("用户名", "Username")}</label>
<input id="u" name="username" autocomplete="username" required>
<label for="p">${L("密码", "Password")}</label>
<input id="p" name="password" type="password" autocomplete="current-password" required>
<label class="remember"><input type="checkbox" name="remember" value="1" checked> ${L("保持登录（30 天）", "Keep me signed in (30 days)")}</label>
<button type="submit">${L("登录", "Sign in")}</button>
</form>
${repoLink()}
</main>
</body>
</html>`;
}

function safeNext(value) {
	return typeof value === "string" && /^\/(?!\/)/.test(value) && value.length <= 2048 ? value : "/";
}

function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.byteLength;
			if (size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

//#endregion

//#region HTTP 处理

function clientIp(req) {
	const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
	return fwd || req.socket.remoteAddress || "unknown";
}

async function handleLogin(req, res) {
	const admin = loadAdmin();
	const lang = requestLang(req);
	const L = translator(lang);
	if (req.method === "GET" || req.method === "HEAD") {
		const next = safeNext(new URL(req.url, "http://x").searchParams.get("next"));
		const notice = admin ? void 0 : L("尚未配置管理员：请先完成初始设置向导，或运行 `dsh-vps reset-admin`。", "No admin account yet: finish the setup wizard first, or run `dsh-vps reset-admin`.");
		sendHtml(res, 200, loginPage({ notice, next, lang, req }));
		return;
	}
	if (req.method !== "POST") {
		sendText(res, 405, "method not allowed");
		return;
	}
	const ip = clientIp(req);
	if (loginRateLimited(ip)) {
		sendHtml(res, 429, loginPage({ error: L("尝试次数过多，请稍后再试。", "Too many attempts. Try again later."), next: "/", lang, req }));
		return;
	}
	let form;
	try {
		form = new URLSearchParams(await readBody(req, 64 * 1024));
	} catch {
		sendText(res, 400, "bad request");
		return;
	}
	const username = String(form.get("username") || "");
	const password = String(form.get("password") || "");
	const next = safeNext(form.get("next"));
	if (!admin || !verifyAdmin(admin, username, password)) {
		recordLoginFailure(ip);
		log(`login failure from ${ip} for ${JSON.stringify(username)}`);
		sendHtml(res, 200, loginPage({ error: L("用户名或密码错误。", "Wrong username or password."), next, lang, req }));
		return;
	}
	clearLoginFailures(ip);
	log(`login ok from ${ip} (${username})`);
	res.writeHead(303, {
		location: next,
		"set-cookie": sessionCookieHeader(req, admin, form.get("remember") === "1"),
		"cache-control": "no-store",
	});
	res.end();
}

function handleLogout(req, res) {
	res.writeHead(303, {
		location: "/login",
		"set-cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`,
		"cache-control": "no-store",
	});
	res.end();
}

/** 直连回环的请求：dsh-vps CLI、install.sh 的健康检查都走这条路。 */
function isLoopbackRequest(req) {
	const ip = req.socket.remoteAddress || "";
	return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function handleSelfcheckGuarded(req, res) {
	if (!isLoopbackRequest(req)) {
		sendText(res, 403, "forbidden");
		return;
	}
	return handleSelfcheck(req, res);
}

/**
 * /gate/health 会暴露域名、DSH 端口、pid、会话到期时间与崩溃诊断，不能对公网开放。
 * 放行两类：回环（CLI / install.sh 探活）与已登录会话（启动等待页轮询）。
 * 等待页只在登录后才会出现——未登录请求一律被 303 到登录页，不受影响。
 */
function handleHealthGuarded(req, res) {
	if (!isLoopbackRequest(req) && !sessionUser(req)) {
		sendText(res, 403, "forbidden");
		return;
	}
	return handleHealth(req, res);
}

function handleHealth(req, res) {
	const cookie = dsh.cookie;
	res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(
		JSON.stringify({
			gate: "ok",
			uptimeSec: Math.round(process.uptime()),
			adminConfigured: loadAdmin() !== void 0,
			// 已登录的页面（设置 → VPS 部署）显示「管理员：xxx」用
			admin: sessionUser(req) || void 0,
			dsh: {
				alive: dsh.child !== null,
				pid: dsh.child ? dsh.child.pid : null,
				restarts: dsh.restarts,
				trustedHost: dshTrustedHost,
				port: DSH_PORT,
			},
			// 访问策略：public = 公网凭密码登录；tunnel = 仅 WireGuard 隧道网段可达（dsh-vps vpn）
			access: readVpnEnv(STATE_DIR).on ? "tunnel" : "public",
			launchTokenCaptured: dsh.token !== null,
			dshCookie: cookie
				? { authority: cookie.authority, expiresAt: cookie.expiresAt, expiresInHours: Math.round((cookie.expiresAt - Date.now()) / 3_600_000) }
				: null,
			lastError: dsh.lastError,
			lastExchangeError: dsh.lastExchangeError,
			lastExit: dsh.lastExit,
			crashStreak: dsh.crashStreak,
		}),
	);
}

/**
 * DSH 会话尚未就绪（DSH 还在启动，或 token 兑换/端口出了问题）。
 * 页面自己轮询 /gate/health，一旦会话就绪立即刷新；同时把阻塞原因直接摆在页面上，
 * 免得用户只能去翻 journalctl。
 */
function sendDshNotReady(res, lang = "zh") {
	const L = translator(lang);
	const state = notReadyState(lang);
	// 轮询脚本里用的文案（随语言注入，避免脚本里再写两套）
	const W = { alive: L("运行中", "running"), dead: L("未运行", "not running"), tok: L("已捕获", "captured"), notok: L("未捕获", "not captured"), ck: L("已就绪", "ready"), nock: L("等待兑换", "waiting") };
	sendHtml(
		res,
		503,
		`<!doctype html><html lang="${lang === "zh" ? "zh-CN" : "en"}"><meta charset="utf-8"><title>503 ${L("DeepSeek Harness 启动中", "DeepSeek Harness is starting")}</title>
<meta name="robots" content="noindex">
<body style="background:#0b0e14;color:#dbe2ea;font:15px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif;padding:40px;max-width:760px">
<h2 style="margin:0 0 4px">${L("DeepSeek Harness 正在启动", "DeepSeek Harness is starting")}</h2>
<p style="color:#7d8a9c;margin:0 0 20px">${L("gate 还没拿到 DSH 会话；本页每 3 秒自动检查一次，就绪后会自动刷新。", "The gateway has no DSH session yet. This page checks every 3 seconds and reloads as soon as it is ready.")}</p>
<table style="border-collapse:collapse;font-size:14px">
<tr><td style="padding:3px 16px 3px 0;color:#9aa7b8">${L("DSH 子进程", "DSH process")}</td><td id="s-alive">${state.childAlive ? W.alive : W.dead}</td></tr>
<tr><td style="padding:3px 16px 3px 0;color:#9aa7b8">launchToken</td><td id="s-token">${state.tokenCaptured ? W.tok : W.notok}</td></tr>
<tr><td style="padding:3px 16px 3px 0;color:#9aa7b8">${L("会话 Cookie", "Session cookie")}</td><td id="s-cookie">${state.cookieReady ? W.ck : W.nock}</td></tr>
</table>
<p id="s-err" style="margin:16px 0 0;padding:10px 12px;border-radius:8px;background:#2a2112;color:#fbbf24;font-size:13px;${state.error ? "" : "display:none"}">${esc(state.error || "")}</p>
<p id="s-wait" style="color:#7d8a9c;font-size:13px;margin:16px 0 0">${L("已等待", "Waited")} <span id="s-sec">0</span> ${L("秒…", "s…")} <button onclick="location.reload()" style="margin-left:8px;padding:4px 10px;border:1px solid #2a3547;border-radius:6px;background:#0d1219;color:#dbe2ea;cursor:pointer">${L("立即刷新", "Reload now")}</button></p>
<p style="color:#5c6b7e;font-size:12px;margin:20px 0 0">${L("超过 2 分钟仍未就绪，多半是 3080 端口被残留进程占用或 DSH 启动失败：", "Still not ready after 2 minutes? Port 3080 is probably held by a leftover process, or DSH failed to start: ")}<code>journalctl -u dsh-gate -n 100</code>${L("，然后 ", ", then ")}<code>systemctl restart dsh-gate</code>${L("。", ".")}</p>
${repoLinkInline()}
<script>
var W=${JSON.stringify(W)};
var t0=Date.now();
setInterval(function(){document.getElementById('s-sec').textContent=Math.round((Date.now()-t0)/1000)},1000);
setInterval(function(){
  fetch('/gate/health',{cache:'no-store'}).then(function(r){return r.json()}).then(function(h){
    var alive=h.dsh&&h.dsh.alive, tok=h.launchTokenCaptured, ck=!!h.dshCookie;
    document.getElementById('s-alive').textContent=alive?W.alive:W.dead;
    document.getElementById('s-token').textContent=tok?W.tok:W.notok;
    document.getElementById('s-cookie').textContent=ck?W.ck:W.nock;
    var err=(h.dsh&&h.dsh.lastError)||h.lastExchangeError||'';
    var box=document.getElementById('s-err');
    if(err){box.style.display='';box.textContent=err}else{box.style.display='none'}
    if(ck) location.reload();
  }).catch(function(){});
},3000);
</script></body>`,
		{ "retry-after": "3" },
	);
}

function notReadyState(lang = "zh") {
	const L = translator(lang);
	const error = dsh.lastError || dsh.lastExchangeError || (dsh.lastExit ? L(`DSH 已退出 (code=${dsh.lastExit.code} signal=${dsh.lastExit.signal})，即将自动重启`, `DSH exited (code=${dsh.lastExit.code} signal=${dsh.lastExit.signal}); restarting automatically`) : null);
	return {
		childAlive: dsh.child !== null,
		tokenCaptured: dsh.token !== null,
		cookieReady: dsh.cookie !== null,
		error,
	};
}

function sendBadGateway(res, lang = "zh") {
	const L = translator(lang);
	sendHtml(
		res,
		502,
		`<!doctype html><html lang="${lang === "zh" ? "zh-CN" : "en"}"><meta charset="utf-8"><title>502</title>
<body style="background:#0b0e14;color:#dbe2ea;font:15px system-ui;padding:40px">
<h2>${L("无法连接 DeepSeek Harness", "Cannot reach DeepSeek Harness")}</h2>
<p>${L(`DSH 后端（127.0.0.1:${DSH_PORT}）不可达。`, `The DSH backend (127.0.0.1:${DSH_PORT}) is unreachable.`)}</p>
<p style="color:#7d8a9c">${L("排障：", "Troubleshoot: ")}journalctl -u dsh-gate -n 50</p></body>`,
	);
}

/**
 * 收下上游 HTML（限 8MiB），在 <head> 之后插入 ownsHost 声明后整体下发。
 * 只有文档型 HTML 需要改写；其它响应仍是 pipe 直通，不损失流式能力。
 */
function collectAndInject(upRes, res, status, respHeaders) {
	const MAX_BYTES = 32 * 1024 * 1024;
	let body = "";
	let size = 0;
	let overflow = false;
	upRes.setEncoding("utf8"); // 按字符边界收，避免多字节字符被 chunk 切断
	upRes.on("data", (chunk) => {
		if (overflow) {
			res.write(chunk); // 已进入直通：剩余部分原样流式回传
			return;
		}
		size += Buffer.byteLength(chunk, "utf8");
		if (size > MAX_BYTES) {
			// 超限：放弃改写，已收集部分 + 后续全部原样转发（不截断）
			overflow = true;
			res.writeHead(status, respHeaders); // 无 content-length → 走 chunked
			res.write(body);
			res.write(chunk);
			body = "";
			return;
		}
		body += chunk;
	});
	upRes.on("end", () => {
		if (overflow) {
			res.end();
			return;
		}
		// 静态文件补丁（bin/dsh-vps ownshost on）已经在页面里时不再重复注入
		const missing = [];
		if (!body.includes(OWNS_HOST_MARK)) missing.push(OWNS_HOST_SNIPPET);
		if (!body.includes(UI_MARK)) missing.push(UI_SNIPPET);
		if (!body.includes(ICON_MARK)) missing.push(HOME_SCREEN_TAGS);
		if (missing.length) {
			// 只有完整的 HTML 文档才改写；找不到 <head> 说明不是文档（片段/JSON 误标），原样转发
			const at = body.search(/<head\b[^>]*>/i);
			if (at !== -1) {
				const end = body.indexOf(">", at) + 1;
				body = body.slice(0, end) + missing.join("") + body.slice(end);
				if (!ownshostLogged) {
					ownshostLogged = true;
					log("injected page snippets by proxy (静态文件补丁未生效，建议 sudo dsh-vps ownshost on)");
				}
			}
		}
		const payload = Buffer.from(body, "utf8");
		res.writeHead(status, { ...respHeaders, "content-length": payload.byteLength });
		res.end(payload);
	});
	upRes.on("error", () => res.end());
}

/** 透明代理：Host 原样透传，重建 Cookie（剥离 dsh-auth-* → 注入服务端 DSH Cookie），剥掉 /?token=。 */
function proxyHttp(req, res) {
	if (!dsh.cookie) {
		sendDshNotReady(res, requestLang(req));
		return;
	}
	const authority = requestAuthority(req.headers);
	// 导航请求（浏览器要 HTML）：必须拿到完整 200 才能改写，否则浏览器会用本地
	// 缓存的那份没有 ownsHost 的旧 HTML，设置页就会一直报"在此浏览器中不可用"。
	const wantsHtml = OWNS_HOST_INJECT && String(req.headers.accept || "").includes("text/html");
	const headers = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (HOP_HEADERS.has(key) || key === "cookie") continue;
		// 转发头会让 DSH 判定"回环对端是代理"而拒绝特权端点（如 dsh-market 重启）
		if (STRIP_FORWARDING && FORWARDING_HEADERS.has(key)) continue;
		// 条件请求会让上游回 304（无 body 可改写），导航请求一律取全量
		if (wantsHtml && (key === "if-none-match" || key === "if-modified-since")) continue;
		headers[key] = value;
	}
	const cookie = upstreamCookieHeader(req.headers.cookie, authority);
	if (cookie !== void 0) headers.cookie = cookie;
	if (MARKET_LOOPBACK && (req.url || "").startsWith(MARKET_PREFIX)) {
		const loopback = `127.0.0.1:${DSH_PORT}`;
		headers.host = loopback;
		if (headers.origin !== void 0) headers.origin = `http://${loopback}`;
	}

	let responded = false;
	const upstreamReq = http.request(
		{
			host: DSH_HOST,
			port: DSH_PORT,
			method: req.method,
			path: sanitizedPath(req.url || "/"),
			headers,
			timeout: CONNECT_TIMEOUT_MS,
		},
		(upRes) => {
			responded = true;
			const respHeaders = {};
			let isHtml = false;
			let encoded = false; // 上游已压缩：无法改写，原样直通
			for (const [key, value] of Object.entries(upRes.headers)) {
				if (HOP_HEADERS.has(key)) continue;
				if (key === "content-length") continue; // 长度按最终响应体重算
				if (key === "content-type") {
					isHtml = String(value).includes("text/html");
				}
				if (key === "content-encoding") encoded = true;
				if (key === "set-cookie") {
					// DSH Cookie 绝不下发到用户浏览器
					const filtered = value.filter((c) => !c.startsWith(DSH_COOKIE_PREFIX));
					if (filtered.length) respHeaders[key] = filtered;
					continue;
				}
				respHeaders[key] = value;
			}
			// HTML 文档：注入 ownsHost 声明，让设置页在公网域名下同样可用（见文件头说明）。
			// 只对导航型 GET/HEAD 的 200 响应改写；其余（含任何流式响应）一律 pipe 直通。
			const navigational = req.method === "GET" || req.method === "HEAD";
			if (OWNS_HOST_INJECT && isHtml && navigational && !encoded && upRes.statusCode === 200) {
				// 改写过的 HTML 不能再被缓存复用，也不该再带校验器（否则下次又走 304）
				const injected = { ...respHeaders, "cache-control": "no-store" };
				delete injected.etag;
				delete injected["last-modified"];
				collectAndInject(upRes, res, upRes.statusCode, injected);
				return;
			}
			res.writeHead(upRes.statusCode || 502, respHeaders);
			upRes.pipe(res);
		},
	);
	// CONNECT_TIMEOUT_MS 只约束"连上 DSH"这一步。连上后清掉超时：DSH 的非流式 API
	// （如一次完整的模型调用）可能很久才回响应头，不能被当成连接超时切成 502。
	upstreamReq.on("socket", (socket) => {
		if (socket.connecting) socket.once("connect", () => upstreamReq.setTimeout(0));
		else upstreamReq.setTimeout(0); // keep-alive 复用的连接早已连上
	});
	upstreamReq.on("timeout", () => {
		if (!responded) upstreamReq.destroy(new Error("upstream connect timeout"));
	});
	upstreamReq.on("error", (err) => {
		log(`proxy error: ${err.message}`);
		if (!res.headersSent) sendBadGateway(res, requestLang(req));
		else res.end();
	});
	req.pipe(upstreamReq);
}

/** 市场请求的同源检查：Origin（若有）须与浏览器访问的公网 Host 一致，且不是跨站请求。 */
function marketRequestSameOrigin(req) {
	if (String(req.headers["sec-fetch-site"] || "") === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true; // 同源 GET 导航（如备份下载）不带 Origin
	try {
		return new URL(origin).host === requestAuthority(req.headers);
	} catch {
		return false;
	}
}

function denyUnauthenticated(req, res, pathname) {
	if (pathname.startsWith("/api")) {
		sendText(res, 401, "gate authentication required");
		return;
	}
	const next = encodeURIComponent((req.url || "/").slice(0, 2048));
	res.writeHead(303, { location: `/login?next=${next}`, "cache-control": "no-store" });
	res.end();
}

/**
 * 接管 dsh-market 的"立即重启"：官方实现会自行拉起一个新的 dsh 进程，
 * 在 systemd 下会脱离 gate 的父子关系——新进程抢走 3080，gate 的子进程随后
 * EADDRINUSE，且 gate 永远读不到新进程的 launchToken（页面卡在"会话尚未就绪"）。
 * 这里按官方客户端的协议回 202 + ok，然后由 gate 自己重启 DSH 子进程：
 * 子进程是全新的，/dsh-market/status 的 boot id 随之变化，前端会自动 reload。
 */
function handleMarketRestart(req, res, v1) {
	if (req.method !== "POST") {
		res.writeHead(405, { allow: "POST", "content-length": "0" });
		res.end();
		return;
	}
	log(`market restart requested${v1 ? " (v1)" : ""}; gate takes over`);
	const result = { ok: true, managedBy: "dsh-gate", note: "由 gate 重启 DSH 子进程" };
	res.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(v1 ? { schema: MARKET_V1_SCHEMA, result } : result));
	// 让 202 先落地，再动手（客户端随后轮询 /dsh-market/status 等 boot id 变化）
	setTimeout(() => restartDsh("market restart"), 300);
}

//#endregion

//#region WebSocket upgrade 透传

function handleUpgrade(req, socket, head) {
	const user = sessionUser(req);
	if (!user) {
		socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
		socket.destroy();
		return;
	}
	if (!dsh.cookie) {
		socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
		socket.destroy();
		return;
	}
	const authority = requestAuthority(req.headers);
	const upstream = net.connect(DSH_PORT, DSH_HOST, () => {
		const cookie = upstreamCookieHeader(req.headers.cookie, authority);
		const lines = [`${req.method} ${sanitizedPath(req.url || "/")} HTTP/1.1`];
		for (const [key, value] of Object.entries(req.headers)) {
			if (key === "cookie") continue;
			if (STRIP_FORWARDING && FORWARDING_HEADERS.has(key)) continue;
			if (Array.isArray(value)) for (const v of value) lines.push(`${key}: ${v}`);
			else lines.push(`${key}: ${value}`);
		}
		if (cookie !== void 0) lines.push(`cookie: ${cookie}`);
		upstream.write(lines.join("\r\n") + "\r\n\r\n");
		if (head && head.length) upstream.write(head);
		socket.pipe(upstream);
		upstream.pipe(socket);
	});
	const kill = () => {
		socket.destroy();
		upstream.destroy();
	};
	socket.on("error", kill);
	upstream.on("error", kill);
}

//#endregion

//#region M3：服务端 RPC / setup 向导 / 域名变更 / 自检

function setupLockPath() {
	return path.join(STATE_DIR, "setup.lock");
}

function setupOpen() {
	return !fs.existsSync(setupLockPath());
}

// ---- 启动令牌 ----
// 从 install.sh 跑完到用户第一次打开浏览器之间，/setup 对全网开放：谁先提交谁就是
// 管理员。install.sh 因此生成一个一次性令牌写进 state/setup.token，并打印带令牌的
// URL；向导提交成功后立刻删除令牌文件，令牌永久失效。
// 没有令牌文件时（手工部署、令牌被清），行为退回旧版的开放向导，不锁死用户。
function setupTokenPath() {
	return path.join(STATE_DIR, "setup.token");
}

function loadSetupToken() {
	try {
		const token = fs.readFileSync(setupTokenPath(), "utf8").trim();
		return /^[A-Za-z0-9]{16,64}$/.test(token) ? token : null;
	} catch {
		return null;
	}
}

function clearSetupToken() {
	try {
		fs.rmSync(setupTokenPath());
		log("setup token consumed");
	} catch {
		/* 已不存在 */
	}
}

function setupTokenValid(provided) {
	const expected = loadSetupToken();
	if (!expected) return true; // 未启用令牌
	if (typeof provided !== "string" || provided.length !== expected.length) return false;
	return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/** 令牌可来自查询串（GET / 重定向）或表单字段（POST）。 */
function providedSetupToken(req, form) {
	const fromForm = form ? String(form.get("token") || "") : "";
	if (fromForm) return fromForm;
	const q = (req.url || "").split("?")[1];
	return q ? String(new URLSearchParams(q).get("token") || "") : "";
}

/** 服务端身份调用 DSH 特权 RPC（走已注入的会话 Cookie，等价于"登录态探测"）。 */
function dshRpc(method, args) {
	return new Promise((resolve, reject) => {
		if (!dsh.cookie || dsh.cookie.expiresAt <= Date.now()) {
			reject(new Error("dsh session not ready"));
			return;
		}
		const rpcId = crypto.randomUUID();
		const body = JSON.stringify({ type: "client-request", rpcId, method, payload: { args } });
		const req = http.request(
			{
				host: DSH_HOST,
				port: DSH_PORT,
				method: "POST",
				path: `/api/${method}`,
				headers: {
					host: dshTrustedHost,
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body),
					cookie: `${dsh.cookie.name}=${dsh.cookie.value}`,
				},
				timeout: 10_000,
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					try {
						if (res.statusCode !== 200) {
							reject(new Error(`rpc http ${res.statusCode}`));
							return;
						}
						const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						if (json.type !== "server-response" || json.rpcId !== rpcId) {
							reject(new Error("rpc envelope mismatch"));
							return;
						}
						if (json.result && json.result.ok === true) resolve(json.result.value);
						else reject(new Error((json.result && json.result.error && (json.result.error.message || json.result.error.code)) || "rpc failed"));
					} catch (err) {
						reject(err);
					}
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("rpc timeout")));
		req.on("error", reject);
		req.end(body);
	});
}

function waitForDshCookie(timeoutMs) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (dsh.cookie) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("等待 DSH 会话就绪超时"));
			setTimeout(tick, 500);
		};
		tick();
	});
}

/**
 * 经 Caddy admin API（127.0.0.1:2019）热加载：把完整 Caddyfile 以 caddyfile 适配器
 * POST 到 /load。gate 以 dsh 用户运行，无权执行 `caddy reload`，admin API 是官方途径。
 */
function caddyReload() {
	return new Promise((resolve, reject) => {
		let caddyfile;
		try {
			caddyfile = fs.readFileSync("/etc/caddy/Caddyfile", "utf8");
		} catch (err) {
			reject(new Error(`读取 /etc/caddy/Caddyfile 失败: ${err.message}`));
			return;
		}
		const body = JSON.stringify({ config: caddyfile, adapter: "caddyfile" });
		const url = new URL(`${CADDY_ADMIN}/load`);
		const req = http.request(
			{
				host: url.hostname,
				port: url.port || 80,
				method: "POST",
				path: url.pathname,
				headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
				timeout: 20_000,
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					if (res.statusCode === 200) resolve();
					else reject(new Error(`caddy admin ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`));
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("caddy admin timeout")));
		req.on("error", reject);
		req.end(body);
	});
}

/** 把新的 trusted host 持久化到 state/gate.env 与 state/config.json（供下次 systemd 启动与 status 展示）。 */
function persistTrustedHost(domain) {
	try {
		const lines = [`GATE_HOME=${process.env.GATE_HOME || GATE_HOME}`, `DSH_BIN=${process.env.DSH_BIN || DSH_BIN}`];
		if (process.env.DSH_HOME) lines.push(`DSH_HOME=${process.env.DSH_HOME}`);
		lines.push(`DSH_TRUSTED_HOST=${domain}`);
		fs.writeFileSync(path.join(STATE_DIR, "gate.env"), lines.join("\n") + "\n", { mode: 0o600 });
	} catch (err) {
		log(`warn: persist gate.env failed: ${err.message}`);
	}
	try {
		const cfgFile = path.join(STATE_DIR, "config.json");
		const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
		cfg.domain = domain;
		cfg.trustedHost = domain;
		fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
	} catch {
		/* config.json 可选 */
	}
}

/**
 * 向导改域名：写站点配置文件（主 Caddyfile 已 import 它）→ 经 Caddy admin API 热加载 →
 * 更新运行期 trustedHost 并持久化 → 重启 DSH 子进程（自动重新捕获 token + 兑换）。
 * 站点文件由 install.sh 预创建并属主 dsh（组 caddy 可读），gate 无需 root。
 */
// 站点块模板在 gate/site-block.js（install.sh 与 dsh-vps vpn 共用）。
// 改域名时必须带上当前隧道策略，否则「仅隧道可访问」会被改域名动作悄悄抹掉。
function siteBlock(host) {
	return caddySiteBlock(host, { gatePort: GATE_PORT, vpn: readVpnEnv(STATE_DIR) });
}

async function applyDomainChange(domain) {
	fs.writeFileSync(CADDY_SITE_FILE, siteBlock(domain));
	try {
		await caddyReload();
		log(`caddy reloaded with site ${domain}`);
	} catch (err) {
		log(`warn: caddy reload failed: ${err.message}（站点配置已写入，Caddy 重启后生效）`);
	}
	dshTrustedHost = domain;
	persistTrustedHost(domain);
	restartDsh(`trusted host changed to ${domain}`);
}

/**
 * 设置页「修改密码」：必须给出正确的当前密码；输错计入登录失败限流（不能拿这里试密码）。
 * 改完换新盐 → 所有旧会话立即作废；只给发起修改的这台设备换发新会话，其他设备需重新登录。
 * 返回错误码而非文案，由界面按 DSH 语言显示。
 */
async function handlePassword(req, res, user) {
	const json = (status, body, headers) => {
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
		res.end(JSON.stringify(body));
	};
	if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
	const origin = req.headers.origin;
	let sameOrigin = false;
	try {
		sameOrigin = origin !== void 0 && new URL(origin).host === requestAuthority(req.headers);
	} catch {
		/* 非法 Origin */
	}
	if (!sameOrigin || String(req.headers["sec-fetch-site"] || "") === "cross-site") return json(403, { error: "cross_origin" });
	const ip = clientIp(req);
	if (loginRateLimited(ip)) return json(429, { error: "rate_limited" });
	let body;
	try {
		body = JSON.parse(await readBody(req, 16 * 1024));
	} catch {
		return json(400, { error: "bad_request" });
	}
	const current = typeof body?.current === "string" ? body.current : "";
	const next = typeof body?.next === "string" ? body.next : "";
	const admin = loadAdmin();
	if (!admin || admin.username !== user) return json(409, { error: "admin_changed" });
	if (!verifyAdmin(admin, admin.username, current)) {
		recordLoginFailure(ip);
		log(`password change rejected (wrong current password) from ${ip} for ${JSON.stringify(user)}`);
		return json(400, { error: "wrong_current" });
	}
	if (next.length < 12) return json(400, { error: "too_short" });
	if (next.length > 1024) return json(400, { error: "too_long" });
	if (next === current) return json(400, { error: "same_as_current" });
	clearLoginFailures(ip);
	writeAdminRecord(admin.username, next);
	log(`admin password changed from ${ip} (${admin.username}); all other sessions revoked`);
	// 新盐已生效：给这台设备换发会话，免得改完密码自己也被踢出去
	return json(200, { ok: true }, { "set-cookie": sessionCookieHeader(req, loadAdmin(), true) });
}

function writeAdminRecord(username, password) {
	ensureStateDir();
	const salt = crypto.randomBytes(16);
	const record = {
		username,
		salt: salt.toString("hex"),
		hash: hashPassword(password, salt).toString("hex"),
		scrypt: SCRYPT_PARAMS,
		createdAt: Date.now(),
	};
	fs.writeFileSync(adminPath(), JSON.stringify(record, null, 2), { mode: 0o600 });
}

/** 以 DSH 子命令运行（如 `plugin --profile web add <pkg>`），返回 { code, stdout, stderr }。 */
function runDshCli(cmdArgs, timeoutMs = 5 * 60_000) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [DSH_BIN, ...cmdArgs], {
			cwd: GATE_HOME,
			env: { ...process.env, ...PLUGIN_ENV },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (code) => {
			if (done) return;
			done = true;
			resolve({ code, stdout, stderr });
		};
		child.stdout.on("data", (c) => { stdout += c; });
		child.stderr.on("data", (c) => { stderr += c; });
		child.on("error", (err) => finish(128));
		child.on("exit", (code) => finish(code === null ? 128 : code));
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		timer.unref();
	});
}

/** 安装时用的 registry：install.sh --mirror cn 记在 config.json 里，与 DSH 本体同源。 */
function npmRegistry() {
	try {
		const cfg = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "config.json"), "utf8"));
		if (cfg.mirror === "cn") return "https://registry.npmmirror.com";
	} catch {
		/* 默认源 */
	}
	return "https://registry.npmjs.org";
}

/** 查询包在 registry 上的 latest 版本；失败返回 null（调用方退回不带版本号安装）。 */
function latestVersion(pkg) {
	return new Promise((resolve) => {
		const url = `${npmRegistry()}/${encodeURIComponent(pkg).replace(/^%40/, "@")}/latest`;
		const req = https.get(url, { headers: { accept: "application/json" }, timeout: 10_000 }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				try {
					const v = res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString("utf8")).version : null;
					resolve(typeof v === "string" && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(v) ? v : null);
				} catch {
					resolve(null);
				}
			});
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(null));
	});
}

/**
 * 后台安装一批常用插件（不阻塞向导响应）。
 * `dsh plugin` 内部转发给 pnpm；装完置空 token 触发一次 DSH 重启，让新 bundle 进入 profile 生效。
 */
async function installPlugins(options) {
	let installed = 0;
	for (const opt of options) {
		// 下限钉在 registry 上的 latest：即使 pnpm 冷却期配置被别处覆盖，也至少装到最新版；
		// 用 ^ 而非精确版本，profile 里记成范围，之后插件市场的"更新"照常能升级。
		const version = await latestVersion(opt.pkg);
		const pkg = version ? `${opt.pkg}@^${version}` : opt.pkg;
		log(`installing plugin: ${pkg}${version ? "" : "（未查到 latest，交给 pnpm 解析）"}`);
		// -w 等附加参数由插件作者的安装命令指定，dsh 原样透传给 pnpm
		const res = await runDshCli(["plugin", "--profile", "web", "add", ...(opt.args || []), pkg]);
		if (res.code === 0) {
			installed += 1;
			log(`plugin installed: ${pkg}`);
		} else {
			const tail = (res.stderr || res.stdout || "").trim().split("\n").slice(-4).join(" | ");
			log(`plugin install failed for ${pkg}: code=${res.code}${tail ? ` | ${tail}` : ""}`);
			if (/pnpm not found/i.test(res.stderr || "")) {
				log("hint: install pnpm first (`npm install -g pnpm`), or re-run install.sh");
				break; // 后续插件同样会因缺 pnpm 失败，不再逐个重试
			}
		}
	}
	if (installed > 0) restartDsh("plugins installed");
}

// 向导限流（内存）：同 IP 10 次 / 10 分钟
const setupFailures = new Map();

function setupRateLimited(ip) {
	const entry = setupFailures.get(ip);
	return entry !== void 0 && entry.count >= SETUP_MAX_FAILURES && Date.now() <= entry.resetAt;
}

function recordSetupFailure(ip) {
	const now = Date.now();
	let entry = setupFailures.get(ip);
	if (!entry || now > entry.resetAt) entry = { count: 0, resetAt: now + SETUP_WINDOW_MS };
	entry.count += 1;
	setupFailures.set(ip, entry);
}

function currentDomainHint(req) {
	try {
		const cfg = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "config.json"), "utf8"));
		if (typeof cfg.domain === "string" && cfg.domain && DOMAIN_PATTERN.test(cfg.domain)) return cfg.domain;
	} catch {
		/* fallthrough */
	}
	const authority = requestAuthority(req.headers);
	if (authority && DOMAIN_PATTERN.test(authorityOf(authority).split(":")[0])) return authorityOf(authority).split(":")[0];
	return "";
}

function setupPage({ error, username, domain, warnings, token, lang = "zh", req }) {
	const L = translator(lang);
	return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>dsh-vps · ${L("初始设置", "Setup")}</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0b0e14;color:#dbe2ea;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(420px,92vw);padding:32px 28px;border:1px solid #1f2733;border-radius:12px;background:#11161f}
h1{margin:0 0 4px;font-size:20px;letter-spacing:.5px}
.sub{margin:0 0 20px;color:#7d8a9c;font-size:13px}
label{display:block;margin:12px 0 4px;font-size:13px;color:#9aa7b8}
input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #2a3547;border-radius:8px;
background:#0d1219;color:#e6edf5;font-size:15px}
input:focus{outline:none;border-color:#3b82f6}
button{margin-top:20px;width:100%;padding:10px;border:0;border-radius:8px;background:#2563eb;
color:#fff;font-size:15px;cursor:pointer}
button:hover{background:#1d4fd8}
.err{margin:0 0 12px;padding:8px 10px;border-radius:8px;background:#2a1215;color:#f87171;font-size:13px}
.warn{margin:0 0 12px;padding:8px 10px;border-radius:8px;background:#2a2112;color:#fbbf24;font-size:13px}
.hint{margin:2px 0 0;font-size:12px;color:#5c6b7e}
hr{border:0;border-top:1px solid #1f2733;margin:20px 0 4px}
.chk{display:flex;align-items:flex-start;gap:8px;margin:14px 0 2px;cursor:pointer;font-size:14px;color:#dbe2ea}
.chk input{width:auto;margin:2px 0 0;accent-color:#2563eb}
.chk .tip{margin:2px 0 0;font-size:12px;color:#5c6b7e}
${REPO_CSS}
${LANG_CSS}
</style>
</head>
<body>
${req ? langSwitch(req, lang) : ""}
<main>
<h1>dsh-vps ${L("初始设置", "setup")}</h1>
<p class="sub">DeepSeek Harness · ${L("仅需填写以下几项", "just a few fields")}</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
${(warnings || []).map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
<form method="post" action="/setup">
${token ? `<input type="hidden" name="token" value="${esc(token)}">` : ""}
<label for="u">${L("管理员用户名", "Admin username")}</label>
<input id="u" name="username" value="${esc(username || "")}" autocomplete="username" required>
<p class="hint">${L("3-32 位字母、数字或下划线", "3–32 letters, digits or underscores")}</p>
<label for="p">${L("管理员密码", "Admin password")}</label>
<input id="p" name="password" type="password" autocomplete="new-password" required>
<label for="p2">${L("确认密码", "Confirm password")}</label>
<input id="p2" name="password2" type="password" autocomplete="new-password" required>
<p class="hint">${L("至少 12 位", "At least 12 characters")}</p>
<hr>
<label for="d">${L("域名（可选）", "Domain (optional)")}</label>
<input id="d" name="domain" value="${esc(domain || "")}" placeholder="dsh.example.com">
<p class="hint">${L("需已将 A 记录解析到本服务器；留空则沿用当前访问方式。Caddy 自动签发证书。", "Its A record must already point at this server; leave empty to keep the current address. Caddy issues the certificate automatically.")}</p>
<label for="k">DeepSeek API Key${L("（可选）", " (optional)")}</label>
<input id="k" name="apiKey" type="password" autocomplete="off" placeholder="sk-...">
<p class="hint">${L("现在填写最省事；跳过也可稍后在登录后的「添加 API Key」引导，或设置 → 模型 → DeepSeek 中填写。", "Easiest to fill in now; you can also add it later from the \"Add API key\" prompt after signing in, or under Settings → Models → DeepSeek.")}</p>
<hr>
<p class="hint" style="margin:2px 0 0">${L("预置插件（默认全选，可取消；其余插件装好后随时在插件市场里自行安装）", "Bundled plugins (pre-checked, optional ones can be unchecked; install anything else from the plugin market later)")}</p>
${PLUGIN_OPTIONS.map((o) => `
<label class="chk"><input type="checkbox" name="plugin" value="${o.id}" checked${o.required ? " disabled" : ""}> <span>${esc(lang === "zh" ? o.name : o.nameEn || o.name)}<br><span class="tip">${esc(lang === "zh" ? o.desc : o.descEn || o.desc)}</span></span></label>`).join("")}
<button type="submit">${L("完成设置", "Finish setup")}</button>
</form>
${repoLink()}
</main>
</body>
</html>`;
}

/** 缺少/错误的启动令牌：不给向导表单，只告诉用户去哪里拿链接。 */
function setupTokenPage(lang = "zh", req) {
	const L = translator(lang);
	return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>dsh-vps · ${L("需要启动令牌", "Setup token required")}</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0b0e14;color:#dbe2ea;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(420px,92vw);padding:32px 28px;border:1px solid #1f2733;border-radius:12px;background:#11161f}
h1{margin:0 0 4px;font-size:20px;letter-spacing:.5px}
.sub{margin:0 0 20px;color:#7d8a9c;font-size:13px}
.err{margin:0 0 12px;padding:8px 10px;border-radius:8px;background:#2a1215;color:#f87171;font-size:13px}
.hint{margin:2px 0 0;font-size:12px;color:#5c6b7e}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
${REPO_CSS}
${LANG_CSS}
</style>
</head>
<body>
${req ? langSwitch(req, lang) : ""}
<main>
<h1>dsh-vps ${L("初始设置", "setup")}</h1>
<p class="sub">${L("初始设置向导需要启动令牌", "The setup wizard needs a setup token")}</p>
<p class="err">${L("当前链接缺少启动令牌或令牌不正确。向导只对持有令牌的人开放。", "This link has no setup token, or the token is wrong. The wizard only answers to holders of the token.")}</p>
<p style="font-size:14px;color:#9aa7b8;margin:0 0 4px">${L("在服务器上执行下面的命令获取带令牌的链接：", "Run this on the server to get the link with its token:")}</p>
<p style="margin:6px 0 0"><code style="display:block;padding:9px 10px;border-radius:8px;background:#0d1219;color:#93c5fd;font-size:13px;overflow-x:auto">sudo dsh-vps setup-url</code></p>
<p class="hint" style="margin:16px 0 0">${L("安装结束时该链接已打印在终端里。", "The link was also printed in the terminal when the install finished.")}</p>
${repoLink()}
</main>
</body>
</html>`;
}

async function handleSetup(req, res) {
	const lang = requestLang(req);
	const L = translator(lang);
	if (!setupOpen()) {
		sendText(res, 404, "not found");
		return;
	}
	if (req.method === "GET" || req.method === "HEAD") {
		const token = providedSetupToken(req, null);
		if (!setupTokenValid(token)) {
			log("setup page rejected: missing or wrong token");
			sendHtml(res, 403, setupTokenPage(lang, req));
			return;
		}
		sendHtml(res, 200, setupPage({ domain: currentDomainHint(req), token, lang, req }));
		return;
	}
	if (req.method !== "POST") {
		sendText(res, 405, "method not allowed");
		return;
	}
	let form;
	try {
		form = new URLSearchParams(await readBody(req, 64 * 1024));
	} catch {
		sendText(res, 400, "bad request");
		return;
	}
	// 令牌校验放在限流之前：拿不到令牌的人不该消耗掉真正的密码尝试额度，
	// 反之只带错误令牌的请求也刷不掉限流窗口。
	const token = providedSetupToken(req, form);
	if (!setupTokenValid(token)) {
		log("setup submit rejected: missing or wrong token");
		sendHtml(res, 403, setupTokenPage(lang, req));
		return;
	}
	const ip = clientIp(req);
	if (setupRateLimited(ip)) {
		sendHtml(res, 429, setupPage({ error: L("尝试次数过多，请稍后再试。", "Too many attempts. Try again later."), token, lang, req }));
		return;
	}
	const username = String(form.get("username") || "").trim();
	const password = String(form.get("password") || "");
	const password2 = String(form.get("password2") || "");
	const domain = String(form.get("domain") || "").trim().toLowerCase();
	const apiKey = String(form.get("apiKey") || "").trim();
	const plugins = (form.getAll("plugin") || [])
		.map((v) => PLUGIN_OPTIONS.find((o) => o.id === v || o.pkg === v))
		.filter(Boolean);
	// 必装项不看表单：disabled 的勾选框不会随表单提交，而且也不该允许被去掉
	for (const o of PLUGIN_OPTIONS) if (o.required) plugins.unshift(o);
	const pluginsToInstall = plugins.filter((o, i, arr) => arr.findIndex((x) => x.pkg === o.pkg) === i);

	const redisplay = (error) => {
		recordSetupFailure(ip);
		sendHtml(res, 200, setupPage({ error, username, domain, token, lang, req }));
	};
	if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) return redisplay(L("用户名须为 3-32 位字母、数字或下划线。", "The username must be 3–32 letters, digits or underscores."));
	if (password.length < 12) return redisplay(L("密码至少 12 位。", "The password needs at least 12 characters."));
	if (password !== password2) return redisplay(L("两次输入的密码不一致。", "The two passwords do not match."));
	if (domain && !DOMAIN_PATTERN.test(domain)) return redisplay(L("域名格式不合法。", "That domain is not valid."));

	log(`setup submitted from ${ip} (username=${username}, domain=${domain || "(unchanged)"}, apiKey=${apiKey ? "yes" : "no"})`);
	writeAdminRecord(username, password);

	const warnings = [];
	if (domain && domain !== dshTrustedHost) {
		try {
			await applyDomainChange(domain);
		} catch (err) {
			log(`setup: domain change failed: ${err.message}`);
			sendHtml(res, 200, setupPage({
				error: L(`域名配置失败：${err.message}。管理员账号已保存，请修正后重新提交。`, `Domain setup failed: ${err.message}. The admin account was saved; fix it and submit again.`),
				username,
				domain,
				token,
				lang,
				req,
			}));
			return;
		}
	}
	if (apiKey) {
		try {
			await waitForDshCookie(30_000);
			await dshRpc("credentials/set", { ref: DEEPSEEK_KEY_REF, value: apiKey });
			log("setup: api key written via credentials/set");
		} catch (err) {
			log(`setup: api key write failed: ${err.message}`);
			warnings.push(L(`API Key 写入失败：${err.message}。不影响登录，可稍后在原生设置页填写。`, `Could not save the API key: ${err.message}. Signing in is unaffected; add it later in the DSH settings.`));
		}
	}

	fs.writeFileSync(setupLockPath(), JSON.stringify({ completedAt: Date.now(), username }, null, 2), { mode: 0o600 });
	clearSetupToken();
	log("setup completed; wizard locked");

	if (pluginsToInstall.length) {
		log(`setup: installing plugins in background: ${pluginsToInstall.map((o) => o.pkg).join(", ")}`);
		installPlugins(pluginsToInstall).catch((err) => log(`plugin install aborted: ${err && err.message}`));
	}

	if (warnings.length) {
		sendHtml(res, 200, setupPage({ warnings, username, domain, token, lang, req }));
		return;
	}
	if (domain && domain !== requestAuthority(req.headers)) {
		// 域名已切换：引导用户到新地址登录（旧 host 的会话不再适用）
		sendHtml(
			res,
			200,
			`<!doctype html><html lang="${lang === "zh" ? "zh-CN" : "en"}"><meta charset="utf-8"><title>dsh-vps · ${L("设置完成", "Setup complete")}</title>
<body style="background:#0b0e14;color:#dbe2ea;font:15px system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="max-width:420px;padding:32px;border:1px solid #1f2733;border-radius:12px;background:#11161f">
<h2 style="margin-top:0">${L("设置完成", "Setup complete")}</h2>
<p>${L("请在新地址打开并登录：", "Open the new address and sign in:")}</p>
<p><a href="https://${esc(domain)}/" style="color:#60a5fa">https://${esc(domain)}/</a></p>
<p style="color:#7d8a9c;font-size:13px">${L("证书签发需要几十秒；若暂不可访问请稍候重试。", "Issuing the certificate takes a few tens of seconds; if it does not open yet, retry shortly.")}</p>
</div></body>`,
		);
		return;
	}
	res.writeHead(303, { location: "/login", "cache-control": "no-store" });
	res.end();
}

//#region DSH 版本检测与浏览器一键升级

const update = { latest: null, pending: null, checkedAt: 0, error: null };

function upgradeRequestPath() {
	return path.join(STATE_DIR, "upgrade.request");
}

function currentDshVersion() {
	try {
		const v = fs.readlinkSync(path.join(GATE_HOME, "dsh", "current"));
		return SEMVER_PATTERN.test(v) ? v : null;
	} catch {
		return null;
	}
}

/** semver 比较（含预发布段）：a>b 返回正数。 */
function compareVersions(a, b) {
	const split = (v) => {
		const [core, pre] = v.split("-", 2);
		return { core: core.split(".").map(Number), pre: pre === void 0 ? null : pre.split(".") };
	};
	const x = split(a);
	const y = split(b);
	for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
	if (x.pre === null || y.pre === null) return (x.pre === null) - (y.pre === null);
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === void 0 || q === void 0) return p === void 0 ? -1 : 1;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
		if (pn !== qn) return pn ? -1 : 1;
		if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

/**
 * 官方 latest（正式）与 next（预览）两个渠道中版本号更高、且已过冷静期的一个；alpha 等内部渠道不取。
 * 返回 { version, pending }：pending 是更新但仍在冷静期内的版本 { version, availableAt }。
 */
function newestDshVersion() {
	return new Promise((resolve) => {
		const url = `${npmRegistry()}/${encodeURIComponent(DSH_PACKAGE).replace(/^%40/, "@")}`;
		const req = https.get(url, { headers: { accept: "application/json" }, timeout: 20_000 }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				try {
					if (res.statusCode !== 200) return resolve(null);
					const doc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					const tags = doc["dist-tags"] || {};
					const times = doc.time || {};
					const candidates = [...new Set([tags.latest, tags.next])]
						.filter((v) => typeof v === "string" && SEMVER_PATTERN.test(v))
						.sort(compareVersions);
					const now = Date.now();
					const mature = candidates.filter((v) => {
						const at = Date.parse(times[v] || "");
						return Number.isFinite(at) && now - at >= UPGRADE_COOLDOWN_MS;
					});
					const version = mature.length ? mature[mature.length - 1] : null;
					const newest = candidates[candidates.length - 1];
					const pending = newest && newest !== version
						? { version: newest, availableAt: Date.parse(times[newest] || "") + UPGRADE_COOLDOWN_MS || null }
						: null;
					resolve({ version, pending });
				} catch {
					resolve(null);
				}
			});
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(null));
	});
}

async function checkDshLatest() {
	const r = await newestDshVersion();
	update.checkedAt = Date.now();
	if (r) {
		if (r.version && r.version !== update.latest) log(`dsh latest on registry: ${r.version} (running ${currentDshVersion() || "unknown"})`);
		update.latest = r.version;
		update.pending = r.pending;
		update.error = null;
	} else {
		update.error = "无法查询 npm 最新版本";
	}
}

function readUpgradeStatus() {
	try {
		const st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "upgrade.status.json"), "utf8"));
		return st && typeof st.state === "string" ? st : null;
	} catch {
		return null;
	}
}

/** 升级失败时给界面看的日志末尾（state/upgrade.log 由 root 写入并交还 dsh 用户）。 */
function upgradeLogTail(lines = 15) {
	try {
		return fs.readFileSync(path.join(STATE_DIR, "upgrade.log"), "utf8").replace(/\x1b\[[0-9;]*m/g, "").trimEnd().split("\n").slice(-lines).join("\n");
	} catch {
		return null;
	}
}

function updateInfo() {
	const current = currentDshVersion();
	const latest = update.latest;
	const status = readUpgradeStatus();
	return {
		current,
		latest,
		available: Boolean(current && latest && compareVersions(latest, current) > 0),
		checkedAt: update.checkedAt || null,
		// 更新但仍在冷静期内的版本：界面上告知「X 小时后可升级」，不给升级按钮
		pending: update.pending && current && compareVersions(update.pending.version, current) > 0 ? update.pending : null,
		cooldownHours: UPGRADE_COOLDOWN_MS / 3_600_000,
		error: update.error,
		requested: fs.existsSync(upgradeRequestPath()),
		status,
		logTail: status && status.state === "failed" ? upgradeLogTail() : null,
	};
}

/** GET：更新状态；POST：请求升级到官方最新版（写请求文件，交给 root 的 path 单元）。 */
async function handleUpdate(req, res, user) {
	const json = (status, body) => {
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	};
	if (req.method === "GET") {
		// 设置页的「检查更新」：立即查一次，而不是等 6 小时一次的定时检查
		if (/[?&]refresh=1(?:&|$)/.test(req.url || "")) await checkDshLatest();
		return json(200, updateInfo());
	}
	if (req.method !== "POST") return json(405, { error: "method not allowed" });
	// 触发的是 root 操作：必须是本站页面发起（fetch POST 必带 Origin）
	const origin = req.headers.origin;
	let sameOrigin = false;
	try {
		sameOrigin = origin !== void 0 && new URL(origin).host === requestAuthority(req.headers);
	} catch {
		/* 非法 Origin */
	}
	if (!sameOrigin || String(req.headers["sec-fetch-site"] || "") === "cross-site") return json(403, { error: "cross-origin request refused" });
	await checkDshLatest(); // 以点击时的最新结果为准
	const info = updateInfo();
	if (info.requested || (info.status && info.status.state === "running")) return json(409, { error: "升级已在进行中" });
	if (!info.available) return json(409, { error: "已是最新版本" });
	fs.writeFileSync(upgradeRequestPath(), JSON.stringify({ target: info.latest, from: info.current, by: user, at: Date.now() }) + "\n", { mode: 0o600 });
	log(`upgrade requested from browser by ${user}: ${info.current} -> ${info.latest}`);
	return json(202, { ok: true, from: info.current, to: info.latest });
}

// 注入 DSH 页面的升级提示条（同源脚本，无外部依赖）。
// 只做提示与确认；真正的升级由 root 服务执行，失败会自动回滚。
// 语言跟随 DSH「设置 → 通用 → 语言」：DSH 把当前语言同步到 <html lang>（中文为 zh-CN），
// 这里读它，并监听它的变化——DSH 晚于提示条完成语言初始化、或用户切换语言时，提示条随之重画。
const UI_JS = `(function () {
	if (window.top !== window || document.getElementById("dshvps-update")) return;
	var KEY = "dshvps-update-dismissed";
	function L(cn, en) { var l = String(document.documentElement.getAttribute("lang") || "").toLowerCase(); return l.indexOf("zh") === 0 ? cn : en; }
	function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
	var box, timer, view = null, busy = false, asked = false;
	function el(tag, css, text) { var n = document.createElement(tag); if (css) n.style.cssText = css; if (text) n.textContent = text; return n; }
	var BTN = "margin-left:8px;padding:5px 12px;border-radius:7px;border:1px solid #2a3547;cursor:pointer;font:inherit;";
	// view 是一个返回 [文案, 按钮] 的函数：语言变了只需重新调用它
	function show(fn) { view = fn; paint(); }
	function paint() {
		if (!view) return;
		var v = view(), msg = v[0], actions = v[1];
		if (!box) {
			box = el("div", "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:min(420px,calc(100vw - 32px));" +
				"padding:12px 14px;border-radius:10px;background:#11161f;color:#dbe2ea;border:1px solid #2a3547;" +
				"box-shadow:0 8px 30px rgba(0,0,0,.35);font:13px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif");
			box.id = "dshvps-update";
			document.body.appendChild(box);
		}
		box.textContent = "";
		box.appendChild(el("div", "", msg));
		if (actions && actions.length) {
			var row = el("div", "margin-top:8px;text-align:right");
			actions.forEach(function (a) {
				var b = el("button", BTN + (a.primary ? "background:#2563eb;color:#fff;border-color:#2563eb" : "background:#0d1219;color:#dbe2ea"), a.label);
				b.onclick = a.onClick;
				row.appendChild(b);
			});
			box.appendChild(row);
		}
	}
	function hide() { view = null; if (box) { box.remove(); box = null; } }
	try { new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] }); } catch (e) {}
	function get() { return fetch("/gate/update", { cache: "no-store", credentials: "same-origin" }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); }); }
	function poll() {
		get().then(function (u) {
			var st = u.status;
			if (u.requested || (st && st.state === "running")) {
				show(function () { return [L("正在升级 DeepSeek Harness" + (u.latest ? " 到 " + u.latest : "") + "…（约 1–3 分钟，期间页面会短暂不可用，请勿关闭）",
					"Upgrading DeepSeek Harness" + (u.latest ? " to " + u.latest : "") + "… (about 1–3 minutes; the page is briefly unavailable — keep it open)")]; });
				return;
			}
			if (st && asked && st.state === "success") {
				show(function () { return [L("升级完成（" + st.from + " → " + st.to + "），正在刷新…", "Upgrade complete (" + st.from + " → " + st.to + "), reloading…")]; });
				clearInterval(timer);
				setTimeout(function () { location.reload(); }, 1500);
				return;
			}
			if (st && asked && st.state === "failed") {
				clearInterval(timer);
				show(function () { return [L("升级未成功，已自动回滚到 " + (st.to || st.from) + "，当前可继续使用。详情：sudo cat /opt/dsh-vps/state/upgrade.log",
					"The upgrade did not succeed and was rolled back to " + (st.to || st.from) + "; DSH works normally. Details: sudo cat /opt/dsh-vps/state/upgrade.log"),
					[{ label: L("知道了", "OK"), onClick: hide }]]; });
				return;
			}
		}).catch(function () {
			if (asked) show(function () { return [L("正在升级，DeepSeek Harness 重启中…", "Upgrading — DeepSeek Harness is restarting…")]; });
		});
	}
	function start() {
		if (busy) return;
		if (!window.confirm(L("升级期间 DeepSeek Harness 会重启，约 1–3 分钟不可用。\\\\n升级前自动备份；新版本自检不通过会自动回滚到当前版本。\\\\n\\\\n确认升级？",
			"DeepSeek Harness restarts during the upgrade and is unavailable for about 1–3 minutes.\\\\nA backup is taken first; if the new version fails its self-check, it rolls back automatically.\\\\n\\\\nUpgrade now?"))) return;
		busy = true;
		fetch("/gate/update", { method: "POST", credentials: "same-origin" }).then(function (r) {
			return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || String(r.status)); return b; });
		}).then(function () {
			asked = true;
			store("dshvps-update-asked", String(Date.now()));
			show(function () { return [L("已提交升级请求，等待开始…", "Upgrade requested, waiting for it to start…")]; });
			timer = setInterval(poll, 3000);
		}).catch(function (e) {
			busy = false;
			show(function () { return [L("无法开始升级：", "Could not start the upgrade: ") + e.message, [{ label: L("关闭", "Close"), onClick: hide }]]; });
		});
	}
	function init() {
		// 升级过程中刷新了页面：继续跟进，完成后给出结果
		var t = Number(store("dshvps-update-asked") || 0);
		asked = t > 0 && Date.now() - t < 30 * 60000;
		get().then(function (u) {
			var st = u.status;
			if (u.requested || (st && st.state === "running")) { asked = true; timer = setInterval(poll, 3000); poll(); return; }
			if (asked && st && st.at > t) { store("dshvps-update-asked", "0"); if (st.state === "failed") poll(); return; }
			if (!u.available || store(KEY) === u.latest) return;
			show(function () { return [L("DeepSeek Harness 有新版本 " + u.latest + "（当前 " + u.current + "）", "A new DeepSeek Harness version is available: " + u.latest + " (current " + u.current + ")"), [
				{ label: L("稍后", "Later"), onClick: function () { store(KEY, u.latest); hide(); } },
				{ label: L("立即升级", "Upgrade now"), primary: true, onClick: start },
			]]; });
		}).catch(function () {});
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
})();
`;

/** 手机桌面图标（iPhone 的 apple-touch-icon） */
function handleAppleTouchIcon(req, res) {
	const png = Buffer.from(APPLE_TOUCH_ICON_B64, "base64");
	res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });
	res.end(req.method === "HEAD" ? void 0 : png);
}

function handleUiJs(req, res) {
	res.writeHead(200, {
		"content-type": "text/javascript; charset=utf-8",
		"cache-control": "no-cache",
		"x-content-type-options": "nosniff",
	});
	res.end(req.method === "HEAD" ? void 0 : UI_JS);
}

//#endregion

/** 升级回归自检（dsh-vps upgrade 调用）：健康 + token 兑换 + 登录态 credentials/describe 探针。 */
async function handleSelfcheck(req, res) {
	const report = {
		gate: "ok",
		dshAlive: dsh.child !== null,
		launchTokenCaptured: dsh.token !== null,
		dshCookieValid: dsh.cookie !== null && dsh.cookie.expiresAt > Date.now(),
		rpcProbe: null,
	};
	let pass = report.dshAlive && report.launchTokenCaptured && report.dshCookieValid;
	if (pass) {
		try {
			await dshRpc("credentials/describe", { refs: [DEEPSEEK_KEY_REF] });
			report.rpcProbe = "ok";
		} catch (err) {
			report.rpcProbe = `failed: ${err.message}`;
			pass = false;
		}
	}
	report.pass = Boolean(pass);
	res.writeHead(pass ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(report));
}

/** selfcheck 仅限回环调用（dsh-vps upgrade 在本机执行），防止公网探测内部状态。 */
//#endregion

//#region CLI：--set-admin（安装/应急重置用）

function setAdminCli(argv) {
	const [username, password] = argv;
	if (!/^[A-Za-z0-9_]{3,32}$/.test(username || "")) {
		console.error("username must match ^[A-Za-z0-9_]{3,32}$");
		process.exit(2);
	}
	if (typeof password !== "string" || password.length < 12) {
		console.error("password must be at least 12 characters");
		process.exit(2);
	}
	ensureStateDir();
	const salt = crypto.randomBytes(16);
	const record = {
		username,
		salt: salt.toString("hex"),
		hash: hashPassword(password, salt).toString("hex"),
		scrypt: SCRYPT_PARAMS,
		createdAt: Date.now(),
	};
	fs.writeFileSync(adminPath(), JSON.stringify(record, null, 2), { mode: 0o600 });
	console.log(`admin "${username}" written to ${adminPath()}`);
}

//#endregion

//#region main

function main() {
	if (!dshTrustedHost) {
		console.error("error: DSH_TRUSTED_HOST is required (domain or IP literal passed to dsh --trusted-host)");
		process.exit(2);
	}
	ensureStateDir();
	sessionKey = loadOrCreateSessionKey();

	const server = http.createServer((req, res) => {
		const pathname = (req.url || "/").split("?")[0];
		Promise.resolve()
			.then(async () => {
				// 页面右上角的语言切换：记进 Cookie，再回到去掉 lang 参数的同一地址（向导令牌等其余参数保留）
				if ((req.method === "GET" || req.method === "HEAD") && /[?&]lang=(zh|en)(?:&|$)/.test(req.url || "")) {
					const url = new URL(req.url, "http://x");
					const chosen = url.searchParams.get("lang");
					url.searchParams.delete("lang");
					res.writeHead(303, {
						location: url.pathname + url.search,
						"set-cookie": `${LANG_COOKIE}=${chosen}; Max-Age=31536000; Path=/; SameSite=Lax`,
						"cache-control": "no-store",
					});
					res.end();
					return;
				}
				if (pathname === "/login") return handleLogin(req, res);
				if (pathname === "/logout") return handleLogout(req, res);
				if (pathname === "/gate/health") return handleHealthGuarded(req, res);
				if (pathname === "/gate/selfcheck") return handleSelfcheckGuarded(req, res);
				if (pathname === "/gate/ui.js") return handleUiJs(req, res);
				if (pathname === "/gate/apple-touch-icon.png") return handleAppleTouchIcon(req, res);
				if (pathname === "/setup") return handleSetup(req, res);
				if (!loadAdmin()) {
					// 尚未完成初始设置：浏览器导航导向导，/api 保持 401
					if (pathname.startsWith("/api")) {
						sendText(res, 401, "gate not configured");
						return;
					}
					if (setupOpen()) {
						// 绝不能在这里把令牌拼进跳转地址：此刻来访者尚未证明任何身份，
						// 带上令牌等于把管理员注册权发给整个公网。无令牌时 /setup 会显示「需要令牌」页。
						res.writeHead(303, { location: "/setup", "cache-control": "no-store" });
						res.end();
						return;
					}
					sendText(res, 503, "gate not configured: admin account missing (run `dsh-vps reset-admin`)");
					return;
				}
				const user = sessionUser(req);
				if (!user) {
					denyUnauthenticated(req, res, pathname);
					return;
				}
				if (pathname === "/gate/update") return handleUpdate(req, res, user);
				if (pathname === "/gate/password") return handlePassword(req, res, user);
				if (pathname.startsWith(MARKET_PREFIX) && !marketRequestSameOrigin(req)) {
					sendText(res, 403, "cross-origin market request refused by gate");
					return;
				}
				if (TAKEOVER_RESTART && MARKET_RESTART_PATHS.has(pathname)) return handleMarketRestart(req, res, false);
				if (TAKEOVER_RESTART && MARKET_RESTART_V1_PATHS.has(pathname)) return handleMarketRestart(req, res, true);
				proxyHttp(req, res);
			})
			.catch((err) => {
				log(`request error: ${err && err.message}`);
				if (!res.headersSent) sendText(res, 500, "internal error");
				else res.end();
			});
	});
	server.on("upgrade", handleUpgrade);
	server.listen(GATE_PORT, GATE_HOST, () => {
		log(`listening on http://${GATE_HOST}:${GATE_PORT} (trusted host: ${dshTrustedHost})`);
	});

	spawnDshWithPreflight();

	// DSH 新版本检测：启动 1 分钟后查一次，之后每 6 小时一次
	setTimeout(() => checkDshLatest().catch(() => {}), 60_000).unref();
	setInterval(() => checkDshLatest().catch(() => {}), UPDATE_CHECK_INTERVAL_MS).unref();

	// DSH Cookie 续期：剩余有效期 < 24h 时用同一 launchToken 重新兑换
	setInterval(() => {
		if (dsh.cookie && dsh.cookie.expiresAt <= Date.now()) {
			// 续期一直没成功（例如将来 DSH 改为一次性 launchToken）：重启子进程拿新令牌，
			// 否则页面会永远停在"正在启动"。
			restartDsh("dsh session cookie expired");
		} else if (dsh.cookie && dsh.cookie.expiresAt - Date.now() < 24 * 3_600_000) {
			log("renewing dsh session cookie");
			exchangeToken(0);
		}
		// 顺手清理过期的限流窗口
		const now = Date.now();
		for (const [ip, entry] of loginFailures) if (now > entry.resetAt) loginFailures.delete(ip);
		for (const [ip, entry] of setupFailures) if (now > entry.resetAt) setupFailures.delete(ip);
	}, 3_600_000);

	const shutdown = (signal) => {
		log(`received ${signal}; shutting down`);
		dsh.shuttingDown = true;
		clearTimeout(exchangeTimer);
		if (dsh.child) dsh.child.kill("SIGTERM");
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000).unref();
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
	if (process.argv[2] === "--set-admin") setAdminCli(process.argv.slice(3));
	else main();
}

//#endregion

// 手机桌面图标 assets/apple-touch-icon.png（180×180 PNG）的 base64，见 handleAppleTouchIcon
// eslint-disable-next-line max-len
var APPLE_TOUCH_ICON_B64 = "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";
