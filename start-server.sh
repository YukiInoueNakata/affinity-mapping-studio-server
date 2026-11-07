#!/usr/bin/env bash
# ============================================================
# Affinity Mapping Studio Server 起動スクリプト (Mac + Linux 版)
# CP1 (2026-06-10): start-server.bat の移植．
#
# このターミナルで以下を実行:
#   - 管理画面をブラウザで開く
#   - preset が cloudflare-quick なら，サーバーの起動後に管理 API で Quick Tunnel を張る
#     (scripts/auto-tunnel.mjs．2026-11-07 から．以前は cloudflared を直接起動していたが，
#      そのトンネルは管理画面が知らず，招待 URL のボタンや「停止」と食い違った)
#   - Affinity Mapping Studio Server を foreground で実行
#
# 停止: Ctrl-C
# ============================================================

set -eo pipefail

PORT="${KJ_PORT:-1234}"
ADMIN_PORT="${KJ_ADMIN_PORT:-1235}"
ADMIN_BIND_HOST="${KJ_ADMIN_BIND_HOST:-127.0.0.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

# OS 判定
case "$(uname -s)" in
  Darwin*) OS="mac" ;;
  Linux*)  OS="linux" ;;
  *)       OS="unknown" ;;
esac

open_url() {
  case "$OS" in
    mac)   open "$1" ;;
    linux) xdg-open "$1" > /dev/null 2>&1 || true ;;
    *)     echo "[info] browser を手動で開いてください: $1" ;;
  esac
}

# --- 1. admin token ---

mkdir -p config
if [ ! -f config/admin-token.txt ]; then
  echo "[setup] 管理トークン生成中..."
  if command -v openssl > /dev/null 2>&1; then
    openssl rand -hex 32 > config/admin-token.txt
  elif command -v node > /dev/null 2>&1; then
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > config/admin-token.txt
  else
    echo "[ERROR] openssl も node も見つかりません" >&2
    exit 1
  fi
  chmod 600 config/admin-token.txt
fi

ADMIN_TOKEN=$(tr -d '[:space:]' < config/admin-token.txt)
if [ -z "$ADMIN_TOKEN" ]; then
  echo "[ERROR] 管理トークンが空です．config/admin-token.txt を削除して再実行してください" >&2
  exit 1
fi

# --- 2. node 確認 + npm install ---

if ! command -v node > /dev/null 2>&1; then
  echo "[ERROR] Node.js が見つかりません．" >&2
  case "$OS" in
    mac)   echo "  brew install node" >&2 ;;
    linux) echo "  sudo apt install nodejs npm   (Debian/Ubuntu)" >&2 ;;
  esac
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[setup] 初回起動: npm install を実行中..."
  npm install
fi

# --- 3. port 占用チェック ---

is_port_in_use() {
  local p="$1"
  if command -v lsof > /dev/null 2>&1; then
    lsof -i ":$p" -sTCP:LISTEN > /dev/null 2>&1
  elif command -v ss > /dev/null 2>&1; then
    ss -lnt | awk '{print $4}' | grep -qE "[:.]$p$"
  else
    # fallback: try connecting
    (echo > "/dev/tcp/127.0.0.1/$p") > /dev/null 2>&1
  fi
}

if is_port_in_use "$PORT"; then
  echo "[ERROR] port $PORT は既に使用中です．" >&2
  echo "  既存 node プロセスを止めるには: pkill -f 'node src/index.js'" >&2
  exit 1
fi

# --- 4. Cloudflare Quick Tunnel は起動後に scripts/auto-tunnel.mjs が張る (下の 7.) ---

# --- 5. 管理画面を開く (R6: fragment 方式) ---

ADMIN_URL="http://${ADMIN_BIND_HOST}:${ADMIN_PORT}/admin#_t=${ADMIN_TOKEN}"
open_url "$ADMIN_URL"

# --- 6. サマリ表示 ---

echo
echo "============================================================"
echo "  管理トークン (config/admin-token.txt):"
echo "    $ADMIN_TOKEN"
echo
echo "  管理画面 (localhost) : http://${ADMIN_BIND_HOST}:${ADMIN_PORT}/admin#_t=<token>"
echo "  LAN 接続 URL         : ws://(このマシンの IP):${PORT}"
echo "  Cloudflare           : preset が cloudflare-quick なら，起動後にこのターミナルに URL が出ます"
echo "============================================================"
echo
echo " サーバーをこのターミナルで実行します．"
echo " 停止するには Ctrl-C を押してください．"
echo

# --- 7. サーバー本体を foreground 実行 ---

export KJ_ADMIN_TOKEN="$ADMIN_TOKEN"
export KJ_ADMIN_PORT="$ADMIN_PORT"
export KJ_ADMIN_BIND_HOST="$ADMIN_BIND_HOST"
export PORT

# 背後でサーバーの起動を待ち，管理 API で Quick Tunnel を張る (preset が cloudflare-quick のときだけ)．
# トンネルの cloudflared はサーバーの子なので，Ctrl-C でサーバーと一緒に止まる．
node scripts/auto-tunnel.mjs &

exec node src/index.js
