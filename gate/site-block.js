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
const net = require("node:net");
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
/** 站点地址是否为裸 IP：公网 CA 不给 IP 签证书（至少不稳定），只能由 Caddy 内置 CA 签。 */
function isIpHost(host) {
	return net.isIP(String(host).replace(/^\[|\]$/g, "")) !== 0;
}

function caddySiteBlock(host, opts = {}) {
	const port = opts.gatePort || DEFAULT_GATE_PORT;
	const vpn = opts.vpn || { on: false, subnet: DEFAULT_SUBNET };
	// IP 站点：浏览器按 IP 访问时不发 SNI，Caddy 会退而按本机网卡地址找证书；
	// 云主机网卡上多是内网地址（公网 IP 经 NAT），于是找不到证书、握手失败。
	// default_sni 让无 SNI 的连接按公网 IP 选证书。本文件被主 Caddyfile 第一行 import，
	// 全局选项块因此仍位于配置开头，合法。
	const ip = isIpHost(host);
	const globals = ip ? `{\n\tdefault_sni ${host}\n}\n\n` : "";
	const tls = ip ? "\ttls internal\n" : "";
	if (!vpn.on) return `${globals}${host} {\n${tls}${proxyLines(port, "\t")}}\n`;
	// 隧道模式：非隧道来源直接断连，连响应体都不给。
	// ACME HTTP-01 挑战由 Caddy 在路由之前处理（fall-through），不受本块影响，证书照常续期。
	return (
		globals +
		`${host} {\n` +
		tls +
		`\t@tunnel remote_ip ${vpn.subnet}\n` +
		`\thandle @tunnel {\n` +
		proxyLines(port, "\t\t") +
		`\t}\n` +
		`\thandle {\n\t\tabort\n\t}\n` +
		`}\n`
	);
}

module.exports = { caddySiteBlock, readVpnEnv, isIpHost, DEFAULT_SUBNET, DEFAULT_GATE_PORT };

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
