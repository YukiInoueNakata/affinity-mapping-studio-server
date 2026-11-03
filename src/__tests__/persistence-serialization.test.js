// Fix #1: persistUpdate(append) と compactRoom(encode→write→rename) の直列化．
// Fix #2: server pre-seed (ensureEmptyTables) による同時 upload の union 化．
//
// #1 の退行: 直列化が無いと「encode と rename の隙間」に来た append が rename で
//   旧ファイルごと捨てられ，再起動後に消失する (in-memory にはあるが disk に無い)．
// #2 の退行: 空ルームへ 2 client が各々 tables.set(new Y.Array()) すると Y.Map.set の
//   last-writer-wins で一方の全行が clobber される．server が root array を 1 度
//   pre-seed すれば client は push に集約され union になる．

import { describe, it, expect, afterAll } from 'vitest';
import * as Y from 'yjs';
import { unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistUpdate, compactRoom, loadRoom } from '../persistence.js';
import { ensureEmptyTables, appendRecord, yDocToProjectData } from '../yjs-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', '..', 'data');
const ROOM = 'test-serialization-room';
const binPath = join(DATA_DIR, `${ROOM}.bin`);

afterAll(async () => {
  try { await unlink(binPath); } catch {}
});

function captureLastUpdate(doc, mutate) {
  const captured = [];
  const handler = (u) => captured.push(u);
  doc.on('update', handler);
  mutate();
  doc.off('update', handler);
  return captured[captured.length - 1];
}

describe('persistUpdate ↔ compactRoom 直列化 (Fix #1)', () => {
  it('compact と append を並行発行しても全データが永続化される', async () => {
    const doc = new Y.Doc();
    const tables = doc.getMap('tables');
    const cards = new Y.Array();
    tables.set('cards', cards);
    const c1 = new Y.Map();
    c1.set('id', 'c1');
    cards.push([c1]);

    // 初期状態を append．
    await persistUpdate(ROOM, Y.encodeStateAsUpdate(doc));

    // compact を await せずに発行 → その直後に doc を変更して新 append を発行．
    // 旧実装では compact の encode が「発行時点 (c2 適用前)」のスナップショットを
    // 同期的に取り，rename で c2 を含む旧 .bin を捨てるため c2 が消えた．
    // 新実装では encode が IO chain の op 内 (= c2 適用後) で走るため消えない．
    const pCompact = compactRoom(ROOM, doc);
    const appendUpdate = captureLastUpdate(doc, () => {
      const c2 = new Y.Map();
      c2.set('id', 'c2');
      cards.push([c2]);
    });
    const pAppend = persistUpdate(ROOM, appendUpdate);
    await Promise.all([pCompact, pAppend]);

    const reloaded = new Y.Doc();
    await loadRoom(ROOM, reloaded);
    const ids = reloaded
      .getMap('tables')
      .get('cards')
      .toArray()
      .map((m) => m.get('id'))
      .sort();
    expect(ids).toEqual(['c1', 'c2']);
  });

  it('複数 append → compact → append の順で round-trip する', async () => {
    try { await unlink(binPath); } catch {}
    const doc = new Y.Doc();
    const tables = doc.getMap('tables');
    const cards = new Y.Array();
    tables.set('cards', cards);

    for (const id of ['a', 'b', 'c']) {
      const u = captureLastUpdate(doc, () => {
        const m = new Y.Map();
        m.set('id', id);
        cards.push([m]);
      });
      await persistUpdate(ROOM, u);
    }
    await compactRoom(ROOM, doc);
    const u = captureLastUpdate(doc, () => {
      const m = new Y.Map();
      m.set('id', 'd');
      cards.push([m]);
    });
    await persistUpdate(ROOM, u);

    const reloaded = new Y.Doc();
    await loadRoom(ROOM, reloaded);
    const ids = reloaded
      .getMap('tables')
      .get('cards')
      .toArray()
      .map((m) => m.get('id'))
      .sort();
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('server pre-seed による同時 upload union 化 (Fix #2)', () => {
  it('ensureEmptyTables 後の同時 upload は union になり clobber しない', () => {
    const server = new Y.Doc();
    const created = ensureEmptyTables(server);
    expect(created).toBeGreaterThan(0);
    const base = Y.encodeStateAsUpdate(server);

    // 2 client が server 状態 (空 array 済) から開始．
    const a = new Y.Doc();
    Y.applyUpdate(a, base);
    const b = new Y.Doc();
    Y.applyUpdate(b, base);

    // 各 client は既存 array へ push (tables.set しない)．
    appendRecord(a, 'cards', { id: 'a1', body: 'from A' });
    appendRecord(b, 'cards', { id: 'b1', body: 'from B' });

    // 双方を server にマージ．
    Y.applyUpdate(server, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(server, Y.encodeStateAsUpdate(b));

    const ids = yDocToProjectData(server)
      .cards.map((c) => c.id)
      .sort();
    expect(ids).toEqual(['a1', 'b1']);
  });

  it('ensureEmptyTables は冪等 (2 回目は新規作成 0)', () => {
    const doc = new Y.Doc();
    expect(ensureEmptyTables(doc)).toBeGreaterThan(0);
    expect(ensureEmptyTables(doc)).toBe(0);
  });

  it('退行ガード: pre-seed 無しで両 client が tables.set すると一方が clobber される', () => {
    const base = Y.encodeStateAsUpdate(new Y.Doc());
    const a = new Y.Doc();
    Y.applyUpdate(a, base);
    const b = new Y.Doc();
    Y.applyUpdate(b, base);

    const setCards = (doc, id) => {
      Y.transact(doc, () => {
        const arr = new Y.Array();
        doc.getMap('tables').set('cards', arr);
        const m = new Y.Map();
        m.set('id', id);
        arr.push([m]);
      });
    };
    setCards(a, 'a1');
    setCards(b, 'b1');

    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(server, Y.encodeStateAsUpdate(b));

    // last-writer-wins で cards array は一方のみ → union にならない (clobber の証拠)．
    const cards = server.getMap('tables').get('cards');
    expect(cards.length).toBe(1);
  });
});
