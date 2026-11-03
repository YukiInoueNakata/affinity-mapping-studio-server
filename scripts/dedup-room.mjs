// 重複エントリを除去して length-prefixed update を 1 件に圧縮する．
// YArray の各テーブルから「キー（id/cardId/groupId 等）が同じ複数エントリ」を
// 1 つに集約する．保持戦略: updatedAt が新しい方（無ければ最後に来たもの）．
//
// 使い方:
//   node scripts/dedup-room.mjs <roomId>          # dry-run
//   node scripts/dedup-room.mjs <roomId> --apply  # 実ファイルを置換

import * as Y from 'yjs';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rotateEpoch } from '../src/persistence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');

const [, , roomId, ...flags] = process.argv;
if (!roomId) {
  console.error('usage: node scripts/dedup-room.mjs <roomId> [--apply]');
  process.exit(1);
}
const apply = flags.includes('--apply');
const binPath = join(DATA_DIR, `${roomId}.bin`);

const raw = await readFile(binPath);
console.log(`[info] file ${binPath} = ${raw.length} bytes`);

// 元 doc を読み込む
const srcDoc = new Y.Doc({ gc: true });
let off = 0;
Y.transact(srcDoc, () => {
  while (off + 4 <= raw.length) {
    const len = raw.readUInt32BE(off);
    off += 4;
    if (off + len > raw.length) break;
    try { Y.applyUpdate(srcDoc, raw.subarray(off, off + len)); } catch {}
    off += len;
  }
}, 'dedup');

const srcTables = srcDoc.getMap('tables');
const srcMeta = srcDoc.getMap('metadata');

// テーブルごとの主キー定義．対象外（純粋追記型．例: text_revisions）は dedup しない．
const PRIMARY_KEY = {
  participants: 'id',
  source_segments: 'id',
  cards: 'id',
  groups: 'id',
  labels: 'groupId',          // 1 group : 1 label が正しい
  group_memberships: 'id',
  card_source_links: 'id',
  card_positions: 'cardId',   // 1 card : 1 position が正しい
  group_positions: 'groupId', // 1 group : 1 position が正しい
  analysis_methods: 'id',
  analysis_sessions: 'id',
  analytic_object_links: 'id',
  m_gta_settings: 'id',
  m_gta_concepts: 'id',
  m_gta_variations: 'id',
  m_gta_categories: 'id',
  theoretical_memos: 'id',
  diagram_relations: 'id',
  gta_codes: 'id',
  gta_code_applications: 'id',
  gta_categories: 'id',
  // text_revisions は append-only ログなので dedup しない
};

// kj-studio の src/sync/yjsBridge.ts と同じ schema．Y.Text として保存するべき
// 文字列フィールド一覧．これらは Y.Map.set(k, new Y.Text()) で格納する．
const Y_TEXT_FIELDS = {
  source_segments: ['text'],
  cards: ['body'],
  labels: ['text', 'sharedMemo', 'basisMemo', 'holdMemo'],
  theoretical_memos: ['body'],
  m_gta_concepts: ['definition'],
  m_gta_variations: ['interpretation'],
  m_gta_categories: ['definition'],
  gta_codes: ['definition'],
  gta_categories: ['definition'],
};

function isPlainObject(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !(v instanceof Y.AbstractType) &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/** 1 レコード (plain object) を Y.Map に変換．kj-studio の recordToYMap と同じ
 *  ロジック．これを通さずに plain object を YArray に push すると，クライアント
 *  側で `m.forEach is not a function` のエラーで sync が壊れる． */
function recordToYMap(tableName, record) {
  const m = new Y.Map();
  const ytextFields = Y_TEXT_FIELDS[tableName] ?? [];
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    if (ytextFields.includes(k) && typeof v === 'string') {
      const t = new Y.Text();
      if (v.length > 0) t.insert(0, v);
      m.set(k, t);
    } else if (v === null) {
      m.set(k, null);
    } else if (Array.isArray(v)) {
      m.set(k, v.slice());
    } else if (isPlainObject(v)) {
      m.set(k, { ...v });
    } else {
      m.set(k, v);
    }
  }
  return m;
}

