// 2026-11-07: ウィザードの認証設定が無視されていた不具合の回帰テスト．
// resolveServerConfig() に fileCfg を直接渡すので，手元の config/server.json に左右されない．

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveServerConfig } from '../config.js';

const ENV_KEYS = ['KJ_EXPOSURE_PRESET', 'KJ_AUTH_LEGACY_EMAIL', 'KJ_ALLOWED_CIDRS', 'KJ_TRUSTED_PROXY_HEADER'];
const saved = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const token = { adminTokenInfo: { token: 'test', source: 'test' } };
const resolve = (fileCfg) => resolveServerConfig(fileCfg, token);

describe('authPolicy の既定値', () => {
  it('公開系 preset (cloudflare-quick) では legacy email が既定で無効', async () => {
    const c = await resolve({ exposure: { preset: 'cloudflare-quick' } });
    expect(c.authPolicy.legacyEmailEnabled).toBe(false);
    expect(c.auth.providers).not.toContain('email-legacy');
    expect(c.warnings.join('\n')).not.toMatch(/email-legacy 認証が有効/);
  });

  it('非公開系 preset (local) では従来どおり既定で有効', async () => {
    const c = await resolve({ exposure: { preset: 'local' } });
    expect(c.authPolicy.legacyEmailEnabled).toBe(true);
  });

  it('公開系でも authPolicy で明示すれば有効にでき，警告が出る', async () => {
    const c = await resolve({ exposure: { preset: 'cloudflare-quick' }, authPolicy: { legacyEmailEnabled: true } });
    expect(c.authPolicy.legacyEmailEnabled).toBe(true);
    expect(c.warnings.join('\n')).toMatch(/email-legacy 認証が有効/);
  });

  it('env KJ_AUTH_LEGACY_EMAIL=true でも有効にできる', async () => {
    process.env.KJ_AUTH_LEGACY_EMAIL = 'true';
    const c = await resolve({ exposure: { preset: 'cloudflare-quick' } });
    expect(c.authPolicy.legacyEmailEnabled).toBe(true);
  });
});

describe('旧ウィザード形式 auth.* の読み替え', () => {
  it('auth.legacyEmail=true を読み替え，警告を出す', async () => {
    const c = await resolve({ exposure: { preset: 'cloudflare-quick' }, auth: { legacyEmail: true, allowedCidrs: [], trustedProxyHeader: '' } });
    expect(c.authPolicy.legacyEmailEnabled).toBe(true);
    expect(c.warnings.join('\n')).toMatch(/"auth" は旧形式/);
  });

  it('auth.allowedCidrs と trustedProxyHeader を読み替える', async () => {
    const c = await resolve({
      exposure: { preset: 'reverse-proxy' },
      auth: { legacyEmail: false, allowedCidrs: ['10.0.0.0/8'], trustedProxyHeader: 'X-Authenticated-User' },
    });
    expect(c.authPolicy.allowedCidrs).toEqual(['10.0.0.0/8']);
    expect(c.authPolicy.trustedProxyHeader).toBe('X-Authenticated-User');
    expect(c.authPolicy.legacyEmailEnabled).toBe(false);
  });

  it('authPolicy に明示があれば auth より authPolicy を優先する', async () => {
    const c = await resolve({
      exposure: { preset: 'local' },
      authPolicy: { legacyEmailEnabled: false },
      auth: { legacyEmail: true },
    });
    expect(c.authPolicy.legacyEmailEnabled).toBe(false);
  });

  it('auth が無ければ旧形式の警告は出ない', async () => {
    const c = await resolve({ exposure: { preset: 'cloudflare-quick' } });
    expect(c.warnings.join('\n')).not.toMatch(/旧形式/);
  });
});
