#!/usr/bin/env node
"use strict";

/*
 * Caddy 站点块的唯一模板。
 *
 * 三处共用同一份，任何改动只改这里：
 *   - install.sh        首次写入 /etc/caddy/dsh-site.conf
 *   - gate/server.js    浏览器向导改域名时重写
 *   - bin/dsh-vps       vpn on/off 切换访问策略
 *
 * 隧道模式（state/vpn.env 里 DSHVPS_VPN=on）：Caddy 只放行隧道网段，其余来源 abort。
 * 为什么不用公网出口 IP 白名单：出口 IP 不是身份，换网络 / 宽带重拨就变，会把使用者
 * 自己关在门外。隧道 IP 由我们自己分配（WireGuard），永不变化。
 *
 * CLI: node site-block.js <host> [installRoot] [gatePort]
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SUBNET = "10.7.0.0/24";
const DEFAULT_GATE_PORT = 3100;

/** 读 state/vpn.env → { on, subnet }。文件不存在即未启用隧道。 */
function readVpnEnv(stateDir) {
	const out = { on: false, subnet: DEFAULT_SUBNET };
	try {
		const txt = fs.readFileSync(path.join(stateDir, "vpn.env"), "utf8");
		if (/^\s*DSHVPS_VPN\s*=\s*on\s*$/m.test(txt)) out.on = true;
		const m = txt.match(/^\s*DSHVPS_VPN_SUBNET\s*=\s*(\S+)\s*$/m);
		if (m) out.subnet = m[1];
	} catch {
		/* 未启用隧道 */
	}
	return out;
}

function proxyLines(port, indent) {
	return (
		`${indent}reverse_proxy 127.0.0.1:${port} {\n` +
		// 只信 Caddy 自己看到的对端地址：显式覆盖，客户端伪造的 X-Forwarded-For 一律作废。
		// gate 的登录限流与审计日志都读这个头，能被伪造就等于把限流关掉。
		`${indent}\theader_up X-Forwarded-For {remote_host}\n` +
		`${indent}}\n`
	);
}

/**
 * @param {string} host 站点地址（域名 / IP / :443）
 * @param {{gatePort?: number, vpn?: {on: boolean, subnet: string}}} opts
 */
function caddySiteBlock(host, opts = {}) {
	const port = opts.gatePort || DEFAULT_GATE_PORT;
	const vpn = opts.vpn || { on: false, subnet: DEFAULT_SUBNET };
	if (!vpn.on) return `${host} {\n${proxyLines(port, "\t")}}\n`;
	// 隧道模式：非隧道来源直接断连，连响应体都不给。
	// ACME HTTP-01 挑战由 Caddy 在路由之前处理（fall-through），不受本块影响，证书照常续期。
	return (
		`${host} {\n` +
		`\t@tunnel remote_ip ${vpn.subnet}\n` +
		`\thandle @tunnel {\n` +
		proxyLines(port, "\t\t") +
		`\t}\n` +
		`\thandle {\n\t\tabort\n\t}\n` +
		`}\n`
	);
}

module.exports = { caddySiteBlock, readVpnEnv, DEFAULT_SUBNET, DEFAULT_GATE_PORT };

if (require.main === module) {
	const host = process.argv[2];
	const root = process.argv[3] || process.env.GATE_HOME || "/opt/dsh-vps";
	const gatePort = Number(process.argv[4] || process.env.GATE_PORT || DEFAULT_GATE_PORT);
	if (!host) {
		console.error("用法: node site-block.js <host> [installRoot] [gatePort]");
		process.exit(2);
	}
	process.stdout.write(caddySiteBlock(host, { gatePort, vpn: readVpnEnv(path.join(root, "state")) }));
}
