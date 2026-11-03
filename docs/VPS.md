# 在 VPS 上安装 dsh-checkin-all

四个签到服务（MiniMax Code / WPS 灵犀 / 百度 DuMate / AStudio）都能在无图形界面的服务器上跑。
凭据从本机拷过去，插件用环境变量指过去。

---

## 为什么不能直接装

VPS 上没有这四个 App，插件默认去这几个位置找凭据：

| 服务 | 默认位置（macOS） |
| --- | --- |
| MiniMax Code | `~/.minimax/auth/` |
| WPS 灵犀 | `~/Library/Application Support/WPS 灵犀/Cookies` |
| 百度 DuMate | `~/Library/Application Support/qianfan-desktop-app/{auth.json,.cookie-key}` |
| AStudio | `~/.acode/acode/userdata/astron-session.json` |

所以要把凭据拷到 VPS，再用环境变量告诉插件去哪读。

---

## 三步装好

### 1. 传代码

```bash
# 在你电脑上
rsync -av ~/dsh/dsh-checkin-all/ vps:/opt/dsh-checkin-all/
```

（或者用 DSH 面板的「文件」页拖上去。）

### 2. 传凭据

```bash
# 在你电脑上
bash ~/dsh/dsh-checkin-all/scripts/sync-to-vps.sh vps
```

这个脚本会：
- 在 VPS 建 `~/.minimax-auth/`（权限 700）
- 把三个服务的凭据都推过去
- 在 VPS 上跑一次 `dsh-checkin-all status` 验证

如果想换凭据目录：`bash scripts/sync-to-vps.sh vps /root/.minimax-auth`

### 3. 装插件

```bash
# 在 VPS 上
ssh vps
bash /opt/dsh-checkin-all/scripts/deploy-vps.sh /opt/dsh-checkin-all
```

脚本会检查环境、link 进 profile、生成 `env.sh`、并跑一次 status。

---

## 接进 systemd

`deploy-vps.sh` 会生成 `~/.minimax-auth/env.sh`。dsh 由 systemd 管的话：

```ini
[Service]
EnvironmentFile=/root/.minimax-auth/env.sh
```

然后：

```bash
systemctl daemon-reload
systemctl restart <你的 dsh 服务名>
```

手动跑 dsh 的话，启动前 `source ~/.minimax-auth/env.sh`。

---

## 时区（容易踩）

VPS 通常是 UTC。四个服务的「今天」不一样：

| 服务 | 「今天」按哪算 |
| --- | --- |
| MiniMax Code | 本机时区（VPS 上就是 UTC） |
| WPS 灵犀 | **北京时间** |
| 百度 DuMate | **北京时间** |
| AStudio | **北京时间** |

想在北京时间早上 9 点签，UTC 机器上要把灵犀、搭子和 AStudio 的签到时间设成 **01:00**。
面板里可以给每个服务单独设时间。

---

## 凭据过期怎么办

| 服务 | 过期表现 | 怎么修 |
| --- | --- | --- |
| MiniMax | 401，`AUTH_READONLY_EXPIRED` | 本机重新登录 → 重跑 sync |
| 灵犀 | `LINGXI_NOT_LOGGED_IN` | 灵犀 App 里重新登录 → 重跑 sync |
| 搭子 | `DUMATE_API_ERROR` 或解密失败 | 搭子 App 里重新登录 → 重跑 sync |
| AStudio | `ASTUDIO_SESSION_EXPIRED` 或 `ASTUDIO_NOT_LOGGED_IN` | AStudio App 里重新登录 → 重跑 sync |

**建议挂个定时同步**（本机 crontab，每小时一次）：

```cron
0 * * * * bash ~/dsh/dsh-checkin-all/scripts/sync-to-vps.sh vps >> ~/.dsh/dsh-checkin-all/sync.log 2>&1
```

---

## 关键：MiniMax 的 refresh token 是一次性的

这是最容易出事的地方。实测确认：**RT 用一次旧的立刻作废**。

所以两台机器共用一份 MiniMax 凭据时，**谁先刷新，另一个就 401**。

### 三种策略

| 策略 | 做法 | 结果 |
| --- | --- | --- |
| **A. 只让 VPS 跑** | 本机把 MiniMax 自动签到关掉 | ✅ 最省心，一份凭据一处用 |
| **B. VPS 只读** | `DSH_CHECKIN_ALL_READONLY=1`（默认）+ 本机定时同步 | ⚠️ 能用，但 access token 约 1 小时过期，同步要跟上 |
| **C. 两边都跑，都刷新** | 不加只读 | ❌ 会互相踢 |

`deploy-vps.sh` 默认给的是 **B**（只读）。

想改成 A（VPS 负责刷新）：把 `env.sh` 里的 `DSH_CHECKIN_ALL_READONLY=1` 删掉或改成 0，
同时**在本机把 MiniMax 的自动签到关掉**（面板里点一下）。

**灵犀和搭子不受这个限制**——它们用 cookie，多处使用不会互相失效。

---

## 面板里按服务开关

正好用来做上面的取舍：

1. 打开 DSH 网页版 → 右侧栏「自动签到」
2. 点 MiniMax 那张卡
3. 关掉「每天自动签到」→ 保存

灵犀和搭子照常开着。

---

## 排查

```bash
# 在 VPS 上
source ~/.minimax-auth/env.sh
dsh-checkin-all status          # 三个服务的登录状态和签到表
dsh-checkin-all checkin --dry   # 只看不签
```

| 现象 | 原因 |
| --- | --- |
| `没找到 ... 的 Cookies 库` | `LINGXI_DATA_DIR` 没设，或文件没拷过去 |
| `AUTH_READONLY_EXPIRED` | 只读模式下 token 过期了，从本机重新同步 |
| `读不了 SQLite` | node 版本低于 22.5（灵犀用 `node:sqlite`） |
| 三张卡都在但都是「未登录」 | `env.sh` 没生效，检查 systemd 的 `EnvironmentFile` |

---

## 验证清单

装完对照一下：

- [ ] `dsh-checkin-all status` 三个服务都显示「已登录」
- [ ] DSH 网页版右侧栏有三张卡
- [ ] 点「立刻签到」返回 `already_claimed` 或 `claimed`
- [ ] `env.sh` 已接进 systemd（`systemctl show <服务> -p EnvironmentFiles`）
- [ ] 本机 crontab 有定时同步（可选但建议）
- [ ] 时区换算对（UTC 机器上灵犀/搭子设 01:00）
