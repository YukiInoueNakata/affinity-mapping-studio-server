// tunnel-watchdog.mjs -- Cloudflare Quick Tunnel の生存監視 (fail-loud).
//
// なぜ要るか (2026-09-18):
//   2026-08-08 に張った quick tunnel が停止していたが，誰も気づかないまま 41 日放置された．
//   src/tunnel.js の readRuntime() には stale PID の掃除があるが，**呼ばれた時にしか動かない**
//   pull 型で，しかも黙って直すだけなので通知が無い．結果 data/runtime.json は
//   running:true + 死んだ URL を保持し続け，実態と食い違っていた．
//   グローバル絶対ルール「定期実行系は成功も失敗も必ず Slack で分かるようにする」を満たしていない．
//
// このスクリプトがやること:
//   1. 期待状態を config/server.json の exposure.preset から決める (cloudflare-quick なら「上がっているべき」)
//   2. runtime.json の状態を readRuntime() 経由で読む (ここで stale PID は掃除される)
//   3. PID の生存だけでなく **公開 URL に実際に HTTP 到達できるか** を確かめる
//      (cloudflared のプロセスが生きていてもトンネルが機能していないことがあるため)
//   4. 食い違いを検出したら failLoud() で stderr + Slack に出し，**exit 1** で終わる
//      (exit≠0 はフリート watchdog ScheduledTaskHealth が LastTaskResult で拾う二重の担保)
//
//   5. 運用者が意図して止めた場合 (runtime.json の stopReason='manual') は異常にしない (2026-10-06)．
//      以前は意図した停止も DOWN 扱いで毎時 exit 1 + Slack になり，異常停止と区別できなかった．
//      PC ごと落ちた・cloudflared が死んだ場合は readRuntime() が stopReason='stale' を書くので
//      従来どおり DOWN になる．
//
// あえてやらないこと:
//   **自動で張り直さない**．quick tunnel は張り直すたびに URL が変わるので，
//   黙って再起動すると共同編集者が持っている URL が無言で無効になる．
//   復旧は人間が判断する (通知に復旧コマンドを載せてある)．
//
// 使い方:
//   node scripts/tunnel-watchdog.mjs          # 監視 (定期実行用)
//   node scripts/tunnel-watchdog.mjs --json   # 結果を JSON で出す

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuntime } from '../src/tunnel.js';
import { failLoud } from '../src/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PROBE_TIMEOUT_MS = 15000;

const asJson = process.argv.includes('--json');

/** 公開 URL に実際に到達できるか確かめる． */
async function probeUrl(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', signal: ac.signal, redirect: 'manual' });
    // 2xx/3xx/401 いずれもトンネル自体は通っている．5xx と接続失敗だけを異常とみなす．
    return { ok: res.status < 500, status: res.status };
  } catch (e) {
    return { ok: false, status: null, error: e.name === 'AbortError' ? `timeout ${PROBE_TIMEOUT_MS}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** exposure.preset から「トンネルが上がっているべきか」を決める． */
async function readExpectation() {
  try {
    const raw = await readFile(join(ROOT, 'config', 'server.json'), 'utf-8');
    const cfg = JSON.parse(raw);
    const preset = cfg?.exposure?.preset ?? null;
    return { preset, expectUp: preset === 'cloudflare-quick' };
  } catch (e) {
    // 設定が読めないこと自体が異常．期待値不明のまま黙って OK にしない．
    return { preset: null, expectUp: null, error: e.message };
  }
}

const result = { checkedAt: new Date().toISOString(), verdict: null, detail: {} };

const exp = await readExpectation();
result.detail.preset = exp.preset;

if (exp.expectUp === null) {
  result.verdict = 'CONFIG_UNREADABLE';
  failLoud('tunnel-watchdog', 'config/server.json を読めず期待状態を判定できない', exp.error);
  emit(1);
}

const status = await readRuntime().then((r) => r.cloudflare ?? {});
result.detail.runtime = { running: !!status.running, url: status.url ?? null, pid: status.pid ?? null };

if (!exp.expectUp) {
  // 公開しない設定．トンネルが上がっていたらそれはそれで想定外なので知らせる．
  if (status.running) {
    result.verdict = 'UNEXPECTED_TUNNEL';
    failLoud(
      'tunnel-watchdog',
      `exposure.preset='${exp.preset}' なのにトンネルが動いている (url=${status.url})`,
      '意図しない公開の可能性がある．停止するなら: POST /admin/api/tunnel/stop',
    );
    emit(1);
  }
  result.verdict = 'OK_NOT_EXPOSED';
  emit(0);
}

// ここから先は「上がっているべき」ケース
result.detail.runtime.stoppedAt = status.stoppedAt ?? null;
result.detail.runtime.stopReason = status.stopReason ?? null;

if (!status.running && isManualStop(status)) {
  // 意図した停止．公開していないのが正しい状態なので通知しない．
  result.verdict = 'STOPPED_BY_OPERATOR';
  emit(0);
}

if (!status.running || !status.url) {
  result.verdict = 'DOWN';
  failLoud(
    'tunnel-watchdog',
    'Cloudflare トンネルが落ちている (exposure.preset=cloudflare-quick なので上がっているべき)',
    [
      'runtime.json の stale 状態は readRuntime() が掃除済み．',
      '復旧するとURLが変わるので，共同編集者へ新URLの再通知が要る．',
      '復旧コマンド (サーバー機で実行・管理ポートはローカル限定):',
      `  $t = (Get-Content '${join(ROOT, 'config', 'admin-token.txt')}' -Raw).Trim()`,
      "  Invoke-RestMethod -Uri 'http://127.0.0.1:1235/admin/api/tunnel/start' -Method POST " +
        "-Headers @{Authorization='Bearer '+$t;'Content-Type'='application/json'} -Body '{\"target\":\"app\"}'",
    ].join('\n'),
  );
  emit(1);
}

const probe = await probeUrl(status.url);
result.detail.probe = probe;

if (!probe.ok) {
  result.verdict = 'UNREACHABLE';
  failLoud(
    'tunnel-watchdog',
    `runtime.json は running だが公開 URL に到達できない: ${status.url}`,
    `probe: status=${probe.status ?? 'n/a'} error=${probe.error ?? 'n/a'}\n` +
      'cloudflared のプロセスが生きていてもトンネルが機能していない状態．stop → start で張り直す．',
  );
  emit(1);
}

result.verdict = 'OK';
emit(0);

/**
 * 運用者が意図して止めたか．killTunnel() は stopReason='manual' を書く．
 * stopReason 導入前 (2026-10-06 以前) の手動停止は stopReason も staleCleanup も持たないので，
 * stoppedAt があって staleCleanup が無いものも手動停止とみなす．
 */
function isManualStop(s) {
  if (s.stopReason) return s.stopReason === 'manual';
  return !!s.stoppedAt && !s.staleCleanup;
}

function emit(code) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const d = result.detail;
    console.log(
      `[tunnel-watchdog] ${result.verdict} preset=${d.preset ?? 'n/a'} ` +
        `url=${d.runtime?.url ?? 'none'} pid=${d.runtime?.pid ?? 'none'}` +
        (d.runtime?.stopReason ? ` stopReason=${d.runtime.stopReason}` : '') +
        (d.probe ? ` probe=${d.probe.status ?? d.probe.error}` : ''),
    );
  }
  process.exit(code);
}
