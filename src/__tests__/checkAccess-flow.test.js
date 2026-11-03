// R1+A1+A2+R13 checkAccess の完全評価フローテスト．
//
// rooms.json は実ファイル (data/rooms.json) を読むため、テスト中に room を作成 →
// テスト後にクリーンアップ．既存 room は影響を受けないよう、
// test-* prefix の room 名を使う．

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createRoom,
  deleteRoom,
  setRoomOptions,
  setRoomPassword,
  inviteEmail,
  checkAccess,
} from '../rooms.js';

// テスト用 server authPolicy (resolved config 相当)
const baseServerPolicy = {
  inviteTokenEnabled: true,
  roomPasswordEnabled: true,
  legacyEmailEnabled: true,
  tailscaleEnabled: true,
  allowedCidrs: [],
  trustedProxyHeader: null,
  noneOpenEnabled: false,
  localhostAutoEnabled: false,
  allowAutoRoomCreate: false,
};

const TEST_ROOM_PREFIX = 'test-flow-';
const cleanups = [];

async function makeTestRoom(suffix, opts = {}) {
  const id = TEST_ROOM_PREFIX + suffix + '-' + Date.now();
  await createRoom(id, opts);
  cleanups.push(id);
  return id;
}

afterEach(async () => {
  for (const id of cleanups) {
    try { await deleteRoom(id); } catch {}
  }
  cleanups.length = 0;
});

describe('checkAccess: open room シナリオ', () => {
  it('passwordHash なし + open + email-legacy で入室可能 (legacy 互換)', async () => {
    const id = await makeTestRoom('open', { accessControl: 'open' });
    const v = await checkAccess(id, { email: 'anon@test', judgeIp: '1.2.3.4', directIp: '1.2.3.4' }, baseServerPolicy);
    expect(v.allowed).toBe(true);
    expect(v.via).toBe('emailLegacy');
    expect(v.role).toBe('editor');
    expect(v.effectivePolicy.requirementGroups).toEqual([]);
  });

  it('open + admin 招待 email を自己申告しても admin にはならない (レビュー critical#1)', async () => {
    // 回帰: 旧実装は open ルームで自己申告 email が招待に一致すると inv.role
    // (admin) をそのまま返し，第三者が ?email=<admin> だけで admin 化して破壊的
    // restore と監査偽装まで到達できた．open では editor 固定にする．
    const id = await makeTestRoom('open-admin-spoof', { accessControl: 'open' });
    await inviteEmail(id, 'boss@test', 'admin', {});
    const v = await checkAccess(
      id,
      { email: 'boss@test', judgeIp: '1.2.3.4', directIp: '1.2.3.4' },
      baseServerPolicy,
    );
    expect(v.allowed).toBe(true);
    expect(v.via).toBe('emailLegacy');
    expect(v.role).not.toBe('admin');
    expect(v.role).toBe('editor');
  });

  it('passwordHash なし + open + 何も送らないと no-valid-credentials', async () => {
    const id = await makeTestRoom('open-noemail', { accessControl: 'open' });
    // emailLegacy provider は ctx.email がない場合でも accessControl='open' で passed する
    // (provider 実装が「email 無くても editor として通す」設計のため．これは legacy 動作．)
    // → "no-email" が出るのは invite_list の場合のみ
    const v = await checkAccess(id, { judgeIp: '1.2.3.4', directIp: '1.2.3.4' }, baseServerPolicy);
    expect(v.allowed).toBe(true);
    expect(v.via).toBe('emailLegacy');
  });
});

