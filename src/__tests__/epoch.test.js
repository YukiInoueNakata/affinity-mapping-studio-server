// v0.2.16 test: docEpoch 永続化 + rotate セマンティクス．
//
// epoch は room の Yjs lineage 世代 ID．dedup/clone で lineage を作り直したときだけ
// rotate される．compactRoom は lineage 不変なので epoch 据え置き．
// クライアントは保存済 epoch と不一致なら IndexedDB を破棄して download-only 同期する．

import { describe, it, expect, afterEach } from 'vitest';
import { loadEpoch, writeEpoch, ensureEpoch, rotateEpoch } from '../persistence.js';
import { unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');

// 実 room ファイルと衝突しないユニークな ID
const TEST_ROOM = `epochtest${process.pid}`;
const EPOCH_PATH = join(DATA_DIR, `${TEST_ROOM}.epoch`);

afterEach(async () => {
  try { await unlink(EPOCH_PATH); } catch {}
});

describe('docEpoch persistence', () => {
  it('loadEpoch returns null for a room with no epoch file', async () => {
    expect(await loadEpoch(TEST_ROOM)).toBeNull();
  });

  it('ensureEpoch generates + persists a fresh epoch on first call', async () => {
    const e = await ensureEpoch(TEST_ROOM);
    expect(typeof e).toBe('string');
    expect(e.length).toBeGreaterThan(0);
    // 永続化されている
    expect(await loadEpoch(TEST_ROOM)).toBe(e);
  });

  it('ensureEpoch is idempotent — returns the same epoch on subsequent calls', async () => {
    const first = await ensureEpoch(TEST_ROOM);
    const second = await ensureEpoch(TEST_ROOM);
    expect(second).toBe(first);
  });

  it('writeEpoch overwrites and loadEpoch round-trips (trimmed)', async () => {
    await writeEpoch(TEST_ROOM, 'fixed-epoch-123');
    expect(await loadEpoch(TEST_ROOM)).toBe('fixed-epoch-123');
  });

  it('rotateEpoch produces a DIFFERENT epoch (cache invalidation)', async () => {
    const before = await ensureEpoch(TEST_ROOM);
    const after = await rotateEpoch(TEST_ROOM);
    expect(after).not.toBe(before);
    // 永続化された新しい epoch が読める
    expect(await loadEpoch(TEST_ROOM)).toBe(after);
  });

  it('rejects invalid room ids (path-traversal defense)', async () => {
    await expect(loadEpoch('../evil')).rejects.toThrow();
    await expect(writeEpoch('../evil', 'x')).rejects.toThrow();
  });
});
