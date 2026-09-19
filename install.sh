#!/usr/bin/env bash
# dsh-vps 一键安装脚本（M2）
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/install.sh \
#     | sudo bash -s -- --domain dsh.example.com
#   # 或在仓库克隆目录内：
#   sudo bash install.sh --domain dsh.example.com [--mirror cn]
#
# 目标 OS：Ubuntu 22.04+ / Debian 12+（裸机，无 Docker）
# 设计依据：dsh-vps-architecture-design.md §4.1 / §4.3 / §4.4 / §5 / §10
#
# 说明：仓库未发布时 curl 管道模式无法拉取 gate 代码，请在克隆目录内直接运行。

set -euo pipefail

## region: 常量与参数

DSH_VERSION="0.1.5-rc.2" # 钉住版本（设计文档 §10 已验证版本表，勿随意改）
INSTALL_ROOT="/opt/dsh-vps"
DSH_USER="dsh"
DSH_HOME_DIR="/home/dsh/.dsh"
GATE_PORT=3100
DSH_PORT=3080
# gate/unit/caddy 模板来源：优先脚本同目录（仓库克隆），否则从 raw 地址下载
RAW_BASE="${DSHVPS_RAW_BASE:-https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main}"

DOMAIN=""
MIRROR=""

log()  { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
dsh-vps 安装脚本
用法: sudo bash install.sh [--domain <域名>] [--mirror cn]
  --domain <域名>   访问域名（需已解析到本机）。不传则以公网 IP + 自签证书过渡
  --mirror cn       国内镜像：Node 走 npmmirror 二进制，DSH 走 npmmirror registry
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--domain) DOMAIN="${2:?--domain 需要一个值}"; shift 2 ;;
	--mirror) MIRROR="${2:?--mirror 需要一个值}"; shift 2 ;;
	-h | --help) usage; exit 0 ;;
	*) die "未知参数: $1（--help 查看用法）" ;;
	esac
done

[[ "$MIRROR" == "" || "$MIRROR" == "cn" ]] || die "--mirror 目前仅支持 cn"
if [[ -n "$DOMAIN" ]]; then
	[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
		|| die "域名格式不合法: $DOMAIN"
fi

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
	SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi

# 取仓库文件：本地克隆优先，否则走 RAW_BASE
fetch_file() { # $1=仓库内相对路径 $2=目标路径
	local rel="$1" dst="$2"
	if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/$rel" ]]; then
		install -m 644 "$SCRIPT_DIR/$rel" "$dst"
	else
		curl -fsSL "$RAW_BASE/$rel" -o "$dst" \
			|| die "下载 $rel 失败（仓库未发布时请在克隆目录内运行本脚本）"
	fi
}

export DEBIAN_FRONTEND=noninteractive
trap 'warn "安装失败（行 $LINENO），可用 journalctl -u dsh-gate -n 50 排查服务问题"' ERR

## endregion

## region: 步骤 1：前置检查

REINSTALL=0

step1_prechecks() {
	log "步骤 1/9：前置检查"
	[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo bash install.sh ...）"
	command -v curl >/dev/null 2>&1 || { apt-get update -y >/dev/null; apt-get install -y curl ca-certificates >/dev/null; }

	# OS 检查
	. /etc/os-release
	local ok=0
	case "${ID:-}" in
	ubuntu) awk -v v="${VERSION_ID:-0}" 'BEGIN{exit !(v>=22.04)}' && ok=1 ;;
	debian) awk -v v="${VERSION_ID:-0}" 'BEGIN{exit !(v>=12)}' && ok=1 ;;
	esac
	[[ $ok -eq 1 ]] || die "不支持的发行版: ${ID:-unknown} ${VERSION_ID:-}（目标：Ubuntu 22.04+ / Debian 12+）"

	# glibc 检查（Ubuntu 22.04=2.35 / Debian 12=2.36，正常必然通过，仅告警）
	local glibc
	glibc=$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+$' || echo 0)
	awk -v v="$glibc" 'BEGIN{exit !(v>=2.28)}' || warn "glibc $glibc < 2.28，DSH 可能无法运行"

	# 内存检查（< 1.5G 仅告警）
	local mem_kb
	mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)
	[[ "$mem_kb" -lt 1572864 ]] && warn "内存 $((mem_kb / 1024))MB 低于建议的 1.5GB，体验可能不稳定"

	# 幂等判定：已有安装则进入修复/更新模式（不碰 state/ 内的凭据与 setup.lock）
	[[ -f "$INSTALL_ROOT/state/config.json" ]] && REINSTALL=1

	# 端口检查（重装时本机服务已占用这些端口，跳过）
	if [[ $REINSTALL -eq 0 ]]; then
		local p
		for p in 80 443 "$DSH_PORT" "$GATE_PORT"; do
			if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$"; then
				die "端口 $p 已被占用，请先释放（重装场景请保留 $INSTALL_ROOT 后重跑）"
			fi
		done
	else
		log "检测到已有安装（$INSTALL_ROOT），进入修复/更新模式（保留 state/）"
	fi
}

