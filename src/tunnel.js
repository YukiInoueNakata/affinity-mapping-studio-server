// R8 + A4 (2026-06-09): Cloudflare Quick Tunnel の spawn/kill/URL 取得を集約．
//
// 重要な安全ガード:
//   - target='app' (default) → cfg.network.appPort 強制使用．admin port は絶対公開しない
//   - target='custom' → port 必須．admin port を渡したら throw
//   - 多重起動防止 (getTunnelStatus() で確認)
//   - stale PID 検出 (process.kill(pid, 0) で生存確認)
//   - atomic write (tmp + rename)
//   - runtime.json は data/runtime.json (gitignore)
//
// bat / tray / CLI / REST から共通呼出．

import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, unlink, stat, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getResolvedConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const RUNTIME_PATH = join(DATA_DIR, 'runtime.json');

const CLOUDFLARED_CANDIDATES = (() => {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  return [
    'cloudflared',                                    // PATH
    'cloudflared.exe',
    // WinGet packages 典型
    homeDir &&
      `${homeDir}\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\\cloudflared.exe`,
    // Homebrew
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    // apt
    '/usr/bin/cloudflared',
  ].filter(Boolean);
})();

/** PATH 探索 (where / which 経由) で実行ファイルを探す． */
async function whichCloudflared() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const proc = spawn(cmd, ['cloudflared'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      resolve(line || null);
    });
  });
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** R8 A4: cloudflared の実行ファイル path を検出．
 *  PATH → 既知ロケーションの順．見つかれば文字列，無ければ null． */
export async function detectCloudflared() {
  const fromPath = await whichCloudflared();
  if (fromPath) return fromPath;
  for (const p of CLOUDFLARED_CANDIDATES) {
    if (p === 'cloudflared' || p === 'cloudflared.exe') continue;
    if (await fileExists(p)) return p;
  }
  return null;
}

async function readRuntimeInner() {
  try {
    const raw = await readFile(RUNTIME_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    console.warn('[tunnel] runtime.json read failed:', e.message);
    return {};
  }
}

/** R8: runtime.json を atomic write (tmp + rename) */
async function writeRuntimeAtomic(patch) {
  const current = await readRuntimeInner();
  const next = { ...current, ...patch, writtenAt: new Date().toISOString() };
  const tmp = RUNTIME_PATH + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
  try {
    await rename(tmp, RUNTIME_PATH);
  } catch (e) {
    try { await unlink(tmp); } catch {}
    throw e;
  }
  return next;
}

/** R8: runtime.json から状態を返す．stale PID は cleanup する． */
export async function readRuntime() {
  const r = await readRuntimeInner();
  // Stale PID 検出: cloudflared 起動中とされているが PID 存在しないなら cleanup
  if (r.cloudflare?.running && r.cloudflare?.pid) {
    if (!isPidAlive(r.cloudflare.pid)) {
      await writeRuntimeAtomic({
        cloudflare: { running: false, url: null, pid: null, stoppedAt: new Date().toISOString(), staleCleanup: true, stopReason: 'stale' },
      });
      return await readRuntimeInner();
    }
  }
  return r;
}

/** R8: PID 生存確認 (kill(pid, 0)) */
function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'EPERM') return true; // permission denied = 存在する
    return false;
  }
}

/** R8 + A4: cloudflared を spawn して URL を取得．
 *
 *  @param {object} opts
 *  @param {'app'|'custom'} opts.target - 'app' なら cfg.network.appPort 強制
 *  @param {number} [opts.port] - target='custom' のとき必須．admin port は throw
 *  @param {'quick'} [opts.mode='quick'] - 将来 'named' も追加予定
 *  @param {number} [opts.urlTimeoutMs=20000] - URL 検出タイムアウト
 *  @returns {Promise<{proc, url, pid}>}
 */
