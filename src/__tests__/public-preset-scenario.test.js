// Phase 0 公開系 preset E2E シナリオテスト．
//
// レビュー指摘の整合性チェック (Sec-112) を end-to-end で確認:
//   - cloudflare-quick + localhostAuto=on → 強制 OFF + warning
//   - cloudflare-quick + legacyEmail=on → warning
//   - cloudflare-quick + noneOpen=on → warning
//   - reverse-proxy + trustedProxyHeader 設定で trusted-proxy provider active
//   - local + localhostAuto は許可

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadServerConfig } from '../config.js';

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
  const keys = [
    'KJ_EXPOSURE_PRESET',
    'KJ_LOCALHOST_AUTO_TRUST',
    'KJ_AUTH_LEGACY_EMAIL',
    'KJ_ALLOW_NO_AUTH_OPEN_ROOM',
    'KJ_TRUSTED_PROXY_HEADER',
    'KJ_ALLOWED_CIDRS',
    'PORT', 'KJ_APP_BIND_HOST',
  ];
  for (const k of keys) setEnv(k, undefined);
});

afterEach(() => restoreEnv());

describe('Public preset シナリオ: cloudflare-quick', () => {
  it('localhostAuto を try=true で渡しても強制 OFF + warning', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'cloudflare-quick');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.preset.name).toBe('cloudflare-quick');
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(false);
    expect(cfg.warnings.some((w) => w.includes('localhostAuto'))).toBe(true);
  });

  it('legacyEmail=on で warning', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'cloudflare-quick');
    setEnv('KJ_AUTH_LEGACY_EMAIL', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.legacyEmailEnabled).toBe(true);
    expect(cfg.warnings.some((w) => w.includes('email-legacy') || w.includes('legacy'))).toBe(true);
  });

  it('noneOpen=on で warning (公開 + 認証なし誰でも入室危険)', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'cloudflare-quick');
    setEnv('KJ_ALLOW_NO_AUTH_OPEN_ROOM', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.noneOpenEnabled).toBe(true);
    expect(cfg.warnings.some((w) => w.includes('noneOpen') || w.includes('open room'))).toBe(true);
  });

  it('trustedProxySources に loopback が default で入っている', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'cloudflare-quick');
    const cfg = await loadServerConfig();
    expect(cfg.network.trustedProxySources).toContain('127.0.0.1/32');
  });
});

describe('Public preset シナリオ: cloudflare-named', () => {
  it('localhostAuto 強制 OFF + warning', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'cloudflare-named');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(false);
    expect(cfg.warnings.length).toBeGreaterThan(0);
  });
});

describe('Public preset シナリオ: tailscale-funnel', () => {
  it('localhostAuto 強制 OFF', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'tailscale-funnel');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(false);
  });
});

describe('Public preset シナリオ: reverse-proxy', () => {
  it('trustedProxyHeader 設定で trusted-proxy provider active', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'reverse-proxy');
    setEnv('KJ_TRUSTED_PROXY_HEADER', 'X-Authenticated-User');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.trustedProxyHeader).toBe('X-Authenticated-User');
    expect(cfg.auth.providers).toContain('trusted-proxy');
  });

  it('trustedProxySources default あり', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'reverse-proxy');
    const cfg = await loadServerConfig();
    expect(cfg.network.trustedProxySources).toContain('127.0.0.1/32');
  });
});

describe('local preset (非公開系) シナリオ', () => {
  it('local + localhostAuto=on は許可される', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'local');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(true);
    expect(cfg.warnings.some((w) => w.includes('localhostAuto'))).toBe(false);
  });

  it('local + appBindHost=0.0.0.0 で warning (LAN 公開してる)', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'local');
    setEnv('KJ_APP_BIND_HOST', '0.0.0.0');
    const cfg = await loadServerConfig();
    expect(cfg.warnings.some((w) => w.includes('0.0.0.0') || w.includes('LAN'))).toBe(true);
  });
});

describe('lan preset シナリオ', () => {
  it('lan preset で trustedProxySources は空 (XFF 全部無視)', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'lan');
    const cfg = await loadServerConfig();
    expect(cfg.network.trustedProxySources).toEqual([]);
  });

  it('lan + localhostAuto=on は許可される (公開系ではない)', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'lan');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(true);
  });
});

describe('tailscale-serve シナリオ', () => {
  it('tailscale-serve は公開系ではないので localhostAuto を強制しない', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'tailscale-serve');
    setEnv('KJ_LOCALHOST_AUTO_TRUST', 'true');
    const cfg = await loadServerConfig();
    expect(cfg.authPolicy.localhostAutoEnabled).toBe(true);
  });
});

describe('active providers (banner 用)', () => {
  it('default で room-token と room-password は常時 active', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'local');
    const cfg = await loadServerConfig();
    expect(cfg.auth.providers).toContain('room-token');
    expect(cfg.auth.providers).toContain('room-password');
  });

  it('emailLegacy=false で email-legacy が active providers から消える', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'local');
    setEnv('KJ_AUTH_LEGACY_EMAIL', 'false');
    const cfg = await loadServerConfig();
    expect(cfg.auth.providers).not.toContain('email-legacy');
  });

  it('KJ_ALLOWED_CIDRS あれば ip-cidr が active', async () => {
    setEnv('KJ_EXPOSURE_PRESET', 'local');
    setEnv('KJ_ALLOWED_CIDRS', '192.168.1.0/24');
    const cfg = await loadServerConfig();
    expect(cfg.auth.providers).toContain('ip-cidr');
  });
});
