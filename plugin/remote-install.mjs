// plugin/remote-install.mjs — 从这台 DSH 经 SSH 把 dsh-vps 装到（或卸出）指定的 VPS
//
// 设置 → VPS 部署 的表单填好服务器信息后调用；action 为 install 或 uninstall。要点：
//   - 密码只进这一次 ssh 子进程的环境变量，经 SSH_ASKPASS 小脚本交给 ssh：不写盘、不进日志、
//     不保存（与 dsh-vps-manager「添加机器」同一做法）。不填密码则用本机已有的 SSH 密钥
//   - 安装在服务器上以 nohup + setsid 后台运行，日志写 /var/log/dsh-vps-install.log；
//     这边只是 tail 它。SSH 中途断开，安装照样跑完
//   - 同一时间只跑一个安装任务；结果（含带一次性令牌的设置链接）留在内存里供界面轮询
//
// 路由挂在 DSH 的 /api 通道（ctx.connection.fetch），由 DSH 自己做同源与登录校验。

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const RAW_BASE = 'https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main'
const ACTIONS = {
  install: { script: `${RAW_BASE}/install.sh`, log: '/var/log/dsh-vps-install.log' },
  uninstall: { script: `${RAW_BASE}/uninstall.sh`, log: '/var/log/dsh-vps-uninstall.log' },
}
const JOB_TIMEOUT_MS = 40 * 60_000
const MAX_LINES = 400

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[?[0-9A-Fa-f:.]+\]?)$/
const DOMAIN_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/

/** 校验并规整表单；返回 { value } 或 { error }（界面直接展示 error） */
export function validateRequest(body) {
  const b = body && typeof body === 'object' ? body : {}
  const host = String(b.host ?? '').trim().replace(/^\[|\]$/g, '')
  const port = Number(b.port ?? 22)
  const user = String(b.user ?? 'root').trim() || 'root'
  const password = typeof b.password === 'string' ? b.password : ''
  const action = b.action === 'uninstall' ? 'uninstall' : 'install'
  const domain = action === 'install' ? String(b.domain ?? '').trim().toLowerCase() : ''
  const mirror = action === 'install' && b.mirror === true
  // 卸载默认保留 DSH 数据（对话、设置）：不勾才删
  const keepData = action === 'uninstall' && b.keepData !== false
  const purgeCaddy = action === 'uninstall' && b.purgeCaddy === true
  if (!host || host.length > 253 || !HOST_RE.test(host)) return { error: '服务器地址格式不对（填公网 IP 或能解析到它的域名）' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'SSH 端口应为 1–65535' }
  if (!USER_RE.test(user)) return { error: '用户名格式不对' }
  if (password.length > 1024) return { error: '密码太长' }
  if (domain && (domain.length > 253 || !DOMAIN_RE.test(domain))) return { error: '访问域名格式不对（例如 dsh.example.com）' }
  return { value: { action, host, port, user, password, domain, mirror, keepData, purgeCaddy } }
}

/** 传给 install.sh / uninstall.sh 的参数 */
export function scriptArgs({ action = 'install', domain, mirror, keepData, purgeCaddy }) {
  if (action === 'uninstall') return ['--yes', ...(keepData ? ['--keep-data'] : []), ...(purgeCaddy ? ['--purge-caddy'] : [])]
  return [...(domain ? ['--domain', domain] : []), ...(mirror ? ['--mirror', 'cn'] : [])]
}

/** 服务器上执行的脚本（经 stdin 交给 sh -s，参数不进命令行） */
export function remoteScript(opts) {
  const { script, log } = ACTIONS[opts.action === 'uninstall' ? 'uninstall' : 'install']
  const args = scriptArgs(opts)
  // 参数已按正则校验（仅字母数字、点、横线），这里仍逐个单引号包起来
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
  return [
    'set -u',
    'if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo -n"; $SUDO true 2>/dev/null || { echo "DSHVPS_ERR=need_root"; exit 3; }; fi',
    'if command -v curl >/dev/null 2>&1; then FETCH="curl -fsSL"; elif command -v wget >/dev/null 2>&1; then FETCH="wget -qO-"; else echo "DSHVPS_ERR=no_fetch"; exit 4; fi',
    `L=${log}`,
    '$SUDO rm -f "$L"',
    // 后台独立运行：SSH 断开不影响安装/卸载；结束时在日志末尾写退出码
    `$SUDO nohup setsid sh -c 'L="$1"; F="$2"; U="$3"; shift 3; { $F "$U" | bash -s -- "$@"; echo "DSHVPS_EXIT=$?"; } >>"$L" 2>&1' dshvps "$L" "$FETCH" '${script}' ${quoted} </dev/null >/dev/null 2>&1 &`,
    'P=$!',
    'for i in 1 2 3 4 5 6 7 8 9 10; do [ -f "$L" ] && break; sleep 1; done',
    'echo "DSHVPS_STARTED"',
    '$SUDO tail -n +1 -f --pid="$P" "$L" 2>/dev/null',
    '$SUDO tail -n 3 "$L" 2>/dev/null | grep "^DSHVPS_EXIT=" || true',
  ].join('\n') + '\n'
}

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '')

