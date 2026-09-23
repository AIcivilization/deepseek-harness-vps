import https from 'node:https'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const get = url => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'user-agent': 'dsh-vps-catalog-check' } }, res => {
    let body = ''
    res.on('data', c => { body += c })
    res.on('end', () => resolve({ status: res.statusCode, body }))
  }).on('error', reject)
})

const ok = b => (b ? '[OK]  ' : '[缺]  ')
const root = process.env.DSHVPS_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(root + '/package.json', 'utf8'))
const canonicalFrom = v => String(v || '').replace(/^git\+/, '').replace(/\.git$/, '').toLowerCase()
const expected = 'https://github.com/aicivilization/deepseek-harness-vps'

console.log('== DSH 目录站（catalog/v2）收录自检 ==')
const nameOk = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name)
const versionOk = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(pkg.version)
let homepageOk = false
try { homepageOk = new URL(pkg.homepage).toString().length > 0 } catch {}

console.log(ok(nameOk) + '包名为合法 npm 名: ' + pkg.name)
console.log(ok(versionOk) + 'version 为精确 semver: ' + pkg.version)
console.log(ok(homepageOk) + 'homepage 是合法 URL')
console.log(ok(canonicalFrom(pkg.repository?.url) === expected) + 'repository 归一化为仓库地址')

const gh = await get('https://api.github.com/repos/AIcivilization/deepseek-harness-vps')
const g = JSON.parse(gh.body)
const topics = g.topics ?? []
console.log(ok(topics.includes('dsh-plugin')) + 'GitHub 主题含 dsh-plugin（当前: ' + (topics.length ? topics.join(', ') : '无') + '）')
console.log(ok(Boolean(g.description)) + '仓库 description: ' + (g.description ?? '（空）'))
console.log(ok(Boolean(g.homepage)) + '仓库 homepage: ' + (g.homepage ?? '（空）'))

const n = await get('https://registry.npmjs.org/' + encodeURIComponent(pkg.name))
if (n.status !== 200) {
  console.log(ok(false) + 'npm 上还没有 ' + pkg.name + '（HTTP ' + n.status + '）')
} else {
  const d = JSON.parse(n.body)
  const v = d.versions[pkg.version]
  console.log(ok(Boolean(v)) + 'npm 已发布 ' + pkg.name + '@' + pkg.version)
  if (v) {
    const repoField = typeof v.repository === 'string' ? v.repository : v.repository?.url
    console.log(ok(canonicalFrom(repoField) === expected) + 'npm 元数据 repository 指向本仓库')
  }
}
