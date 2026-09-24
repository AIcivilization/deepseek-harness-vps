#!/usr/bin/env bash
# dsh-vps 卸载脚本
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/uninstall.sh \
#     | sudo bash -s -- --yes
#   # 或在仓库克隆目录内：
#   sudo bash uninstall.sh [--yes] [--keep-data] [--purge-caddy]
#
# 目标 OS：Ubuntu 22.04+ / Debian 12+
#
# 顺序：备份 → 停服务 → 移除 unit 与安装目录 → 移除 Caddy 站点块 → 清 DSH 数据目录。
# 任何一步失败都会就地停下（set -euo pipefail），不做半吊子清理。

set -euo pipefail

## region: 常量与参数

INSTALL_ROOT="/opt/dsh-vps"
DSH_USER="dsh"
DSH_HOME_DIR="/home/dsh/.dsh"
SERVICE="dsh-gate"
UNIT_FILE="/etc/systemd/system/dsh-gate.service"
CADDY_SITE_FILE="/etc/caddy/dsh-site.conf"
CADDYFILE="/etc/caddy/Caddyfile"

ASSUME_YES=0
KEEP_DATA=0
PURGE_CADDY=0

log()  { printf '\033[1;32m[uninstall]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[uninstall]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[uninstall]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
dsh-vps 卸载脚本
用法: sudo bash uninstall.sh [--yes] [--keep-data] [--purge-caddy]
  --yes          跳过交互确认（脚本化调用时用）
  --keep-data    保留 DSH 数据目录 /home/dsh/.dsh 与系统用户 dsh
  --purge-caddy  连 Caddy 软件包与 apt 源一起移除（默认只删本产品的站点块）
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--yes) ASSUME_YES=1; shift ;;
	--keep-data) KEEP_DATA=1; shift ;;
	--purge-caddy) PURGE_CADDY=1; shift ;;
	-h | --help) usage; exit 0 ;;
	*) die "未知参数: $1（--help 查看用法）" ;;
	esac
done

[[ $EUID -eq 0 ]] || die "需要 root（sudo bash uninstall.sh ...）"

## endregion

## region: 步骤 1：确认

if [[ $ASSUME_YES -eq 0 ]]; then
	cat <<EOF
即将移除 dsh-vps：
  - 服务        ${SERVICE}（停止并禁用，删除 ${UNIT_FILE}）
  - 安装目录    ${INSTALL_ROOT}（含 gate 代码、state、备份）
  - 命令        /usr/local/bin/dsh-vps
  - Caddy 站点  $CADDY_SITE_FILE$([ $PURGE_CADDY -eq 1 ] && echo "（并移除 caddy 软件包）")
  - 隧道        /etc/wireguard/wg0.conf（仅当它是 dsh-vps vpn 创建的；你自己的 wg0 不动）
  - DSH 数据    $DSH_HOME_DIR$([ $KEEP_DATA -eq 1 ] && echo "（--keep-data：保留）" || echo "（删除）")
  - 系统用户    $DSH_USER$([ $KEEP_DATA -eq 1 ] && echo "（--keep-data：保留）" || echo "（保留，重装可复用）")

删除前会先打包备份到 /root/dsh-vps-uninstall-<时间戳>.tar.gz
EOF
	read -rp "确认卸载？输入 yes 继续： " ans
	[[ "$ans" == "yes" ]] || die "已取消"
fi

## endregion

## region: 步骤 2：备份

