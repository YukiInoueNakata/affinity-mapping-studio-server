// auto-tunnel.mjs -- start-server.bat / start-server.sh から背後で呼ぶ．
// サーバーの管理 API (POST /admin/api/tunnel/start) で Cloudflare Quick Tunnel を張る．
//
// なぜ要るか (2026-11-07):
//   以前の起動スクリプトは cloudflared を自分で起動していた．そのトンネルは管理画面が知らない
//   (admin-router は src/tunnel.js の状態 = data/runtime.json しか見ない) ので，
//   管理画面の「URL」ボタンが LAN の ws:// を返し，「⏹ 停止」も使えず，監視 (tunnel-watchdog) とも食い違った．
//   管理 API 経由で張れば，管理画面のボタンで張ったのと同じ状態になる．
//
// 動き:
//   - preset が cloudflare-quick のときだけ張る (それ以外は何もしないで終わる)．
//   - サーバーの管理ポートが応答するまで最大 60 秒待つ．
//   - 既に張られていれば張り直さない (URL が変わって招待 URL が無効になるのを防ぐ)．
//   - 失敗したら理由を stderr に出して exit 1 (黙って終わらない)．
//
// 使い方: node scripts/auto-tunnel.mjs

import { loadServerConfig } from '../src/config.js';

const WAIT_MS = 60000;
const RETRY_MS = 1000;
const line = '============================================================';

function fail(msg) {
  console.error(`\n[auto-tunnel] ERROR: ${msg}`);
  console.error('[auto-tunnel] 管理画面の「サーバー URL」の「▶ 起動 (Quick Tunnel)」から張り直せます．');
  process.exit(1);
}

let cfg;
try {
  cfg = await loadServerConfig();
} catch (e) {
  fail(`設定を読めません: ${e.message}`);
}

if (cfg.preset.name !== 'cloudflare-quick') {
  console.log(`[auto-tunnel] preset=${cfg.preset.name} なので Cloudflare Quick Tunnel は張りません．`);
  process.exit(0);
}
if (!cfg.admin.token) fail('管理トークンがありません (config/admin-token.txt)．');

const base = `http://127.0.0.1:${cfg.network.adminPort}/admin/api`;
const headers = { Authorization: `Bearer ${cfg.admin.token}`, 'Content-Type': 'application/json' };

async function getStatus() {
  const res = await fetch(`${base}/tunnel/status`, { headers });
  if (res.status === 401) fail('管理トークンがサーバーと一致しません．');
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

// サーバーの起動を待つ
let status = null;
const deadline = Date.now() + WAIT_MS;
while (Date.now() < deadline) {
  try { status = await getStatus(); break; } catch { /* まだ起動していない */ }
  await new Promise((r) => setTimeout(r, RETRY_MS));
}
if (!status) fail(`サーバーの管理ポート (${cfg.network.adminPort}) が ${WAIT_MS / 1000} 秒たっても応答しません．`);

let url = status.running ? status.url : null;
if (url) {
  console.log('[auto-tunnel] トンネルは既に張られています (張り直しません)．');
} else {
  console.log('[auto-tunnel] Cloudflare Quick Tunnel を張っています…');
  let res, body;
  try {
    res = await fetch(`${base}/tunnel/start`, { method: 'POST', headers, body: JSON.stringify({ target: 'app' }) });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    fail(`管理 API に接続できません: ${e.message}`);
  }
  if (!res.ok || !body.ok) {
    const msg = body.error ?? `HTTP ${res.status}`;
    if (/cloudflared not found/i.test(msg)) {
      fail('cloudflared が見つかりません．Windows: winget install --id Cloudflare.cloudflared -e / Mac: brew install cloudflared');
    }
    fail(`トンネルを張れませんでした: ${msg}`);
  }
  url = body.url;
}

console.log();
console.log(line);
console.log(`  Cloudflare HTTPS : ${url}`);
console.log(`  共同編集の URL   : ${url.replace(/^https:/, 'wss:')}`);
console.log('  招待 URL は管理画面の招待の表の「URL」ボタンでコピーします．');
console.log('  トンネルを止めるときは管理画面の「⏹ 停止」を押します．');
console.log(line);
console.log();
