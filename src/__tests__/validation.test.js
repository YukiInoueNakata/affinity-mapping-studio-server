// R4 validation test
import { describe, it, expect } from 'vitest';
import { validateAuthPolicy } from '../validation.js';

const PUBLIC_PRESETS = ['cloudflare-quick', 'cloudflare-named', 'tailscale-funnel', 'reverse-proxy'];
const NON_PUBLIC = ['local', 'lan', 'tailscale-serve', 'custom'];

describe('R4 validateAuthPolicy: errors (保存拒否)', () => {
  it('公開系 + noneOpen=on → error', () => {
    for (const preset of PUBLIC_PRESETS) {
      const room = { accessControl: 'open' };
      const policy = { authMethods: { noneOpen: true } };
      const v = validateAuthPolicy(room, policy, { preset: { name: preset } });
      expect(v.errors.length).toBeGreaterThan(0);
    }
  });

  it('非公開系 + noneOpen=on → error なし', () => {
    for (const preset of NON_PUBLIC) {
      const room = { accessControl: 'open' };
      const policy = { authMethods: { noneOpen: true } };
      const v = validateAuthPolicy(room, policy, { preset: { name: preset } });
      const noneOpenErrors = v.errors.filter((e) => e.includes('noneOpen'));
      expect(noneOpenErrors).toEqual([]);
    }
  });

  it('invite_list + inviteToken=off → error (room ロック)', () => {
    const room = { accessControl: 'invite_list' };
    const policy = { authMethods: { inviteToken: false } };
    const v = validateAuthPolicy(room, policy, { preset: { name: 'lan' } });
    expect(v.errors.some((e) => e.includes('invite_list'))).toBe(true);
  });
});

describe('R4 validateAuthPolicy: warnings', () => {
  it('公開系 + emailLegacy=on → warning', () => {
    const room = { accessControl: 'open' };
    const policy = { authMethods: { emailLegacy: true } };
    const v = validateAuthPolicy(room, policy, { preset: { name: 'cloudflare-quick' } });
    expect(v.warnings.some((w) => w.includes('emailLegacy'))).toBe(true);
  });

  it('reverse-proxy + trustedProxy=on + 0.0.0.0 → warning', () => {
    const room = { accessControl: 'open' };
    const policy = { authMethods: { trustedProxy: true } };
    const v = validateAuthPolicy(room, policy, {
      preset: { name: 'reverse-proxy' },
      network: { appBindHost: '0.0.0.0' },
    });
    expect(v.warnings.some((w) => w.includes('0.0.0.0'))).toBe(true);
  });

  it('passwordHash あり + roomPassword=off → warning', () => {
    const room = { accessControl: 'open', passwordHash: 'scrypt$...' };
    const policy = { authMethods: { roomPassword: false } };
    const v = validateAuthPolicy(room, policy, { preset: { name: 'lan' } });
    expect(v.warnings.some((w) => w.includes('password'))).toBe(true);
  });

  it('requirementGroups=[] + 公開系 → warning', () => {
    const room = { accessControl: 'open' };
    const policy = { authMethods: {}, requirementGroups: [] };
    const v = validateAuthPolicy(room, policy, { preset: { name: 'cloudflare-quick' } });
    expect(v.warnings.some((w) => w.includes('requirementGroups') || w.includes('必須条件'))).toBe(true);
  });
});

describe('R4 validateAuthPolicy: 安全な設定', () => {
  it('cloudflare-quick + inviteToken のみ → 警告なし', () => {
    const room = { accessControl: 'open' };
    const policy = {
      authMethods: {
        inviteToken: true,
        emailLegacy: false,
        noneOpen: false,
      },
      requirementGroups: [['inviteToken']],
    };
    const v = validateAuthPolicy(room, policy, { preset: { name: 'cloudflare-quick' } });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it('local シナリオ A (localhostAuto のみ) → 警告なし', () => {
    const room = { accessControl: 'open' };
    const policy = {
      authMethods: { localhostAuto: true },
      requirementGroups: [['localhostAuto']],
    };
    const v = validateAuthPolicy(room, policy, { preset: { name: 'local' } });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });
});
