# deepseek-harness-vps

在 VPS 上一键裸机部署 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）：无 Docker，浏览器里填几个空，即可 7×24 通过公网使用 **100% 原生** 的 DSH Web 界面。

One-click bare-metal deployment of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) on a VPS: no Docker, fill in a few fields in your browser, and use the **100% native** DSH web interface from anywhere, 24/7.

---

## 中文

### 它解决什么问题

DSH 的特权接口（设置读写、API Key 写入等 `/api` RPC）受"浏览器信任围栏 + 会话认证"双重保护，直接反代到公网后设置页完全不可用。本项目用一个零依赖登录网关（dsh-gate）+ DSH 官方 `--trusted-host` 机制彻底解决，DSH 本体零改动。

### 特性

- **一键安装**：`curl | bash`，唯一可选参数 `--domain`
- **登录门**：scrypt 口令 + HMAC 会话 Cookie + 登录限流
- **浏览器初始向导**：填用户名/密码（+ 可选域名、DeepSeek API Key），全程无需 SSH 敲命令
- **自动 HTTPS**：Caddy 自动签发/续期证书；向导里改域名即时热加载
- **100% 原生界面**：零注入、零魔改，DSH 升级只需换版本号
- **安全升级**：版本钉住 + 备份 + 升级后回归自检 + 失败自动回滚 + 秒级手动回滚

### 环境要求

- Ubuntu 22.04+ / Debian 12+（root）
- 2C2G 以上，端口 80/443 开放
- 有域名更佳（自动 HTTPS）；没有也能先用 IP + 自签证书

### 安装

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/install.sh \
  | sudo bash -s -- --domain dsh.example.com
```

国内网络可加 `--mirror cn`（npm 走 npmmirror）。不传 `--domain` 则先以 IP 起服务，域名稍后在浏览器向导里填。

安装完成后浏览器打开输出的地址，自动进入初始设置向导：填管理员用户名/密码 → （可选）域名与 DeepSeek API Key → 登录即用。

### 管理命令

```bash
sudo dsh-vps status        # 服务状态 + 健康 + 版本提示
sudo dsh-vps restart       # 重启（DSH 随之重启并自动重新兑换会话）
sudo dsh-vps upgrade       # 升级到已验证版本（备份 → 自检 → 失败自动回滚）
sudo dsh-vps rollback      # 切回上一版本
sudo dsh-vps reset-admin   # 忘记管理员密码时的应急重置
sudo dsh-vps backup        # 备份数据（保留最近 3 份）
```

### 架构速览

```
浏览器 ──HTTPS──▶ Caddy ──▶ dsh-gate(:3100, 仅回环) ──▶ dsh web(:3080, 仅回环)
                              登录门 + 透明代理           官方原版，零改动
                              + DSH 会话 Cookie 注入
```

DSH 与 gate 均只绑 127.0.0.1；用户浏览器永远接触不到 DSH 的会话 Cookie；DSH 升级版本钉在 `versions.json` 已验证清单内。详见设计文档（仓库外）。

---

## English

### What problem it solves

DSH's privileged interfaces (settings, API key storage, all `/api` RPCs) are protected by a browser-trust fence plus session auth — a plain reverse proxy to the public internet leaves the settings page completely broken. This project solves it with a zero-dependency login gateway (dsh-gate) built on DSH's official `--trusted-host` mechanism. DSH itself is never modified.

### Features

- **One-command install**: `curl | bash`, single optional flag `--domain`
- **Login gate**: scrypt password + HMAC session cookie + rate limiting
- **Browser setup wizard**: username/password (+ optional domain & DeepSeek API key) — no SSH commands needed
- **Automatic HTTPS**: Caddy issues/renews certificates; domain changes from the wizard hot-reload instantly
- **100% native UI**: zero injection, zero patches; upgrading DSH is just a version bump
- **Safe upgrades**: pinned versions + backup + post-upgrade self-check + automatic rollback on failure

### Requirements

- Ubuntu 22.04+ / Debian 12+ (root)
- 2 vCPU / 2 GB RAM or better; ports 80/443 open
- A domain is recommended (automatic HTTPS); IP + self-signed cert works too

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/install.sh \
  | sudo bash -s -- --domain dsh.example.com
```

Add `--mirror cn` if you're behind the GFW (npm via npmmirror). Without `--domain`, the service starts on the IP and you can set the domain later in the browser wizard.

After installation, open the printed URL — the setup wizard starts automatically: admin username/password → (optional) domain & DeepSeek API key → log in.

### Management

```bash
sudo dsh-vps status        # service status + health + version hints
sudo dsh-vps restart       # restart (DSH restarts and re-exchanges its session)
sudo dsh-vps upgrade       # upgrade to the latest verified version (backup → self-check → auto rollback)
sudo dsh-vps rollback      # switch back to the previous version
sudo dsh-vps reset-admin   # emergency reset if you lose the admin password
sudo dsh-vps backup        # back up data (keeps the latest 3)
```

### Architecture at a glance

```
Browser ──HTTPS──▶ Caddy ──▶ dsh-gate(:3100, loopback only) ──▶ dsh web(:3080, loopback only)
                              login gate + transparent proxy      stock DSH, untouched
                              + server-side DSH cookie injection
```

Both DSH and the gateway bind to 127.0.0.1 only; the user's browser never sees DSH's session cookie; DSH versions are pinned to the verified list in `versions.json`.

---

## License

MIT