/** 从安装输出里取带令牌的设置链接（install.sh 结尾打印「访问地址  : https://…/setup?token=…」） */
export function findSetupUrl(text) {
  const m = /https:\/\/[^\s]+\/setup\?token=[A-Za-z0-9]+/.exec(text)
  if (m) return m[0]
  const a = /访问地址\s*:\s*(https:\/\/\S+)/.exec(text)
  return a ? a[1] : null
}

/** 卸载输出里的备份位置（uninstall.sh 结尾打印「备份：/root/dsh-vps-uninstall-….tar.gz」） */
export function findBackupPath(text) {
  const m = /备份[：:]\s*(\/\S+\.tar\.gz)/.exec(text)
  return m ? m[1] : null
}

/** 本机找不到 ssh 时告诉用户怎么装（与 dsh-vps-manager 同一说法） */
export function noSshClientHint(platform = process.platform) {
  return platform === 'win32'
    ? '本机找不到 ssh 命令：打开 Windows「设置 → 系统 → 可选功能」，添加「OpenSSH 客户端」，装好后重启 DSH'
    : '本机找不到 ssh 命令：先装 OpenSSH 客户端，装好后重启 DSH'
}

/** ssh 失败说人话 */
export function classifyFailure(stderr, exitCode, usedPassword, platform = process.platform) {
  const t = String(stderr)
  if (/\bENOENT\b/.test(t)) return noSshClientHint(platform)
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(t)) {
    return '服务器的 SSH 指纹和本机记录的不一致（重装过系统？）。确认无误后在本机执行 ssh-keygen -R <服务器地址> 再试'
  }
  if (/Permission denied \(publickey\)/i.test(t) && usedPassword) return '这台服务器关掉了密码登录，只认密钥：把密码留空，用本机已配置好的 SSH 密钥登录'
  if (/Permission denied/i.test(t)) return usedPassword ? '密码不对，或这个用户不允许用密码登录（有的系统默认禁止 root 密码登录）' : '本机的 SSH 密钥登录不了这台服务器：填上密码再试'
  if (/Could not resolve hostname/i.test(t)) return '服务器地址解析不了，检查一下是否填错'
  if (/Connection closed by|Connection reset by|kex_exchange_identification/i.test(t)) {
    return '服务器断开了 SSH 连接：确认端口确实是 SSH 端口，以及服务器防火墙、fail2ban 是否拦截了本机的地址'
  }
  if (/Connection refused/i.test(t)) return 'SSH 端口拒绝连接：检查端口号，以及服务器防火墙/安全组是否放行'
  if (/timed out|No route to host|Network is unreachable/i.test(t)) return '连不上服务器：检查地址和端口，以及云厂商安全组是否放行 SSH'
  if (exitCode === 3) return '这个用户不是 root，也没有免密 sudo。请改用 root，或先给该用户配置免密 sudo'
  if (exitCode === 4) return '服务器上既没有 curl 也没有 wget，先装上其中一个再试'
  const last = t.replace(/\r/g, '').trim().split('\n').filter((l) => l && !/^Warning: Permanently added/i.test(l)).pop()
  return last ? `SSH 连接失败：${last}` : `SSH 连接失败（退出码 ${exitCode}）`
}

