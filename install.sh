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
# 说明：仓库已公开，curl 管道模式可直接拉取 gate 代码；若在克隆目录内运行则优先用本地文件。

set -euo pipefail

## region: 常量与参数

DSH_VERSION="0.1.5-rc.2" # 钉住版本（设计文档 §10 已验证版本表，勿随意改）
# 只钉顶层包版本是不够的：DSH 各子包的依赖是 ^0.1.5-rc.2 这类浮动范围，上游一发新的
# 预发布波次，解析结果就整体漂上去。2026-09-22 上游发了 0.1.5-rc.3 波次，但漏发了
# dsh-client-ui-sidebar-documentpreview，于是 ETARGET 装不上。用 --before 把解析冻结在
# 验证通过的那个时间点之前，装到的就是验证过的那棵树。升级 DSH_VERSION 时同步推后这个值。
# 注意：同一天 03:46 上游还先发了一批 cordis 系列（cordis 4.0.3 / cordis-plugin-hmr 1.0.18 等），
# 与 rc.2 不兼容——web profile 启动即报 "user patch-layer watching requires the Cordis HMR service"。
# 冻结点必须早于这一批，所以是 03:40 而不是 05:00。
# 设为 none 可关闭冻结。
DSH_RESOLVE_BEFORE="${DSH_RESOLVE_BEFORE:-2026-09-22T03:40:00Z}"
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
trap 'warn "安装失败（行 ${LINENO}），可用 journalctl -u dsh-gate -n 50 排查服务问题"' ERR

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
		log "检测到已有安装（${INSTALL_ROOT}），进入修复/更新模式（保留 state/）"
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
	log "下载 Node.js: ${pkg}（npmmirror）"
	curl -fsSL --retry 2 -o "/tmp/$pkg" "https://registry.npmmirror.com/-/binary/node/latest-v22.x/$pkg"
	(cd /tmp && curl -fsSL "https://registry.npmmirror.com/-/binary/node/latest-v22.x/SHASUMS256.txt" \
		| grep "${pkg}\$" | sha256sum -c - >/dev/null) || die "Node 包 sha256 校验失败"
	tar -xJf "/tmp/$pkg" -C /usr/local --strip-components=1
	rm -f "/tmp/$pkg"
	hash -r
}

step2_node() {
	log "步骤 2/9：Node.js 22 + pnpm"
	local major
	major=$(node --version 2>/dev/null | sed -n 's/^v\{0,1\}\([0-9]\{1,\}\).*/\1/p' || true)
	if [[ "${major:-0}" -ge 22 ]]; then
		log "已安装 Node $(node --version)，跳过"
	else
		apt-get update -y >/dev/null
		if [[ "$MIRROR" == "cn" ]]; then install_node_cn; else install_node_nodesource; fi
		major=$(node --version | sed -n 's/^v\{0,1\}\([0-9]\{1,\}\).*/\1/p')
		[[ "${major:-0}" -ge 22 ]] || die "Node.js 22 安装失败"
		log "Node $(node --version) 安装完成"
	fi

	# pnpm：`dsh plugin` 管理插件依赖的包管理器（/setup 向导可选安装插件需要）
	if ! command -v pnpm >/dev/null 2>&1; then
		log "安装 pnpm（插件管理需要）"
		if [[ "$MIRROR" == "cn" ]]; then
			npm install -g pnpm --registry=https://registry.npmmirror.com >/dev/null 2>&1 \
				|| npm install -g pnpm >/dev/null 2>&1 || true
		else
			npm install -g pnpm >/dev/null 2>&1 || true
		fi
	fi
	command -v pnpm >/dev/null 2>&1 || warn "pnpm 未安装，插件安装功能不可用（可稍后 npm i -g pnpm）"
}

## endregion

## region: 步骤 3：DSH 版本化安装