export async function spawnTunnel(opts = {}) {
  const { target = 'app', mode = 'quick', urlTimeoutMs = 20000 } = opts;
  let port = opts.port;

  const cfg = getResolvedConfig();
  const adminPort = cfg.network.adminPort;

  // 1. target validation + admin port ガード
  if (target === 'app') {
    port = cfg.network.appPort;
  } else if (target === 'custom') {
    if (port === undefined || port === null) {
      throw new Error("spawnTunnel: target='custom' requires explicit port");
    }
    if (port === adminPort) {
      throw new Error(`spawnTunnel: refusing port ${port} — that is the admin port`);
    }
  } else {
    throw new Error(`spawnTunnel: unknown target '${target}' (expected 'app' or 'custom')`);
  }

  // 2. 多重起動チェック
  const status = await getTunnelStatus();
  if (status.running) {
    throw new Error(`tunnel already running (pid=${status.pid}, url=${status.url})`);
  }

  // 3. cloudflared 検出
  const cloudflaredPath = await detectCloudflared();
  if (!cloudflaredPath) {
    throw new Error('cloudflared not found. Install via: winget install Cloudflare.cloudflared');
  }

  // 4. spawn
  const proc = spawn(
    cloudflaredPath,
    ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  // 5. URL 検出: stdout / stderr に "https://*.trycloudflare.com" が出るまで待つ
  const urlPromise = new Promise((resolve, reject) => {
    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    let captured = null;
    const onData = (chunk) => {
      const text = chunk.toString();
      if (!captured) {
        const m = text.match(urlRegex);
        if (m) {
          captured = m[0];
          resolve(captured);
        }
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => reject(new Error(`cloudflared spawn error: ${e.message}`)));
    proc.on('close', (code) => {
      if (!captured) reject(new Error(`cloudflared exited (code=${code}) without URL`));
    });
    setTimeout(() => {
      if (!captured) reject(new Error(`URL not detected within ${urlTimeoutMs}ms`));
    }, urlTimeoutMs);
  });

  const url = await urlPromise.catch(async (e) => {
    // 起動失敗 → process 終了 + runtime クリーン
    try { proc.kill('SIGTERM'); } catch {}
    throw e;
  });

  // 6. runtime.json に保存
  await writeRuntimeAtomic({
    cloudflare: {
      running: true,
      url,
      pid: proc.pid,
      target,
      targetPort: port,
      mode,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
    },
  });

  return { proc, url, pid: proc.pid };
}

/** R8 + A4: cloudflared を停止．PID 不在なら runtime をクリーンアップして fresh 返却． */
export async function killTunnel() {
  const r = await readRuntimeInner();
  const pid = r.cloudflare?.pid;
  if (!pid) {
    return { killed: false, reason: 'not-running' };
  }
  if (!isPidAlive(pid)) {
    await writeRuntimeAtomic({
      cloudflare: { running: false, url: null, pid: null, stoppedAt: new Date().toISOString(), staleCleanup: true, stopReason: 'stale' },
    });
    return { killed: false, reason: 'stale-pid' };
  }
  // SIGTERM
  let killedGracefully = false;
  try {
    process.kill(pid, 'SIGTERM');
    // 5 秒待って生存確認
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!isPidAlive(pid)) {
        killedGracefully = true;
        break;
      }
    }
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
    killedGracefully = true;
  }
  // SIGKILL fallback
  if (!killedGracefully) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (e) {
      if (e.code !== 'ESRCH') console.warn('[tunnel] SIGKILL failed:', e.message);
    }
  }
  // stopReason='manual': 運用者が意図して止めた印．tunnel-watchdog はこれを異常扱いしない．
  await writeRuntimeAtomic({
    cloudflare: { running: false, url: null, pid: null, stoppedAt: new Date().toISOString(), stopReason: 'manual' },
  });
  return { killed: true, graceful: killedGracefully };
}

/** R8: tunnel status．stale PID 検出ロジックを含む． */
export async function getTunnelStatus() {
  const r = await readRuntime();
  if (!r.cloudflare?.running) {
    return { running: false };
  }
  return {
    running: true,
    url: r.cloudflare.url,
    pid: r.cloudflare.pid,
    target: r.cloudflare.target,
    targetPort: r.cloudflare.targetPort,
    startedAt: r.cloudflare.startedAt,
  };
}

/** A4: 外部 (bat / tray) が "URL を runtime.json に登録だけしたい" 場合のヘルパー．
 *  cloudflared 自体は外部で起動済み．PID と URL を渡せば runtime に書く． */
export async function recordExternalTunnel({ url, pid, target = 'app', targetPort, mode = 'quick' }) {
  await writeRuntimeAtomic({
    cloudflare: {
      running: true,
      url,
      pid,
      target,
      targetPort,
      mode,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      external: true,
    },
  });
  return { ok: true };
}
