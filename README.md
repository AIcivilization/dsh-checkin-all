# dsh-checkin-all

每天自动给 **MiniMax Code**、**WPS 灵犀**、**百度 DuMate（搭子）**、**AStudio（星火）**、**Qoder**、**Trae** 和 **豆包** 签到领积分。装进 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（dsh）之后，
它会用本机 App 已经存好的登录凭据，每天到点调一次官方签到接口，签完记账，面板挂在对话页右侧栏，
**顶部按服务切换卡片**。

> 你不用记着签，也不用把账号密码交给任何东西——凭据本来就是 App 自己存的
> （MiniMax Code 在 `~/.minimax/auth/`，WPS 灵犀和 DuMate 在各自的 Cookies 里）。

> **为什么要自动签**：灵犀的连续签到断一天就归零（回退到第 1 天）。手动记着签太容易忘，
> 这个插件就是替你记住的那一下。

## 支持的服务

| 服务 | 凭据来源 | 签到单位 | 「今天」按哪算 |
| --- | --- | --- | --- |
| MiniMax Code | `~/.minimax/auth/`（OAuth） | 分 | 本机时区 |
| WPS 灵犀 | 灵犀自己的 Cookies（`wps_sid`） | 智点 | **北京时间** |
| 百度 DuMate | `qianfan-desktop-app/auth.json`（加密 cookie） | 积分 | **北京时间** |
| AStudio | `~/.acode/acode/userdata/astron-session.json` | 积分 | **北京时间** |
| Qoder | 个人访问令牌（PAT，面板里填） | 积分 | **北京时间** |
| Trae | 本机 Trae App/CLI 登录（自动读） | 积分 | **北京时间** |
| 豆包 | 登录 Cookie（面板里填，或从本机浏览器读） | 额度 | **北京时间** |

签到窗口不一样：灵犀、搭子、AStudio、Qoder、Trae、豆包 按北京时间算日期，美西晚上 8 点之后就已经是北京的第二天了。
插件按各自的规则判断「今天」，互不干扰。

## 它做什么

- **每个服务每天到点自动签到**：默认 09:00，可给每个服务单独设时间
- **顶部索引**：每个服务一张卡，显示登录状态、今天签没签、连续天数，点一下切到详情
- **补签**：电脑睡过了、DSH 半夜才启动，醒来照样补上（可关）
- **不重复签**：今天已经签过（哪怕你是在 App 里点的）就不动
- **自动续期**：access token 快过期时用 refresh token 换新的并**写回 App 的位置**，App 那边不受影响
- **记账**：每个服务分开记连续天数、累计积分、最近 14 天每天的结果
- **面板**：对话页右侧栏，顶部索引卡 + 每个服务的一周签到表 + 设置；DSH 设置里也有一块
- **对话里能用**：说「帮我签到」「MiniMax 积分还有多少」「以后每天 8 点签」就行
- **登录兜底**：凭据失效时给一个设备码，在浏览器里确认一次（和 App 里登录是同一条 OAuth 链路）

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

node bin/dsh-checkin-all.js unset lingxi   # 删除某个服务的手动凭据，回退到 App 文件
```

手动配置优先于 App 文件；删掉手动凭据后自动回退读 App。

### 不依赖 DSH 常驻：挂到系统 crontab

```cron
0 9 * * * /usr/local/bin/node /Users/wf/dsh/dsh-checkin-all/bin/dsh-checkin-all.js cron >> ~/.dsh/dsh-checkin-all/cron.log 2>&1
```

`cron` 是静默模式：今天签过了就什么都不做，只在真签的时候输出一行。

## 在对话里

| 你说 | 会发生什么 |
| --- | --- |
| 帮我签到 / 领一下积分 | 调 `minimax_checkin`，三个服务都签（也可只签一个） |
| 灵犀连续多少天了 / 签到情况 | 调 `minimax_checkin_status`，给每个服务的一周表、连续天数 |
| 以后每天 8 点自动签 | 调 `minimax_checkin_config`，改时间（可只改一个服务） |
| MiniMax 登录失效了 | 调 `minimax_login`，给设备码和网址 |

命令：`/checkin 状态｜签到 [服务]｜时间 09:00｜开启｜关闭｜登录`（`/minimax` 是别名）

服务名：`minimax`（MiniMax Code）/ `lingxi`（WPS 灵犀）/ `dumate`（百度 DuMate）/ `astudio`（AStudio）/ `qoder`（Qoder）/ `trae`（Trae）/ `doubao`（豆包）

## 配置

面板里改，或者 profile 的 `cordis.patch.yml` 里给 `id: dsh-checkin-all` 加 `config`：

```yaml
- id: dsh-checkin-all
  config:
    enabled: true      # 是否自动签到
    time: '09:00'      # 每天几点签
    timeZone: ''       # 时区覆盖，空 = 跟随本机（只影响 MiniMax；灵犀固定按北京时间）
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
- 凭据：**个人访问令牌（PAT）**，在面板里填，存 `~/.dsh/dsh-checkin-all/secrets.json`（0600）
- 「今天」按**北京时间**算

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

- 凭据：豆包登录 Cookie（`doubao.com`），在面板里手动粘贴，或从本机豆包电脑版/Chrome/Edge/Brave 自动读
- 只支持个人账号：飞书企业账号没有签到任务
- 「今天」按**北京时间**算

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
| `ASTUDIO_VERSION` | AStudio 版本号（默认 `3.5.5`，用于上游 `studioVersion` 头） |
| `DSH_CHECKIN_ALL_READONLY` | `1` = 不刷新 refresh token |
| `DSH_CHECKIN_ALL_HOME` | 插件自己的状态目录（默认 `~/.dsh/dsh-checkin-all`） |

> 凭据文件的记录 key 里嵌了 **authHome 的绝对路径**，换目录后算出来的 key 对不上。
> 插件会自动按 service 前缀兜底找（`lib/credentials.js` 的 `pickRecord`），所以拷过去能用。

## 开发

```bash
node --test "test/*.test.js"
```

## License

MIT
