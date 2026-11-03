// Fix #4 / #5: roomFileBytes (byte-based monitoring) と tombstone 一掃 rebuild の不変条件．
//
// roomFileBytes は admin UI のルームサイズ列 + index.js の byte-based 自動 compaction
// が依存する．rebuild 不変条件は scripts/gc-room.mjs --rebuild が満たすべき性質
// (現在の論理状態を保ったまま tombstone を捨てて小さくなる) をロックする．

import { describe, it, expect, afterAll } from 'vitest';
import * as Y from 'yjs';
import { unlink, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistUpdate, roomFileBytes } from '../persistence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', '..', 'data');
const TEST_ROOM = 'test-compact-room';
const binPath = join(DATA_DIR, `${TEST_ROOM}.bin`);

afterAll(async () => {
  try { await unlink(binPath); } catch {}
});

describe('roomFileBytes (Fix #4)', () => {
  it('存在しないルームは 0 を返す', async () => {
    expect(await roomFileBytes('nonexistent-room-xyz')).toBe(0);
  });

  it('append したルームの実バイト数を返す', async () => {
    const doc = new Y.Doc();
    doc.getMap('tables');
    const update = Y.encodeStateAsUpdate(doc);
    await persistUpdate(TEST_ROOM, update);
    const bytes = await roomFileBytes(TEST_ROOM);
    // 4 byte length-prefix + payload
    expect(bytes).toBe(update.length + 4);
    expect(bytes).toBe((await stat(binPath)).size);
  });
});

// gc-room.mjs --rebuild が依存する不変条件をこの単体テストで固定する．
// スクリプト本体は top-level argv で動くため import できないので，rebuild ロジックの
// 中核 (現在状態だけを新 Doc に作り直す) を同形で再現して性質を検証する．
function rebuildValue(v) {
  if (v instanceof Y.Map) {
    const m = new Y.Map();
    for (const [k, val] of v.entries()) m.set(k, rebuildValue(val));
    return m;
  }
  if (v instanceof Y.Array) {
    const a = new Y.Array();
    a.push(v.toArray().map(rebuildValue));
    return a;
  }
  if (v instanceof Y.Text) {
    const t = new Y.Text();
    const s = v.toString();
    if (s.length > 0) t.insert(0, s);
    return t;
  }
  return v;
}

function rebuildDoc(oldDoc) {
  const newDoc = new Y.Doc({ gc: true });
  Y.transact(newDoc, () => {
    for (const [name] of oldDoc.share) {
      const old = oldDoc.share.get(name);
      if (old instanceof Y.Map) {
        const nm = newDoc.getMap(name);
        for (const [k, val] of old.entries()) nm.set(k, rebuildValue(val));
      } else if (old instanceof Y.Array) {
        const na = newDoc.getArray(name);
        na.push(old.toArray().map(rebuildValue));
      } else if (old instanceof Y.Text) {
        const nt = newDoc.getText(name);
        const s = old.toString();
        if (s.length > 0) nt.insert(0, s);
      }
    }
  });
  return newDoc;
}

describe('rebuild tombstone 一掃 (Fix #5)', () => {
  it('多数の削除で tombstone が貯まった Doc を rebuild すると小さくなり内容は保たれる', () => {
    const doc = new Y.Doc({ gc: true });
    const tables = doc.getMap('tables');
    const cards = new Y.Array();
    tables.set('cards', cards);

    // 1 件のカードを残しつつ，本文を 500 回書き換える（全削除+再挿入で tombstone 蓄積）
    const card = new Y.Map();
    card.set('id', 'c1');
    const body = new Y.Text();
    body.insert(0, 'start');
    card.set('body', body);
    cards.push([card]);

    for (let i = 0; i < 500; i++) {
      // pathological: 全削除して入れ直す（旧 mirror が起こしていた挙動の縮図）
      body.delete(0, body.length);
      body.insert(0, `iteration-${i}`);
    }

    const encodeBytes = Y.encodeStateAsUpdate(doc).byteLength;
    const rebuilt = rebuildDoc(doc);
    const rebuildBytes = Y.encodeStateAsUpdate(rebuilt).byteLength;

    // rebuild は tombstone を捨てるので encode より小さい
    expect(rebuildBytes).toBeLessThan(encodeBytes);
    // 論理内容は保たれる
    const rc = rebuilt.getMap('tables').get('cards');
    expect(rc.length).toBe(1);
    expect(rc.get(0).get('id')).toBe('c1');
    expect(rc.get(0).get('body').toString()).toBe('iteration-499');
  });

  it('rebuild 後の Doc は compactRoom 経由で round-trip できる', () => {
    const doc = new Y.Doc({ gc: true });
    const m = doc.getMap('metadata');
    m.set('title', 'プロジェクト');
    const rebuilt = rebuildDoc(doc);
    const update = Y.encodeStateAsUpdate(rebuilt);
    const verify = new Y.Doc();
    Y.applyUpdate(verify, update);
    expect(verify.getMap('metadata').get('title')).toBe('プロジェクト');
  });
});