## endregion

## region: 步骤 2：Node.js 22

install_node_nodesource() {
	curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
	bash /tmp/nodesource_setup.sh >/dev/null
	apt-get install -y nodejs >/dev/null
}

install_node_cn() {
	# npmmirror 二进制镜像：取 latest-v22.x 目录中最新的 linux-x64 包并校验 sha256
	local list pkg
	list=$(curl -fsSL --max-time 30 "https://registry.npmmirror.com/-/binary/node/latest-v22.x/")
	pkg=$(printf '%s' "$list" | grep -o 'node-v22[0-9.]*-linux-x64\.tar\.xz' | sort -Vu | tail -1)
	[[ -n "$pkg" ]] || die "无法从 npmmirror 获取 Node 22 版本号"
	log "下载 Node.js: $pkg（npmmirror）"
	curl -fsSL --retry 2 -o "/tmp/$pkg" "https://registry.npmmirror.com/-/binary/node/latest-v22.x/$pkg"
	(cd /tmp && curl -fsSL "https://registry.npmmirror.com/-/binary/node/latest-v22.x/SHASUMS256.txt" \
		| grep "${pkg}\$" | sha256sum -c - >/dev/null) || die "Node 包 sha256 校验失败"
	tar -xJf "/tmp/$pkg" -C /usr/local --strip-components=1
	rm -f "/tmp/$pkg"
	hash -r
}

step2_node() {
	log "步骤 2/9：Node.js 22"
	local major
	major=$(node --version 2>/dev/null | sed -n 's/^v\{0,1\}\([0-9]\{1,\}\).*/\1/p' || true)
	if [[ "${major:-0}" -ge 22 ]]; then
		log "已安装 Node $(node --version)，跳过"
		return
	fi
	apt-get update -y >/dev/null
	if [[ "$MIRROR" == "cn" ]]; then install_node_cn; else install_node_nodesource; fi
	major=$(node --version | sed -n 's/^v\{0,1\}\([0-9]\{1,\}\).*/\1/p')
	[[ "${major:-0}" -ge 22 ]] || die "Node.js 22 安装失败"
	log "Node $(node --version) 安装完成"
}

## endregion

## region: 步骤 3：DSH 版本化安装

step3_dsh() {
	log "步骤 3/9：DeepSeek Harness $DSH_VERSION（版本化安装）"
	local prefix="$INSTALL_ROOT/dsh/$DSH_VERSION"
	local bin="$prefix/node_modules/@deepseek-ai/dsh/lib/bin.js"
	if [[ -f "$bin" ]]; then
		log "DSH $DSH_VERSION 已安装，跳过"
	else
		mkdir -p "$prefix"
		if [[ "$MIRROR" == "cn" ]]; then
			npm install --prefix "$prefix" --registry=https://registry.npmmirror.com \
				--no-audit --no-fund --loglevel=error "@deepseek-ai/dsh@$DSH_VERSION"
		else
			npm install --prefix "$prefix" \
				--no-audit --no-fund --loglevel=error "@deepseek-ai/dsh@$DSH_VERSION"
		fi
		[[ -f "$bin" ]] || die "DSH 安装产物缺失: $bin"
	fi
	ln -sfn "$DSH_VERSION" "$INSTALL_ROOT/dsh/current"
}

## endregion

## region: 步骤 4：运行身份

step4_user() {
	log "步骤 4/9：系统用户 $DSH_USER"
	if ! id "$DSH_USER" >/dev/null 2>&1; then
		useradd --system --shell /usr/sbin/nologin --home-dir /home/dsh --create-home "$DSH_USER"
	fi
	mkdir -p "$DSH_HOME_DIR"
	chown -R "$DSH_USER" "$DSH_HOME_DIR"
	chmod 700 "$DSH_HOME_DIR"
}

## endregion

## region: 步骤 5：dsh-gate 代码

