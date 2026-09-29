// plugin/index.mjs — DSH 插件入口（设置 → VPS 部署）
//
// 本包首先是 VPS 部署工具（install.sh / gate / dsh-vps 命令）；同时也是一个 DSH 插件，
// 装进 DSH 后在设置里加一页「VPS 部署」：
//   - 在 dsh-vps 部署的 DSH 里：查看 DSH 版本并一键升级、网关状态、访问方式
//   - 在其他 DSH 里：把 DSH 部署到自己 VPS 的一键命令与说明
//
// 界面全部在 plugin/client.js；数据来自同源的 gate 接口（/gate/update、/gate/health），
// 由网关自己做登录校验。宿主侧无需注册任何服务，这里只是插件入口。

export const name = 'dsh-vps'

export function apply() {}

export default { name, apply }
