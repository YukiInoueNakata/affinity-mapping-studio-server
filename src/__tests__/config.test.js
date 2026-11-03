// R5 / R3 test: config source of truth + resolved config + public preset で localhost-auto 強制 OFF
//
// 注意: loadServerConfig() は config/server.json と env を読むので、
//       テスト中は CONFIG_DIR を意識して mock する必要がある．
//       本テストは「env override の挙動」と「resolved config の shape」を確認．

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadServerConfig,
  EXPOSURE_PRESETS,
  bootConfig,
  getResolvedConfig,
  setResolvedConfigForTest,
} from '../config.js';

// env を一時的に置換するヘルパー
const envBackup = {};
function setEnv(key, value) {
  if (!(key in envBackup)) envBackup[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
function restoreEnv() {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(envBackup)) delete envBackup[k];
}

beforeEach(() => {
  // 他テストの影響を避けるため、関連 env をすべて undefined に
  const keys = [
    'KJ_EXPOSURE_PRESET',
    'PORT', 'KJ_ADMIN_PORT', 'KJ_APP_BIND_HOST', 'KJ_ADMIN_BIND_HOST',
    'KJ_MAX_PAYLOAD_BYTES', 'KJ_MAX_CONN_PER_IP', 'KJ_MAX_CONN_PER_ROOM', 'KJ_MAX_UPDATES_PER_SEC',
    'KJ_COMPACT_ON_STARTUP', 'KJ_COMPACT_AFTER_UPDATES',
    'KJ_COMPACT_AFTER_BYTES', 'KJ_COMPACT_WARN_UPDATE_BYTES', 'KJ_COMPACT_WARN_FILE_BYTES',
    'KJ_REQUIRE_KJ_STUDIO_PROTOCOL', 'KJ_STRICT_VIEWER',
    'KJ_AUTH_LEGACY_EMAIL', 'KJ_TAILSCALE_NETWORK_OK', 'KJ_ALLOWED_CIDRS',
    'KJ_TRUSTED_PROXY_HEADER', 'KJ_ALLOW_NO_AUTH_OPEN_ROOM',
    'KJ_LOCALHOST_AUTO_TRUST', 'KJ_ALLOW_AUTO_ROOM_CREATE',
    'KJ_ALLOWED_ORIGINS', 'KJ_ALLOW_EMPTY_ORIGIN', 'KJ_ALLOW_LOCALHOST_ANY_PORT',
    'KJ_TRUSTED_PROXY_SOURCES',
    'KJ_ADMIN_TOKEN',
  ];
  for (const k of keys) setEnv(k, undefined);
});

afterEach(() => {
  restoreEnv();
});

describe('R5 resolved config shape', () => {
  it('loadServerConfig() が必須フィールドを全て持つ', async () => {
    const cfg = await loadServerConfig();
    expect(cfg).toHaveProperty('preset');
    expect(cfg).toHaveProperty('network.appPort');
    expect(cfg).toHaveProperty('network.trustedProxySources');
    expect(cfg).toHaveProperty('limits.maxPayloadBytes');
    expect(cfg).toHaveProperty('compact.onStartup');
    expect(cfg).toHaveProperty('origins.allowedExplicit');
    expect(cfg).toHaveProperty('protocol.requireKjStudio');
    expect(cfg).toHaveProperty('authPolicy.inviteTokenEnabled');
    expect(cfg).toHaveProperty('admin.token');
    expect(cfg).toHaveProperty('admin.tokenSource');
    expect(cfg).toHaveProperty('warnings');
  });

  it('デフォルトで authPolicy.inviteTokenEnabled / roomPasswordEnabled は常時 true', async () => {
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.inviteTokenEnabled).toBe(true);
    expect(cfg.authPolicy.roomPasswordEnabled).toBe(true);
  });

  it('デフォルトで authPolicy.localhostAutoEnabled は false', async () => {
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(false);
  });
});

describe('R5 env override (admin token は env 優先)', () => {
  it('KJ_ADMIN_TOKEN env があれば admin.token は env を採用', async () => {
    setEnv('KJ_ADMIN_TOKEN', 'test-admin-token-from-env');
    const cfg = await loadServerConfig();
    expect(cfg.admin.token).toBe('test-admin-token-from-env');
    expect(cfg.admin.tokenSource).toBe('env');
  });

  it('PORT env が反映される (config 無し時のデフォルト override)', async () => {
    setEnv('PORT', '9999');
    const cfg = await loadServerConfig();
    expect(cfg.network.appPort).toBe(9999);
  });

  it('KJ_AUTH_LEGACY_EMAIL=false で legacyEmailEnabled が false', async () => {
    setEnv('KJ_AUTH_LEGACY_EMAIL', 'false');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.legacyEmailEnabled).toBe(false);
  });

  it('KJ_ALLOWED_CIDRS で複数 CIDR が parse される', async () => {
    setEnv('KJ_ALLOWED_CIDRS', '192.168.1.0/24,10.0.0.0/8');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.allowedCidrs).toEqual(['192.168.1.0/24', '10.0.0.0/8']);
  });
});

