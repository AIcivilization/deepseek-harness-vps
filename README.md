# deepseek-harness-vps

在 VPS 上一键裸机部署 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）：无 Docker，浏览器里填几个空，即可 7×24 通过公网使用官方原生的 DSH Web 界面。

One-click bare-metal deployment of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) on a VPS: no Docker, a few fields in your browser, and the stock DSH web interface is yours to use from anywhere, 24/7.

---

## 中文

### 它能做什么

- **一键安装**：`curl | bash`，装完即服务化运行（systemd 托管，开机自启）
- **登录门**：scrypt 口令 + HMAC 会话 Cookie + 登录限流，公网访问先过这道门
- **浏览器初始向导**：管理员账号、域名、DeepSeek API Key、社区插件，全程在浏览器里填完
- **社区插件一键装**：向导内置 5 款，默认全选、可取消，后台安装完自动重启生效
- **自动 HTTPS**：Caddy 自动签发并续期证书；向导里改域名即时热加载
- **公网可用的原生设置页**：设置、模型、API Key、权限策略在公网域名下照常读写
- **插件市场可用**：市场里浏览/安装插件，点「立即重启」直接生效
- **会话自愈**：DSH 首启与插件安装需要几十秒，页面自动等待，就绪后自动进入
- **安全升级**：DSH 版本钉在已验证清单内，升级走备份 → 自检 → 失败自动回滚，也可随时手动回滚
- **可观测与可恢复**：`/gate/health` 直接给出崩溃原因与连续崩溃次数；`dsh-vps backup` 保留最近 3 份备份

### 环境要求

- Ubuntu 22.04+ / Debian 12+（root）
- 2C2G 以上，端口 80/443 开放
- 有域名更佳（自动 HTTPS）；没有也能先用 IP + 自签证书

### 安装

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/install.sh \
  | sudo bash -s -- --domain dsh.example.com
```

> 国内网络加 `--mirror cn`（npm 走 npmmirror）：`sudo bash -s -- --domain dsh.example.com --mirror cn`

### 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/uninstall.sh \
  | sudo bash -s -- --yes
```

删除服务、安装目录、Caddy 站点块与 DSH 数据目录，删除前打包备份到 `/root/dsh-vps-uninstall-<时间戳>.tar.gz`。`--keep-data` 保留 DSH 数据，`--purge-caddy` 连 Caddy 一起移除。

### 首次使用

安装完成打开输出的地址，自动进入初始设置向导：填管理员用户名/密码 → （可选）域名、DeepSeek API Key 与社区插件 → 登录即用。API Key 跳过也无妨，登录后仍可在「添加 API Key」引导或 设置 → 模型 → DeepSeek 中补填。

勾选的插件在后台安装（约几十秒），装完 DSH 自动重启生效。其中两款：

- **dsh-subscriptions**：设置 → 插件 → Subscriptions 里绑定 ChatGPT / Claude / Grok / Kimi / GLM 等订阅账户，之后即可当作模型提供方使用，省下按量付费额度
- **dsh-task-board**：左侧栏 Task Board 入口直接使用，支持真实执行会话与定时调度

### 管理命令

```bash
sudo dsh-vps status        # 服务状态 + 健康 + 版本提示
sudo dsh-vps restart       # 重启（DSH 随之重启并自动重新兑换会话）
sudo dsh-vps upgrade       # 升级 DSH 到已验证版本（备份 → 自检 → 失败自动回滚）
sudo dsh-vps update-gate   # 拉取并重启网关自身代码（安装目录非 git 仓库，无需 git pull）
sudo dsh-vps ownshost on   # 应用设置页可用性补丁（公网域名下恢复设置页）
sudo dsh-vps rollback      # 切回上一 DSH 版本
sudo dsh-vps reset-admin   # 忘记管理员密码时的应急重置
sudo dsh-vps backup        # 备份数据（保留最近 3 份）
```

### 运行机制

```
浏览器 ──HTTPS──▶ Caddy ──▶ dsh-gate(:3100, 仅回环) ──▶ dsh web(:3080, 仅回环)
                              登录门 + 透明代理              官方原版 DSH
                              + 服务端 DSH 会话 Cookie 注入
```

DSH 与网关均只绑 127.0.0.1，用户浏览器接触不到 DSH 的会话 Cookie，所有请求经网关认证后透传。

- **会话自愈**：首启与插件安装期间页面显示「DeepSeek Harness 正在启动」，按 3 秒一次自检，会话就绪后自动刷新进入。
- **设置页可用性**：DSH 前端按页面 hostname 判断是否为操作者本机浏览器，公网域名下会隐藏设置。网关随页面下发官方支持的 `__DSH_TRANSPORT__.ownsHost` 声明，设置页、模型、API Key 与权限策略随之恢复。`--trusted-host` 只负责打开网络围栏，两者是两道独立的门。
- **插件市场重启**：市场的「立即重启」由网关接管——它剥掉 Caddy 加的 `X-Forwarded-For`（该头会触发 DSH 的回环校验而 403），并由网关重启自己托管的 DSH 子进程，保证会话兑换链路不中断。
- **排障入口**：`sudo ss -ltnp | grep 3080` 查残留 DSH 进程；`/gate/health` 直接给出 `lastError` / `lastExit` / `crashStreak`。

