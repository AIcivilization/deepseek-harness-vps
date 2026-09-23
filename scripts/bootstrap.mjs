#!/usr/bin/env node
// 把当前这份 npm 包里自带的安装脚本跑起来——不联网抓取，装的就是这个版本的内容。
// install.sh 自带“本地文件优先”逻辑，所以这里只要把工作目录指向包根目录即可。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scripts = {
  install: join(root, 'install.sh'),
  uninstall: join(root, 'uninstall.sh'),
}
const usage = `dsh-vps-install — 用 npm 包里的脚本安装/卸载 dsh-vps

用法:
  npx dsh-vps-install install --domain <域名> [--mirror cn]
  npx dsh-vps-install uninstall [--yes]

等价的传统方式（不需要 npm）:
  curl -fsSL https://raw.githubusercontent.com/AIcivilization/deepseek-harness-vps/main/install.sh | sudo bash -s -- --domain <域名>
`

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(usage)
  process.exit(args.length === 0 ? 1 : 0)
}

const action = args[0]
const target = scripts[action]
if (!target) {
  process.stderr.write(`未知子命令: ${action}\n\n${usage}`)
  process.exit(1)
}
if (!existsSync(target)) {
  process.stderr.write(`缺少脚本: ${target}（npm 包不完整，请重新安装 dsh-vps）\n`)
  process.exit(1)
}

const rest = args.slice(1)
const elevated = typeof process.getuid === 'function' && process.getuid() === 0
const command = elevated ? 'bash' : 'sudo'
const argv = elevated ? [target, ...rest] : ['--', 'bash', target, ...rest]
if (!elevated) {
  process.stdout.write('[dsh-vps] 需要 root 权限，将通过 sudo 执行，可能会提示输入密码。\n')
}

const result = spawnSync(command, argv, { stdio: 'inherit', shell: false })
if (result.error) {
  process.stderr.write(`执行失败: ${result.error.message}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