describe('R3 公開系 preset で localhost-auto 強制 OFF', () => {
  it('cloudflare-quick + localhostAuto=on でも resolved は false', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'cloudflare-quick');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(false);
    expect(cfg.warnings.some((w) => w.includes('localhostAuto'))).toBe(true);
  });

  it('cloudflare-named でも強制 OFF', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'cloudflare-named');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(false);
  });

  it('tailscale-funnel でも強制 OFF', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'tailscale-funnel');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(false);
  });

  it('reverse-proxy でも強制 OFF', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'reverse-proxy');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(false);
  });

  it('local preset では localhostAuto=on を尊重', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'local');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(true);
  });

  it('tailscale-serve では localhostAuto を強制しない', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'tailscale-serve');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(true);
  });
});

describe('R2 trustedProxySources preset default', () => {
  it('local preset で trustedProxySources に loopback が入る', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'local');
    const cfg = await loadServerConfig();
    expect(cfg.network.trustedProxySources).toContain('127.0.0.1/32');
  });

  it('lan preset で trustedProxySources が空', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'lan');
    const cfg = await loadServerConfig();
    expect(cfg.network.trustedProxySources).toEqual([]);
  });

  it('cloudflare-quick で trustedProxySources に loopback', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'cloudflare-quick');
    const cfg = await loadServerConfig();
    expect(cfg.network.trustedProxySources).toContain('127.0.0.1/32');
  });
});

describe('R5 bootConfig / getResolvedConfig', () => {
  it('getResolvedConfig() を bootConfig() 前に呼ぶと throw', () => {
    setResolvedConfigForTest(null);
    expect(() => getResolvedConfig()).toThrow();
  });

  it('bootConfig() 後に getResolvedConfig() で同じ値が返る', async () => {
    setResolvedConfigForTest(null);
    const a = await bootConfig();
    const b = getResolvedConfig();
    expect(a).toBe(b); // 同じオブジェクト参照
  });

  it('setResolvedConfigForTest でテスト時 mock 可能', () => {
    const mock = { preset: { name: 'test' }, network: {}, authPolicy: {}, admin: {}, warnings: [] };
    setResolvedConfigForTest(mock);
    expect(getResolvedConfig()).toBe(mock);
  });
});

describe('R5 warnings (Sec-112 整合性チェック)', () => {
  it('public preset で noneOpenEnabled=on で warning', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'cloudflare-quick');
    setEnv('KJ_ALLOW_NO_AUTH_OPEN_ROOM', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.warnings.some((w) => w.includes('noneOpen') || w.includes('open room'))).toBe(true);
  });

  it('public preset で legacyEmail=on で warning', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'cloudflare-quick');
    setEnv('KJ_AUTH_LEGACY_EMAIL', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.warnings.some((w) => w.includes('email-legacy') || w.includes('legacy'))).toBe(true);
  });
});

describe('Fix #4 byte-based compaction config', () => {
  it('compact のバイト系デフォルト (afterBytes / warnUpdateBytes / warnFileBytes) を持つ', async () => {
    const cfg = await loadServerConfig();
    expect(cfg.compact.afterBytes).toBe(16 * 1024 * 1024);
    expect(cfg.compact.warnUpdateBytes).toBe(256 * 1024);
    expect(cfg.compact.warnFileBytes).toBe(64 * 1024 * 1024);
  });

  it('env でバイト閾値を上書きできる', async () => {
    setEnv('KJ_COMPACT_AFTER_BYTES', '8388608'); // 8 MB
    setEnv('KJ_COMPACT_WARN_UPDATE_BYTES', '131072'); // 128 KB
    setEnv('KJ_COMPACT_WARN_FILE_BYTES', '33554432'); // 32 MB
    const cfg = await loadServerConfig();
    expect(cfg.compact.afterBytes).toBe(8 * 1024 * 1024);
    expect(cfg.compact.warnUpdateBytes).toBe(128 * 1024);
    expect(cfg.compact.warnFileBytes).toBe(32 * 1024 * 1024);
  });

  it('count 系トリガー (afterUpdates) も維持される', async () => {
    const cfg = await loadServerConfig();
    expect(cfg.compact.afterUpdates).toBe(200);
  });
});
