/* global window, document, fetch, navigator, setTimeout, clearTimeout, setInterval, clearInterval */
// plugin/client.js — 设置 → VPS 部署
//
// 手写单文件 bundle，没有构建链：供 DSH web 客户端的 ModuleLoader 注入。
// 只挂一处：settings.section。
//
// 两种状态，由同源的 /gate/update 能否返回网关数据来判断：
//   - 这个 DSH 是 dsh-vps 部署的（前面有 dsh-gate）：DSH 版本与一键升级、网关状态、服务器常用命令
//   - 普通 DSH：把 DSH 部署到自己 VPS 的一键命令
//
// 升级请求由网关校验登录与同源后写入请求文件，真正执行的是服务器上 root 的
// dsh-vps-upgrade 服务（备份 → 安装 → 自检 → 失败自动回滚）；页面只负责发起与展示。
//
// 硬约束：界面出错不能影响 DSH 本身，注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-vps',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const REPO = 'https://github.com/AIcivilization/deepseek-harness-vps'
    const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/install.sh | sudo bash -s'

    // ——————————————————————— 文案 ———————————————————————

    // DSH 页面的 <html lang> 恒为 en，不能用来判断；按浏览器语言走
    const zh = (() => {
      try {
        return /^zh/i.test(navigator.language || '')
      } catch {
        return true
      }
    })()
    const t = (cn, en) => (zh ? cn : en)

    // ——————————————————————— 样式（跟随 DSH 主题变量） ———————————————————————

    const T = {
      border: 'var(--border, var(--dsw-alias-border-l1, rgba(127,127,127,0.25)))',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))',
      danger: 'var(--dsw-alias-state-error-primary, #e5534b)',
      ok: 'var(--dsw-alias-state-success-primary, #2ea043)',
      accent: 'var(--primary, #3b82f6)',
    }
    const line = `1px solid ${T.border}`
    const S = {
      root: { fontSize: 13, lineHeight: 1.6 },
      h2: { fontSize: 14, fontWeight: 600, margin: '0 0 8px' },
      card: { border: line, borderRadius: 8, padding: 12, marginBottom: 10 },
      spread: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 4 },
      muted: { opacity: 0.6 },
      pre: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        background: T.layer,
        borderRadius: 6,
        padding: '8px 10px',
        overflowX: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        margin: 0,
      },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      btn: (kind, disabled) => ({
        border: kind === 'primary' ? `1px solid ${T.accent}` : line,
        background: kind === 'primary' ? T.accent : 'transparent',
        color: kind === 'primary' ? 'var(--primary-foreground, #fff)' : 'inherit',
        borderRadius: 6,
        padding: '4px 12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 13,
        whiteSpace: 'nowrap',
      }),
      badge: (tone) => ({
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 10,
        border: line,
        color: tone === 'danger' ? T.danger : tone === 'ok' ? T.ok : tone === 'accent' ? T.accent : 'inherit',
        whiteSpace: 'nowrap',
      }),
      err: { border: `1px solid ${T.danger}`, color: T.danger, borderRadius: 6, padding: '8px 10px', marginTop: 8 },
      note: { border: line, borderRadius: 6, padding: '8px 10px', marginTop: 8, background: T.layer },
      // 勾选框始终贴在文字左边（窄窗口里文字换行，勾选框不单独占一行）
      check: { display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' },
      checkbox: { flex: 'none', marginTop: 4 },
    }

    // ——————————————————————— 与网关通信 ———————————————————————

    /** GET 网关接口；不是网关（普通 DSH 返回 404 或前端页面）时返回 null */
    async function gateGet(path) {
      try {
        const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000) })
        if (!res.ok || !String(res.headers.get('content-type') || '').includes('application/json')) return null
        return await res.json()
      } catch {
        return null
      }
    }

    async function requestUpgrade() {
      const res = await fetch('/gate/update', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(30_000) })
      let body = {}
      try {
        body = await res.json()
      } catch {
        // 非 JSON：用状态码说话
      }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    }

    // ——————————————————————— 小工具 ———————————————————————

    function ago(ms) {
      if (!ms) return t('尚未检查', 'not checked yet')
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (s < 60) return t('刚刚', 'just now')
      if (s < 3600) return t(`${Math.round(s / 60)} 分钟前`, `${Math.round(s / 60)} min ago`)
      if (s < 86400) return t(`${Math.round(s / 3600)} 小时前`, `${Math.round(s / 3600)} h ago`)
      return t(`${Math.round(s / 86400)} 天前`, `${Math.round(s / 86400)} d ago`)
    }

    function duration(sec) {
      if (sec < 3600) return t(`${Math.max(1, Math.round(sec / 60))} 分钟`, `${Math.max(1, Math.round(sec / 60))} min`)
      if (sec < 86400) return t(`${Math.round(sec / 3600)} 小时`, `${Math.round(sec / 3600)} h`)
      return t(`${Math.round(sec / 86400)} 天`, `${Math.round(sec / 86400)} d`)
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        // 非安全上下文拿不到 clipboard：退回 execCommand
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          const ok = document.execCommand('copy')
          ta.remove()
          return ok
        } catch {
          return false
        }
      }
    }

    function CopyLine({ text, note }) {
      const [copied, setCopied] = useState(false)
      return h('div', { style: { marginTop: 6 } },
        h('div', { style: { ...S.row, flexWrap: 'nowrap', alignItems: 'stretch' } },
          h('pre', { style: { ...S.pre, flex: 1 } }, text),
          h('button', {
            type: 'button',
            style: S.btn(),
            onClick: async () => {
              setCopied(await copyText(text))
              setTimeout(() => setCopied(false), 1500)
            },
          }, copied ? t('已复制', 'Copied') : t('复制', 'Copy'))),
        note ? h('div', { style: { ...S.muted, fontSize: 12, marginTop: 2 } }, note) : null)
    }

    // ——————————————————————— 部署在 dsh-vps 上 ———————————————————————

    function VersionCard({ info, reload }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [upgrading, setUpgrading] = useState(false)
      const [checking, setChecking] = useState(false)
      const startedAt = useRef(0)
      const timer = useRef(null)

      const st = info.status
      const running = info.requested || (st && st.state === 'running')

      const poll = useCallback(() => {
        clearInterval(timer.current)
        timer.current = setInterval(async () => {
          const next = await gateGet('/gate/update')
          if (!next) return // 升级中网关会重启一次，连不上属正常，继续等
          reload(next)
          const s = next.status
          if (!next.requested && s && s.state !== 'running' && s.at >= startedAt.current) {
            clearInterval(timer.current)
            setUpgrading(false)
            if (s.state === 'success') setTimeout(() => window.location.reload(), 1500)
          }
        }, 3000)
      }, [reload])

      useEffect(() => {
        if (running) {
          startedAt.current = startedAt.current || Date.now() - 60_000
          setUpgrading(true)
          poll()
        }
        return () => clearInterval(timer.current)
      }, []) // eslint-disable-line react-hooks/exhaustive-deps

      async function upgrade() {
        const msg = t(
          `升级 DeepSeek Harness 到 ${info.latest}？\n\n升级期间 DSH 会重启，约 1–3 分钟不可用。升级前自动备份；新版本自检不通过会自动回滚到当前版本。`,
          `Upgrade DeepSeek Harness to ${info.latest}?\n\nDSH restarts during the upgrade and is unavailable for about 1–3 minutes. A backup is taken first; if the new version fails its self-check, it rolls back automatically.`,
        )
        if (!window.confirm(msg)) return
        setBusy(true)
        setError(null)
        try {
          startedAt.current = Date.now() - 5_000
          await requestUpgrade()
          setUpgrading(true)
          poll()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      async function check() {
        setChecking(true)
        const next = await gateGet('/gate/update?refresh=1')
        if (next) reload(next)
        setChecking(false)
      }

      const finished = !upgrading && st && st.state !== 'running' && Date.now() - st.at < 24 * 3600_000
      return h('div', { style: S.card },
        h('div', { style: S.spread },
          h('div', { style: S.h2 }, 'DeepSeek Harness'),
          info.available
            ? h('span', { style: S.badge('accent') }, t('有新版本', 'Update available'))
            : info.latest ? h('span', { style: S.badge('ok') }, t('已是最新', 'Up to date')) : null),
        h('div', { style: S.kv },
          h('span', { style: S.muted }, t('当前版本', 'Current')), h('span', { style: S.code }, info.current || '—'),
          h('span', { style: S.muted }, t('官方最新', 'Latest')),
          h('span', null, h('span', { style: S.code }, info.latest || '—'),
            h('span', { style: { ...S.muted, marginLeft: 8, fontSize: 12 } }, t(`检查于 ${ago(info.checkedAt)}`, `checked ${ago(info.checkedAt)}`)))),
        h('div', { style: { ...S.muted, fontSize: 12, marginTop: 4 } },
          t(`跟随官方发布：npm 上 latest（正式）与 next（预览）两个渠道中版本号较高的一个；新版本发布满 ${info.cooldownHours ?? 12} 小时后才提供升级，避开上游刚发布时的缺包。`,
            `Follows official releases: the higher of the npm \`latest\` (stable) and \`next\` (preview) channels, offered ${info.cooldownHours ?? 12} hours after release so upstream has time to finish publishing.`)),
        info.pending
          ? h('div', { style: S.note }, t(
            `${info.pending.version} 刚发布不久，${info.pending.availableAt ? `约 ${Math.max(1, Math.ceil((info.pending.availableAt - Date.now()) / 3600_000))} 小时后` : '稍后'}可以升级。`,
            `${info.pending.version} was released recently; it can be installed ${info.pending.availableAt ? `in about ${Math.max(1, Math.ceil((info.pending.availableAt - Date.now()) / 3600_000))} h` : 'later'}.`))
          : null,
        upgrading
          ? h('div', { style: S.note }, t(
            `正在升级${info.latest ? ` 到 ${info.latest}` : ''}…（约 1–3 分钟，期间页面会短暂不可用，完成后自动刷新）`,
            `Upgrading${info.latest ? ` to ${info.latest}` : ''}… (about 1–3 minutes; the page is briefly unavailable and reloads when done)`))
          : h('div', { style: { ...S.row, marginTop: 10 } },
            h('button', { type: 'button', style: S.btn(null, checking), disabled: checking, onClick: check },
              checking ? t('检查中…', 'Checking…') : t('检查更新', 'Check for updates')),
            info.available
              ? h('button', { type: 'button', style: S.btn('primary', busy), disabled: busy, onClick: upgrade },
                t(`升级到 ${info.latest}`, `Upgrade to ${info.latest}`))
              : null),
        error ? h('div', { style: S.err }, t(`无法开始升级：${error}`, `Could not start the upgrade: ${error}`)) : null,
        finished && st.state === 'success'
          ? h('div', { style: S.note }, t(`最近一次升级成功：${st.from} → ${st.to}（${ago(st.at)}）`, `Last upgrade succeeded: ${st.from} → ${st.to} (${ago(st.at)})`))
          : null,
        finished && st.state === 'failed'
          ? h('div', { style: S.err },
            h('div', null, t(`最近一次升级未成功（${ago(st.at)}），已保持在 ${st.to || st.from}，可以正常使用。`,
              `The last upgrade did not succeed (${ago(st.at)}); DSH stayed on ${st.to || st.from} and works normally.`)),
            info.logTail ? h('pre', { style: { ...S.pre, marginTop: 6, color: 'inherit' } }, info.logTail) : null)
          : null)
    }

    function GatewayCard({ health }) {
      if (!health) {
        return h('div', { style: S.card },
          h('div', { style: S.h2 }, t('网关', 'Gateway')),
          h('div', { style: S.muted }, t('读取网关状态失败，稍后刷新再试。', 'Could not read gateway status; refresh later.')))
      }
      const d = health.dsh || {}
      const cookie = health.dshCookie
      const tunnel = health.access === 'tunnel'
      return h('div', { style: S.card },
        h('div', { style: S.spread },
          h('div', { style: S.h2 }, t('网关', 'Gateway')),
          h('span', { style: S.badge(d.alive ? 'ok' : 'danger') }, d.alive ? t('运行正常', 'Healthy') : t('DSH 未运行', 'DSH not running'))),
        h('div', { style: S.kv },
          h('span', { style: S.muted }, t('访问地址', 'Address')), h('span', { style: S.code }, d.trustedHost ? `https://${d.trustedHost}` : '—'),
          h('span', { style: S.muted }, t('访问方式', 'Access')),
          h('span', null, tunnel
            ? t('仅 WireGuard 隧道内的设备可访问', 'WireGuard tunnel devices only')
            : t('公网可访问，凭管理员账号登录', 'Public, behind the admin login')),
          h('span', { style: S.muted }, t('网关已运行', 'Gateway uptime')), h('span', null, duration(health.uptimeSec || 0)),
          h('span', { style: S.muted }, t('DSH 重启次数', 'DSH restarts')), h('span', null, String(d.restarts ?? 0)),
          h('span', { style: S.muted }, t('DSH 会话', 'DSH session')),
          h('span', null, cookie
            ? t(`有效，剩余约 ${Math.max(0, Math.round(cookie.expiresInHours / 24))} 天（到期前自动续期）`,
              `valid, about ${Math.max(0, Math.round(cookie.expiresInHours / 24))} days left (renewed automatically)`)
            : t('尚未就绪', 'not ready'))),
        health.lastError ? h('div', { style: S.err }, health.lastError) : null)
    }

    function CommandsCard() {
      const rows = [
        ['sudo dsh-vps status', t('服务状态、版本、健康检查', 'services, versions and health')],
        ['sudo dsh-vps backup', t('备份 DSH 数据与网关配置（保留最近 3 份）', 'back up DSH data and gateway config (keeps the last 3)')],
        ['sudo dsh-vps rollback', t('切回上一个 DSH 版本', 'switch back to the previous DSH version')],
        ['sudo dsh-vps vpn setup <设备名>'.replace('<设备名>', t('<设备名>', '<device>')), t('改为仅 WireGuard 隧道可访问', 'restrict access to a WireGuard tunnel')],
        ['sudo dsh-vps update-gate', t('更新网关（登录页、代理）自身', 'update the gateway itself (login page, proxy)')],
        ['sudo dsh-vps reset-admin', t('忘记管理员密码时重置', 'reset a forgotten admin password')],
      ]
      return h('div', { style: S.card },
        h('div', { style: S.h2 }, t('服务器上的常用命令', 'Server commands')),
        h('div', { style: { ...S.muted, fontSize: 12 } }, t('SSH 登录服务器后执行。', 'Run these over SSH on the server.')),
        rows.map(([cmd, note]) => h(CopyLine, { key: cmd, text: cmd, note })))
    }

    // ——————————————————————— 普通 DSH：填表安装到 VPS ———————————————————————

    const INSTALL_API = '/api/dsh-vps.install'

    async function installApi(method, body) {
      const res = await fetch(INSTALL_API, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 404) return { unavailable: true }
      let data = {}
      try {
        data = await res.json()
      } catch {
        // 非 JSON
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    function Field({ label, hint, children }) {
      return h('label', { style: { display: 'block', minWidth: 0 } },
        h('div', { style: { fontSize: 12, opacity: 0.75, marginBottom: 3 } }, label),
        children,
        hint ? h('div', { style: { ...S.muted, fontSize: 12, marginTop: 3 } }, hint) : null)
    }

    const inputStyle = {
      width: '100%', boxSizing: 'border-box', border: line, borderRadius: 6, padding: '6px 8px',
      background: 'transparent', color: 'inherit', fontSize: 13,
    }

    function ManualCommand() {
      return h('div', null,
        h(CopyLine, { text: INSTALL_CMD }),
        h('ul', { style: { margin: '8px 0 0', paddingLeft: 18 } },
          h('li', null, t('有域名（A 记录已解析到服务器）：在末尾加 ', 'With a domain pointed at the server: append '),
            h('span', { style: S.code }, '-- --domain dsh.example.com'), t('，自动签发证书。', ' for an automatic certificate.')),
          h('li', null, t('国内网络：再加 ', 'Behind the GFW: also add '), h('span', { style: S.code }, '--mirror cn'), t('。', '.')),
          h('li', null, t('需要 root 权限，并开放 80/443 端口。安装结束时会打印带一次性令牌的设置链接，打开它创建管理员账号。',
            'Needs root and open ports 80/443. It prints a setup link with a one-time token at the end; open it to create the admin account.'))))
    }

    const UNINSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/uninstall.sh | sudo bash -s -- --yes --keep-data'

    function InstallProgress({ job, onReset }) {
      const logRef = useRef(null)
      useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      }, [job.lines.length])
      const un = job.action === 'uninstall'
      const running = job.state === 'running'
      const where = `${job.user}@${job.host}`
      const title = running
        ? (job.phase === 'installing'
          ? (un ? t(`正在从 ${where} 卸载…`, `Uninstalling from ${where}…`) : t(`正在安装到 ${where}…`, `Installing on ${where}…`))
          : t(`正在连接 ${where}…`, `Connecting to ${where}…`))
        : job.state === 'success'
          ? (un ? t('卸载完成', 'Uninstalled') : t('安装完成', 'Installed'))
          : (un ? t('卸载未完成', 'Uninstall did not finish') : t('安装未完成', 'Install did not finish'))
      return h('div', null,
        h('div', { style: S.spread },
          h('div', { style: S.h2 }, title),
          h('span', { style: S.badge(running ? 'accent' : job.state === 'success' ? 'ok' : 'danger') },
            running ? t('进行中', 'Running') : job.state === 'success' ? t('成功', 'Done') : t('失败', 'Failed'))),
        running ? h('div', { style: { ...S.muted, fontSize: 12 } }, un
          ? t('通常不到一分钟。可以关掉这一页，卸载在服务器上继续进行。', 'Usually under a minute. You can close this page — it keeps running on the server.')
          : t('通常需要 3–8 分钟（要下载 Node、DSH 与 Caddy）。可以关掉这一页，安装在服务器上继续进行，回来还能看到进度。',
            'Usually 3–8 minutes (Node, DSH and Caddy are downloaded). You can close this page — the install keeps running on the server and progress is here when you come back.')) : null,
        job.state === 'success' && un
          ? h('div', { style: S.note },
            h('div', null, job.keepData
              ? t('已从服务器移除 dsh-vps 的服务、网关与安装目录；DSH 数据（对话、设置）保留在 /home/dsh/.dsh，重新安装后可继续使用。',
                'The dsh-vps services, gateway and install directory were removed; DSH data (conversations, settings) is kept in /home/dsh/.dsh for a later reinstall.')
              : t('已从服务器移除 dsh-vps 的服务、网关、安装目录和 DSH 数据。', 'The dsh-vps services, gateway, install directory and DSH data were removed from the server.')),
            job.backupPath
              ? h('div', { style: { marginTop: 4 } }, t('删除前的备份：', 'Backup taken before removal: '), h('span', { style: S.code }, job.backupPath))
              : null)
          : null,
        job.state === 'success' && !un
          ? h('div', { style: S.note },
            job.setupUrl
              ? h('div', null,
                /\/setup\?token=/.test(job.setupUrl)
                  ? h('div', null, t('打开下面的链接创建管理员账号（链接含一次性令牌，用过即失效）：',
                    'Open the link below to create the admin account (it carries a one-time token):'))
                  : h('div', null, t('这台服务器之前已经装过，本次按「修复/更新」完成，账号与数据保持不变：',
                    'This server already had dsh-vps; it was repaired/updated in place, accounts and data kept:')),
                h('div', { style: { ...S.row, marginTop: 6 } },
                  h('a', { href: job.setupUrl, target: '_blank', rel: 'noreferrer', style: { ...S.btn('primary'), textDecoration: 'none' } },
                    /\/setup\?token=/.test(job.setupUrl) ? t('打开设置向导', 'Open setup wizard') : t('打开 DSH', 'Open DSH')),
                  h('span', { style: { ...S.code, wordBreak: 'break-all' } }, job.setupUrl)),
                job.domain ? null : h('div', { style: { ...S.muted, fontSize: 12, marginTop: 6 } },
                  t('未填域名时使用自签证书，浏览器会提示“不安全”，选择继续访问即可；之后可在向导里填上域名。',
                    'Without a domain a self-signed certificate is used: the browser warns, proceed anyway; you can add a domain in the wizard later.')))
              : t('已安装。SSH 登录服务器执行 sudo dsh-vps setup-url 取设置链接。', 'Installed. Run sudo dsh-vps setup-url on the server to get the setup link.'))
          : null,
        job.error ? h('div', { style: S.err }, job.error) : null,
        job.lines.length
          ? h('pre', { ref: logRef, style: { ...S.pre, marginTop: 8, maxHeight: 260, overflowY: 'auto' } }, job.lines.join('\n'))
          : null,
        running ? null : h('div', { style: { ...S.row, marginTop: 10 } },
          h('button', { type: 'button', style: S.btn(), onClick: onReset }, job.state === 'success' ? t('完成', 'Done') : t('返回修改', 'Back to the form'))))
    }

    function DeployForm() {
      const [avail, setAvail] = useState('loading') // loading | yes | no
      const [job, setJob] = useState(null)
      const [showForm, setShowForm] = useState(true)
      const [mode, setMode] = useState('install') // install | uninstall
      const [form, setForm] = useState({ host: '', port: '22', user: 'root', password: '', domain: '', mirror: false, keepData: true, purgeCaddy: false })
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [manual, setManual] = useState(false)
      const timer = useRef(null)
      const un = mode === 'uninstall'

      const poll = useCallback(() => {
        clearInterval(timer.current)
        timer.current = setInterval(async () => {
          try {
            const r = await installApi('GET')
            if (r.job) setJob(r.job)
            if (!r.job || r.job.state !== 'running') clearInterval(timer.current)
          } catch {
            // 暂时连不上 DSH：下次再试
          }
        }, 2000)
      }, [])

      useEffect(() => {
        ;(async () => {
          try {
            const r = await installApi('GET')
            if (r.unavailable) return setAvail('no')
            setAvail('yes')
            if (r.job) {
              setJob(r.job)
              setShowForm(false)
              if (r.job.state === 'running') poll()
            }
          } catch {
            setAvail('no')
          }
        })()
        return () => clearInterval(timer.current)
      }, [poll])

      const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

      async function submit(e) {
        e.preventDefault()
        setError(null)
        if (!form.host.trim()) return setError(t('请填写服务器 IP 或域名', 'Enter the server IP or hostname'))
        const target = `${form.user || 'root'}@${form.host.trim()}`
        const msg = un
          ? t(
            `从 ${target} 卸载 DeepSeek Harness（dsh-vps）？\n\n将停止并删除网关与 DSH 服务、安装目录 /opt/dsh-vps、Caddy 站点配置${form.purgeCaddy ? '以及 Caddy 软件包' : ''}，${form.keepData ? '保留' : '并删除'} DSH 数据（对话、设置）。\n删除前会在服务器上打包备份到 /root。此操作不可撤销。`,
            `Uninstall DeepSeek Harness (dsh-vps) from ${target}?\n\nThis stops and removes the gateway and DSH services, /opt/dsh-vps and the Caddy site config${form.purgeCaddy ? ' plus the Caddy package' : ''}, and ${form.keepData ? 'keeps' : 'deletes'} DSH data (conversations, settings).\nA backup is written to /root on the server first. This cannot be undone.`)
          : t(
            `在 ${target} 上安装 DeepSeek Harness（dsh-vps）？\n\n会安装 Node.js、DSH、Caddy 并创建系统服务，占用 80/443 端口。建议用一台新的或专用的服务器。`,
            `Install DeepSeek Harness (dsh-vps) on ${target}?\n\nThis installs Node.js, DSH and Caddy, creates system services and uses ports 80/443. A fresh or dedicated server is recommended.`)
        if (!window.confirm(msg)) return
        setBusy(true)
        try {
          const r = await installApi('POST', { ...form, action: mode, port: Number(form.port) || 22 })
          setForm((f) => ({ ...f, password: '' })) // 密码不在页面里多留
          setJob(r.job)
          setShowForm(false)
          poll()
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }

      if (avail === 'loading') return h('div', { style: S.muted }, t('读取中…', 'Loading…'))
      if (avail === 'no') return h(ManualCommand)
      if (!showForm && job) return h(InstallProgress, { job, onReset: () => { setShowForm(true); setError(null) } })

      const tab = (key, label) => h('button', {
        type: 'button',
        onClick: () => { setMode(key); setError(null) },
        style: {
          ...S.btn(), border: 'none', borderRadius: 0, padding: '6px 14px',
          borderBottom: mode === key ? `2px solid ${key === 'uninstall' ? T.danger : T.accent}` : '2px solid transparent',
          opacity: mode === key ? 1 : 0.6, fontWeight: mode === key ? 600 : 400,
        },
      }, label)

      return h('form', { onSubmit: submit },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, borderBottom: line, marginBottom: 12 } },
          tab('install', t('安装到 VPS', 'Install on a VPS')),
          tab('uninstall', t('从 VPS 卸载', 'Uninstall from a VPS'))),
        un ? h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 10 } },
          t('从服务器上移除 dsh-vps 部署的 DSH：网关、DSH 服务、安装目录与 Caddy 站点配置。删除前自动打包备份到服务器的 /root。',
            'Removes a dsh-vps deployment from the server: the gateway, DSH services, install directory and Caddy site config. A backup is written to /root on the server first.')) : null,
        // 窄窗口（小屏、Windows 上缩小的 DSH 窗口）自动变成一行一个：flex 换行而不是固定两栏
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
          h('div', { style: { flex: '2 1 220px', minWidth: 0 } },
            h(Field, { label: t('服务器 IP 或域名', 'Server IP or hostname'), hint: t('你买的 VPS 的公网地址', 'The public address of your VPS') },
              h('input', { style: inputStyle, value: form.host, onChange: set('host'), placeholder: '1.2.3.4', autoComplete: 'off', spellCheck: false }))),
          h('div', { style: { flex: '1 1 100px', minWidth: 0 } },
            h(Field, { label: t('SSH 端口', 'SSH port') },
              h('input', { style: inputStyle, value: form.port, onChange: set('port'), inputMode: 'numeric' })))),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 } },
          h('div', { style: { flex: '1 1 200px', minWidth: 0 } },
            h(Field, { label: t('用户名', 'Username'), hint: t('建议用 root；其他用户需要免密 sudo', 'root recommended; other users need passwordless sudo') },
              h('input', { style: inputStyle, value: form.user, onChange: set('user'), autoComplete: 'off', spellCheck: false }))),
          h('div', { style: { flex: '1 1 200px', minWidth: 0 } },
            h(Field, { label: t('密码', 'Password'), hint: t('只用这一次，不保存；留空则用本机已有的 SSH 密钥', 'Used once, never stored; leave empty to use your existing SSH key') },
              h('input', { style: inputStyle, type: 'password', value: form.password, onChange: set('password'), placeholder: t('服务器的登录密码', 'server login password'), autoComplete: 'new-password' })))),
        un
          ? h('div', null,
            h('label', { style: { ...S.check, marginTop: 12 } },
              h('input', { type: 'checkbox', checked: form.keepData, onChange: set('keepData'), style: S.checkbox }),
              h('span', null, t('保留 DSH 数据（对话、设置、插件，位于 /home/dsh/.dsh），以后重装可继续使用', 'Keep DSH data (conversations, settings, plugins in /home/dsh/.dsh) for a later reinstall'))),
            h('label', { style: { ...S.check, marginTop: 6 } },
              h('input', { type: 'checkbox', checked: form.purgeCaddy, onChange: set('purgeCaddy'), style: S.checkbox }),
              h('span', null, t('连同 Caddy 软件包一起移除（服务器上还有别的网站在用 Caddy 时不要勾）', 'Also remove the Caddy package (leave unchecked if other sites on the server use Caddy)'))))
          : h('div', null,
            h('div', { style: { marginTop: 12 } },
              h(Field, { label: t('访问域名（可选）', 'Domain (optional)'), hint: t('已把 A 记录解析到这台服务器的域名，填了自动签发 HTTPS 证书；不填先用 IP + 自签证书，之后可在向导里补填', 'A domain whose A record points at this server gets an automatic HTTPS certificate; leave empty to start with the IP and a self-signed certificate') },
                h('input', { style: inputStyle, value: form.domain, onChange: set('domain'), placeholder: 'dsh.example.com', autoComplete: 'off', spellCheck: false }))),
            h('label', { style: { ...S.check, marginTop: 10 } },
              h('input', { type: 'checkbox', checked: form.mirror, onChange: set('mirror'), style: S.checkbox }),
              h('span', null, t('服务器在国内（Node 与 DSH 从 npmmirror 下载）', 'Server is in mainland China (download Node and DSH from npmmirror)')))),
        error ? h('div', { style: S.err }, error) : null,
        h('div', { style: { ...S.row, marginTop: 12 } },
          h('button', {
            type: 'submit',
            style: un ? { ...S.btn(null, busy), borderColor: T.danger, color: T.danger } : S.btn('primary', busy),
            disabled: busy,
          }, busy ? t('连接中…', 'Connecting…') : un ? t('从这台 VPS 卸载', 'Uninstall from this VPS') : t('安装到这台 VPS', 'Install on this VPS')),
          h('button', { type: 'button', style: { ...S.btn(), border: 'none', opacity: 0.75 }, onClick: () => setManual(!manual) },
            manual ? t('收起手动命令', 'Hide manual command') : t('想自己在服务器上执行？', 'Prefer to run it yourself?'))),
        manual
          ? h('div', { style: { marginTop: 8 } }, un
            ? h(CopyLine, { text: UNINSTALL_CMD, note: t('去掉 --keep-data 则连 DSH 数据一起删除；加 --purge-caddy 连 Caddy 一起移除', 'Drop --keep-data to delete DSH data too; add --purge-caddy to remove Caddy as well') })
            : h(ManualCommand))
          : null)
    }

    function DeployGuide() {
      return h('div', { style: S.card },
        h('div', { style: S.h2 }, t('在你的 VPS 上安装 / 卸载 DeepSeek Harness', 'Install / uninstall DeepSeek Harness on your VPS')),
        h('div', { style: { marginBottom: 12 } }, t(
          '填好一台 Ubuntu 22.04+ / Debian 12+ 服务器的登录信息，点「安装到这台 VPS」，就会在上面装好带登录页、自动 HTTPS 的原版 DSH。之后在任何地方用浏览器访问：设置、API Key、插件市场都能正常用，DSH 出新版本时在那边的「设置 → VPS 部署」里一键升级。',
          'Enter the login details of an Ubuntu 22.04+ / Debian 12+ server and click "Install on this VPS" to set up stock DSH there behind a login page with automatic HTTPS. Then use it from any browser — settings, API keys and the plugin market all work, and new DSH releases upgrade with one click under Settings → VPS Deploy over there.')),
        h(DeployForm),
        h('div', { style: { marginTop: 10 } },
          h('a', { href: REPO, target: '_blank', rel: 'noreferrer', style: { color: T.accent } }, t('完整说明（GitHub）', 'Full guide (GitHub)'))))
    }

    // ——————————————————————— 设置页 ———————————————————————

    function SettingsSection() {
      const [mode, setMode] = useState('loading')
      const [info, setInfo] = useState(null)
      const [health, setHealth] = useState(null)

      useEffect(() => {
        let alive = true
        ;(async () => {
          const u = await gateGet('/gate/update')
          if (!alive) return
          if (!u || !('current' in u)) {
            setMode('standalone')
            return
          }
          setInfo(u)
          setMode('deployed')
          const hh = await gateGet('/gate/health')
          if (alive) setHealth(hh)
        })()
        return () => {
          alive = false
        }
      }, [])

      if (mode === 'loading') return h('div', { style: { ...S.root, ...S.muted } }, t('读取中…', 'Loading…'))
      if (mode === 'standalone') return h('div', { style: S.root }, h(DeployGuide))
      return h('div', { style: S.root },
        h(VersionCard, { info, reload: setInfo }),
        h(GatewayCard, { health }),
        h(CommandsCard))
    }

    // ——————————————————————— 注册 ———————————————————————

    const name = 'dsh-vps-client'
    const inject = ['slots']

    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-vps', order: 35, label: () => t('VPS 部署', 'VPS Deploy') }, SettingsSection))
      } catch (error) {
        console.warn('[dsh-vps] 设置页注册失败', error)
      }
    }

    module.exports = { name, inject, apply, __test: { ago, duration, gateGet } }
    return module.exports
  },
})
