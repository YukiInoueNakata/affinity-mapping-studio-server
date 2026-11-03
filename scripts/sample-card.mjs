// 数件のカードを完全な形でダンプする．
import * as Y from 'yjs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
const roomId = process.argv[2] ?? 'myroom';
const raw = await readFile(join(DATA_DIR, `${roomId}.bin`));

const doc = new Y.Doc({ gc: true });
let off = 0;
Y.transact(doc, () => {
  while (off + 4 <= raw.length) {
    const len = raw.readUInt32BE(off); off += 4;
    if (off + len > raw.length) break;
    try { Y.applyUpdate(doc, raw.subarray(off, off + len)); } catch {}
    off += len;
  }
});

const cards = (doc.getMap('tables').get('cards') ?? {}).toJSON?.() ?? [];
console.log(`total cards: ${cards.length}`);
console.log('first 3 cards full:');
for (const c of cards.slice(0, 3)) console.log(JSON.stringify(c, null, 2));
console.log('\nplacement breakdown:');
const byPlacement = {};
for (const c of cards) {
  const p = c.placement ?? '(undefined)';
  byPlacement[p] = (byPlacement[p] ?? 0) + 1;
}
console.log(byPlacement);

const positions = (doc.getMap('tables').get('card_positions') ?? {}).toJSON?.() ?? [];
console.log(`\ncard_positions: ${positions.length}`);
console.log('first 3 positions:');
for (const p of positions.slice(0, 3)) console.log(JSON.stringify(p));
