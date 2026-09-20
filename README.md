<div align="center">

# deepseek-harness-vps

<p><strong>把 DeepSeek Harness 装进你的 VPS：一条命令，公网可达，界面原样</strong></p>
<p><strong>Your DeepSeek Harness on your own VPS — one command, reachable from anywhere, native UI intact</strong></p>

<p>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AIcivilization/deepseek-harness-vps" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/platform-Ubuntu%2022.04%2B%20%2F%20Debian%2012%2B-blue" alt="平台：Ubuntu 22.04+ / Debian 12+">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.5--rc.2-4176E6" alt="DeepSeek Harness 0.1.5-rc.2">
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen" alt="运行时依赖：0">
  <img src="https://img.shields.io/badge/Docker-not%20required-orange" alt="无需 Docker">
  <img src="https://img.shields.io/github/stars/AIcivilization/deepseek-harness-vps?style=social" alt="star">
</p>

<p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

</div>

---

## 简介

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）默认只认本机浏览器：它的特权接口（设置、API Key、插件管理）受浏览器信任围栏保护，直接反代到公网后这些页面全部失效。

dsh-vps 用一个零运行时依赖的登录网关（dsh-gate）架在 DSH 前面：公网请求先过 scrypt 登录门，再由网关以服务端身份完成 DSH 会话认证并透传。你在任何地方打开浏览器，用的都是官方原版的 DSH Web 界面，设置、模型、API Key、插件市场该有的都有。

DeepSeek Harness (DSH) trusts the operator's own browser only: its privileged interfaces — settings, API keys, plugin management — sit behind a browser-trust fence, and a plain reverse proxy to the public internet leaves those pages dead.

dsh-vps puts a zero-dependency login gateway (dsh-gate) in front of DSH: public requests pass a scrypt login gate first, then the gateway performs DSH session authentication server-side and proxies the rest. You open a browser anywhere and get the stock DSH web interface — settings, models, API keys and the plugin marketplace all working.

---

## 能力一览

| 能力 | 说明 |
| --- | --- |
| 一键安装 | `curl \| bash`，装完即 systemd 托管、开机自启 |
| 登录门 | scrypt 口令 + HMAC 会话 Cookie + 登录限流 |
| 浏览器初始向导 | 管理员账号、域名、DeepSeek API Key、社区插件，全程在浏览器里填完 |
| 社区插件一键装 | 向导内置 6 款，默认全选、可取消，后台装完自动重启生效 |
| 自动 HTTPS | Caddy 自动签发并续期证书；向导里改域名即时热加载 |
| 公网可用的原生设置页 | 设置、模型、API Key、权限策略在公网域名下照常读写 |
| 插件市场可用 | 市场里浏览/安装插件，点「立即重启」直接生效 |
| 会话自愈 | DSH 首启与插件安装需要几十秒，页面自动等待，就绪后自动进入 |
| 安全升级 | DSH 版本钉在已验证清单内，升级走备份 → 自检 → 失败自动回滚，也可随时手动回滚 |
| 可观测与可恢复 | `/gate/health` 直接给出崩溃原因与连续崩溃次数；`dsh-vps backup` 保留最近 3 份 |

---

## 环境要求

- Ubuntu 22.04+ / Debian 12+（root）
- 2C2G 以上，端口 80/443 开放
- 有域名即可自动 HTTPS；暂无域名也能先用公网 IP + 自签证书

---

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/install.sh \
  | sudo bash -s -- --domain dsh.example.com
```

国内网络加 `--mirror cn`（Node 与 DSH 走 npmmirror）：

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/install.sh \
  | sudo bash -s -- --domain dsh.example.com --mirror cn
```

## 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/uninstall.sh \
  | sudo bash -s -- --yes
```

删除服务、安装目录、Caddy 站点块与 DSH 数据目录，删除前打包备份到 `/root/dsh-vps-uninstall-<时间戳>.tar.gz`。`--keep-data` 保留 DSH 数据，`--purge-caddy` 连 Caddy 一起移除。卸载完再跑安装命令即为全新环境。

---

## 首次使用

安装完成打开输出的地址，自动进入初始设置向导：填管理员用户名/密码 → （可选）域名、DeepSeek API Key 与社区插件 → 登录即用。API Key 跳过也无妨，登录后仍可在「添加 API Key」引导或 设置 → 模型 → DeepSeek 中补填。

勾选的插件在后台安装（约几十秒），装完 DSH 自动重启生效。其中三款：

- **dsh-subscriptions**：设置 → 插件 → Subscriptions 里绑定 ChatGPT / Claude / Grok / Kimi / GLM 等订阅账户，之后即可当作模型提供方使用，省下按量付费额度
- **dsh-task-board**：左侧栏 Task Board 入口直接使用，支持真实执行会话与定时调度
- **dsh-im**：设置 → IM机器人 里扫码或填凭据，把飞书 / 钉钉 / 企微 / QQ / Slack / Telegram 等 11 种 IM 机器人接进 Harness

---

## 管理命令

```bash
sudo dsh-vps status        # 服务状态 + 健康 + 版本提示
sudo dsh-vps restart       # 重启（DSH 随之重启并自动重新兑换会话）
sudo dsh-vps upgrade       # 升级 DSH 到已验证版本（备份 → 自检 → 失败自动回滚）
sudo dsh-vps update-gate   # 拉取并重启网关自身代码（安装目录非 git 仓库，无需 git pull）
sudo dsh-vps ownshost on   # 应用设置页可用性补丁（公网域名下恢复设置页）
sudo dsh-vps selfcheck     # 跑一遍回归自检（登录 / RPC / WebSocket / 会话）
sudo dsh-vps rollback      # 切回上一 DSH 版本
sudo dsh-vps reset-admin   # 忘记管理员密码时的应急重置
sudo dsh-vps backup        # 备份数据（保留最近 3 份）
```

---

## 运行机制

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

## 仓库内容

| 文件 | 作用 |
| --- | --- |
| `install.sh` | 一键安装入口（唯一可选参数 `--domain`、`--mirror cn`） |
| `uninstall.sh` | 卸载并备份 |
| `bin/dsh-vps` | 运维命令行 |
| `gate/server.js` | 登录网关（Node 原生，零依赖） |
| `caddy/Caddyfile.template` | Caddy 主配置 |
| `units/dsh-gate.service` | systemd 单元模板 |
| `versions.json` | DSH 已验证版本清单 |

---

## 许可

[MIT](LICENSE)
