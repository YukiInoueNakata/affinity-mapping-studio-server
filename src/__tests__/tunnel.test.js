// R8 test: tunnel module の安全ガード
//
// テスト戦略: 実 cloudflared を起動せず、内部 API を直接呼ぶ．
// runtime.json は一時 path に切替 (テスト分離) — 実装で path 切替できないので
// data/runtime.json は全テストの前に退避し，終了時に元へ戻す．

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  detectCloudflared,
  spawnTunnel,
  killTunnel,
  getTunnelStatus,
  readRuntime,
  recordExternalTunnel,
} from '../tunnel.js';
import { setResolvedConfigForTest } from '../config.js';
import { readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const RUNTIME_PATH = join(DATA_DIR, 'runtime.json');

async function clearRuntime() {
  try { await unlink(RUNTIME_PATH); } catch {}
}

async function setRuntime(json) {
  await writeFile(RUNTIME_PATH, JSON.stringify(json, null, 2), 'utf-8');
}

// 本番の data/runtime.json を退避して最後に戻す (2026-11-04 / 11-07: 退避が無く
// テストのたびに消え，tunnel-watchdog が「意図した停止」を判定できなくなった)．
// 実装で path を切り替えられないため，ここで丸ごと退避・復元する．
let savedRuntime = null; // null = もともと無かった
beforeAll(async () => {
  try { savedRuntime = await readFile(RUNTIME_PATH, 'utf-8'); } catch { savedRuntime = null; }
});
afterAll(async () => {
  if (savedRuntime === null) await clearRuntime();
  else await writeFile(RUNTIME_PATH, savedRuntime, 'utf-8');
});

beforeEach(async () => {
  await clearRuntime();
  // テスト用の resolved config を設定 (app=1234, admin=1235)
  setResolvedConfigForTest({
    preset: { name: 'test' },
    network: { appPort: 1234, adminPort: 1235, appBindHost: '127.0.0.1', adminBindHost: '127.0.0.1' },
    limits: {},
    compact: {},
    origins: {},
    protocol: {},
    authPolicy: {},
    admin: { token: 'test', tokenSource: 'test' },
    warnings: [],
  });
});

afterEach(async () => {
  await clearRuntime();
  setResolvedConfigForTest(null);
});

describe('R8 spawnTunnel: admin port ガード', () => {
  it("target='custom' で admin port を渡すと throw", async () => {
    await expect(spawnTunnel({ target: 'custom', port: 1235 })).rejects.toThrow(/admin port/);
  });

  it("target='custom' で port 未指定なら throw", async () => {
    await expect(spawnTunnel({ target: 'custom' })).rejects.toThrow(/explicit port/);
  });

  it("target='other' (未知) なら throw", async () => {
    await expect(spawnTunnel({ target: 'unknown' })).rejects.toThrow(/unknown target/);
  });
});

describe('R8 多重起動防止', () => {
  it('既に running 状態なら spawnTunnel が throw', async () => {
    // runtime.json に running 状態を事前設定 + 自分自身の PID で生存判定パス
    await setRuntime({
      cloudflare: {
        running: true,
        url: 'https://example.trycloudflare.com',
        pid: process.pid, // 自分の PID なので生存
        target: 'app',
        targetPort: 1234,
        startedAt: new Date().toISOString(),
      },
    });
    await expect(spawnTunnel({ target: 'app' })).rejects.toThrow(/already running/);
  });
});

describe('R8 stale PID 検出', () => {
  it('runtime に存在しない PID があれば cleanup される', async () => {
    // 99999 (たぶん不存在) を runtime に書く
    await setRuntime({
      cloudflare: {
        running: true,
        url: 'https://example.trycloudflare.com',
        pid: 999999,
        target: 'app',
        targetPort: 1234,
        startedAt: new Date().toISOString(),
      },
    });
    const r = await readRuntime();
    expect(r.cloudflare.running).toBe(false);
    expect(r.cloudflare.staleCleanup).toBe(true);
  });

  it('killTunnel が stale PID で reason="stale-pid"', async () => {
    await setRuntime({
      cloudflare: {
        running: true,
        url: 'https://example.trycloudflare.com',
        pid: 999999,
        target: 'app',
        targetPort: 1234,
        startedAt: new Date().toISOString(),
      },
    });
    const r = await killTunnel();
    expect(r.killed).toBe(false);
    expect(r.reason).toBe('stale-pid');
  });

  it('killTunnel が "not-running" のとき適切に reason', async () => {
    await clearRuntime();
    const r = await killTunnel();
    expect(r.killed).toBe(false);
    expect(r.reason).toBe('not-running');
  });
});

describe('R8 getTunnelStatus', () => {
  it('runtime.json なし → { running: false }', async () => {
    await clearRuntime();
    const s = await getTunnelStatus();
    expect(s.running).toBe(false);
  });

  it('runtime に自分の PID (alive) なら running: true + url', async () => {
    await setRuntime({
      cloudflare: {
        running: true,
        url: 'https://example.trycloudflare.com',
        pid: process.pid,
        target: 'app',
        targetPort: 1234,
        startedAt: new Date().toISOString(),
      },
    });
    const s = await getTunnelStatus();
    expect(s.running).toBe(true);
    expect(s.url).toBe('https://example.trycloudflare.com');
    expect(s.pid).toBe(process.pid);
  });
});

describe('R8 atomic write + recordExternalTunnel', () => {
  it('recordExternalTunnel で runtime.json が atomic 書込', async () => {
    // process.pid を使う (alive PID なので readRuntime の stale cleanup をパス)
    await recordExternalTunnel({
      url: 'https://abc.trycloudflare.com',
      pid: process.pid,
      target: 'app',
      targetPort: 1234,
    });
    const r = await readRuntime();
    expect(r.cloudflare.url).toBe('https://abc.trycloudflare.com');
    expect(r.cloudflare.pid).toBe(process.pid);
    expect(r.cloudflare.target).toBe('app');
    expect(r.cloudflare.targetPort).toBe(1234);
    expect(r.cloudflare.external).toBe(true);
  });
});

describe('R8 detectCloudflared', () => {
  it('cloudflared が PATH or 既知ロケーションにあれば文字列を返す or null', async () => {
    const r = await detectCloudflared();
    // 環境依存．string or null．
    expect(r === null || typeof r === 'string').toBe(true);
  });
});
