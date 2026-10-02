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
