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
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

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
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 7) * 86_400_000;
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
	{ id: "dshmarket", pkg: "dshmarket", name: "插件市场 dsh-market", desc: "设置页内浏览/搜索/一键安装社区插件与主题（推荐）" },
	{ id: "dsh-cost-meter", pkg: "dsh-cost-meter", name: "会话费用统计 dsh-cost-meter", desc: "本会话/当日/历史费用与额度显示" },
	{ id: "dsh-context", pkg: "dsh-context", name: "上下文洞察 dsh-context", desc: "查看当前上下文构成与演进" },
];
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
const OWNS_HOST_SNIPPET = '<script>window.__DSH_TRANSPORT__={ownsHost:true}</script>';

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

function sendHtml(res, status, html, extraHeaders) {
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		...extraHeaders,
	});
	res.end(html);
}

function sendText(res, status, text) {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
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

function signSession(username, expiresMs) {
	const body = `${b64u(Buffer.from(username, "utf8"))}.${expiresMs}`;
	const mac = b64u(crypto.createHmac("sha256", sessionKey).update(body).digest());
	return `${body}.${mac}`;
}

function sessionUser(req) {
	const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
	if (!value) return void 0;
	const parts = value.split(".");
	if (parts.length !== 3) return void 0;
	const [user64, expiresStr, mac] = parts;
	const expectedMac = b64u(crypto.createHmac("sha256", sessionKey).update(`${user64}.${expiresStr}`).digest());
	if (!timingSafeEqualStr(mac, expectedMac)) return void 0;
	const expiresMs = Number(expiresStr);
	if (!Number.isSafeInteger(expiresMs) || expiresMs <= Date.now()) return void 0;
	try {
		return Buffer.from(user64, "base64url").toString("utf8");
	} catch {
		return void 0;
	}
}

function sessionCookieHeader(req, username) {
	const expiresMs = Date.now() + SESSION_TTL_MS;
	const secure =
		process.env.GATE_COOKIE_SECURE === "1" ||
		String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
	return [
		`${SESSION_COOKIE}=${signSession(username, expiresMs)}`,
		`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
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
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	dsh.child = child;
	dsh.startedAt = Date.now();
	dsh.token = null;
	dsh.cookie = null;

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
				// 快速退出（<5s）多半是端口/配置类硬故障：退避重启，避免空转打满 journal
				dsh.crashStreak = uptimeMs < 5000 ? dsh.crashStreak + 1 : 0;
				const delay = dsh.crashStreak > 1 ? Math.min(2000 * 2 ** (dsh.crashStreak - 1), 30_000) : 2000;
				if (dsh.crashStreak >= 3) {
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
	if (dsh.cookie && authority !== void 0 && dsh.cookie.authority === authority) {
		parts.push(`${dsh.cookie.name}=${dsh.cookie.value}`);
	}
	return parts.length ? parts.join("; ") : void 0;
}

//#endregion

//#region 登录页

function loginPage({ error, notice, next }) {
	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>dsh-vps · 登录</title>
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
</style>
</head>
<body>
<main>
<h1>dsh-vps</h1>
<p class="sub">DeepSeek Harness 登录门</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next || "/")}">
<label for="u">用户名</label>
<input id="u" name="username" autocomplete="username" required>
<label for="p">密码</label>
<input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">登录</button>
</form>
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
	if (req.method === "GET" || req.method === "HEAD") {
		const next = safeNext(new URL(req.url, "http://x").searchParams.get("next"));
		const notice = admin ? void 0 : "尚未配置管理员：请先完成初始设置向导，或运行 `dsh-vps reset-admin`。";
		sendHtml(res, 200, loginPage({ notice, next }));
		return;
	}
	if (req.method !== "POST") {
		sendText(res, 405, "method not allowed");
		return;
	}
	const ip = clientIp(req);
	if (loginRateLimited(ip)) {
		sendHtml(res, 429, loginPage({ error: "尝试次数过多，请稍后再试。", next: "/" }));
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
		sendHtml(res, 200, loginPage({ error: "用户名或密码错误。", next }));
		return;
	}
	clearLoginFailures(ip);
	log(`login ok from ${ip} (${username})`);
	res.writeHead(303, {
		location: next,
		"set-cookie": sessionCookieHeader(req, username),
		"cache-control": "no-store",
	});
	res.end();
}

function handleLogout(req, res) {
	res.writeHead(303, {
		location: "/login",
		"set-cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
		"cache-control": "no-store",
	});
	res.end();
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
function sendDshNotReady(res) {
	const state = notReadyState();
	sendHtml(
		res,
		503,
		`<!doctype html><meta charset="utf-8"><title>503 DeepSeek Harness 启动中</title>
<meta name="robots" content="noindex">
<body style="background:#0b0e14;color:#dbe2ea;font:15px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif;padding:40px;max-width:760px">
<h2 style="margin:0 0 4px">DeepSeek Harness 正在启动</h2>
<p style="color:#7d8a9c;margin:0 0 20px">gate 还没拿到 DSH 会话；本页每 3 秒自动检查一次，就绪后会自动刷新。</p>
<table style="border-collapse:collapse;font-size:14px">
<tr><td style="padding:3px 16px 3px 0;color:#9aa7b8">DSH 子进程</td><td id="s-alive">${state.childAlive ? "运行中" : "未运行"}</td></tr>
<tr><td style="padding:3px 16px 3px 0;color:#9aa7b8">launchToken</td><td id="s-token">${state.tokenCaptured ? "已捕获" : "未捕获"}</td></tr>
<tr><td style="padding:3px 16px 3px 0;color:#9aa7b8">会话 Cookie</td><td id="s-cookie">${state.cookieReady ? "已就绪" : "等待兑换"}</td></tr>
</table>
<p id="s-err" style="margin:16px 0 0;padding:10px 12px;border-radius:8px;background:#2a2112;color:#fbbf24;font-size:13px;${state.error ? "" : "display:none"}">${esc(state.error || "")}</p>
<p id="s-wait" style="color:#7d8a9c;font-size:13px;margin:16px 0 0">已等待 <span id="s-sec">0</span> 秒… <button onclick="location.reload()" style="margin-left:8px;padding:4px 10px;border:1px solid #2a3547;border-radius:6px;background:#0d1219;color:#dbe2ea;cursor:pointer">立即刷新</button></p>
<p style="color:#5c6b7e;font-size:12px;margin:20px 0 0">超过 2 分钟仍未就绪，多半是 3080 端口被残留进程占用或 DSH 启动失败：<code>journalctl -u dsh-gate -n 100</code>，然后 <code>systemctl restart dsh-gate</code>。</p>
<script>
var t0=Date.now();
setInterval(function(){document.getElementById('s-sec').textContent=Math.round((Date.now()-t0)/1000)},1000);
setInterval(function(){
  fetch('/gate/health',{cache:'no-store'}).then(function(r){return r.json()}).then(function(h){
    var alive=h.dsh&&h.dsh.alive, tok=h.launchTokenCaptured, ck=!!h.dshCookie;
    document.getElementById('s-alive').textContent=alive?'运行中':'未运行';
    document.getElementById('s-token').textContent=tok?'已捕获':'未捕获';
    document.getElementById('s-cookie').textContent=ck?'已就绪':'等待兑换';
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

function notReadyState() {
	const error = dsh.lastError || dsh.lastExchangeError || (dsh.lastExit ? `DSH 已退出 (code=${dsh.lastExit.code} signal=${dsh.lastExit.signal})，即将自动重启` : null);
	return {
		childAlive: dsh.child !== null,
		tokenCaptured: dsh.token !== null,
		cookieReady: dsh.cookie !== null,
		error,
	};
}

function sendBadGateway(res) {
	sendHtml(
		res,
		502,
		`<!doctype html><meta charset="utf-8"><title>502</title>
<body style="background:#0b0e14;color:#dbe2ea;font:15px system-ui;padding:40px">
<h2>无法连接 DeepSeek Harness</h2>
<p>DSH 后端（127.0.0.1:${DSH_PORT}）不可达。</p>
<p style="color:#7d8a9c">排障：journalctl -u dsh-gate -n 50</p></body>`,
	);
}

/**
 * 收下上游 HTML（限 8MiB），在 <head> 之后插入 ownsHost 声明后整体下发。
 * 只有文档型 HTML 需要改写；其它响应仍是 pipe 直通，不损失流式能力。
 */
function collectAndInject(upRes, res, status, respHeaders) {
	const chunks = [];
	let size = 0;
	let overflow = false;
	upRes.on("data", (chunk) => {
		if (overflow) return;
		size += chunk.byteLength;
		if (size > 8 * 1024 * 1024) {
			overflow = true;
			return;
		}
		chunks.push(chunk);
	});
	upRes.on("end", () => {
		let body = Buffer.concat(chunks).toString("utf8");
		if (!overflow) {
			const at = body.search(/<head\b[^>]*>/i);
			if (at !== -1) {
				const end = body.indexOf(">", at) + 1;
				body = body.slice(0, end) + OWNS_HOST_SNIPPET + body.slice(end);
			} else {
				body = OWNS_HOST_SNIPPET + body;
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
		sendDshNotReady(res);
		return;
	}
	const authority = requestAuthority(req.headers);
	const headers = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (HOP_HEADERS.has(key) || key === "cookie") continue;
		// 转发头会让 DSH 判定"回环对端是代理"而拒绝特权端点（如 dsh-market 重启）
		if (STRIP_FORWARDING && FORWARDING_HEADERS.has(key)) continue;
		headers[key] = value;
	}
	const cookie = upstreamCookieHeader(req.headers.cookie, authority);
	if (cookie !== void 0) headers.cookie = cookie;

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
			for (const [key, value] of Object.entries(upRes.headers)) {
				if (HOP_HEADERS.has(key)) continue;
				if (key === "content-length") continue; // 长度按最终响应体重算
				if (key === "content-type") {
					isHtml = String(value).includes("text/html");
				}
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
			if (OWNS_HOST_INJECT && isHtml && navigational && upRes.statusCode === 200) {
				collectAndInject(upRes, res, upRes.statusCode, respHeaders);
				return;
			}
			res.writeHead(upRes.statusCode || 502, respHeaders);
			upRes.pipe(res);
		},
	);
	upstreamReq.on("timeout", () => {
		if (!responded) upstreamReq.destroy(new Error("upstream connect timeout"));
	});
	upstreamReq.on("error", (err) => {
		log(`proxy error: ${err.message}`);
		if (!res.headersSent) sendBadGateway(res);
		else res.end();
	});
	req.pipe(upstreamReq);
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
function handleMarketRestart(req, res) {
	if (req.method !== "POST") {
		res.writeHead(405, { allow: "POST", "content-length": "0" });
		res.end();
		return;
	}
	log("market restart requested; gate takes over");
	res.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify({ ok: true, managedBy: "dsh-gate", note: "由 gate 重启 DSH 子进程" }));
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

/** 服务端身份调用 DSH 特权 RPC（走已注入的会话 Cookie，等价于"登录态探测"）。 */
function dshRpc(method, args) {
	return new Promise((resolve, reject) => {
		if (!dsh.cookie) {
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
async function applyDomainChange(domain) {
	const siteBlock = `${domain} {\n\treverse_proxy 127.0.0.1:${GATE_PORT}\n}\n`;
	fs.writeFileSync(CADDY_SITE_FILE, siteBlock);
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
			env: { ...process.env },
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

/**
 * 后台安装一批常用插件（不阻塞向导响应）。
 * `dsh plugin` 内部转发给 pnpm；装完置空 token 触发一次 DSH 重启，让新 bundle 进入 profile 生效。
 */
async function installPlugins(packages) {
	let installed = 0;
	for (const pkg of packages) {
		log(`installing plugin: ${pkg}`);
		const res = await runDshCli(["plugin", "--profile", "web", "add", pkg]);
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

function setupPage({ error, username, domain, warnings }) {
	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>dsh-vps · 初始设置</title>
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
</style>
</head>
<body>
<main>
<h1>dsh-vps 初始设置</h1>
<p class="sub">DeepSeek Harness · 仅需填写以下几项</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
${(warnings || []).map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
<form method="post" action="/setup">
<label for="u">管理员用户名</label>
<input id="u" name="username" value="${esc(username || "")}" autocomplete="username" required>
<p class="hint">3-32 位字母、数字或下划线</p>
<label for="p">管理员密码</label>
<input id="p" name="password" type="password" autocomplete="new-password" required>
<label for="p2">确认密码</label>
<input id="p2" name="password2" type="password" autocomplete="new-password" required>
<p class="hint">至少 12 位</p>
<hr>
<label for="d">域名（可选）</label>
<input id="d" name="domain" value="${esc(domain || "")}" placeholder="dsh.example.com">
<p class="hint">需已将 A 记录解析到本服务器；留空则沿用当前访问方式。Caddy 自动签发证书。</p>
<label for="k">DeepSeek API Key（可选）</label>
<input id="k" name="apiKey" type="password" autocomplete="off" placeholder="sk-...">
<p class="hint">现在填写最省事；跳过也可稍后在登录后的「添加 API Key」引导，或设置 → 模型 → DeepSeek 中填写。</p>
<hr>
<p class="hint" style="margin:2px 0 0">常用插件（可选，安装后自动重启 DSH 生效）</p>
${PLUGIN_OPTIONS.map((o, i) => `
<label class="chk"><input type="checkbox" name="plugin" value="${o.id}"${i === 0 ? " checked" : ""}> <span>${esc(o.name)}<br><span class="tip">${esc(o.desc)}</span></span></label>`).join("")}
<button type="submit">完成设置</button>
</form>
</main>
</body>
</html>`;
}

async function handleSetup(req, res) {
	if (!setupOpen()) {
		sendText(res, 404, "not found");
		return;
	}
	if (req.method === "GET" || req.method === "HEAD") {
		sendHtml(res, 200, setupPage({ domain: currentDomainHint(req) }));
		return;
	}
	if (req.method !== "POST") {
		sendText(res, 405, "method not allowed");
		return;
	}
	const ip = clientIp(req);
	if (setupRateLimited(ip)) {
		sendHtml(res, 429, setupPage({ error: "尝试次数过多，请稍后再试。" }));
		return;
	}
	let form;
	try {
		form = new URLSearchParams(await readBody(req, 64 * 1024));
	} catch {
		sendText(res, 400, "bad request");
		return;
	}
	const username = String(form.get("username") || "").trim();
	const password = String(form.get("password") || "");
	const password2 = String(form.get("password2") || "");
	const domain = String(form.get("domain") || "").trim().toLowerCase();
	const apiKey = String(form.get("apiKey") || "").trim();
	const plugins = (form.getAll("plugin") || [])
		.map((v) => PLUGIN_OPTIONS.find((o) => o.id === v || o.pkg === v))
		.filter(Boolean)
		.map((o) => o.pkg);

	const redisplay = (error) => {
		recordSetupFailure(ip);
		sendHtml(res, 200, setupPage({ error, username, domain }));
	};
	if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) return redisplay("用户名须为 3-32 位字母、数字或下划线。");
	if (password.length < 12) return redisplay("密码至少 12 位。");
	if (password !== password2) return redisplay("两次输入的密码不一致。");
	if (domain && !DOMAIN_PATTERN.test(domain)) return redisplay("域名格式不合法。");

	log(`setup submitted from ${ip} (username=${username}, domain=${domain || "(unchanged)"}, apiKey=${apiKey ? "yes" : "no"})`);
	writeAdminRecord(username, password);

	const warnings = [];
	if (domain && domain !== dshTrustedHost) {
		try {
			await applyDomainChange(domain);
		} catch (err) {
			log(`setup: domain change failed: ${err.message}`);
			sendHtml(res, 200, setupPage({
				error: `域名配置失败：${err.message}。管理员账号已保存，请修正后重新提交。`,
				username,
				domain,
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
			warnings.push(`API Key 写入失败：${err.message}。不影响登录，可稍后在原生设置页填写。`);
		}
	}

	fs.writeFileSync(setupLockPath(), JSON.stringify({ completedAt: Date.now(), username }, null, 2), { mode: 0o600 });
	log("setup completed; wizard locked");

	if (plugins.length) {
		log(`setup: installing plugins in background: ${plugins.join(", ")}`);
		installPlugins(plugins).catch((err) => log(`plugin install aborted: ${err && err.message}`));
	}

	if (warnings.length) {
		sendHtml(res, 200, setupPage({ warnings, username, domain }));
		return;
	}
	if (domain && domain !== requestAuthority(req.headers)) {
		// 域名已切换：引导用户到新地址登录（旧 host 的会话不再适用）
		sendHtml(
			res,
			200,
			`<!doctype html><meta charset="utf-8"><title>dsh-vps · 设置完成</title>
<body style="background:#0b0e14;color:#dbe2ea;font:15px system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="max-width:420px;padding:32px;border:1px solid #1f2733;border-radius:12px;background:#11161f">
<h2 style="margin-top:0">设置完成</h2>
<p>请在新地址打开并登录：</p>
<p><a href="https://${esc(domain)}/" style="color:#60a5fa">https://${esc(domain)}/</a></p>
<p style="color:#7d8a9c;font-size:13px">证书签发需要几十秒；若暂不可访问请稍候重试。</p>
</div></body>`,
		);
		return;
	}
	res.writeHead(303, { location: "/login", "cache-control": "no-store" });
	res.end();
}

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
function handleSelfcheckGuarded(req, res) {
	const ip = req.socket.remoteAddress || "";
	const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
	if (!loopback) {
		sendText(res, 403, "forbidden");
		return;
	}
	return handleSelfcheck(req, res);
}

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
				if (pathname === "/login") return handleLogin(req, res);
				if (pathname === "/logout") return handleLogout(req, res);
				if (pathname === "/gate/health") return handleHealth(req, res);
				if (pathname === "/gate/selfcheck") return handleSelfcheckGuarded(req, res);
				if (pathname === "/setup") return handleSetup(req, res);
				if (!loadAdmin()) {
					// 尚未完成初始设置：浏览器导航导向导，/api 保持 401
					if (pathname.startsWith("/api")) {
						sendText(res, 401, "gate not configured");
						return;
					}
					if (setupOpen()) {
						res.writeHead(303, { location: "/setup", "cache-control": "no-store" });
						res.end();
						return;
					}
					sendText(res, 503, "gate not configured: admin account missing (run `dsh-vps reset-admin`)");
					return;
				}
				if (!sessionUser(req)) {
					denyUnauthenticated(req, res, pathname);
					return;
				}
				if (TAKEOVER_RESTART && MARKET_RESTART_PATHS.has(pathname)) return handleMarketRestart(req, res);
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

	// DSH Cookie 续期：剩余有效期 < 24h 时用同一 launchToken 重新兑换
	setInterval(() => {
		if (dsh.cookie && dsh.cookie.expiresAt - Date.now() < 24 * 3_600_000) {
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