step5_gate() {
	log "步骤 5/9：dsh-gate"
	mkdir -p "$INSTALL_ROOT/gate" "$INSTALL_ROOT/bin"
	fetch_file gate/server.js "$INSTALL_ROOT/gate/server.js"
	node --check "$INSTALL_ROOT/gate/server.js" || die "gate/server.js 语法检查失败"
	fetch_file bin/dsh-vps "$INSTALL_ROOT/bin/dsh-vps"
	chmod 755 "$INSTALL_ROOT/bin/dsh-vps"
	bash -n "$INSTALL_ROOT/bin/dsh-vps" || die "bin/dsh-vps 语法检查失败"
	ln -sfn "$INSTALL_ROOT/bin/dsh-vps" /usr/local/bin/dsh-vps
}

## endregion

## region: 步骤 6：Caddy

step6_caddy() {
	log "步骤 6/9：Caddy"
	if ! command -v caddy >/dev/null 2>&1; then
		apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gpg >/dev/null
		curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
			| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
		curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
			>/etc/apt/sources.list.d/caddy-stable.list
		apt-get update -y >/dev/null
		apt-get install -y caddy >/dev/null
	fi

	# 主 Caddyfile（静态，import 站点文件）+ 站点文件（向导改域名时由 gate 重写）
	fetch_file caddy/Caddyfile.template /tmp/Caddyfile.dshvps
	if [[ -f /etc/caddy/Caddyfile ]] && ! cmp -s /etc/caddy/Caddyfile /tmp/Caddyfile.dshvps; then
		cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
	fi
	install -m 644 /tmp/Caddyfile.dshvps /etc/caddy/Caddyfile

	# 站点块：有域名写域名块（自动 HTTPS），无则 :443 内部自签过渡
	# 属主 dsh（向导重写）、组 caddy（Caddy 读取）、640
	local site="${DOMAIN:-:443}"
	cat >/etc/caddy/dsh-site.conf <<EOF
${site} {
	reverse_proxy 127.0.0.1:$GATE_PORT
}
EOF
	chown "$DSH_USER":caddy /etc/caddy/dsh-site.conf
	chmod 640 /etc/caddy/dsh-site.conf

	systemctl enable --now caddy >/dev/null 2>&1 || true
	systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy
	log "Caddyfile 已生效（站点：$site）"
}

## endregion

## region: 步骤 7：systemd + gate.env + config.json

detect_public_ip() {
	local ip url
	for url in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
		ip=$(curl -4 -fsSL --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]') || continue
		if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
			printf '%s' "$ip"
			return 0
		fi
	done
	ip=$(hostname -I 2>/dev/null | awk '{print $1}')
	[[ -n "$ip" ]] || die "无法探测公网 IP，请显式传 --domain"
	printf '%s' "$ip"
}