log "步骤 1/6：备份"
mkdir -p /root
local_ts="dsh-vps-uninstall-$(date +%Y%m%d-%H%M%S).tar.gz"
BACKUP="/root/$local_ts"
targets=()
# 注意：set -e 下不能写 `[[ -d x ]] && arr+=(x)`——条件为假时整条列表返回非 0 会直接退出
if [[ -d "$INSTALL_ROOT/state" ]]; then targets+=("${INSTALL_ROOT#/}/state"); fi
if [[ -d "$INSTALL_ROOT/backups" ]]; then targets+=("${INSTALL_ROOT#/}/backups"); fi
if [[ -d "$DSH_HOME_DIR" ]]; then targets+=("${DSH_HOME_DIR#/}"); fi
# Caddyfile 下一步会被改写，先连同站点块一起进备份
if [[ -f "$CADDYFILE" ]]; then targets+=("${CADDYFILE#/}"); fi
if [[ -f "$CADDY_SITE_FILE" ]]; then targets+=("${CADDY_SITE_FILE#/}"); fi
if [[ ${#targets[@]} -gt 0 ]]; then
	tar -czf "$BACKUP" -C / "${targets[@]}" 2>/dev/null || warn "部分文件无法打包（继续卸载）"
	chmod 600 "$BACKUP"
	log "备份完成: $BACKUP"
else
	BACKUP=""
	log "没有可备份的内容"
fi

## endregion

## region: 步骤 3：停服务、移除 unit

log "步骤 2/6：停止并移除 $SERVICE"
systemctl stop "$SERVICE" 2>/dev/null || true
systemctl disable "$SERVICE" 2>/dev/null || true
rm -f "$UNIT_FILE"
# 浏览器一键升级单元
systemctl disable --now dsh-vps-upgrade.path 2>/dev/null || true
rm -f /etc/systemd/system/dsh-vps-upgrade.path /etc/systemd/system/dsh-vps-upgrade.service
systemctl daemon-reload 2>/dev/null || true
systemctl reset-failed "$SERVICE" 2>/dev/null || true

# gate 拉起的 DSH 子进程随 gate 停止而退出；残留则兜底清理
pkill -u "$DSH_USER" -f "dsh/lib/bin.js" 2>/dev/null || true
pkill -u "$DSH_USER" -f "gate/server.js" 2>/dev/null || true

## endregion

## region: 步骤 4：删文件

log "步骤 3/6：移除安装目录与命令"
rm -rf "$INSTALL_ROOT"
rm -f /usr/local/bin/dsh-vps

## endregion

## region: 步骤 5：Caddy

log "步骤 4/6：移除 Caddy 站点块"
if [[ -f "$CADDY_SITE_FILE" ]]; then
	rm -f "$CADDY_SITE_FILE"
fi
if [[ -f "$CADDYFILE" ]] && grep -qF "import $CADDY_SITE_FILE" "$CADDYFILE"; then
	# install.sh 覆盖前留下的原文件（Caddyfile.bak.<时间戳>）：取最新一份不含本产品 import 的还原；
	# 没有则换成占位文件，避免 Caddy 因 import 缺失而启动失败。
	orig=""
	for f in $(ls -1t "$CADDYFILE".bak.* 2>/dev/null); do
		if ! grep -qF "import $CADDY_SITE_FILE" "$f"; then orig="$f"; break; fi
	done
	if [[ -n "$orig" ]]; then
		cp "$orig" "$CADDYFILE" && log "已还原安装前的 Caddyfile（来自 $orig）" \
			|| warn "Caddyfile 还原失败，请手工检查 $CADDYFILE"
	else
		printf '# Caddyfile 已被 dsh-vps 卸载脚本重置（原内容已备份进 %s）\n' "${BACKUP:-（无备份）}" >"$CADDYFILE" \
			|| warn "Caddyfile 重置失败，请手工检查 $CADDYFILE"
	fi
fi
if command -v caddy >/dev/null 2>&1; then
	systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
fi
if [[ $PURGE_CADDY -eq 1 ]]; then
	systemctl stop caddy 2>/dev/null || true
	systemctl disable caddy 2>/dev/null || true
	apt-get purge -y caddy >/dev/null 2>&1 || warn "caddy 卸载失败（可能不是 apt 安装的）"
	rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	log "已移除 caddy"
fi

## endregion

## region: 步骤 5：隧道

log "步骤 5/6：移除隧道"
if [[ -f /etc/wireguard/wg0.conf ]] && ! grep -q "dsh-vps" /etc/wireguard/wg0.conf; then
	log "wg0.conf 不是 dsh-vps 创建的，保留不动"
elif [[ -f /etc/wireguard/wg0.conf ]]; then
	systemctl stop wg-quick@wg0 2>/dev/null || true
	systemctl disable wg-quick@wg0 2>/dev/null || true
	rm -f /etc/wireguard/wg0.conf
	log "已移除 wg0（设备里的客户端配置请自行删掉）"
else
	log "没有隧道，跳过"
fi

## endregion

## region: 步骤 6：DSH 数据

log "步骤 6/6：处理 DSH 数据目录"
if [[ $KEEP_DATA -eq 1 ]]; then
	log "保留 ${DSH_HOME_DIR}（--keep-data）"
else
	rm -rf "$DSH_HOME_DIR"
	log "已删除 $DSH_HOME_DIR"
fi

## endregion

cat <<EOF

卸载完成。
  备份：${BACKUP:-（无）}
重装：
  curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/install.sh | sudo bash -s -- --domain <你的域名> --mirror cn
EOF
