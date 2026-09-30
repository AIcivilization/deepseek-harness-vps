// plugin/index.mjs — DSH 插件入口（设置 → VPS 部署）
//
// 本包首先是 VPS 部署工具（install.sh / gate / dsh-vps 命令）；同时也是一个 DSH 插件，
// 装进 DSH 后在设置里加一页「VPS 部署」：
//   - 在 dsh-vps 部署的 DSH 里：查看 DSH 版本并一键升级、网关状态、访问方式
//     （数据来自同源的 gate 接口 /gate/update、/gate/health，由网关自己做登录校验）
//   - 在其他 DSH 里：填服务器信息，经 SSH 把 dsh-vps 装到那台 VPS 上（remote-install.mjs）
//
// 安装接口挂在 DSH 的 /api 通道（ctx.connection.fetch）：DSH 自己做 Host/Origin 围栏与
// 登录校验，跨站网页调不到。connection 服务缺席（旧版 DSH）时不注册，界面退回「复制命令」。

import { createInstaller, validateRequest } from './remote-install.mjs'

export const name = 'dsh-vps'

const INSTALL_PATH = '/api/dsh-vps.install'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export function apply(ctx) {
  ctx.inject(['connection'], (connCtx) => {
    const fetchApi = connCtx.connection?.fetch
    if (!fetchApi || typeof fetchApi.register !== 'function') return
    const installer = createInstaller()
    connCtx.effect(() => () => installer.dispose(), 'dsh-vps: installer')
    try {
      fetchApi.register({
        path: INSTALL_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method === 'GET') return json(installer.snapshot())
          let body
          try {
            body = await request.json()
          } catch {
            return json({ error: '请求格式不对' }, 400)
          }
          const checked = validateRequest(body)
          if (checked.error) return json({ error: checked.error }, 400)
          const result = await installer.start(checked.value)
          if (result.error) return json({ error: result.error }, result.status || 400)
          return json(result, 202)
        },
      })
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-vps] 安装接口注册失败：${error?.message ?? error}`)
    }
  })
}

export default { name, apply }
