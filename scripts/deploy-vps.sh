#!/usr/bin/env bash
# scripts/deploy-vps.sh — 在 VPS 上装 dsh-checkin-all（四个签到服务都支持）
#
# 前提：VPS 上已经装了 dsh，并且至少跑起来过一次（~/.dsh/profiles 存在）。
#
# 用法（在 VPS 上）：
#   bash scripts/deploy-vps.sh [包目录] [profile]
#
# 默认包目录 = 脚本所在的上一级；profile 自动挑（优先 vps，否则第一个不是 desktop 的）。
#
# 它做的事：
#   1. 检查 node / dsh / profiles
#   2. 建 ~/.minimax-auth/（700），四个服务各一个子目录
#   3. 检查四个服务的凭据在不在，缺哪个告诉你缺什么、从本机怎么拷
#   4. 把插件 link 进 profile
#   5. 生成 ~/.minimax-auth/env.sh（环境变量，给 systemd 或 shell 用）
#   6. 跑一次 status 验证
#
# 凭据要单独从本机同步 —— 用本机的 scripts/sync-to-vps.sh。

set -euo pipefail

PKG_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PROFILE="${2:-}"

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m !\033[0m %s\n' "$*"; }
die() { printf '\033[31m xx\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. 环境 ──
say "检查环境"
[ -f "$PKG_DIR/package.json" ] || die "$PKG_DIR 不像 dsh-checkin-all（没有 package.json）"
grep -q '"name": "dsh-checkin-all"' "$PKG_DIR/package.json" || die "$PKG_DIR 不是 dsh-checkin-all"

command -v node >/dev/null || die "没装 node（dsh 需要 22+）"
NODE_VER="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VER%%.*}"
if [ "$NODE_MAJOR" -lt 22 ]; then
  warn "node v$NODE_VER：node:sqlite 需要 22.5+，否则读不了灵犀的 cookie（其余两个不受影响）"
fi

command -v dsh >/dev/null || die "没装 dsh"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
[ -d "$DSH_HOME/profiles" ] || die "$DSH_HOME/profiles 不存在——先在 VPS 上跑一次 dsh 让它初始化"

ok "node v$NODE_VER · dsh $(dsh --version 2>/dev/null | head -1 || echo '?') · DSH_HOME=$DSH_HOME"
say "时区：$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo '?')"

# ── 2. profile ──
if [ -z "$PROFILE" ]; then
  if [ -d "$DSH_HOME/profiles/vps" ]; then
    PROFILE=vps
  else
    PROFILE="$(ls "$DSH_HOME/profiles" 2>/dev/null | grep -v '^desktop$' | head -1 || true)"
  fi
fi
[ -n "$PROFILE" ] || die "找不到可用的 profile，先跑一次 dsh 让它初始化"
ok "目标 profile：$PROFILE"

# ── 3. 凭据目录 ──
CRED_HOME="${DSH_CHECKIN_ALL_CRED_HOME:-$HOME/.minimax-auth}"
say "凭据目录：$CRED_HOME"
mkdir -p "$CRED_HOME/minimax/auth" "$CRED_HOME/lingxi" "$CRED_HOME/dumate" "$CRED_HOME/astudio"
chmod 700 "$CRED_HOME" "$CRED_HOME/minimax" "$CRED_HOME/minimax/auth" "$CRED_HOME/lingxi" "$CRED_HOME/dumate" "$CRED_HOME/astudio"

# ── 4. 检查四个服务的凭据 ──
missing=0
say "检查凭据"

# MiniMax：整个 auth 目录
MM_AUTH="$CRED_HOME/minimax/auth/prod/en/mcode-public/auth.json"
if [ -f "$MM_AUTH" ]; then
  ok "MiniMax：auth.json 在"
else
  warn "MiniMax：缺 auth.json"
  echo "     本机拷：rsync -av ~/.minimax/auth/ vps:$CRED_HOME/minimax/auth/"
  missing=$((missing+1))
fi

# 灵犀：Cookies（SQLite）
if [ -f "$CRED_HOME/lingxi/Cookies" ]; then
  ok "灵犀：Cookies（$(du -h "$CRED_HOME/lingxi/Cookies" | cut -f1)）"
else
  warn "灵犀：缺 Cookies"
  echo "     本机拷：rsync -av \"\$HOME/Library/Application Support/WPS 灵犀/Cookies\" vps:$CRED_HOME/lingxi/"
  missing=$((missing+1))
fi

# DuMate：auth.json + .cookie-key（必须成对）
DM_OK=1
[ -f "$CRED_HOME/dumate/auth.json" ] || DM_OK=0
[ -f "$CRED_HOME/dumate/.cookie-key" ] || DM_OK=0
if [ "$DM_OK" = 1 ]; then
  ok "搭子：auth.json + .cookie-key 都在"
else
  warn "搭子：缺 auth.json 或 .cookie-key（两个必须一起拷，否则解不开）"
  echo "     本机拷：rsync -av \"\$HOME/Library/Application Support/qianfan-desktop-app/auth.json\" \\"
  echo "                    \"\$HOME/Library/Application Support/qianfan-desktop-app/.cookie-key\" vps:$CRED_HOME/dumate/"
  missing=$((missing+1))
fi

# AStudio：astron-session.json（登录态）
if [ -f "$CRED_HOME/astudio/astron-session.json" ]; then
  ok "AStudio：astron-session.json 在"
else
  warn "AStudio：缺 astron-session.json"
  echo "     本机拷：rsync -av \"\$HOME/.acode/acode/userdata/astron-session.json\" vps:$CRED_HOME/astudio/"
  missing=$((missing+1))
fi

[ "$missing" = 0 ] || warn "有 $missing 个服务缺凭据，装完插件后补上即可（不影响其他服务）"

# ── 5. 装插件 ──
say "把插件装进 profile $PROFILE"
dsh plugin --profile "$PROFILE" add "link:$PKG_DIR" 2>&1 | tail -3

# ── 6. 环境变量 ──
ENV_FILE="$CRED_HOME/env.sh"
cat > "$ENV_FILE" <<EOF
# dsh-checkin-all 在 VPS 上的环境变量（由 deploy-vps.sh 生成）
# 让插件去读拷过来的凭据，而不是找本机不存在的 App 目录

export MINIMAX_DATA_DIR="$CRED_HOME/minimax"
export LINGXI_DATA_DIR="$CRED_HOME/lingxi"
export DUMATE_DATA_DIR="$CRED_HOME/dumate"
export ASTUDIO_DATA_DIR="$CRED_HOME/astudio"

# 只读：VPS 不刷新 MiniMax 的 refresh token
# （RT 是一次性的，VPS 刷了本机那份就作废了）。
# 如果你打算只让 VPS 跑、本机不用了，把下面这行改成 0 或删掉。
export DSH_CHECKIN_ALL_READONLY=1
EOF
chmod 600 "$ENV_FILE"
ok "环境变量：$ENV_FILE"

# ── 7. 验证 ──
say "验证（读一次状态）"
set +e
# shellcheck disable=SC1090
. "$ENV_FILE"
node "$PKG_DIR/bin/dsh-checkin-all.js" status 2>&1 | head -40
set -e

cat <<EOF

────────────────────────────────────────
装好了。

接下来：

1) 把环境变量接进 dsh 的启动环境。
   dsh 由 systemd 管的话，给 unit 加一行（路径按你实际的 unit 改）：
       EnvironmentFile=$ENV_FILE
   改完：
       systemctl daemon-reload && systemctl restart <你的 dsh 服务名>
   手动跑 dsh 的话，启动前先：
       source $ENV_FILE

2) 打开 dsh 网页版，右侧栏应该出现「自动签到」，四张卡都在。

3) 时区提醒（重要）：
   灵犀、搭子和 AStudio 按【北京时间】算日期，MiniMax 按【本机时区】。
   这台机器是 UTC 的话，想在北京时间早上 9 点签，签到时间要设成 01:00。
   在面板里可以给每个服务单独设时间。

4) 凭据会过期，需要定期从本机同步：
   在本机跑 scripts/sync-to-vps.sh（见 README），或者手动 rsync。
────────────────────────────────────────
EOF
