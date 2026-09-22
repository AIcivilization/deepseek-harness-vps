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
  <a href="https://dshget.com/plugins/AIcivilization/deepseek-harness-vps"><img src="https://img.shields.io/badge/Listed_on-DSH_Get-1677ff?style=flat-square" alt="Listed on DSH Get"></a>
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
| Browser setup wizard | admin account, domain, DeepSeek API key and bundled plugins — all filled in from the browser |
| One-time setup token | the wizard only answers to holders of the token; the link is printed at install time, re-printable, and voided once setup completes |
| One-click bundled plugins | 2 shipped in the wizard, pre-checked and uncheckable, installed in the background and activated by an automatic restart |
| Automatic HTTPS | Caddy issues and renews certificates; changing the domain in the wizard hot-reloads instantly |
| Native settings on a public domain | settings, models, API keys and permission policies read and write normally |
| Working plugin marketplace | browse and install plugins from the marketplace, and "restart now" just works |
| Self-healing startup | the first boot and plugin installs take tens of seconds; the page waits and enters on its own |
| Safe upgrades | DSH is pinned to a verified version list; upgrades go backup → self-check → automatic rollback on failure, plus manual rollback at any time |
| Observable and recoverable | `/gate/health` on the server reports the crash reason and crash streak; `dsh-vps backup` keeps the latest 3 copies |
| Tightened exposure | session cookies are always Secure/HttpOnly/SameSite; diagnostics are reachable only from the server itself or an authenticated session; the service runs as the unprivileged `dsh` user under systemd sandboxing |
| Reachable by me only | one command builds a WireGuard tunnel, after which the public internet can't even reach the login page; SSH local forwarding covers you if you'd rather install nothing |

---

## Screenshots

<p align="center">
  <img src="docs/demo.gif" alt="Full walkthrough: install → setup wizard → login → DSH UI → plugin marketplace" width="830">
</p>

| Install done | Setup wizard | Wizard filled |
| :---: | :---: | :---: |
| ![](docs/screenshots/01-install.png) | ![](docs/screenshots/02-setup.png) | ![](docs/screenshots/03-setup-filled.png) |

| Setup complete | Login gate | Logging in |
| :---: | :---: | :---: |
| ![](docs/screenshots/04-setup-done.png) | ![](docs/screenshots/05-login.png) | ![](docs/screenshots/06-login-filled.png) |

| Native DSH UI | Settings (works on a public domain) | Plugin marketplace |
| :---: | :---: | :---: |
| ![](docs/screenshots/07-dsh.png) | ![](docs/screenshots/08-settings.png) | ![](docs/screenshots/09-market.png) |

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

Installation prints a **setup link carrying a one-time token** — open it to reach the wizard: admin username/password → (optional) domain, DeepSeek API key & bundled plugins → log in. The wizard only answers to holders of the token, and the token is voided once setup completes. Lost the link? Print it again:

```bash
sudo dsh-vps setup-url
```

Skipping the API key is fine; you can add it later via the "Add API key" prompt or Settings → Models → DeepSeek.

The checked plugins install in the background (tens of seconds) and DSH restarts to activate them. Two of them:

- **dsh-market**: browse, search and install community plugins and themes from Settings. Everything else is left to you — add whatever you want from the marketplace afterwards
- **dsh-vps-manager**: manage this very VPS from inside DSH — `/vps-` queries that skip the model and cost no tokens, a terminal in the conversation, AI operations confirmed by risk level, and a recipe library. Add this machine under Settings → VPS Manager (SSH key login)

---

## Reachable by me only (optional)

By default the site is publicly reachable and the login page is what keeps people out. If you'd rather the public internet never even reach that page, build a tunnel:

```bash
sudo dsh-vps vpn setup macbook
```

It installs WireGuard, brings up the tunnel and issues the first device's client config (printed to the terminal; pipe it through `qrencode -t ansiutf8` for a phone to scan). Once enabled, Caddy serves only the tunnel subnet and drops every other source outright — scanners don't even get a handshake. Your domain and certificate stay as they are, renewals unaffected.

```bash
sudo dsh-vps vpn add iphone     # issue another device
sudo dsh-vps vpn list           # devices + last handshake
sudo dsh-vps vpn revoke iphone  # lost a device? revoke it, effective immediately
sudo dsh-vps vpn status         # access policy + tunnel state + devices
sudo dsh-vps vpn off            # public access restored instantly; tunnel config is kept
```

The tunnel is **split**: only traffic to this DSH goes through it, everything else keeps using your local network. No IP forwarding, no NAT — this is not a full-traffic VPN. SSH remains the outermost fallback, so if the tunnel breaks you can still log in and run `vpn off`.

If you only ever use a computer, you don't even need WireGuard — SSH local forwarding does the same job:

```bash
sudo dsh-vps tunnel            # prints a ready-made ssh -L command and an ~/.ssh/config snippet
```

Browsers treat `127.0.0.1` as a secure origin, so the login session works normally. The trade-offs: it dies when the SSH connection drops, and phones can't do it. Pick the tunnel if you want always-on or mobile access.

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
sudo dsh-vps reset-admin   # emergency reset if you lose the admin password (re-runs the wizard, new token)
sudo dsh-vps setup-url     # re-print the setup link with its one-time token
sudo dsh-vps backup        # back up data (keeps the latest 3)
sudo dsh-vps vpn setup macbook  # build a WireGuard tunnel and switch to "tunnel only"
sudo dsh-vps vpn add iphone     # issue another device (prints config + QR code)
sudo dsh-vps vpn list|revoke|status|on|off
sudo dsh-vps tunnel        # zero-install alternative: SSH local forwarding usage
```

The Caddy site block is generated by `gate/site-block.js` — installation, domain changes and the tunnel switch all share that one template.

---

## How it runs

<p align="center">
  <img src="assets/architecture.svg" alt="Request path: browser to Caddy to dsh-gate to dsh web" width="680">
</p>

Both DSH and the gateway bind to 127.0.0.1 only, the user's browser never sees DSH's session cookie, and every request is proxied through after the gateway authenticates it.

- **Self-healing startup**: during first boot and plugin installs the page shows "DeepSeek Harness 正在启动", polls health every 3s and reloads itself as soon as the session is ready.
- **Settings availability**: DSH's frontend decides "is this the operator's own browser" from the page hostname and hides settings on a public domain. The gateway serves the officially supported `__DSH_TRANSPORT__.ownsHost` declaration alongside the page, which restores settings, models, API keys and permission policies. `--trusted-host` only opens the network fence — the two are separate gates.
- **Marketplace restart**: "restart now" is handled by the gateway — it strips Caddy's `X-Forwarded-For` (which trips DSH's loopback check and 403s) and restarts the DSH child process it owns, keeping session exchange intact.
- **Troubleshooting entry points**: `sudo ss -ltnp | grep 3080` finds stale DSH processes; `curl -s http://127.0.0.1:3100/gate/health` on the server reports `lastError`, `lastExit` and `crashStreak` (that endpoint answers only to the server itself or an authenticated session).

---

## Repository layout

| File | Purpose |
| --- | --- |
| `install.sh` | one-command installer (optional `--domain`, `--mirror cn`) |
| `uninstall.sh` | uninstall with backup |
| `bin/dsh-vps` | operations CLI |
| `gate/server.js` | login gateway (Node, zero dependencies) |
| `gate/site-block.js` | Caddy site block template (shared by install, domain change and tunnel switch) |
| `caddy/Caddyfile.template` | Caddy main config |
| `units/dsh-gate.service` | systemd unit template |
| `versions.json` | verified DSH version list |

---

## License

[MIT](LICENSE)
