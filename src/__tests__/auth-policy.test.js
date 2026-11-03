// R1 + A1 + A2 + R13 test: authPolicy schema + policy-driven checkAccess
//
// - 自動推論ロジック (passwordHash + accessControl から requirementGroups)
// - provider 順 + requirementGroups 評価
// - 戻り値の effectivePolicy / matchedRule / failedGroups / deniedReasons
// - legacy room (authPolicy なし) との互換性

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { inferAuthPolicy } from '../rooms.js';

describe('R1 inferAuthPolicy: 自動推論ロジック', () => {
  const serverPolicy = {
    inviteTokenEnabled: true,
    roomPasswordEnabled: true,
    legacyEmailEnabled: true,
    tailscaleEnabled: true,
    localhostAutoEnabled: false,
  };

  it('passwordHash なし + accessControl=open → requirementGroups = []', () => {
    const room = { accessControl: 'open', invitations: [], passwordHash: undefined };
    const p = inferAuthPolicy(room, serverPolicy);
    expect(p.requirementGroups).toEqual([]);
  });

  it('passwordHash なし + accessControl=invite_list → [["inviteToken"]]', () => {
    const room = { accessControl: 'invite_list', invitations: [], passwordHash: undefined };
    const p = inferAuthPolicy(room, serverPolicy);
    expect(p.requirementGroups).toEqual([['inviteToken']]);
  });

  it('passwordHash あり + accessControl=open → [["inviteToken", "roomPassword"]]', () => {
    const room = { accessControl: 'open', invitations: [], passwordHash: 'scrypt$...' };
    const p = inferAuthPolicy(room, serverPolicy);
    expect(p.requirementGroups).toEqual([['inviteToken', 'roomPassword']]);
  });

  it('passwordHash あり + accessControl=invite_list → [["inviteToken"]]', () => {
    const room = { accessControl: 'invite_list', invitations: [], passwordHash: 'scrypt$...' };
    const p = inferAuthPolicy(room, serverPolicy);
    expect(p.requirementGroups).toEqual([['inviteToken']]);
  });

  it('room.authPolicy.requirementGroups が明示 → そちらを優先', () => {
    const room = {
      accessControl: 'open',
      invitations: [],
      passwordHash: undefined,
      authPolicy: { requirementGroups: [['inviteToken'], ['roomPassword']] },
    };
    const p = inferAuthPolicy(room, serverPolicy);
    expect(p.requirementGroups).toEqual([['inviteToken'], ['roomPassword']]);
  });

  it('既存 room (authPolicy なし) は legacy 互換動作', () => {
    const room = { accessControl: 'open', invitations: [], passwordHash: undefined };
    const p = inferAuthPolicy(room, serverPolicy);
    // 互換: authMethods は global default
    expect(p.authMethods.inviteToken).toBe(true);
    expect(p.authMethods.roomPassword).toBe(true);
    expect(p.authMethods.emailLegacy).toBe(true);
    expect(p.authMethods.tailscale).toBe(true);
    expect(p.authMethods.localhostAuto).toBe(false);
  });
});

describe('R1 inferAuthPolicy: per-room authMethods override', () => {
  const serverPolicy = {
    inviteTokenEnabled: true,
    roomPasswordEnabled: true,
    legacyEmailEnabled: true,
    tailscaleEnabled: true,
    localhostAutoEnabled: false,
  };

  it('authMethods.tailscale=off で room ごとに OFF', () => {
    const room = {
      accessControl: 'open',
      invitations: [],
      authPolicy: { authMethods: { tailscale: 'off' } },
    };
    const p = inferAuthPolicy(room, serverPolicy);
    expect(p.authMethods.tailscale).toBe(false);
  });

  it('authMethods.localhostAuto=on で room ごとに ON', () => {
    const room = {
      accessControl: 'open',
      invitations: [],
      authPolicy: { authMethods: { localhostAuto: 'on' } },
    };
    const p = inferAuthPolicy(room, serverPolicy);
    expect(p.authMethods.localhostAuto).toBe(true);
  });

  it('authMethods.legacyEmail=inherit は global default に従う', () => {
    const room = {
      accessControl: 'open',
      invitations: [],
      authPolicy: { authMethods: { emailLegacy: 'inherit' } },
    };
    const p = inferAuthPolicy(room, serverPolicy);
    expect(p.authMethods.emailLegacy).toBe(true); // global=true
  });

  it('authMethods.legacyEmail=inherit で global=false なら false', () => {
    const serverPolicyNoLegacy = { ...serverPolicy, legacyEmailEnabled: false };
    const room = {
      accessControl: 'open',
      invitations: [],
      authPolicy: { authMethods: { emailLegacy: 'inherit' } },
    };
    const p = inferAuthPolicy(room, serverPolicyNoLegacy);
    expect(p.authMethods.emailLegacy).toBe(false);
  });
});

describe('R1 inferAuthPolicy: ipCidr / trustedProxy 自動推論', () => {
  it('serverPolicy.allowedCidrs 非空で ipCidr=true', () => {
    const sp = { allowedCidrs: ['192.168.1.0/24'] };
    const room = { accessControl: 'open', invitations: [] };
    const p = inferAuthPolicy(room, sp);
    expect(p.authMethods.ipCidr).toBe(true);
  });

  it('serverPolicy.allowedCidrs 空で ipCidr=false', () => {
    const sp = { allowedCidrs: [] };
    const room = { accessControl: 'open', invitations: [] };
    const p = inferAuthPolicy(room, sp);
    expect(p.authMethods.ipCidr).toBe(false);
  });

  it('serverPolicy.trustedProxyHeader あり → trustedProxy=true', () => {
    const sp = { trustedProxyHeader: 'X-Authenticated-User' };
    const room = { accessControl: 'open', invitations: [] };
    const p = inferAuthPolicy(room, sp);
    expect(p.authMethods.trustedProxy).toBe(true);
  });
});
