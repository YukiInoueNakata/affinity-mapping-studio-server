// 単発スクリプト: 指定ルームの Y.Doc を読み込んでサイズを縮小する．
//
// 2 つのモード:
//   (A) 既定 (--encode):  Y.encodeStateAsUpdate で append-log を 1 件に畳む．
//        append-log のサイズは減るが，削除済み構造の tombstone (delete-set) は
//        state vector に残るため，編集を続けると再び肥大する余地がある．
//        lineage (docEpoch) は保たれるので，クライアントは再同期不要．
//
//   (B) --rebuild:  現在の論理状態だけを読み出して **真っさらな Y.Doc に作り直す**．
//        新しい client id / clock で再構築するので tombstone を完全に捨てられる．
//        ただし lineage が変わるため docEpoch を rotate する → 全クライアントの
//        IndexedDB キャッシュが破棄され，次回接続時にサーバーから取り直す．
//        2026-06 に実運用ルームの .bin が 3MB→205MB に肥大したインシデントの根治用．
//
// 使い方:
//   node scripts/gc-room.mjs giro                    # dry-run (encode 比較のみ)
//   node scripts/gc-room.mjs giro --apply            # encode 畳み込みを書き込む
//   node scripts/gc-room.mjs giro --rebuild          # dry-run (rebuild サイズ比較)
//   node scripts/gc-room.mjs giro --rebuild --apply  # 真っさら作り直し + epoch rotate
//
// 前提: サーバープロセスが停止していること (ファイルロック / epoch 競合回避)．

import * as Y from 'yjs';
import { readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rotateEpoch, loadEpoch } from '../src/persistence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');

const [, , roomId, ...flags] = process.argv;
if (!roomId) {
  console.error('usage: node scripts/gc-room.mjs <roomId> [--rebuild] [--apply]');
  process.exit(1);
}
const apply = flags.includes('--apply');
const rebuild = flags.includes('--rebuild');

const binPath = join(DATA_DIR, `${roomId}.bin`);
if (!existsSync(binPath)) {
  console.error(`[error] not found: ${binPath}`);
  process.exit(1);
}

const beforeStat = await stat(binPath);
console.log(`[info] room=${roomId}`);
console.log(`[info] file=${binPath}`);
console.log(`[info] mode=${rebuild ? 'rebuild (tombstone 一掃 + epoch rotate)' : 'encode (lineage 保持)'}`);
console.log(`[info] size before: ${(beforeStat.size / 1024 / 1024).toFixed(2)} MB`);

const raw = await readFile(binPath);
console.log(`[info] raw file bytes: ${raw.length}`);
console.log('[info] parsing length-prefixed updates ([u32 len][bytes...]) ...');
const oldDoc = new Y.Doc({ gc: true });
let off = 0;
let count = 0;
Y.transact(
  oldDoc,
  () => {
    while (off + 4 <= raw.length) {
      const len = raw.readUInt32BE(off);
      off += 4;
      if (off + len > raw.length) {
        console.warn(`[warn] truncated entry at offset ${off - 4} (need ${len}, have ${raw.length - off})`);
        break;
      }
      const update = raw.subarray(off, off + len);
      try {
        Y.applyUpdate(oldDoc, update, 'gc-script');
        count++;
      } catch (e) {
        console.warn(`[warn] failed to apply update at offset ${off - 4}: ${e.message}`);
      }
      off += len;
    }
  },
  'gc-script'
);
console.log(`[info] applied ${count} updates`);

// 比較用: encode 畳み込み後のサイズ (tombstone は残る)
const encodeUpdate = Y.encodeStateAsUpdate(oldDoc);
console.log(`[info] encode (lineage 保持) bytes: ${(encodeUpdate.byteLength / 1024 / 1024).toFixed(2)} MB`);

// 現在の論理状態を真っさらな Doc に作り直す (tombstone を完全に捨てる)
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
  return v; // primitive / 平文 JSON
}

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
const rebuildUpdate = Y.encodeStateAsUpdate(newDoc);
console.log(`[info] rebuild (tombstone 一掃) bytes: ${(rebuildUpdate.byteLength / 1024 / 1024).toFixed(2)} MB`);

// 内容サニティチェック: 上位 shared type 数とテーブル件数を old/new で比較
function summarizeDoc(doc, label) {
  console.log(`[info] ${label} top-level shared types:`);
  for (const [name] of doc.share) {
    const obj = doc.share.get(name);
    let summary;
    try {
      if (obj instanceof Y.Map) {
        summary = `YMap (size=${obj.size})`;
        if (name === 'tables') {
          const parts = [];
          for (const [k, val] of obj.entries()) {
            if (val instanceof Y.Array) parts.push(`${k}=${val.length}`);
          }
          summary += ' { ' + parts.join(', ') + ' }';
        }
      } else if (obj instanceof Y.Array) summary = `YArray (length=${obj.length})`;
      else if (obj instanceof Y.Text) summary = `YText (length=${obj.length})`;
      else summary = obj.constructor.name;
    } catch {
      summary = '?';
    }
    console.log(`  - ${name}: ${summary}`);
  }
}
summarizeDoc(oldDoc, 'OLD');
summarizeDoc(newDoc, 'NEW');

const chosen = rebuild ? rebuildUpdate : encodeUpdate;
const reduction = (1 - chosen.byteLength / beforeStat.size) * 100;
const tombstoneSaving = (1 - rebuildUpdate.byteLength / Math.max(encodeUpdate.byteLength, 1)) * 100;
console.log(`[result] reduction vs file:   ${reduction.toFixed(1)}%`);
console.log(`[result] rebuild vs encode (= tombstone 分): ${tombstoneSaving.toFixed(1)}%`);

if (!apply) {
  console.log('[info] dry-run. --apply で実ファイルを置換します' + (rebuild ? '（+ epoch rotate）' : '') + '．');
  process.exit(0);
}

// --- apply ---
const backupPath = `${binPath}.pre-gc-${Date.now()}.bak`;
console.log(`[info] backing up to: ${backupPath}`);
await copyFile(binPath, backupPath);

// persistence.js の format に合わせて [u32 BE len][bytes...] 形式で書き出す．
const lenBuf = Buffer.alloc(4);
lenBuf.writeUInt32BE(chosen.byteLength, 0);
const payload = Buffer.concat([lenBuf, Buffer.from(chosen)]);
console.log(`[info] writing length-prefixed update (${payload.length} bytes total: 4 header + ${chosen.byteLength} payload) to ${binPath}`);
await writeFile(binPath, payload);

const afterStat = await stat(binPath);
console.log(`[done] size after: ${(afterStat.size / 1024 / 1024).toFixed(2)} MB`);

if (rebuild) {
  const prev = await loadEpoch(roomId);
  const fresh = await rotateEpoch(roomId);
  console.log(`[done] epoch rotated: ${prev ?? '(none)'} -> ${fresh}`);
  console.log('[note] 全クライアントは次回接続時に IndexedDB キャッシュを破棄してサーバーから取り直します．');
}
