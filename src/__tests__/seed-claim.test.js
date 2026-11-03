// 対策3: seed-claim 判定ロジックの単体テスト (4 分岐 + 自分再要求).
import { describe, it, expect } from 'vitest';
import { evaluateSeedClaim } from '../seed-claim.js';

const TTL = 30_000;
const NOW = 1_000_000;

describe('evaluateSeedClaim', () => {
  it('viewer は seed 不可', () => {
    const v = evaluateSeedClaim({ role: 'viewer', roomHasData: false, existingClaim: null, clientId: 1, ttlMs: TTL, now: NOW });
    expect(v).toEqual({ granted: false, reason: 'viewer-cannot-seed', keepClaim: false });
  });

  it('既にデータのあるルームは seed 不可 (上書き防止)', () => {
    const v = evaluateSeedClaim({ role: 'editor', roomHasData: true, existingClaim: null, clientId: 1, ttlMs: TTL, now: NOW });
    expect(v).toEqual({ granted: false, reason: 'room-has-data', keepClaim: false });
  });

  it('別クライアントが有効な claim を保持中は already-claimed', () => {
    const v = evaluateSeedClaim({
      role: 'editor', roomHasData: false,
      existingClaim: { clientId: 2, ts: NOW - 1000 }, clientId: 1, ttlMs: TTL, now: NOW,
    });
    expect(v).toEqual({ granted: false, reason: 'already-claimed', keepClaim: false });
  });

  it('空ルーム・未 claim なら付与 (keepClaim=true)', () => {
    const v = evaluateSeedClaim({ role: 'editor', roomHasData: false, existingClaim: null, clientId: 1, ttlMs: TTL, now: NOW });
    expect(v).toEqual({ granted: true, reason: 'granted', keepClaim: true });
  });

  it('失効した他クライアントの claim は上書きして付与', () => {
    const v = evaluateSeedClaim({
      role: 'editor', roomHasData: false,
      existingClaim: { clientId: 2, ts: NOW - TTL - 1 }, clientId: 1, ttlMs: TTL, now: NOW,
    });
    expect(v.granted).toBe(true);
    expect(v.keepClaim).toBe(true);
  });

  it('自分自身の再要求は許可 (べき等)', () => {
    const v = evaluateSeedClaim({
      role: 'editor', roomHasData: false,
      existingClaim: { clientId: 1, ts: NOW - 1000 }, clientId: 1, ttlMs: TTL, now: NOW,
    });
    expect(v.granted).toBe(true);
  });

  it('admin も seed 可', () => {
    const v = evaluateSeedClaim({ role: 'admin', roomHasData: false, existingClaim: null, clientId: 9, ttlMs: TTL, now: NOW });
    expect(v.granted).toBe(true);
  });

  // Codex#9: clientId 検証
  it('clientId が undefined なら invalid-client で拒否', () => {
    const v = evaluateSeedClaim({ role: 'editor', roomHasData: false, existingClaim: null, clientId: undefined, ttlMs: TTL, now: NOW });
    expect(v).toEqual({ granted: false, reason: 'invalid-client', keepClaim: false });
  });

  it('clientId が空文字なら invalid-client で拒否', () => {
    const v = evaluateSeedClaim({ role: 'editor', roomHasData: false, existingClaim: null, clientId: '', ttlMs: TTL, now: NOW });
    expect(v.granted).toBe(false);
    expect(v.reason).toBe('invalid-client');
  });

  it('undefined 同士でも同一 client 扱いにせず拒否 (多重取得防止)', () => {
    const v = evaluateSeedClaim({
      role: 'editor', roomHasData: false,
      existingClaim: { clientId: undefined, ts: NOW - 1000 }, clientId: undefined, ttlMs: TTL, now: NOW,
    });
    expect(v.granted).toBe(false);
    expect(v.reason).toBe('invalid-client');
  });

  it('非空 string の clientId は有効', () => {
    const v = evaluateSeedClaim({ role: 'editor', roomHasData: false, existingClaim: null, clientId: 'abc', ttlMs: TTL, now: NOW });
    expect(v.granted).toBe(true);
  });
});
