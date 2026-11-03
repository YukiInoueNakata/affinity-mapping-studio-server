// 指定ルームの Y.Doc に格納された tables / metadata の中身をダンプする．
// 使い方: node scripts/inspect-room.mjs <roomId>

import * as Y from 'yjs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');

const [, , roomId] = process.argv;
if (!roomId) {
  console.error('usage: node scripts/inspect-room.mjs <roomId>');
  process.exit(1);
}
const binPath = join(DATA_DIR, `${roomId}.bin`);
console.log(`[info] reading ${binPath}`);
const raw = await readFile(binPath);
console.log(`[info] bytes: ${raw.length}`);

const doc = new Y.Doc({ gc: true });
let off = 0;
let applied = 0;
let failed = 0;
Y.transact(
  doc,
  () => {
    while (off + 4 <= raw.length) {
      const len = raw.readUInt32BE(off);
      off += 4;
      if (off + len > raw.length) break;
      try {
        Y.applyUpdate(doc, raw.subarray(off, off + len), 'inspect');
        applied++;
      } catch (e) {
        failed++;
      }
      off += len;
    }
  },
  'inspect'
);
console.log(`[info] applied=${applied} failed=${failed}`);

const tables = doc.getMap('tables');
const meta = doc.getMap('metadata');

console.log('\n=== tables map ===');
console.log(`tables.size = ${tables.size}`);
for (const [name, value] of tables.entries()) {
  let summary;
  try {
    if (value && typeof value.toArray === 'function') {
      const arr = value.toArray();
      summary = `YArray length=${arr.length}`;
      if (arr.length > 0) {
        const sample = arr[0];
        if (sample && typeof sample === 'object') {
          const keys = Object.keys(sample).slice(0, 6).join(', ');
          summary += ` sample-keys=[${keys}]`;
        }
      }
    } else if (value && typeof value.size === 'number') {
      summary = `YMap size=${value.size}`;
    } else {
      summary = typeof value;
    }
  } catch (e) {
    summary = 'inspect-error: ' + e.message;
  }
  console.log(`  ${name}: ${summary}`);
}

console.log('\n=== metadata map ===');
console.log(`metadata.size = ${meta.size}`);
for (const [k, v] of meta.entries()) {
  const s = typeof v === 'object' ? JSON.stringify(v).slice(0, 100) : String(v).slice(0, 100);
  console.log(`  ${k}: ${s}`);
}

console.log('\n=== top-level types ===');
for (const [name, t] of doc.share) {
  console.log(`  ${name}: ${t.constructor.name}`);
}
