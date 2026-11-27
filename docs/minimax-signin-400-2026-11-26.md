# MiniMax 自动签到 HTTP 400 / 401 排障记录（2026-11-26）

## 现象

面板上 MiniMax Code 卡片显示「上次失败」，红框只有一句 `签到接口返回 HTTP 400`，连续天数与累计分都是空。
`state.json` 里 `providers.minimax.lastAttempt = { ok:false, outcome:'HTTP_ERROR', message:'签到接口返回 HTTP 400' }`，
`days` 全空 —— 这台机器上 MiniMax 从来没签成功过。

## 结论（三条，都实测过）

1. **400 的直接原因：插件没带网关签名头。** 2026-11-26 起，MiniMax 的 `minimax-cloud` 网关先验签再验登录，
   不带 `x-timestamp` / `x-signature` 的请求一律 `HTTP 400 {"error":"invalid signature"}`，token 根本没被看一眼。
   同一 URL、同一 token，唯一变量是这两个头 → 400 消失。
2. **`agent.minimax.io` 上没有签到服务，它只是个 307 转发器。** io 域名下**所有**路径（含 `/`）都回
   `307 → https://agent.minimaxi.com/<同路径>`。按 fetch 规范，跨源重定向会剥掉 `Authorization`，
   所以用 `fetch` 默认跟随时，真正落到服务上的是**没带 token** 的请求，只回一个空体 401 ——
   看起来像「token 不对」，实际是 token 在路上被丢了。改用自己跟跳转、每跳都带 token 之后，
   才看到服务真正的原因：`401 {"error":"invalid access token"}`。
3. **剩下的坎在账号侧，不在代码侧。** 本机这份海外（`prod/en`）设备码登录的 access token，
   用正确签名打到 `agent.minimax.io` / `agent.minimax.cn` / `agent.minimaxi.com` 三个域名，
   全部 `invalid access token`。签到服务挂在 `agent.minimaxi.com`（网页 bundle 里
   `VITE_SITE_ORIGIN:"https://agent.minimaxi.com"`、`REGION:"cn"`、账号服 `account.minimax.cn`）。

## 复现 / 验证命令

复现 400（只读，不领分）——把 `signin.js` 的临时副本换成裸请求即可看到 `invalid signature`；
最小一次性脚本（存这里，别只留在 /tmp）：

```js
// node /tmp/repro.mjs —— 唯一变量：带不带 x-timestamp / x-signature
import { createHash } from 'node:crypto'
const P = '<插件目录>/lib'
const { activeNamespace, readCredential } = await import(`${P}/credentials.js`)
const ns = await activeNamespace()
const token = (await readCredential(ns)).accessToken
const md5 = (s) => createHash('md5').update(s).digest('hex')
const SALT = 'I*7Cf%WZ#S&%1RlZJ&C2'          // 客户端明文常量（网页 bundle 的 axios 拦截器）
const URL_ = 'https://agent.minimax.io/minimax-cloud/api/v1/signin/status?timezone_id=Asia%2FShanghai'
const ts = Math.floor(Date.now() / 1000)
for (const [label, extra] of [['插件现状（无签名）', {}], ['补上签名头', { 'x-timestamp': String(ts), 'x-signature': md5(`${ts}${SALT}`) }]]) {
  const r = await fetch(URL_, { headers: { accept: 'application/json', 'user-agent': 'MiniMaxCode', authorization: `Bearer ${token}`, ...extra } })
  console.log(label, '→ HTTP', r.status, '|', (await r.text()).slice(0, 120))
}
```

跑插件自己的入口看面板文案：

```
node bin/dsh-checkin-all.js checkin minimax --dry
node --test "test/signin-sign.test.js"
```

看 307 与跳转后掉 token：

```
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  -H 'accept: application/json' -H 'user-agent: MiniMaxCode' \
  'https://agent.minimax.io/minimax-cloud/api/v1/config'
```

## 实测数据

