# dsh-checkin-all

[![npm](https://img.shields.io/npm/v/dsh-checkin-all?style=flat-square&logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-checkin-all)
[![npm downloads](https://img.shields.io/npm/dm/dsh-checkin-all?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-checkin-all)
[![license](https://img.shields.io/npm/l/dsh-checkin-all?style=flat-square&color=green)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-checkin-all?style=flat-square&logo=node.js)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0-4B32C3?style=flat-square)](https://github.com/deepseek-ai/dsh)
[![tests](https://img.shields.io/badge/tests-124%20passing-brightgreen?style=flat-square)](./test)
[![services](https://img.shields.io/badge/%E5%86%85%E7%BD%AE%E6%9C%8D%E5%8A%A1-9-2f6bff?style=flat-square)](#支持的服务)

**签到 / 自动签到 / 每日签到 / 打卡 / 领积分 / 多账号 / DIY 自定义签到 / DeepSeek Harness 插件**

每天自动给 **MiniMax Code**、**WPS 灵犀**、**百度 DuMate（搭子）**、**AStudio（星火）**、**Qoder**、**Trae**、**豆包**、**华为 CodeArts**、**腾讯 WorkBuddy** 签到领积分。

**没在列表里的服务，可以自己 DIY 签到**——面板点「＋ 添加签到服务」，让 DSH 的 AI 帮你查接口，或直接贴一份 JSON，导入就变成新卡片。

**每个服务都支持多账号**：同一个服务配多个号，逐个签、分别记账，一个失败不影响其他。

装进 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（dsh）之后，它会用本机 App 已经存好的登录凭据，每天到点调一次官方签到接口，签完记账，面板挂在对话页右侧栏。

> 你不用记着签，也不用把账号密码交给任何东西——凭据本来就是 App 自己存的（MiniMax Code 在 `~/.minimax/auth/`，灵犀和搭子在各自的 Cookies 里）。

> **为什么要自动签**：灵犀的连续签到断一天就归零（回退到第 1 天）。手动记着签太容易忘，这个插件就是替你记住的那一下。

## 三个重点能力

### 1. 内置 9 个服务，开箱即用

装上就能签，凭据自动从本机 App 里读，不用手动配。详见下方「支持的服务」。

### 2. 没有的服务？自己 DIY 一个

内置之外还有一堆能签到的站点。面板底部有 **「＋ 添加签到服务」**，两条路：

**让 DSH 的 AI 帮你做**（推荐）

```
点「＋ 添加签到服务」→ 复制提示词 → 粘到 DSH 对话
→ 告诉 AI 是哪个 App / 网站、本机哪里登录着
→ AI 帮你查接口，给一段 JSON
→ 回来「粘贴定义」贴进去 → 立刻多一张卡片
```

**自己写定义**（知道接口长什么样的话）

一份 JSON 描述接口就行，不用改代码：

```json
{
  "id": "kuaKe",
  "name": "夸克网盘",
  "short": "夸克",
  "color": "#0ea5e9",
  "unit": "积分",
  "checkin": { "method": "POST", "url": "https://example.com/api/checkin",
               "headers": { "cookie": "{{cookie}}" } },
  "status":  { "url": "https://example.com/api/status",
               "claimedPath": "data.checked_in_today",
               "pointsPath": "data.today_points" },
  "successPath": "code",
  "successValue": 0
}
```

导入后它和内置服务**完全一样**：参与自动签到、有卡片、能记账、支持多账号。

> 限制：只覆盖「一个 HTTP 请求 + 一个状态查询」这种形态。需要签名（如华为云 HMAC）或多步流程的服务，还是得写代码。

### 3. 每个服务支持多账号

同一个服务可以配多个账号，签到时会逐个签、分别汇报。

```
面板「账号」卡片 → 填凭据 → 添加账号（可加备注名区分主号 / 小号）
```

命令行也行：

```bash
node bin/dsh-checkin-all.js set lingxi "<sid>" --name 主号
node bin/dsh-checkin-all.js set lingxi "<sid>" --name 小号
```

汇总规则：任一账号签上就算成功，积分累加，连续天数取最大值；单个账号失败不影响其他账号，消息里会点名是哪个失败。

支持多账号的：灵犀、DuMate、AStudio、Qoder、Trae、豆包、CodeArts、WorkBuddy，以及**所有 DIY 的自定义服务**。
（MiniMax 例外：凭据是 App 的 OAuth 文件且 refresh token 一次性，不适合多账号。）

## 支持的服务

| 服务 | 凭据来源 | 签到单位 | 多账号 | 「今天」按哪算 |
| --- | --- | --- | :---: | --- |
| MiniMax Code | `~/.minimax/auth/`（OAuth） | 分 | — | **北京时间** |
| WPS 灵犀 | 灵犀自己的 Cookies（`wps_sid`） | 智点 | ✅ | **北京时间** |
| 百度 DuMate | `qianfan-desktop-app/auth.json`（加密 cookie） | 积分 | ✅ | **北京时间** |
| AStudio | `~/.acode/acode/userdata/astron-session.json` | 积分 | ✅ | **北京时间** |
| Qoder | 本机 Qoder App 登录（自动读），或面板填 PAT | 积分 | ✅ | **北京时间** |
| Trae | 本机 Trae App/CLI 登录（自动读） | 积分 | ✅ | **北京时间** |
| 豆包 | 登录 Cookie（面板「配置 Cookie」，或从本机豆包/浏览器读） | 额度 | ✅ | **北京时间** |
| 华为 CodeArts | 浏览器登录（点一下授权，自动拿 AK/SK；也可手填） | 积分 | ✅ | **北京时间** |
| 腾讯 WorkBuddy | 浏览器登录（点一下授权；也可手贴 token） | 积分 | ✅ | **北京时间** |
| **自定义服务** | 面板「添加签到服务」，AI 生成或自己贴 JSON | 自定义 | ✅ | **北京时间** |

**全部服务一律按北京时间算「今天」和签到窗口，不跟随本机时区。**

（早期版本里 MiniMax 跟本机时区，结果美西晚上 8 点之后本机还是 4 号、北京已经是 5 号，
两条口径对不上，会出现重复签和连续天数错乱。现在统一成北京时间，本机在哪都一样。）

## 它做什么

- **每个服务每天到点自动签到**：默认 09:00，可给每个服务单独设时间
- **多账号**：同一个服务能配多个账号，逐个签、分别汇报，一个失败不影响其他
- **自定义服务**：面板「＋ 添加签到服务」，让 AI 查接口或自己贴 JSON，导入即成卡片
- **紧凑卡片**：每张卡两行——彩色服务名 + 连续天数 / 登录状态 + 今日签到
- **折叠**：未登录、无任务、还没到轮次的自动收起来，点一下展开
- **拖动排序**：拖卡片换位置，顺序记在本机
- **补签**：电脑睡过了、DSH 半夜才启动，醒来照样补上（可关）
- **不重复签**：今天已经签过（哪怕你是在 App 里点的）就不动
- **失败退避**：连续失败会拉长重试间隔（1/2/4/8/16/32 分钟），失败 6 次当天停手，不会白刷接口
- **自动续期**：access token 快过期时用 refresh token 换新的并**写回 App 的位置**，App 那边不受影响
- **记账**：每个服务分开记连续天数、累计积分、最近 14 天每天的结果
- **对话里能用**：说「帮我签到」「MiniMax 积分还有多少」「以后每天 8 点签」就行
- **登录兜底**：凭据失效时给一个设备码或浏览器授权（CodeArts / WorkBuddy），点一下就好

## 安装

```bash
# 从 npm（推荐）
dsh plugin --profile desktop add dsh-checkin-all

# 或者从仓库
git clone https://github.com/AIcivilization/dsh-checkin-all.git
dsh plugin --profile desktop add /path/to/dsh-checkin-all
```

完全退出 DSH（macOS 按 Cmd+Q，不是关窗口）再重新打开。

装好后打开对话页右侧栏，引导页里点「自动签到」；或者「设置 → 自动签到」。

## 命令行

不开 DSH 也能用：

```bash
node bin/dsh-checkin-all.js status          # 每个服务：登录状态 + 本周签到表 + 连续天数
node bin/dsh-checkin-all.js checkin         # 全部签到（--dry 只看不领）
node bin/dsh-checkin-all.js checkin lingxi  # 只签灵犀（或 minimax / dumate / astudio / qoder / trae / doubao）
node bin/dsh-checkin-all.js login           # 设备码登录 MiniMax Code
node bin/dsh-checkin-all.js time 08:30      # 改自动签到时间
node bin/dsh-checkin-all.js on | off        # 开 / 关自动签到
```

### 手动配置凭据（VPS 等没有 App 的机器）

灵犀、搭子、AStudio、Trae 默认读本机 App 的登录文件；在 VPS 上或没有装对应 App 时，
可以手动配置凭据（存 `~/.dsh/dsh-checkin-all/secrets.json`，0600）：

```bash
node bin/dsh-checkin-all.js set lingxi  "<wps_sid>"
node bin/dsh-checkin-all.js set dumate  "<完整 Cookie 串，含 bce-user-info>"
node bin/dsh-checkin-all.js set astudio "<accountId>,<token>,<ssoSessionId>"
node bin/dsh-checkin-all.js set trae    "<Cloud-IDE-JWT token>"
node bin/dsh-checkin-all.js set codearts "<access_key_id>,<secret_access_key>,<security_token>"

node bin/dsh-checkin-all.js unset lingxi   # 删除某个服务的手动凭据，回退到 App 文件
```

手动配置优先于 App 文件；删掉手动凭据后自动回退读 App。

也可以在面板里操作：打开对话页右侧栏「自动签到」，切到对应服务卡，点「配置凭据」，粘贴值保存即可（清除后回退 App 文件）。

### 不依赖 DSH 常驻：挂到系统 crontab

```cron
0 9 * * * /usr/local/bin/node /Users/wf/dsh/dsh-checkin-all/bin/dsh-checkin-all.js cron >> ~/.dsh/dsh-checkin-all/cron.log 2>&1
```

`cron` 是静默模式：今天签过了就什么都不做，只在真签的时候输出一行。

> 注意：cron 的时间是**本机时区**，但插件判断「今天」和签到窗口是**北京时间**。
> 本机在美国时，想在北京时间 09:00 签，cron 要写成本机对应的时刻（美西 = 前一天 17:00）。

## 在对话里

| 你说 | 会发生什么 |
| --- | --- |
| 帮我签到 / 领一下积分 | 调 `minimax_checkin`，三个服务都签（也可只签一个） |
| 灵犀连续多少天了 / 签到情况 | 调 `minimax_checkin_status`，给每个服务的一周表、连续天数 |
| 以后每天 8 点自动签 | 调 `minimax_checkin_config`，改时间（可只改一个服务） |
| MiniMax 登录失效了 | 调 `minimax_login`，给设备码和网址 |

命令：`/checkin 状态｜签到 [服务]｜时间 09:00｜开启｜关闭｜登录`（`/minimax` 是别名）

服务名：`minimax`（MiniMax Code）/ `lingxi`（WPS 灵犀）/ `dumate`（百度 DuMate）/ `astudio`（AStudio）/ `qoder`（Qoder）/ `trae`（Trae）/ `doubao`（豆包）/ `codearts`（华为 CodeArts）/ `buddy`（腾讯 WorkBuddy）

## 加新的签到服务（不写代码）

内置 9 个服务，但外面还有一堆能签到的站点。面板底部有个 **「＋ 添加签到服务」**，
点开有两条路：

### 方式一：让 DSH 的 AI 帮你做（推荐）

1. 点「添加签到服务」→ 复制那段提示词
2. 粘到 DSH 对话里，告诉 AI 是哪个 App / 网站、本机哪里登录着
3. AI 帮你查接口，最后给一段 JSON
4. 回来切到「粘贴定义」，把 JSON 整段贴进去 → 导入

导入后**立刻变成一张新卡片**，和内置服务一样参与自动签到。

### 方式二：自己写定义

如果你已经知道接口长什么样，直接粘这份 JSON：

```json
{
  "id": "kuaKe",
  "name": "夸克网盘",
  "short": "夸克",
  "color": "#0ea5e9",
  "unit": "积分",
  "checkin": {
    "method": "POST",
    "url": "https://example.com/api/checkin",
    "headers": { "referer": "https://example.com/", "cookie": "{{cookie}}" },
    "body": { "type": "daily" }
  },
  "status": {
    "method": "GET",
    "url": "https://example.com/api/status",
    "claimedPath": "data.checked_in_today",
    "pointsPath": "data.today_points"
  },
  "successPath": "code",
  "successValue": 0,
  "alreadyPath": "data.already",
  "messagePath": "message"
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，字母开头，字母数字下划线连字符，2~32 位，不能和内置重名 |
| `short` / `color` / `unit` | 卡片上的名字、品牌色、积分单位 |
| `checkin` | 签到请求：method / url / headers / body |
| `status` | 状态查询（可选）：怎么看出今天签没签、得了多少 |
| `claimedPath` | 从响应里取「今天签没签」的路径，如 `data.checked_in_today` |
| `pointsPath` | 从响应里取「今天得了多少」 |
| `successPath` / `successValue` | 成功的判据，如 `code` 等于 `0` |
| `alreadyPath` | 这个字段为 true 表示今天已签（跳过重复请求） |

**路径写法**：点号分隔，数组下标用 `[0]`，例如 `data.list[0].status`。

**凭据**：在卡片详情的「账号」里填，字段名随便叫（`cookie` / `token` / `key`），
然后在 `url` / `headers` / `body` 里用 `{{字段名}}` 引用。这样一份定义能配多个账号。

定义存在 `~/.dsh/dsh-checkin-all/custom-services.json`（0600），可以随时删。

## 多账号

**每个服务都能配多个账号**，签到时会逐个签，结果分别汇报。

面板里：切到对应服务 → 「账号」卡片 → 填凭据 → 点「添加账号」。想区分就在「备注名」里写「主号 / 小号」。
已配的账号列在上面，每个后面有「删除」。

命令行：

```bash
# 加账号（同一个服务可以加多次）
node bin/dsh-checkin-all.js set lingxi "<wps_sid>" --name 主号
node bin/dsh-checkin-all.js set lingxi "<另一个 wps_sid>" --name 小号
```

存储结构（`~/.dsh/dsh-checkin-all/secrets.json`，0600）：

```json
{ "checkin": { "manual": {
  "lingxi": { "accounts": [
    { "id": "1", "name": "主号", "wps_sid": "..." },
    { "id": "2", "name": "小号", "wps_sid": "..." }
  ] }
} } }
```

**老的单个凭据会自动迁移**：升级后第一次读取会把扁平结构当成 1 个账号，不会丢数据。

汇总规则：任一账号签上就算 `claimed`，积分累加，连续天数取最大的那个；
部分账号失败不影响其他账号，消息里会点名是哪个失败了。

支持多账号的：灵犀、DuMate、AStudio、Qoder、Trae、豆包、CodeArts、WorkBuddy。
**MiniMax 例外**——它的凭据是 App 里的 OAuth 文件（`~/.minimax/auth/`），
天然只有一份，且 refresh token 一次性，不适合手动塞多份 token。

## 配置

面板里改，或者 profile 的 `cordis.patch.yml` 里给 `id: dsh-checkin-all` 加 `config`：

```yaml
- id: dsh-checkin-all
  config:
    enabled: true      # 是否自动签到
    time: '09:00'      # 每天几点签（北京时间）
    catchUp: true      # 过了时间才开机是否补签
    notify: true       # 签完是否提示
```

面板里可以给每个服务单独设开关和时间（存在 `config.json` 的 `providers` 字段里）。

插件自己的数据（设置、签到历史）在 `~/.dsh/dsh-checkin-all/`：

- `config.json` — 设置（全局 + 每个服务的 `providers` 覆盖）
- `state.json` — 按服务分开记：最近一次结果、连续天数、累计积分、每天一条记录（保留 400 天）
  ```
  { "version": 2, "providers": { "minimax": {...}, "lingxi": {...} } }
  ```
  老版本的单服务 `state.json` 会自动迁移成 `providers.minimax`，历史不丢。

## 接口与凭据

### MiniMax Code

MiniMax Code 桌面端自己用的就是这两个接口，插件原样调用（`lib/signin.js`）：

```
GET  https://agent.minimax.io/minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
POST https://agent.minimax.io/minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>
Authorization: Bearer <access token>
```

`agent.minimax.io` / `agent.minimax.cn` 按 region 分（`en` / `cn`）。**必须带 `timezone_id`**，
不带会报 `invalid timezone_id`——这是「按谁的一天算」的关键。

凭据（`lib/credentials.js`）：

```
~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json        # { schemaVersion, records: { "<service>\0<account>": {...} } }
~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth-state.json  # generation / expiresAtMs 必须和凭据对得上
```

- `service` = `com.minimax.mcode.oauth.<buildEnv>.<region>`
- `account` = `base64url(sha256("<authHome>\0mcode-public"))`
- 文件 `0600`、目录 `0700`（App 会检查，太宽直接拒绝读）
- 写回在 `auth.lock` 的锁里做，和 App 自己的 `proper-lockfile` 兼容
- refresh token 是一次性的：换一次旧的就作废，所以必须写回

### WPS 灵犀

```
GET  https://lingxi.wps.cn/api/public/v1/tasks                       # 任务列表
POST https://lingxi.wps.cn/api/public/v1/tasks/daily_check_in/claim  # 签到
Cookie: wps_sid=<...>
```

签到数据在 `tasks[].task_key === "daily_check_in"` 那条里：

```
extra.check_in_days      七天签到表 [{day, date, reward, status}]
extra.consecutive_days   连续签到天数（断一天就回 1）
extra.today_day          今天是第几天
data.total_claimed_credits  账户累计智点
status: claimed / available / locked
```

凭据（`lib/providers/lingxi.js`）：读灵犀自己的 `Cookies`（SQLite，用 `node:sqlite` 只读打开），
取 `wps_sid`。位置：`~/Library/Application Support/WPS 灵犀/Cookies`。

**日期按北京时间算**——服务器返回的 `date` 是北京日期。本机在美西时，晚上 8 点之后就已经是北京的第二天，
所以灵犀的签到窗口和 MiniMax 完全不同，代码里两个 provider 分开判断。

### 百度 DuMate（搭子）

```
GET  https://console.bce.baidu.com/api/dumate/points/loginBonusInfo   签到状态
POST https://console.bce.baidu.com/api/dumate/points/loginBonus       领今天的分
GET  https://console.bce.baidu.com/api/dumate/points/quota_overview   积分总览
Cookie: <解密出来的 cookie>; csrftoken: <bce-user-info 的值>
```

`loginBonusInfo` 返回：

```json
{"totalTimes":2,"totalPoints":1000,"hasIssued":true,"signInDays":["2026-11-01","2026-11-02"]}
```

**坑：必须带 `csrftoken` 头**（值来自 `bce-user-info` cookie，去掉引号）。
少了它服务端一律回 `{"success":false,"message":{"global":"登录凭证已过期，请重新登录"}}`——
这句话是误导的，cookie 其实好好的。注意不是 `X-Bce-Csrf-Token`，就叫 `csrftoken`。

凭据（`lib/providers/dumate.js`）：DuMate 把 cookie 加密存在
`~/Library/Application Support/qianfan-desktop-app/auth.json` 的 `cookies` 字段：

```
base64( iv(12) || authTag(16) || ciphertext )   AES-256-GCM
密钥：同目录 .cookie-key 的 32 字节
```

插件用 `node:crypto` 解密（不需要额外的原生模块）。

### AStudio（星火）

AStudio 的「签到」= **每日登录积分**：每天首次连上时自动到账，桌面端用「每日积分」弹窗提示。
插件复刻同一套调用（`lib/providers/astudio.js`）：

```
GET  points/balance                积分余额（通用 + 星火）
GET  points/summary                积分摘要
GET  membership/me                 当前套餐
GET  membership/plan-config        每日登录积分配置（按套餐给 dailyLoginPoints）
GET  client-popups/pending         待展示/待领取弹窗（每日积分在这里）
POST client-popups/complete        领取（body: { popupId, instanceKey }）
```

- 上游：`https://agent.xfyun.cn/xingchen-studio/`
- 认证：`Cookie` + 身份头 `clientType` / `studioVersion`
  - `clientType` 按平台自动上报：Windows `21`、macOS/Linux `22`
  - `studioVersion` 默认 `3.5.5`，可用环境变量 `ASTUDIO_VERSION` 覆盖
- 「今天」按**北京时间**算

凭据（`lib/providers/astudio.js`）读 AStudio 的登录态文件 `astron-session.json`：

```
# macOS / Linux
~/.acode/acode/userdata/astron-session.json
# Windows
%USERPROFILE%\.acode\acode\userdata\astron-session.json
# { accountId, uid, token, ssoSessionId, mobile, ... }
```

凭据目录可用 `ASTUDIO_DATA_DIR` 环境变量覆盖（VPS 部署时指到同步目录）。

拼出的 Cookie（和桌面端 `buildAstronCookieHeader` 一致）：

```
ssoSessionId=<ssoSessionId>; sso_sessionid=<ssoSessionId>; account_id=<accountId>; token=<token>
```

### Qoder

Qoder 的「签到」= **每日领取 CLAIM_BENEFIT 赠送积分**，与 Qoder 桌面端「用量面板」的领取链路一致
（`lib/providers/qoder.js`）：

```
POST {openApi}/api/v1/jobToken/exchange         PAT 换短期 jobToken
GET  {openApi}/sash/api/v1/me/campaigns         找当天的 CLAIM_BENEFIT 活动
POST {openApi}/sash/api/v1/me/campaigns/{id}/claim   幂等领取（重复返回 replayed）
```

- 国内版 `https://openapi.qoder.com.cn`，国际版 `https://openapi.qoder.sh`
- 凭据有两条路，**优先用本机 Qoder App 的登录**（零配置）：
  1. 本机 Qoder 桌面 App 登录态：`<App Support>/com.qoder.app.stable/auth.v1.dat`
     （Electron safeStorage，密钥在钥匙串「Qoder App Safe Storage」），
     解出来直接当 token 用；`authenticationContext` 里是 `openapi.qoder.sh` 就走国际版
  2. 个人访问令牌（PAT）：面板里填，存 `~/.dsh/dsh-checkin-all/secrets.json`（0600），
     会先打 `exchange` 接口验真再落盘
- 「今天」按**北京时间**算

#### ⚠️ 自动签到时间会自动对齐到 10:00

Qoder 的每日活动是 **10:00 → 次日 09:59** 一轮。在 10:00 之前看到的还是**上一轮**：
如果按全局的 09:00 去签，会读到「已领」（其实是昨天那轮的），于是把当天标成已完成，
10:00 新一轮出来后再也不会重试 —— 这正是以前「手动能签、自动签不上」的原因。

现在两处都改了：

- `PROVIDER_EARLIEST_TIME` 把 qoder 的最早签到时间抬到 **10:00**（你手动设过更早的时间则以你的为准）
- 「还没到轮次」（`not_yet`）**不占用当天记录**，只做退避重试，到点自然会签上

**获取 PAT**：令牌在 **Qoder 网页版**创建，**不在桌面 App 里**（App 里翻不到，这是最容易卡住的地方）：

1. 浏览器登录 Qoder
2. 打开 <https://qoder.com/account/integrations>（海外版）或 <https://qoder.com.cn/account/integrations>（国内版）
3. 点「创建令牌」，复制 —— 以 `pt-` 开头，**只显示一次**

旧版页面可能在「设置 → API 令牌」或「账号 → 集成」下面。

拿到后粘贴到面板「Qoder 令牌」卡片（点卡片头部的「配置令牌」），选区域（国内/海外）、可加备注名，点「添加令牌」——插件会先打 `exchange` 接口验真再落盘。也支持多个令牌（多账号）。

> 注意：dsh-model 的 Qoder 签到**只支持 PAT**，它不会去读 Qoder 桌面 App。
> 本插件多了一条路：本机 Qoder App 登录着就直接读（见上），不用创建令牌。


### Trae

Trae（国内版 / SOLO）的每日签到，读本机 Trae 桌面 App 或 CLI 的登录（`lib/providers/trae.js`）：

```
POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status   今天签没签
POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim    签到
```

- 凭据：本机 Trae 的登录（桌面 App 的 `storage.json` 加密信封，或 `~/.trae-cn/trae-jwt-token` / `~/.trae/trae-jwt-token`），只读不落盘
- 桌面 App 位置：`{TRAE SOLO CN | Trae CN | Trae | TRAE SOLO}/User/globalStorage/storage.json`
- 「今天」按**北京时间**算

### 豆包

豆包的「天天领额度」每日签到（`lib/providers/doubao.js` + `browser-cookies.js`）：

```
POST https://www.doubao.com/alice/ug/campaign/v3/detail/        任务面板
POST https://www.doubao.com/alice/ug/campaign/landing/checkin   领取（幂等，重复返回 idempotent:true）
```

- 凭据：豆包登录 Cookie（`doubao.com`），在面板里手动粘贴，或点「从本机豆包读」（豆包电脑版 / Chrome / Edge / Brave）
- 「今天」按**北京时间**算

#### ⚠️ 只有个人账号有签到，工作版没有

**豆包工作版（DoubaoWork，`com.work.pc.doubao`）和飞书企业账号没有「每日签到」这个玩法。**
它们的任务面板长这样：

```
tasks[].task_kind = chat_activity   ← 全是聊天任务，没有 daily_signin
milestones[] = 累计 2000 / 5000 点额度里程碑
progress.total_amount = 0
```

直接调签到接口，服务端会回：

```json
{ "code": 710010702, "msg": "系统错误", "data": null }
```

**注意这个错误码不是登录失效**（失效是 `710012001`）。`710010702` 表示 cookie 是好的，
但这个账号没有可领的签到活动。插件会识别成 `no_task` 状态并说明原因，不当作故障重试。

判断账号类型：Cookie 里有 `feishu_dpop_keypair` / `has_biz_token` 基本就是工作/企业号，
换个人豆包账号（[doubao.com](https://www.doubao.com) 网页版登录后的 Cookie）即可。


### 华为 CodeArts

华为云 CodeArts 的每日登录积分（`lib/providers/codearts.js`）。四步，全部打同一个网关，
每个请求都要**华为云 SDK-HMAC-SHA256 签名**：

```
GET  https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/statistics/plugin   账户信息
GET  .../v1/ops/delivery?channel=IDE                                                      活动列表
POST .../v1/ops/claim   {"campaignId":"1","channel":"IDE"}                                 领取
POST .../v1/ops/confirm {"campaignId":"1"}                                                 确认
```

- 凭据：**点面板的「登录」按钮，浏览器授权一次就有了**，不用手抠 AK/SK。
  也可以手动配 `{ access_key_id, secret_access_key, security_token? }` 或 `set codearts`

#### 浏览器登录怎么走的

和官方 CodeArts 插件同一条链路（`lib/providers/codearts-login.js`）：

1. 本地起回调服务器 `http://127.0.0.1:8791/authentication`（端口占用就换随机的）
2. 打开 `auth.huaweicloud.com`，带上回调地址和 ticket
3. 你在浏览器登录并同意授权，华为云把请求转回本地
4. 用回调里的 secret 去 `snap-manager/v1/login/ticket` 换临时 AK/SK/security_token
5. 自动写进 `secrets.json`，面板上就变「已登录」

拿到的 `security_token` 是华为云 STS 临时凭据，过期后重新点一次「登录」即可。
- **不是所有账户都能签**：`is_credit_package=false`（Token 计费账户）直接判为没有这个活动
- 幂等靠 `claimable` + `status`（`CLAIMED`/`CONFIRMED`/`CONSUMED` 算已领），不会重复 POST

签名有三个坑（实现里都处理了，`test/providers.test.js` 有逐字节比对）：

1. **参与签名的 URI 必须补尾斜杠**：`/v1/ops/claim` 要按 `/v1/ops/claim/` 签，但请求仍打不带斜杠的
2. `host` 参与签名但**不要手动设** header，交给运行时
3. claim 的 body 有 `channel`、confirm 的**没有** —— 两个 body 不同，签名必须各算各的

#### 浏览器登录怎么走的

和官方客户端同一条链路（`lib/providers/buddy-login.js`）：

1. `POST /v2/plugin/auth/state?platform=ide` → 拿 `state` 和授权地址
2. 打开授权页（补 `version` + `loginSessionId`），你在浏览器登录腾讯账号
3. 轮询 `GET /v2/plugin/auth/token?state=` —— 未确认时服务端回 `code 11217 "login ing..."`
4. 拿到 token 后查 `GET /v2/plugin/login/account?state=` 补 user_id / enterprise_id
5. 写进 `secrets.json` 的 `manual.buddy.accounts[]`

两个产品线各自独立：国内版（`copilot.tencent.com`）填 `region: cn`，
国际版 WorkBuddy（`www.workbuddy.ai`）填 `region: intl`。命令行：

```bash
node bin/dsh-checkin-all.js login buddy          # 国内版
node bin/dsh-checkin-all.js login buddy intl     # 国际版
```

### 腾讯 WorkBuddy

腾讯 WorkBuddy 的每日领取（`lib/providers/buddy.js`）。

> 对外统一叫 **WorkBuddy**。底层有两个产品线，技术标识 `productCode` 分别是
> `codebuddy`（国内版）和 `workbuddy`（国际版）—— 那是发给服务端的，不能改。

```
POST {endpoint}/v2/billing/meter/checkin-activity-status   活动状态（active / today_checked_in / streak）
POST {endpoint}/v2/billing/meter/daily-checkin             领取
POST {endpoint}/v2/billing/meter/get-user-resource         余额
```

- 国内版 `https://copilot.tencent.com`（有签到）；国际版 WorkBuddy `https://www.workbuddy.ai`
  **只有模型接入、没有签到**（上游能力表就是空的）
- 认证是一串头，少一个服务端只回 401 HTML（很难看出原因）：
  ```
  Authorization: Bearer <access_token>
  X-Domain: copilot.tencent.com
  X-Product: SaaS
  X-Product-Code: codebuddy
  X-User-Id / X-Enterprise-Id / X-Tenant-Id   有就带
  User-Agent: CodeBuddyIDE/1.106.1
  ```
- 错误码：`10001`/`1001` = 今天已领；`1002` = 无资格；`1003` = 活动结束（后两个按 `no_task` 处理，不当故障重试）
- 支持多个 token（多账号），存 `manual.buddy.accounts[]`

> **没做的渠道**：dsh-free-model 里另有 LobsterAI、Loomy、ZCode、Cline、Raccoon、Gemini，
> 但 Cline / Gemini / Raccoon / WorkBuddy 国际版**本身没有每日领取**（只有余额或额度查询），
> 另外三个需要另外的账号体系（有道 / 讯飞微信 / 智谱），本机没有登录态，没做。

## 隐私

- 不保存账号密码，只用 App 已经存好的 OAuth 凭据
- 除了 MiniMax 自己的签到接口和 OAuth 接口，不往任何地方发请求
- 签到历史只写在本机 `~/.dsh/dsh-checkin-all/`

## 部署到 VPS（无图形界面）

可以。三个服务都支持，详细步骤见 **[docs/VPS.md](docs/VPS.md)**。

三步：

```bash
# 1) 传代码
rsync -av ~/dsh/dsh-checkin-all/ vps:/opt/dsh-checkin-all/

# 2) 传凭据（在本机跑）
bash ~/dsh/dsh-checkin-all/scripts/sync-to-vps.sh vps

# 3) 装（在 VPS 上）
ssh vps 'bash /opt/dsh-checkin-all/scripts/deploy-vps.sh /opt/dsh-checkin-all'
```

要点（细节见 docs/VPS.md）：

- **时区**：VPS 多是 UTC，灵犀和搭子按北京时间算日期 → 签到时间设 **01:00**
- **MiniMax 的 refresh token 一次性**：VPS 默认只读（`DSH_CHECKIN_ALL_READONLY=1`），
  本机要定时 `sync-to-vps.sh` 同步；或者干脆只让 VPS 跑、本机关掉
- **灵犀和搭子不受限制**：cookie 多处使用不会互相失效

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `MINIMAX_DATA_DIR` | MiniMax 数据根目录（默认 `~/.minimax`） |
| `LINGXI_DATA_DIR` | 灵犀数据目录（默认 macOS 的 `~/Library/Application Support/WPS 灵犀`） |
| `DUMATE_DATA_DIR` | DuMate 数据目录（默认 `~/Library/Application Support/qianfan-desktop-app`） |
| `ASTUDIO_DATA_DIR` | AStudio 用户数据目录（默认 `~/.acode/acode/userdata`） |
| `ASTUDIO_VERSION` | AStudio 版本号（默认自动读 App 的版本，读不到用 `3.5.5`） |
| `DSH_CHECKIN_ALL_READONLY` | `1` = 不刷新 refresh token |
| `DSH_CHECKIN_ALL_HOME` | 插件自己的状态目录（默认 `~/.dsh/dsh-checkin-all`） |

> 凭据文件的记录 key 里嵌了 **authHome 的绝对路径**，换目录后算出来的 key 对不上。
> 插件会自动按 service 前缀兜底找（`lib/credentials.js` 的 `pickRecord`），所以拷过去能用。

## 开发

```bash
node --test "test/*.test.js"
```

## 标签

方便搜索和归类：

**功能**
`签到` `自动签到` `每日签到` `连续签到` `打卡` `领取` `积分` `智点` `额度`
`多账号` `多账户` `账号池` `自定义签到` `自定义服务` `DIY` `扩展`

**服务**
`MiniMax Code` `WPS 灵犀` `百度 DuMate` `搭子` `AStudio` `星火` `Qoder` `Trae` `豆包`
`华为 CodeArts` `华为云` `腾讯 WorkBuddy` `CodeBuddy`

**技术**
`DeepSeek Harness` `dsh` `dsh-plugin` `cordis` `插件` `面板` `dashboard`
`北京时区` `beijing-time` `零配置` `本机凭据` `OAuth`

## License

MIT