step7_systemd() {
	log "步骤 7/9：systemd 服务"
	mkdir -p "$INSTALL_ROOT/state" "$INSTALL_ROOT/backups"

	# --trusted-host 取值：域名优先；重装且未传 --domain 时保留已有配置（幂等，不破坏向导设置）；最后回退公网 IP
	local trusted="${DOMAIN:-}"
	local existing_domain=""
	if [[ -z "$trusted" && $REINSTALL -eq 1 ]]; then
		if [[ -f "$INSTALL_ROOT/state/gate.env" ]]; then
			trusted=$(sed -n 's/^DSH_TRUSTED_HOST=//p' "$INSTALL_ROOT/state/gate.env" | tail -1)
		fi
		if [[ -f "$INSTALL_ROOT/state/config.json" ]]; then
			existing_domain=$(sed -n 's/.*"domain": *"\([^"]*\)".*/\1/p' "$INSTALL_ROOT/state/config.json" | tail -1)
		fi
	fi
	[[ -n "$trusted" ]] || trusted=$(detect_public_ip)
	local cfg_domain="${DOMAIN:-$existing_domain}"

	# gate.env：集中管理运行环境变量（0600 属主 dsh，M3 向导改域名后重写并 restart 即可）
	cat >"$INSTALL_ROOT/state/gate.env" <<EOF
GATE_HOME=$INSTALL_ROOT
DSH_BIN=$INSTALL_ROOT/dsh/current/node_modules/@deepseek-ai/dsh/lib/bin.js
DSH_HOME=$DSH_HOME_DIR
DSH_TRUSTED_HOST=$trusted
EOF
	chmod 600 "$INSTALL_ROOT/state/gate.env"
	chown "$DSH_USER" "$INSTALL_ROOT/state/gate.env"

	# config.json：安装元数据
	cat >"$INSTALL_ROOT/state/config.json" <<EOF
{
  "dshVersion": "$DSH_VERSION",
  "domain": "$cfg_domain",
  "trustedHost": "$trusted",
  "gatePort": $GATE_PORT,
  "dshPort": $DSH_PORT,
  "mirror": "${MIRROR:-default}",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
	chmod 600 "$INSTALL_ROOT/state/config.json"
	chown "$DSH_USER" "$INSTALL_ROOT/state/config.json"
	chown "$DSH_USER" "$INSTALL_ROOT/state" "$INSTALL_ROOT/backups"
	chmod 700 "$INSTALL_ROOT/state"

	# systemd unit（模板替换 node 路径）
	local node_bin
	node_bin=$(command -v node)
	fetch_file units/dsh-gate.service /tmp/dsh-gate.service.tpl
	sed "s|__NODE_BIN__|${node_bin}|" /tmp/dsh-gate.service.tpl >/etc/systemd/system/dsh-gate.service
	systemctl daemon-reload
	systemctl enable dsh-gate >/dev/null 2>&1
	systemctl restart dsh-gate
	log "dsh-gate.service 已启动（DSH_TRUSTED_HOST=$trusted）"
}

## endregion

## region: 步骤 8：防火墙

step8_firewall() {
	log "步骤 8/9：防火墙"
	if command -v ufw >/dev/null 2>&1; then
		ufw allow 22/tcp >/dev/null
		ufw allow 80/tcp >/dev/null
		ufw allow 443/tcp >/dev/null
		log "ufw 已放行 22/80/443"
	else
		log "未检测到 ufw，跳过（请自行确认云厂商安全组放行 80/443）"
	fi
}

## endregion

## region: 步骤 9：健康自检 + 完成输出

wait_gate_health() {
	local i body
	for i in $(seq 1 30); do
		body=$(curl -fsS --max-time 3 "http://127.0.0.1:$GATE_PORT/gate/health" 2>/dev/null) || { sleep 2; continue; }
		if printf '%s' "$body" | grep -q '"gate":"ok"'; then
			printf '%s' "$body"
			return 0
		fi
		sleep 2
	done
	return 1
}

step9_verify() {
	log "步骤 9/9：健康自检"
	local body
	body=$(wait_gate_health) || {
		warn "gate 未就绪，请查看: journalctl -u dsh-gate -n 50"
		die "健康检查失败（gate）"
	}
	# 等待 DSH 子进程启动 + launchToken 兑换完成（冷启动需要几秒到几十秒）
	local i
	for i in $(seq 1 30); do
		body=$(curl -fsS --max-time 3 "http://127.0.0.1:$GATE_PORT/gate/health" 2>/dev/null) || true
		if printf '%s' "$body" | grep -q '"launchTokenCaptured":true' \
			&& printf '%s' "$body" | grep -q '"dshCookie":{"authority"'; then
			log "gate 正常，DSH 会话兑换成功"
			break
		fi
		[[ $i -eq 30 ]] && {
			warn "DSH 会话兑换超时，请查看: journalctl -u dsh-gate -n 50"
			die "健康检查失败（DSH cookie 兑换）"
		}
		sleep 2
	done

	local url
	if [[ -n "$DOMAIN" ]]; then
		url="https://$DOMAIN"
	else
		url="https://$(detect_public_ip)"
	fi

	echo
	echo "============================================================"
	echo " dsh-vps 安装完成"
	echo "------------------------------------------------------------"
	echo " DSH 版本  : $DSH_VERSION（钉住）"
	echo " 访问地址  : $url"
	if [[ -z "$DOMAIN" ]]; then
		echo "             （未传 --domain，当前为自签证书过渡；域名可稍后在浏览器向导中填写）"
	fi
	echo " 服务/日志 : systemctl status dsh-gate | journalctl -u dsh-gate -f"
	echo " 管理命令  : dsh-vps status | restart | upgrade | rollback | reset-admin | backup"
	echo "------------------------------------------------------------"
	echo " 下一步："
	echo " 1. 若使用域名，请先将 A 记录解析到本机（Caddy 会自动签发证书）"
	echo " 2. 浏览器打开访问地址，自动进入初始设置向导"
	echo " 3. 填写管理员用户名/密码（+ 可选域名、DeepSeek API Key）→ 登录"
	echo "============================================================"
}

## endregion

step1_prechecks
step2_node
step3_dsh
step4_user
step5_gate
step6_caddy
step7_systemd
step8_firewall
step9_verify