function pickLatest(a, b) {
  // updatedAt 優先．無ければ createdAt．それも無ければ後で来た方．
  const aT = a.updatedAt ?? a.createdAt;
  const bT = b.updatedAt ?? b.createdAt;
  if (aT && bT) return bT >= aT ? b : a;
  return b; // fallback: 後勝ち
}

// 新しい doc を構築（dedup 結果を入れる）
const dstDoc = new Y.Doc({ gc: true });
const dstTables = dstDoc.getMap('tables');
const dstMeta = dstDoc.getMap('metadata');

// metadata は単純コピー
Y.transact(dstDoc, () => {
  for (const [k, v] of srcMeta.entries()) {
    dstMeta.set(k, v);
  }
});

const summary = [];
Y.transact(dstDoc, () => {
  for (const [tableName, srcArr] of srcTables.entries()) {
    if (!srcArr || typeof srcArr.toJSON !== 'function') continue;
    const entries = srcArr.toJSON();
    if (!Array.isArray(entries)) continue;
    const key = PRIMARY_KEY[tableName];
    let dedupedEntries;
    let dupRemoved = 0;
    if (!key) {
      // dedup 対象外（text_revisions 等）はそのまま
      dedupedEntries = entries;
    } else {
      const byKey = new Map();
      for (const e of entries) {
        if (e == null || typeof e !== 'object') continue;
        const k = e[key];
        if (k == null) continue;
        const existing = byKey.get(k);
        if (existing) {
          dupRemoved++;
          byKey.set(k, pickLatest(existing, e));
        } else {
          byKey.set(k, e);
        }
      }
      dedupedEntries = Array.from(byKey.values());
    }
    summary.push({
      table: tableName,
      before: entries.length,
      after: dedupedEntries.length,
      removed: dupRemoved,
    });
    const dstArr = dstTables.get(tableName) ?? new Y.Array();
    if (!dstTables.has(tableName)) dstTables.set(tableName, dstArr);
    // バグ修正: plain object のまま push せず，必ず Y.Map に変換してから入れる．
    // クライアント (yjsBridge.toProjectData) は要素を YMap として扱い .forEach する．
    if (dedupedEntries.length > 0) {
      dstArr.push(dedupedEntries.map((r) => recordToYMap(tableName, r)));
    }
  }
});

console.log('\n=== dedup summary ===');
for (const s of summary) {
  if (s.removed > 0 || s.before !== s.after) {
    console.log(`  ${s.table.padEnd(28)} ${String(s.before).padStart(4)} → ${String(s.after).padStart(4)}  (removed ${s.removed} dups)`);
  } else {
    console.log(`  ${s.table.padEnd(28)} ${String(s.before).padStart(4)} (clean)`);
  }
}

const dstUpdate = Y.encodeStateAsUpdate(dstDoc);
console.log(`\n[info] new compacted update: ${dstUpdate.byteLength} bytes (${(dstUpdate.byteLength / 1024 / 1024).toFixed(2)} MB)`);

if (!apply) {
  console.log('[info] dry-run. Re-run with --apply to overwrite the file.');
  process.exit(0);
}

const backup = `${binPath}.pre-dedup-${Date.now()}.bak`;
console.log(`[info] backup → ${backup}`);
await copyFile(binPath, backup);

const lenBuf = Buffer.alloc(4);
lenBuf.writeUInt32BE(dstUpdate.byteLength, 0);
const payload = Buffer.concat([lenBuf, Buffer.from(dstUpdate)]);
console.log(`[info] writing length-prefixed (${payload.length} bytes) to ${binPath}`);
await writeFile(binPath, payload);

// v0.2.16: dedup は新しい Y.Doc lineage を作る (新 clientID 群)．古い lineage を
// IndexedDB に持つクライアントが再接続時に再アップロードして肥大化を再発させるのを
// 防ぐため，epoch を rotate する．次回接続時にクライアントは不一致を検出して
// ローカルキャッシュを破棄し download-only で同期する．
const newEpoch = await rotateEpoch(roomId);
console.log(`[info] rotated docEpoch → ${newEpoch} (clients will discard stale IndexedDB cache on next connect)`);
console.log('[done]');