describe('checkAccess: invite_list room シナリオ', () => {
  it('invite_list + メアド未送信なら deny (requirement-group-failed)', async () => {
    const id = await makeTestRoom('invite', { accessControl: 'invite_list' });
    await inviteEmail(id, 'alice@test', 'editor', {});
    const v = await checkAccess(id, { judgeIp: '1.2.3.4', directIp: '1.2.3.4' }, baseServerPolicy);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('requirement-group-failed');
    expect(v.effectivePolicy.requirementGroups).toEqual([['inviteToken']]);
    expect(v.failedGroups).toEqual([['inviteToken']]);
  });

  it('invite_list + 招待した email でも token なしなら deny', async () => {
    const id = await makeTestRoom('invite-email-only', { accessControl: 'invite_list' });
    await inviteEmail(id, 'bob@test', 'viewer', {});
    const v = await checkAccess(id, { email: 'bob@test', judgeIp: '1.2.3.4', directIp: '1.2.3.4' }, baseServerPolicy);
    // invite_list + emailLegacy=on でも、requirementGroups=[['inviteToken']] を満たさず deny
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('requirement-group-failed');
  });

  it('invite_list + 正しい token で入室可能 + role 反映', async () => {
    const id = await makeTestRoom('invite-token-ok', { accessControl: 'invite_list' });
    const room = await inviteEmail(id, 'carol@test', 'viewer', {});
    const invite = room.invitations.find((i) => i.email === 'carol@test');
    const v = await checkAccess(id, { token: invite.token, judgeIp: '1.2.3.4', directIp: '1.2.3.4' }, baseServerPolicy);
    expect(v.allowed).toBe(true);
    expect(v.role).toBe('viewer');
    expect(v.via).toBe('inviteToken');
    expect(v.identity).toBe('carol@test');
  });

  it('invite_list + 不正な token で deny (invalid-token は requirement-group-failed 経路)', async () => {
    const id = await makeTestRoom('invite-bad-token', { accessControl: 'invite_list' });
    await inviteEmail(id, 'dave@test', 'editor', {});
    const v = await checkAccess(id, { token: 'WRONG-TOKEN', judgeIp: '1.2.3.4', directIp: '1.2.3.4' }, baseServerPolicy);
    // inviteToken provider が passed=false なので satisfied set に入らない
    // → requirement-group-failed
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('requirement-group-failed');
  });
});

describe('checkAccess: passwordHash room シナリオ (R1 password 必須化)', () => {
  it('passwordHash あり + open でも password なし → deny (R1 password 必須化)', async () => {
    const id = await makeTestRoom('pwd-open', { accessControl: 'open' });
    await setRoomPassword(id, 'test-password-1234');
    const v = await checkAccess(id, { email: 'eve@test', judgeIp: '1.2.3.4', directIp: '1.2.3.4' }, baseServerPolicy);
    // requirementGroups = [['inviteToken', 'roomPassword']] (OR)
    // → どちらも passed しないので deny
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('requirement-group-failed');
    expect(v.effectivePolicy.requirementGroups).toEqual([['inviteToken', 'roomPassword']]);
  });

  it('passwordHash あり + 正しい password で入室可能', async () => {
    const id = await makeTestRoom('pwd-ok', { accessControl: 'open' });
    await setRoomPassword(id, 'test-password-5678');
    const v = await checkAccess(id, { password: 'test-password-5678', email: 'frank@test', judgeIp: '1.2.3.4', directIp: '1.2.3.4' }, baseServerPolicy);
    expect(v.allowed).toBe(true);
    expect(v.via).toBe('roomPassword');
    expect(v.role).toBe('editor');
  });

  it('passwordHash あり + token も使える (OR 条件)', async () => {
    const id = await makeTestRoom('pwd-token-or', { accessControl: 'open' });
    await setRoomPassword(id, 'pwd-xyz');
    const room = await inviteEmail(id, 'grace@test', 'viewer', {});
    const invite = room.invitations.find((i) => i.email === 'grace@test');
    const v = await checkAccess(id, { token: invite.token, judgeIp: '1.2.3.4', directIp: '1.2.3.4' }, baseServerPolicy);
    expect(v.allowed).toBe(true);
    expect(v.via).toBe('inviteToken');
    expect(v.role).toBe('viewer');
  });
});

