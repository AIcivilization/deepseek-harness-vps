# 发布与上架手册

面向维护者。做完下面两件事，本产品会作为「可安装」条目出现在 DSH 插件目录里。

- 一、GitHub 仓库元数据（决定**能不能被发现**）
- 二、npm 发布（决定**能不能被安装**）

---

## 一、GitHub 仓库元数据

### 1. Topics

路径：仓库首页 → 仓库名右侧 **⚙ 齿轮** → Topics 输入框 → 逐个输入回车 → **Save changes**。

GitHub 每个仓库最多 20 个 topic。按重要性排序，前 5 个是真正带来流量的：

```
dsh-plugin              ← 必填：目录站唯一的发现入口，没有它根本不会被扫描
dsh
deepseek
deepseek-harness
vps
self-hosted
selfhosted
one-click-install
deploy
deployment
caddy
reverse-proxy
https
wireguard
tunnel
vpn
nodejs
cli
devops
llm
ai-agent
```

说明：

- `dsh-plugin` 一个都不能少，目录站的采集器是按这个 topic 扫 GitHub 的。
- `selfhosted` 和 `self-hosted` 两个都加——GitHub 上两个拼写都有人搜，加满不亏。
- `wireguard` / `tunnel` / `vpn` 对应我们的「仅我可访问」能力，是同类工具里少有的。
- 不要加与本产品无关的泛词（如 `ai`、`chatgpt`），噪音大且稀释相关性。

### 2. Description 与 Homepage

路径：仓库首页 → About 右侧 ⚙ 齿轮 → Description / Homepage 两项。

- Description 已填（中英双语一段话），无需改动。
- Homepage 已填 `https://github.com/.../#readme`。如果日后启用了官网（如 `dsh-vps.llmkc.com`），改成官网地址。

### 3. Social preview

路径：仓库 **Settings** → 左侧 **General** 拉到底 → **Social preview** → Upload an image。

建议 1280×640。这是仓库链接被分享到微信、X、Slack 时显示的那张卡片图，比 README 首图传播面更广。可以用 `docs/screenshots/07-dsh.png` 加一句标题文字合成。

---

## 二、npm 发布

### 为什么必须发

目录站的判定是三条同时成立：

1. 仓库带 topic `dsh-plugin`（上面第一步）
2. 根目录 `package.json` 的 `version` 是**精确 semver**（写 `^1.4.0` 直接判清单无效）
3. **同名同版本确实发布在 npm 上**，且 npm 元数据的 `repository` 归一化后正是本仓库

缺第 3 条，条目照样会出现在目录里，但会被标成 `availability: unavailable`——看得见、装不了。目录里 1001 个条目中有 562 个卡在这里。

### 路线 A：一次性发布，用动态验证码（OTP）

**验证码从哪来**

它来自你**当初在 npm 开启两步验证时扫码绑定的那个验证器 App**。本账号的 2FA 级别是 `auth-and-writes`（登录和写操作都要验证码），所以发布时必须给。

- 打开手机或电脑上的验证器：Google Authenticator、Authy、1Password、Microsoft Authenticator，苹果自带的「密码」App 也行
- 找到 **npmjs.com**（或 `aicivilization`）那一条
- 取上面显示的 **6 位数字**，每 30 秒变一次

如果完全想不起来当初绑在哪：

1. 打开 <https://www.npmjs.com/settings/aicivilization/security>（ Settings → Account Settings → **Security**）
2. 若还有**恢复码（recovery codes）**，用恢复码登录后可重新绑定 2FA
3. 若恢复码也丢了 → 用 **Modify 2FA** 重新走一遍绑定流程，新扫码的 App 就是以后的验证码来源
4. 嫌麻烦也可以在这一页关掉 **Require two-factor authentication for write actions**，之后发布就不要验证码了——安全性下降，不推荐，但账号是单人自用的话可以接受

**发布命令**

```bash
cd ~/dsh/dsh-vps            # 仓库目录
npm publish --access public --otp=123456
```

把 `123456` 换成验证器上**当前**显示的 6 位数字。手速要快：它以 30 秒为周期，过期就换一个重跑。电脑时间不准也会导致验证码无效（TOTP 基于时间），系统时间记得保持自动同步。

等价写法（重复尝试时省事）：

```bash
export NPM_CONFIG_OTP=123456
npm publish --access public
```

### 路线 B：一劳永逸，让 GitHub Actions 自动发布（推荐）

发完第一次之后就再也不用验证码了——把发布这件事交给 CI。

1. <https://www.npmjs.com> 右上角头像 → **Access Tokens** → **Generate New Token** → **Granular Access Token**
2. 填名字，例如 `dsh-vps-ci`
3. **勾上 `Bypass two-factor authentication`**（默认不勾，不勾的话 CI 照样卡在 OTP）
4. Packages and scopes：权限选 **Read and write (publish and stage)**，包选 `dsh-vps`（若列表里还没有——因为包尚未发布过——先选 **All Packages**，或先走路线 A 发一次再回来改成只授权这一个包）
5. Expiration 选允许的最长值（最长 90 天，到期需重新生成并替换 Secret）
6. **Generate Token** → 立刻复制（只显示这一次）
7. 本仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，名字填 `NPM_TOKEN`，值粘贴刚才那段

之后每次发版：

```bash
# 1. 改 package.json 的 version（必须与 tag 完全一致，多一个 ^ 都不行）
# 2. 提交
git commit -am "chore: bump version to 1.4.1"
# 3. 打 tag 推送，CI 自动发布
git tag -a v1.4.1 -m "v1.4.1：..."
git push origin main --follow-tags
```

工作流 `.github/workflows/publish-npm.yml` 已就位，它会先校验 `tag == package.json 版本`，对不上就拒绝发布，避免在 npm 上留下与仓库不一致的版本号。

### 验证

```bash
npm view dsh-vps version              # 应输出 package.json 里的版本
node scripts/check-catalog.mjs        # 八项收录条件自检
```

再过 ≤6 小时（目录站每 6 小时扫一次），检查是否出现在目录里：

```bash
curl -fsSL https://raw.githubusercontent.com/hrhgit/deepseek-harness-plugin-manager/main/catalog/v2/catalog.json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); \
  print([e for e in d['entries'] if 'deepseek-harness-vps' in e['repositoryFullName']])"
```

期望看到 `availability: available`。

---

## 三、给 dsh-vps-manager 补一遍

同一组织的 `AIcivilization/dsh-vps-manager` 目前也**不在**目录里，缺的同样是 topic `dsh-plugin`。对它重复「一的 1」即可，若也有 npm 包则重复「二」。

---

## 四、一句实话

目录里的「安装」按钮走的是 `dsh plugin install dsh-vps@<版本>`，而我们分发的是 VPS 部署器、不是 Cordis 插件，按钮点下去不会有实际效果（也无害）。目录对我们的价值是**曝光**，真正上手仍是 README 里的 `curl | bash` 或 `npx dsh-vps-install install --domain <域名>`。