step3_dsh() {
	log "步骤 3/9：DeepSeek Harness ${DSH_VERSION}（版本化安装）"
	local prefix="$INSTALL_ROOT/dsh/$DSH_VERSION"
	local bin="$prefix/node_modules/@deepseek-ai/dsh/lib/bin.js"
	if [[ -f "$bin" ]]; then
		log "DSH $DSH_VERSION 已安装，跳过"
	else
		mkdir -p "$prefix"
		# 数组恒不为空：bash 3.2 在 set -u 下展开空数组会报 unbound variable
		local args=(--no-audit --no-fund --loglevel=error)
		[[ "$MIRROR" == "cn" ]] && args+=(--registry=https://registry.npmmirror.com)
		local frozen=1
		[[ "$DSH_RESOLVE_BEFORE" == "none" ]] && frozen=0
		[[ $frozen -eq 1 ]] && args+=(--before="$DSH_RESOLVE_BEFORE")
		if ! npm install --prefix "$prefix" "${args[@]}" "@deepseek-ai/dsh@$DSH_VERSION"; then
			# 冻结解析本身失败（例如镜像源不带发布时间戳）时退化为不冻结，
			# 宁可装到未验证的新预发布版，也别让安装卡死在这一步。
			if [[ $frozen -eq 1 ]]; then
				warn "按时间点冻结解析失败，改为不冻结重试（可能装到未验证的新版本）"
				local args2=(--no-audit --no-fund --loglevel=error)
				[[ "$MIRROR" == "cn" ]] && args2+=(--registry=https://registry.npmmirror.com)
				npm install --prefix "$prefix" "${args2[@]}" "@deepseek-ai/dsh@$DSH_VERSION"
			fi
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

# 一次性启动令牌：初始向导在安装结束到用户首次打开浏览器之间是全网可达的，
# 谁先提交谁就是管理员。令牌写进 state/setup.token，向导提交成功后由 gate 删除。
generate_setup_token() {
	SETUP_TOKEN=""
	[[ -f "$INSTALL_ROOT/state/setup.lock" ]] && return 0
	local tok
	tok=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
	if [[ ${#tok} -lt 24 ]]; then
		warn "启动令牌生成失败，向导将不校验令牌"
		return 0
	fi
	printf '%s' "$tok" >"$INSTALL_ROOT/state/setup.token"
	chown "$DSH_USER" "$INSTALL_ROOT/state/setup.token" 2>/dev/null || true
	chmod 600 "$INSTALL_ROOT/state/setup.token"
	SETUP_TOKEN="$tok"
	log "已生成一次性启动令牌"
}

step5_gate() {
	log "步骤 5/9：dsh-gate"
	mkdir -p "$INSTALL_ROOT/gate" "$INSTALL_ROOT/bin"
	fetch_file gate/server.js "$INSTALL_ROOT/gate/server.js"
	node --check "$INSTALL_ROOT/gate/server.js" || die "gate/server.js 语法检查失败"
	fetch_file gate/site-block.js "$INSTALL_ROOT/gate/site-block.js"
	node --check "$INSTALL_ROOT/gate/site-block.js" || die "gate/site-block.js 语法检查失败"
	fetch_file bin/dsh-vps "$INSTALL_ROOT/bin/dsh-vps"
	chmod 755 "$INSTALL_ROOT/bin/dsh-vps"
	bash -n "$INSTALL_ROOT/bin/dsh-vps" || die "bin/dsh-vps 语法检查失败"
	ln -sfn "$INSTALL_ROOT/bin/dsh-vps" /usr/local/bin/dsh-vps
	# 公网域名下浏览器判定 isLoopback=false，设置页会报"设置在此浏览器中不可用"。
	# 直接写前端静态文件解除该判定（DSH 每次响应都重读该文件，无需重启）。
	dsh-vps ownshost on || warn "ownsHost 补丁未生效，稍后可手动运行: sudo dsh-vps ownshost on"
	mkdir -p "$INSTALL_ROOT/state"
	chmod 700 "$INSTALL_ROOT/state"
	generate_setup_token
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

	# 站点块：有域名写域名块（自动 HTTPS），无则按公网 IP 写站点、Caddy 内置 CA 自签过渡
	# 属主 dsh（向导重写）、组 caddy（Caddy 读取）、640
	# 站点块由 gate/site-block.js 生成：install.sh 写初始块、gate 改域名、dsh-vps vpn
	# 切换访问策略，三处共用同一份模板。重装时若 state/vpn.env 还开着隧道模式，
	# 这里会直接沿用「仅隧道可访问」，不会把已经关上的门重新敞开。
	local site="$TRUSTED_HOST"
	node "$INSTALL_ROOT/gate/site-block.js" "$site" "$INSTALL_ROOT" "$GATE_PORT" \
		>/etc/caddy/dsh-site.conf || die "生成站点块失败"
	chown "$DSH_USER":caddy /etc/caddy/dsh-site.conf
	chmod 640 /etc/caddy/dsh-site.conf

	systemctl enable --now caddy >/dev/null 2>&1 || true
	systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy
	log "Caddyfile 已生效（站点：${site}）"
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

# 访问地址（= DSH --trusted-host = Caddy 站点地址）必须在写站点块之前确定：
# 域名优先；重装且未传 --domain 时沿用已有配置（含向导改过的域名）；最后回退公网 IP。
TRUSTED_HOST=""
CFG_DOMAIN=""
resolve_trusted_host() {
	TRUSTED_HOST="${DOMAIN:-}"
	local existing_domain=""
	if [[ -z "$TRUSTED_HOST" && $REINSTALL -eq 1 ]]; then
		if [[ -f "$INSTALL_ROOT/state/gate.env" ]]; then
			TRUSTED_HOST=$(sed -n 's/^DSH_TRUSTED_HOST=//p' "$INSTALL_ROOT/state/gate.env" | tail -1)
		fi
		if [[ -f "$INSTALL_ROOT/state/config.json" ]]; then
			existing_domain=$(sed -n 's/.*"domain": *"\([^"]*\)".*/\1/p' "$INSTALL_ROOT/state/config.json" | tail -1)
		fi
	fi
	if [[ -z "$TRUSTED_HOST" ]]; then
		TRUSTED_HOST=$(detect_public_ip)
	fi
	CFG_DOMAIN="${DOMAIN:-$existing_domain}"
}

step7_systemd() {
	log "步骤 7/9：systemd 服务"
	mkdir -p "$INSTALL_ROOT/state" "$INSTALL_ROOT/backups"

	local trusted="$TRUSTED_HOST"
	local cfg_domain="$CFG_DOMAIN"

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
	log "dsh-gate.service 已启动（DSH_TRUSTED_HOST=${trusted}）"
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
	local body healthy=1
	body=$(wait_gate_health) || {
		warn "gate 未就绪，请查看: journalctl -u dsh-gate -n 50"
		die "健康检查失败（gate）"
	}
	# 等待 DSH 子进程启动 + launchToken 兑换完成（冷启动需要几秒到几十秒，小内存机器更久）
	local i
	for i in $(seq 1 60); do
		body=$(curl -fsS --max-time 3 "http://127.0.0.1:$GATE_PORT/gate/health" 2>/dev/null) || true
		if printf '%s' "$body" | grep -q '"launchTokenCaptured":true' \
			&& printf '%s' "$body" | grep -q '"dshCookie":{"authority"'; then
			log "gate 正常，DSH 会话兑换成功"
			break
		fi
		if [[ $i -eq 60 ]]; then
			# 不在这里退出：令牌链接只在下面打印，退出了用户就只剩"缺少令牌"页
			healthy=0
			warn "DSH 会话兑换超时（DSH 可能仍在启动，或启动失败）"
			local err
			err=$(printf '%s' "$body" | sed -n 's/.*"lastError":"\([^"]*\)".*/\1/p')
			[[ -n "$err" ]] && warn "最近错误: $err"
			warn "排查: journalctl -u dsh-gate -n 80 --no-pager"
			break
		fi
		sleep 2
	done

	local url="https://$TRUSTED_HOST"
	local open_url="$url"
	[[ -n "$SETUP_TOKEN" ]] && open_url="$url/setup?token=$SETUP_TOKEN"

	echo
	echo "============================================================"
	if [[ $healthy -eq 1 ]]; then
		echo " dsh-vps 安装完成"
	else
		echo " dsh-vps 已安装，但 DSH 尚未就绪（见上方警告；页面会显示启动进度与错误）"
	fi
	echo "------------------------------------------------------------"
	echo " DSH 版本  : ${DSH_VERSION}（钉住）"
	echo " 访问地址  : $open_url"
	if [[ -n "$SETUP_TOKEN" ]]; then
		echo "             （初始设置需要上面的一次性令牌，别用不带令牌的地址）"
	elif [[ -z "$DOMAIN" ]]; then
		echo "             （未传 --domain，当前为自签证书过渡，浏览器会提示证书不受信任；域名可稍后在向导中填写）"
	fi
	echo " 服务/日志 : systemctl status dsh-gate | journalctl -u dsh-gate -f"
	echo " 管理命令  : dsh-vps status | restart | upgrade | rollback | reset-admin | setup-url | backup"
	echo " 仅我可访问: dsh-vps vpn setup（隧道）| dsh-vps tunnel（SSH 转发，零安装）"
	echo "------------------------------------------------------------"
	echo " 下一步："
	echo " 1. 若使用域名，请先将 A 记录解析到本机（Caddy 会自动签发证书）"
	echo " 2. 浏览器打开上面的访问地址，进入初始设置向导"
	echo " 3. 填写管理员用户名/密码（+ 可选域名、DeepSeek API Key）→ 登录"
	echo " 4. 可选：sudo dsh-vps vpn setup —— 之后公网访问不到登录页，只有隧道内的设备能进"
	if [[ -n "$SETUP_TOKEN" ]]; then
		echo
		echo " 令牌只此一份，链接丢了随时重取：sudo dsh-vps setup-url"
	fi
	echo "============================================================"
}

## endregion

step1_prechecks
step2_node
step3_dsh
step4_user
step5_gate
resolve_trusted_host
step6_caddy
step7_systemd
step8_firewall
step9_verify