---

## English

### What it does

- **One-command install**: `curl | bash`, then it runs as a systemd service, started on boot
- **Login gate**: scrypt password + HMAC session cookie + rate limiting, in front of every public request
- **Browser setup wizard**: admin account, domain, DeepSeek API key and community plugins — all filled in from the browser
- **One-click community plugins**: 5 shipped in the wizard, pre-checked and uncheckable, installed in the background and activated by an automatic restart
- **Automatic HTTPS**: Caddy issues and renews certificates; changing the domain in the wizard hot-reloads instantly
- **Native settings on a public domain**: settings, models, API keys and permission policies read and write normally
- **Working plugin marketplace**: browse and install plugins from the marketplace, and "restart now" just works
- **Self-healing startup**: the first boot and plugin installs take tens of seconds; the page waits and enters on its own
- **Safe upgrades**: DSH is pinned to a verified version list; upgrades go backup → self-check → automatic rollback on failure, plus manual rollback at any time
- **Observable and recoverable**: `/gate/health` reports the crash reason and crash streak; `dsh-vps backup` keeps the latest 3 copies

### Requirements

- Ubuntu 22.04+ / Debian 12+ (root)
- 2 vCPU / 2 GB RAM or better; ports 80/443 open
- A domain is recommended (automatic HTTPS); IP + self-signed cert works too

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/install.sh \
  | sudo bash -s -- --domain dsh.example.com
```

Add `--mirror cn` if you're behind the GFW (npm via npmmirror).

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/uninstall.sh \
  | sudo bash -s -- --yes
```

Removes the service, install directory, Caddy site block and the DSH data directory, packing a backup to `/root/dsh-vps-uninstall-<timestamp>.tar.gz` first. `--keep-data` keeps the DSH data, `--purge-caddy` removes Caddy as well.

### First run

Open the printed URL after installation — the setup wizard starts automatically: admin username/password → (optional) domain, DeepSeek API key & community plugins → log in. Skipping the API key is fine; you can add it later via the "Add API key" prompt or Settings → Models → DeepSeek.

The checked plugins install in the background (tens of seconds) and DSH restarts to activate them. Two worth knowing:

- **dsh-subscriptions**: Settings → Plugins → Subscriptions to bind ChatGPT / Claude / Grok / Kimi / GLM accounts, then use them as model providers and save pay-as-you-go credits
- **dsh-task-board**: available from the Task Board entry in the sidebar, with real session execution and cron scheduling

### Management

```bash
sudo dsh-vps status        # service status + health + version hints
sudo dsh-vps restart       # restart (DSH restarts and re-exchanges its session)
sudo dsh-vps upgrade       # upgrade DSH to the latest verified version (backup → self-check → auto rollback)
sudo dsh-vps update-gate   # pull and restart the gateway code itself (no git repo on the VPS)
sudo dsh-vps ownshost on   # apply the settings-page patch (restores settings on a public domain)
sudo dsh-vps rollback      # switch back to the previous DSH version
sudo dsh-vps reset-admin   # emergency reset if you lose the admin password
sudo dsh-vps backup        # back up data (keeps the latest 3)
```

### How it runs

```
Browser ──HTTPS──▶ Caddy ──▶ dsh-gate(:3100, loopback only) ──▶ dsh web(:3080, loopback only)
                              login gate + transparent proxy      stock DSH
                              + server-side DSH cookie injection
```

Both DSH and the gateway bind to 127.0.0.1 only, the user's browser never sees DSH's session cookie, and every request is proxied through after the gateway authenticates it.

- **Self-healing startup**: during first boot and plugin installs the page shows "DeepSeek Harness 正在启动", polls health every 3s and reloads itself as soon as the session is ready.
- **Settings availability**: DSH's frontend decides "is this the operator's own browser" from the page hostname and hides settings on a public domain. The gateway serves the officially supported `__DSH_TRANSPORT__.ownsHost` declaration alongside the page, which restores settings, models, API keys and permission policies. `--trusted-host` only opens the network fence — the two are separate gates.
- **Marketplace restart**: "restart now" is handled by the gateway — it strips Caddy's `X-Forwarded-For` (which trips DSH's loopback check and 403s) and restarts the DSH child process it owns, keeping session exchange intact.
- **Troubleshooting entry points**: `sudo ss -ltnp | grep 3080` finds stale DSH processes; `/gate/health` reports `lastError`, `lastExit` and `crashStreak` directly.

---

## License

MIT