/** 安装任务：同一时间只有一个 */
export function createInstaller({ spawnImpl = spawn, platform = process.platform, env = process.env, now = Date.now } = {}) {
  let job = null

  function snapshot() {
    if (!job) return { job: null }
    const { child, timer, ...rest } = job
    return { job: { ...rest, lines: job.lines.slice(-MAX_LINES) } }
  }

  async function start(value) {
    if (job && job.state === 'running') return { error: '已经有一个任务在进行中，等它结束再试', status: 409 }
    const { host, port, user, password, domain, mirror, keepData, purgeCaddy } = value
    const action = value.action === 'uninstall' ? 'uninstall' : 'install'
    const remoteLog = ACTIONS[action].log
    const verb = action === 'uninstall' ? '卸载' : '安装'
    job = {
      action, state: 'running', host, port, user, domain, mirror, keepData, purgeCaddy,
      startedAt: now(), endedAt: null, lines: [], setupUrl: null, backupPath: null, error: null, phase: 'connecting',
    }
    const current = job
    const target = `${user}@${host.includes(':') ? `[${host}]` : host}`
    const args = [
      '-T', '-p', String(port),
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=8',
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      // 不压低日志级别：「Connection closed」「timed out」这类关键原因是 INFO 级，压到 ERROR 就只剩退出码 255
    ]
    let askDir = null
    const childEnv = { ...env }
    if (password) {
      askDir = await mkdtemp(join(tmpdir(), 'dsh-vps-askpass-'))
      const helper = join(askDir, platform === 'win32' ? 'askpass.cmd' : 'askpass.sh')
      if (platform === 'win32') {
        await writeFile(helper, `@set ELECTRON_RUN_AS_NODE=1\r\n@"${process.execPath}" -e "process.stdout.write(process.env.DSH_VPS_PW+'\\n')"\r\n`)
      } else {
        await writeFile(helper, '#!/bin/sh\nprintf \'%s\\n\' "$DSH_VPS_PW"\n', { mode: 0o700 })
      }
      args.push('-o', 'PreferredAuthentications=keyboard-interactive,password', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1')
      Object.assign(childEnv, { SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: env.DISPLAY || ':0', DSH_VPS_PW: password })
    } else {
      args.push('-o', 'BatchMode=yes')
    }
    args.push('--', target, 'sh -s')

    let child
    try {
      // windowsHide：Windows 上的 DSH（含桌面版）启动 ssh 时不弹控制台窗口
      child = spawnImpl('ssh', args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      if (askDir) rm(askDir, { recursive: true, force: true }).catch(() => {})
      current.state = 'failed'
      current.error = /ENOENT/.test(String(error.message)) ? noSshClientHint(platform) : `无法启动 ssh：${error.message}`
      current.endedAt = now()
      return { job: snapshot().job }
    }
    current.child = child
    let stderr = ''
    let buf = ''
    // 按完整字符解码：汉字可能被切在两个数据块之间
    const outDec = new StringDecoder('utf8')
    const errDec = new StringDecoder('utf8')
    const push = (line) => {
      const clean = strip(line)
      if (clean === 'DSHVPS_STARTED') {
        current.phase = 'installing'
        return
      }
      current.lines.push(clean)
      if (current.lines.length > MAX_LINES * 2) current.lines.splice(0, current.lines.length - MAX_LINES)
      if (action === 'install' && !current.setupUrl) current.setupUrl = findSetupUrl(clean)
      if (action === 'uninstall' && !current.backupPath) current.backupPath = findBackupPath(clean)
    }
    child.stdout.on('data', (d) => {
      buf += outDec.write(d)
      const parts = buf.split('\n')
      buf = parts.pop()
      for (const p of parts) push(p)
    })
    child.stderr.on('data', (d) => {
      stderr = (stderr + errDec.write(d)).slice(-4000)
    })
    const finish = (code) => {
      if (current.endedAt) return
      clearTimeout(current.timer)
      if (buf) push(buf)
      if (askDir) rm(askDir, { recursive: true, force: true }).catch(() => {})
      current.endedAt = now()
      const exitLine = current.lines.find((l) => /^DSHVPS_EXIT=\d+/.test(l))
      current.lines = current.lines.filter((l) => !/^DSHVPS_(EXIT|ERR)=/.test(l))
      const remoteExit = exitLine ? Number(exitLine.split('=')[1]) : null
      if (remoteExit === 0) {
        current.state = 'success'
      } else if (remoteExit !== null) {
        current.state = 'failed'
        current.error = `${verb}脚本执行失败（退出码 ${remoteExit}），详见下方日志；服务器上的完整日志：${remoteLog}`
      } else if (current.phase === 'installing') {
        current.state = 'failed'
        current.error = action === 'uninstall'
          ? `与服务器的连接中断了，但卸载仍在服务器上继续运行。稍后 SSH 登录执行 sudo tail -n 50 ${remoteLog} 查看结果`
          : `与服务器的连接中断了，但安装仍在服务器上继续运行。稍后 SSH 登录执行 sudo tail -n 50 ${remoteLog} 查看结果，或执行 sudo dsh-vps setup-url 取设置链接`
      } else {
        current.state = 'failed'
        current.error = classifyFailure(stderr, code, Boolean(password), platform)
      }
    }
    child.on('error', (error) => {
      stderr += `\n${error.message}`
      finish(255)
    })
    child.on('close', (code) => finish(code))
    current.timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // 已退出
      }
    }, JOB_TIMEOUT_MS)
    child.stdin.end(remoteScript({ action, domain, mirror, keepData, purgeCaddy }))
    return { job: snapshot().job }
  }

  function dispose() {
    if (job?.child && !job.endedAt) {
      try {
        job.child.kill('SIGTERM')
      } catch {
        // 已退出
      }
    }
  }

  return { start, snapshot, dispose }
}