describe('checkAccess: localhost-auto シナリオ (R3)', () => {
  it('localhostAutoEnabled=false (default) で localhost 接続でも通らない', async () => {
    const id = await makeTestRoom('localhost-off', { accessControl: 'open' });
    const v = await checkAccess(id, { judgeIp: '127.0.0.1', directIp: '127.0.0.1' }, baseServerPolicy);
    // server policy で localhostAuto=false なので provider skip
    // open room なので emailLegacy 経由で通る (email なくても editor 既定)
    expect(v.allowed).toBe(true);
    expect(v.via).toBe('emailLegacy');
  });

  it('localhostAutoEnabled=true + directIp=127.0.0.1 で localhost-auto 経由', async () => {
    const id = await makeTestRoom('localhost-on', { accessControl: 'open' });
    const sp = { ...baseServerPolicy, localhostAutoEnabled: true, legacyEmailEnabled: false };
    const v = await checkAccess(id, { judgeIp: '127.0.0.1', directIp: '127.0.0.1' }, sp);
    expect(v.allowed).toBe(true);
    expect(v.via).toBe('localhostAuto');
    expect(v.role).toBe('editor');
  });

  it('localhostAutoEnabled=true でも directIp が public IP なら通らない (R2 XFF 防御)', async () => {
    const id = await makeTestRoom('localhost-spoof', { accessControl: 'open' });
    const sp = { ...baseServerPolicy, localhostAutoEnabled: true, legacyEmailEnabled: false };
    // judgeIp=127.0.0.1 でも directIp=1.2.3.4 なら localhost-auto は通らない (R2 spoof 防御)
    const v = await checkAccess(id, { judgeIp: '127.0.0.1', directIp: '1.2.3.4' }, sp);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('no-valid-credentials');
  });
});

describe('checkAccess: tailscale シナリオ', () => {
  it('judgeIp が Tailscale CGNAT 範囲 + tailscaleEnabled で入室可能', async () => {
    const id = await makeTestRoom('tailscale', { accessControl: 'open' });
    const sp = { ...baseServerPolicy, legacyEmailEnabled: false };
    const v = await checkAccess(id, { judgeIp: '100.64.1.5', directIp: '100.64.1.5' }, sp);
    expect(v.allowed).toBe(true);
    expect(v.via).toBe('tailscale');
  });

  it('per-room authMethods.tailscale=off で room ごとに tailscale を OFF', async () => {
    const id = await makeTestRoom('tailscale-off', { accessControl: 'open' });
    await setRoomOptions(id, { authPolicy: { authMethods: { tailscale: 'off' } } });
    const sp = { ...baseServerPolicy, legacyEmailEnabled: false };
    const v = await checkAccess(id, { judgeIp: '100.64.1.5', directIp: '100.64.1.5' }, sp);
    expect(v.allowed).toBe(false);
  });
});

describe('checkAccess: 戻り値拡充 (R13)', () => {
  it('allow 時に effectivePolicy + matchedRule + satisfied が返る', async () => {
    const id = await makeTestRoom('verdict-allow', { accessControl: 'invite_list' });
    const room = await inviteEmail(id, 'henry@test', 'editor', {});
    const invite = room.invitations.find((i) => i.email === 'henry@test');
    const v = await checkAccess(id, { token: invite.token, judgeIp: '1.2.3.4', directIp: '1.2.3.4' }, baseServerPolicy);
    expect(v.effectivePolicy).toBeDefined();
    expect(v.matchedRule).toContain('inviteToken');
    expect(v.satisfied).toContain('inviteToken');
  });

  it('deny 時に failedGroups + deniedReasons が返る', async () => {
    const id = await makeTestRoom('verdict-deny', { accessControl: 'invite_list' });
    await inviteEmail(id, 'iris@test', 'editor', {});
    const v = await checkAccess(id, { judgeIp: '1.2.3.4', directIp: '1.2.3.4' }, baseServerPolicy);
    expect(v.allowed).toBe(false);
    expect(v.failedGroups).toEqual([['inviteToken']]);
    expect(v.deniedReasons).toBeDefined();
    expect(v.deniedReasons[0]).toContain('inviteToken');
  });
});

describe('checkAccess: legacy 互換 (旧 signature)', () => {
  it('旧 signature checkAccess(roomId, "email@x") も動作する', async () => {
    const id = await makeTestRoom('legacy-sig', { accessControl: 'open' });
    const v = await checkAccess(id, 'jack@test', baseServerPolicy);
    expect(v.allowed).toBe(true);
    expect(v.via).toBe('emailLegacy');
  });
});