| 变量 | 结果 |
|---|---|
| io / 不签名（插件现状） | `HTTP 400 {"error":"invalid signature"}` |
| io / 签名 + Bearer + `redirect:'follow'`（fetch 默认） | `HTTP 401`（空体，实为跳转后丢了 Authorization） |
| io / 签名 + Bearer + `redirect:'manual'` | `HTTP 307 → agent.minimaxi.com/…`（`/` 与 `/config` 一样 307） |
| io / 手动跟跳转、每跳带 token | `HTTP 401 {"error":"invalid access token"}` |
| cn / minimaxi.com + 签名 + 同一个 token | `HTTP 401 {"error":"invalid access token"}` |
| cn / minimaxi.com + 签名 + 乱造 token | `HTTP 401 {"error":"invalid access token"}` |
| POST（带 `{}` 请求体）签名是否被接受 | 是（打到不存在的路径回 `404`，说明已过签名闸） |
| `yy` 头、web 参数全家桶、`Origin/Referer`、Chrome UA、`x-mavis-desktop-channel`、`token=` cookie | 都不改变 401 —— 网关不需要它们 |
| 强制刷新登录（`usableCredential(force)`） | 刷新成功、一次性 RT 正常轮换写回；新 token 打签到仍 401 → 与 token 过期无关 |
| `oauth2/device/code`（`account.minimax.cn` 与 `account.minimax.io`） | 两个区域都能起设备码 → 换 cn 命名空间重登技术上可行 |
| npm `1.2.0`（2026-11-26 13:13Z 发布） | 全包 grep 无 `x-signature`；`lib/signin.js` 与 1.1.0 逐字节相同 → 升级修不了这个 400 |

## 本次改动

- `lib/signin.js`：加 `signRequest()`（`md5(ts + 盐 + 请求体)`，GET 体为空串），
  status / claim / credit/details 三个调用点都带 `x-timestamp` + `x-signature`。
- `lib/signin.js`：加 `fetchKeepingAuth()`，自己跟 307 且每跳都重发 `Authorization` 与签名，
  不再让 fetch 静默丢 token。
- `lib/signin.js`：错误 message 后面拼服务端原文（`reason()`），面板从「HTTP 400」变成
  「HTTP 401（服务端：invalid access token）」这类能定位的文案；`detail` 仍保留原始响应。
- `README.md`：「接口与凭据 → MiniMax Code」一节补签名头、307 丢 token、en token 未被接受三件事。
- `test/signin-sign.test.js`：钉住签名算法的已知答案（盐换了测试会红）。

## 定论（2026-11-26 23:30 补，已真签成功）

在 `prod/cn` 命名空间用 `account.minimax.cn` 的设备码重新登录一次，拿到国内站 token 之后走插件自己的代码路径：

- `fetchPanel` → 通：`scene:1`，7 天表（第 1/2/3/5/6 天 400 分，第 4/7 天 1000 分），今天=第 1 天 `status:2`（可领）。
- `fetchCredits` → 通：`{entries:[], remaining:0, granted:0}`。
- 真 claim（用户确认后跑的）→ `签到成功：第 1 天，+400 分`；面板 `连续 1 天`、`本周已领 1 天，共 400 分`。

所以 401 的原因是**区域/账号**：签到服务只认国内站（`account.minimax.cn` 签出）的 token，
海外（`prod/en`）那份在三个域名上都是 `invalid access token`。token 本身没坏（强制刷新实测成功）。

**要盯的脆弱点**：`activeNamespace()` 取「mtime 最新的凭据」。cn 写回后（23:26）比 en（21:43）新，插件用 cn；
但 MiniMax Code 桌面端自己用的就是 en 那份，它一刷新 en 就变最新 → 签到会立刻掉回 401。
未验证：桌面端在这台机器上会不会主动写 en（最小验证：正常用一会儿 MiniMax Code，
再比 `~/.minimax/auth/prod/{en,cn}/mcode-public/auth.json` 的 mtime）。要稳需要加一个「签到固定用哪个 region」的配置。

## 未验证

- 盐与签名算法来自网页 bundle 明文，随时可能被服务端换掉；真换掉时面板会重新出现
  `invalid signature`，`test/signin-sign.test.js` 也会先红。

