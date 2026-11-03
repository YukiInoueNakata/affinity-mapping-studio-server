// 段階1: サーバー側スナップショットの round-trip と retention 不変条件．
//   - takeSnapshot → listSnapshots → restoreSnapshot で行数が一致 (完全復元)
//   - retention を超えると古いスナップショット (ファイル + manifest エントリ) が消える

import { describe, it, expect, afterAll } from 'vitest';
import * as Y from 'yjs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeSnapshot, listSnapshots, restoreSnapshot } from '../snapshots.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', '..', 'data');
const TEST_ROOM = 'test-snapshot-room';
const snapDir = join(DATA_DIR, 'snapshots', TEST_ROOM);

afterAll(async () => {
  try { await rm(snapDir, { recursive: true, force: true }); } catch {}
});

/** cards/groups をいくつか持つ doc を作る． */
function makeDoc(nCards, nGroups) {
  const doc = new Y.Doc();
  const tables = doc.getMap('tables');
  const cards = new Y.Array();
  tables.set('cards', cards);
  for (let i = 0; i < nCards; i++) {
    const m = new Y.Map();
    m.set('id', `c${i}`);
    m.set('body', `card ${i}`);
    cards.push([m]);
  }
  const groups = new Y.Array();
  tables.set('groups', groups);
  for (let i = 0; i < nGroups; i++) {
    const m = new Y.Map();
    m.set('id', `g${i}`);
    groups.push([m]);
  }
  return doc;
}

describe('snapshots round-trip', () => {
  it('takeSnapshot → restoreSnapshot で cards/groups 行数が一致する', async () => {
    const doc = makeDoc(7, 3);
    const entry = await takeSnapshot(TEST_ROOM, doc, { trigger: 'manual', label: 'rt' });
    expect(entry).not.toBeNull();
    expect(entry.counts).toEqual({ cards: 7, groups: 3, memberships: 0 });

    const list = await listSnapshots(TEST_ROOM);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].id).toBe(entry.id);
    expect(list[0].trigger).toBe('manual');
    expect(list[0].label).toBe('rt');

    const update = await restoreSnapshot(TEST_ROOM, entry.id);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, update, 'test');
    const t = restored.getMap('tables');
    expect(t.get('cards').length).toBe(7);
    expect(t.get('groups').length).toBe(3);
  });

  it('retention を超えると古いスナップショットが消える', async () => {
    const doc = makeDoc(1, 1);
    // retention=3 で 6 回作成 → 直近 3 件だけ残る
    let last;
    for (let i = 0; i < 6; i++) {
      last = await takeSnapshot(TEST_ROOM + '-ret', doc, { trigger: 'count', retention: 3 });
    }
    const list = await listSnapshots(TEST_ROOM + '-ret');
    expect(list.length).toBe(3);
    // 最新は最後に作ったもの
    expect(list[0].id).toBe(last.id);
    // 残った id のスナップショットは復元できる (ファイルが実在する)
    const update = await restoreSnapshot(TEST_ROOM + '-ret', list[0].id);
    expect(update.length).toBeGreaterThan(0);
    await rm(join(DATA_DIR, 'snapshots', TEST_ROOM + '-ret'), { recursive: true, force: true });
  });
});
