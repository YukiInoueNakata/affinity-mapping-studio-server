// 詳細診断: 各レコードのサイズ・参照整合性・異常値を検出．
// 黒画面/フリーズの原因候補（巨大な本文，循環参照，schema 不一致 など）を炙り出す．
// 使い方: node scripts/diag-room.mjs <roomId>

import * as Y from 'yjs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');

const [, , roomId] = process.argv;
if (!roomId) {
  console.error('usage: node scripts/diag-room.mjs <roomId>');
  process.exit(1);
}
const binPath = join(DATA_DIR, `${roomId}.bin`);
const raw = await readFile(binPath);
console.log(`[info] file ${binPath} = ${raw.length} bytes`);

const doc = new Y.Doc({ gc: true });
let off = 0;
let applied = 0;
Y.transact(doc, () => {
  while (off + 4 <= raw.length) {
    const len = raw.readUInt32BE(off);
    off += 4;
    if (off + len > raw.length) break;
    try { Y.applyUpdate(doc, raw.subarray(off, off + len)); applied++; } catch {}
    off += len;
  }
}, 'diag');
console.log(`[info] applied ${applied} entries\n`);

const tables = doc.getMap('tables');
const meta = doc.getMap('metadata');

// 各テーブルの統計
const stats = {};
for (const [name, arr] of tables.entries()) {
  if (!arr || typeof arr.toJSON !== 'function') continue;
  let json;
  try { json = arr.toJSON(); } catch (e) { stats[name] = { error: e.message }; continue; }
  if (!Array.isArray(json)) { stats[name] = { error: 'not array' }; continue; }
  const sizes = json.map((r) => {
    try { return JSON.stringify(r).length; } catch { return 0; }
  });
  const totalBytes = sizes.reduce((s, n) => s + n, 0);
  sizes.sort((a, b) => b - a);
  stats[name] = {
    count: json.length,
    totalBytes,
    avgBytes: json.length > 0 ? Math.round(totalBytes / json.length) : 0,
    maxBytes: sizes[0] ?? 0,
    top5: sizes.slice(0, 5),
  };
}

console.log('=== per-table size statistics ===');
const sorted = Object.entries(stats).sort(([, a], [, b]) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0));
for (const [name, s] of sorted) {
  if (s.error) { console.log(`  ${name}: ERROR ${s.error}`); continue; }
  if (s.count === 0) continue;
  console.log(
    `  ${name.padEnd(28)} n=${String(s.count).padStart(4)}  total=${String(s.totalBytes).padStart(8)} B  avg=${String(s.avgBytes).padStart(6)} B  max=${s.maxBytes} B`
  );
}

// 最大レコードのプレビュー (上位 3 つを各テーブルから)
console.log('\n=== largest records per table ===');
for (const [name, arr] of tables.entries()) {
  if (!arr || typeof arr.toJSON !== 'function') continue;
  let json;
  try { json = arr.toJSON(); } catch { continue; }
  if (!Array.isArray(json) || json.length === 0) continue;
  const sized = json.map((r, i) => ({ i, r, sz: JSON.stringify(r ?? '').length }));
  sized.sort((a, b) => b.sz - a.sz);
  const top = sized.slice(0, 3);
  if (top.length > 0 && top[0].sz > 1000) {
    console.log(`\n  ${name}:`);
    for (const t of top) {
      const id = t.r?.id ?? t.r?.code ?? `idx${t.i}`;
      console.log(`    [${id}] ${t.sz} B`);
      // body 等の長文フィールドだけ短縮表示
      const r = t.r;
      if (r && typeof r === 'object') {
        for (const k of Object.keys(r)) {
          const v = r[k];
          if (typeof v === 'string' && v.length > 80) {
            console.log(`      ${k}: "${v.slice(0, 80)}..." (${v.length} chars)`);
          }
        }
      }
    }
  }
}

// 参照整合性チェック
console.log('\n=== reference integrity ===');
const get = (k) => {
  const arr = tables.get(k);
  return (arr && typeof arr.toJSON === 'function') ? arr.toJSON() : [];
};
const cards = get('cards');
const segs = get('source_segments');
const parts = get('participants');
const groups = get('groups');
const links = get('card_source_links');
const memberships = get('group_memberships');
const labels = get('labels');
const positions = get('card_positions');
const groupPositions = get('group_positions');

const segIds = new Set(segs.map((s) => s.id));
const cardIds = new Set(cards.map((c) => c.id));
const partIds = new Set(parts.map((p) => p.id));
const groupIds = new Set(groups.map((g) => g.id));

let danglingLinks = 0;
for (const l of links) {
  if (!cardIds.has(l.cardId) || !segIds.has(l.segmentId)) danglingLinks++;
}
console.log(`  card_source_links dangling: ${danglingLinks} / ${links.length}`);

let danglingMemberships = 0;
for (const m of memberships) {
  if (!cardIds.has(m.cardId) || !groupIds.has(m.groupId)) danglingMemberships++;
}
console.log(`  group_memberships dangling: ${danglingMemberships} / ${memberships.length}`);

let orphanCards = 0;
for (const c of cards) {
  if (!partIds.has(c.participantId)) orphanCards++;
}
console.log(`  cards with unknown participantId: ${orphanCards} / ${cards.length}`);

let orphanSegs = 0;
for (const s of segs) {
  if (!partIds.has(s.participantId)) orphanSegs++;
}
console.log(`  segments with unknown participantId: ${orphanSegs} / ${segs.length}`);

let dupCards = 0;
const cardCodes = new Map();
for (const c of cards) {
  cardCodes.set(c.code, (cardCodes.get(c.code) ?? 0) + 1);
}
for (const [code, n] of cardCodes) if (n > 1) dupCards += n;
console.log(`  duplicate card codes: ${dupCards}`);

let nullishCards = 0;
for (const c of cards) {
  if (!c.id || !c.code || c.body === undefined) nullishCards++;
}
console.log(`  cards with null/undefined critical fields: ${nullishCards}`);

let dupGroupPositions = 0;
const gpSeen = new Set();
for (const gp of groupPositions) {
  if (gpSeen.has(gp.groupId)) dupGroupPositions++;
  gpSeen.add(gp.groupId);
}
console.log(`  duplicate group_positions: ${dupGroupPositions}`);

let dupLabels = 0;
const labelSeen = new Set();
for (const l of labels) {
  if (labelSeen.has(l.groupId)) dupLabels++;
  labelSeen.add(l.groupId);
}
console.log(`  duplicate labels per group: ${dupLabels}`);

let dupPositions = 0;
const posSeen = new Set();
for (const p of positions) {
  if (posSeen.has(p.cardId)) dupPositions++;
  posSeen.add(p.cardId);
}
console.log(`  duplicate card_positions per card: ${dupPositions}`);
