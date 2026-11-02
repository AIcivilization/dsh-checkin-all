#!/usr/bin/env bash
# scripts/sync-to-vps.sh — 在本机跑：把三个服务的凭据同步到 VPS
#
# 用法（在本机，不是 VPS 上）：
#   bash scripts/sync-to-vps.sh <ssh目标> [凭据目录]
#
# 例：
#   bash scripts/sync-to-vps.sh lsj
#   bash scripts/sync-to-vps.sh root@209.146.116.150
#   bash scripts/sync-to-vps.sh lsj /root/.minimax-auth
#
# 想定时同步（凭据会过期），本机 crontab 加一行：
#   0 * * * * bash ~/dsh/dsh-checkin-all/scripts/sync-to-vps.sh lsj >> ~/.dsh/dsh-checkin-all/sync.log 2>&1
#
# 注意：MiniMax 的 refresh token 是一次性的。如果 VPS 那边开的是只读模式（默认），
# 它不会动 RT，这里同步过去就是安全的。反过来如果 VPS 负责刷新，本机会被踢下线。

set -euo pipefail

TARGET="${1:-}"
CRED_HOME="${2:-/root/.minimax-auth}"

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m !\033[0m %s\n' "$*"; }
die() { printf '\033[31m xx\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$TARGET" ] || die "用法：bash scripts/sync-to-vps.sh <ssh目标> [凭据目录]"
command -v rsync >/dev/null || die "本机没有 rsync（macOS 自带；没有就 brew install rsync）"

MM_SRC="$HOME/.minimax/auth"
LX_SRC="$HOME/Library/Application Support/WPS 灵犀/Cookies"
DM_DIR="$HOME/Library/Application Support/qianfan-desktop-app"

say "目标：$TARGET:$CRED_HOME"

# 建目录（顺手把权限收紧）
ssh "$TARGET" "mkdir -p '$CRED_HOME/minimax/auth' '$CRED_HOME/lingxi' '$CRED_HOME/dumate' && chmod 700 '$CRED_HOME' '$CRED_HOME/minimax' '$CRED_HOME/minimax/auth' '$CRED_HOME/lingxi' '$CRED_HOME/dumate'"
ok "目录就绪"

# ── MiniMax ──
if [ -f "$MM_SRC/prod/en/mcode-public/auth.json" ]; then
  rsync -a --delete "$MM_SRC/" "$TARGET:$CRED_HOME/minimax/auth/"
  ssh "$TARGET" "chmod -R go-rwx '$CRED_HOME/minimax' 2>/dev/null || true"
  ok "MiniMax 凭据已同步"
else
  warn "本机没找到 MiniMax 凭据（$MM_SRC），跳过"
fi

# ── 灵犀 ──
if [ -f "$LX_SRC" ]; then
  # 灵犀的 Cookies 是 SQLite，App 开着时可能在写；先拷一份快照再传
  TMP_LX="$(mktemp -t lingxi-cookies)"
  cp "$LX_SRC" "$TMP_LX"
  rsync -a "$TMP_LX" "$TARGET:$CRED_HOME/lingxi/Cookies"
  rm -f "$TMP_LX"
  ssh "$TARGET" "chmod go-rwx '$CRED_HOME/lingxi/Cookies' 2>/dev/null || true"
  ok "灵犀 cookie 已同步"
else
  warn "本机没找到灵犀 Cookies，跳过"
fi

# ── 搭子 ──
DM_NEED=0
for f in auth.json .cookie-key; do
  [ -f "$DM_DIR/$f" ] && DM_NEED=$((DM_NEED+1))
done
if [ "$DM_NEED" = 2 ]; then
  rsync -a "$DM_DIR/auth.json" "$DM_DIR/.cookie-key" "$TARGET:$CRED_HOME/dumate/"
  ssh "$TARGET" "chmod go-rwx '$CRED_HOME/dumate/auth.json' '$CRED_HOME/dumate/.cookie-key' 2>/dev/null || true"
  ok "搭子凭据已同步（auth.json + .cookie-key）"
else
  warn "本机没找齐搭子凭据（需要 auth.json 和 .cookie-key 两个），跳过"
fi

# ── 验证 ──
say "在 VPS 上验证"
ssh "$TARGET" "set -e; [ -f '$CRED_HOME/env.sh' ] && . '$CRED_HOME/env.sh'; \
  if command -v dsh-checkin-all >/dev/null 2>&1; then dsh-checkin-all status 2>&1 | head -30; \
  else echo '（dsh-checkin-all 还没装，先跑 deploy-vps.sh）'; fi" || warn "验证没跑通（插件可能还没装）"

echo
ok "同步完成"
