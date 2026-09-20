<div align="center">

# deepseek-harness-vps

<p><strong>Your DeepSeek Harness on your own VPS — one command, reachable from anywhere, native UI intact</strong></p>

<p>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AIcivilization/deepseek-harness-vps" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platform-Ubuntu%2022.04%2B%20%2F%20Debian%2012%2B-blue" alt="Platform: Ubuntu 22.04+ / Debian 12+">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.5--rc.2-4176E6" alt="DeepSeek Harness 0.1.5-rc.2">
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen" alt="Runtime dependencies: 0">
  <img src="https://img.shields.io/badge/Docker-not%20required-orange" alt="No Docker required">
  <img src="https://img.shields.io/github/stars/AIcivilization/deepseek-harness-vps?style=social" alt="star">
</p>

<p><a href="README.md">简体中文</a> · <strong>English</strong></p>

</div>

---

## Overview

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) trusts the operator's own browser only: its privileged interfaces — settings, API keys, plugin management — sit behind a browser-trust fence, and a plain reverse proxy to the public internet leaves those pages dead.

dsh-vps puts a zero-dependency login gateway (dsh-gate) in front of DSH: public requests pass a scrypt login gate first, then the gateway performs DSH session authentication server-side and proxies the rest. You open a browser anywhere and get the stock DSH web interface — settings, models, API keys and the plugin marketplace all working.

---

## Capabilities

| Capability | Notes |
| --- | --- |
| One-command install | `curl \| bash`, then it runs as a systemd service, started on boot |
| Login gate | scrypt password + HMAC session cookie + rate limiting |
| Browser setup wizard | admin account, domain, DeepSeek API key and community plugins — all filled in from the browser |
| One-click community plugins | 6 shipped in the wizard, pre-checked and uncheckable, installed in the background and activated by an automatic restart |
| Automatic HTTPS | Caddy issues and renews certificates; changing the domain in the wizard hot-reloads instantly |
| Native settings on a public domain | settings, models, API keys and permission policies read and write normally |
| Working plugin marketplace | browse and install plugins from the marketplace, and "restart now" just works |
| Self-healing startup | the first boot and plugin installs take tens of seconds; the page waits and enters on its own |
| Safe upgrades | DSH is pinned to a verified version list; upgrades go backup → self-check → automatic rollback on failure, plus manual rollback at any time |
| Observable and recoverable | `/gate/health` reports the crash reason and crash streak; `dsh-vps backup` keeps the latest 3 copies |

---

## Requirements

- Ubuntu 22.04+ / Debian 12+ (root)
- 2 vCPU / 2 GB RAM or better; ports 80/443 open
- A domain gives you automatic HTTPS; a public IP with a self-signed certificate works too

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/install.sh \
  | sudo bash -s -- --domain dsh.example.com
```

Add `--mirror cn` if you're behind the GFW (Node and DSH come from npmmirror).

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/uninstall.sh \
  | sudo bash -s -- --yes
```

Removes the service, install directory, Caddy site block and the DSH data directory, packing a backup to `/root/dsh-vps-uninstall-<timestamp>.tar.gz` first. `--keep-data` keeps the DSH data, `--purge-caddy` removes Caddy as well. Uninstall then install again gives you a clean environment.

---

## First run

Open the printed URL after installation — the setup wizard starts automatically: admin username/password → (optional) domain, DeepSeek API key & community plugins → log in. Skipping the API key is fine; you can add it later via the "Add API key" prompt or Settings → Models → DeepSeek.

The checked plugins install in the background (tens of seconds) and DSH restarts to activate them. Three worth knowing:

- **dsh-subscriptions**: Settings → Plugins → Subscriptions to bind ChatGPT / Claude / Grok / Kimi / GLM accounts, then use them as model providers and save pay-as-you-go credits
- **dsh-task-board**: available from the Task Board entry in the sidebar, with real session execution and cron scheduling
- **dsh-im**: Settings → IM机器人 to scan a QR code or enter credentials, wiring 11 IM channels (Feishu, DingTalk, WeCom, QQ, Slack, Telegram and more) into Harness

---

## Management

```bash
sudo dsh-vps status        # service status + health + version hints
sudo dsh-vps restart       # restart (DSH restarts and re-exchanges its session)
sudo dsh-vps upgrade       # upgrade DSH to the latest verified version (backup → self-check → auto rollback)
sudo dsh-vps update-gate   # pull and restart the gateway code itself (no git repo on the VPS)
sudo dsh-vps ownshost on   # apply the settings-page patch (restores settings on a public domain)
sudo dsh-vps selfcheck     # run the regression self-check (login / RPC / WebSocket / session)
sudo dsh-vps rollback      # switch back to the previous DSH version
sudo dsh-vps reset-admin   # emergency reset if you lose the admin password
sudo dsh-vps backup        # back up data (keeps the latest 3)
```

---

## How it runs

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

## Repository layout

| File | Purpose |
| --- | --- |
| `install.sh` | one-command installer (optional `--domain`, `--mirror cn`) |
| `uninstall.sh` | uninstall with backup |
| `bin/dsh-vps` | operations CLI |
| `gate/server.js` | login gateway (Node, zero dependencies) |
| `caddy/Caddyfile.template` | Caddy main config |
| `units/dsh-gate.service` | systemd unit template |
| `versions.json` | verified DSH version list |

---

## License

[MIT](LICENSE)
