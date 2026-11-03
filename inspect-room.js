// Dump the current Y.Doc state for a given room.
// Usage: node inspect-room.js <roomId>

import * as Y from 'yjs';
import { loadRoom } from './src/persistence.js';

const roomId = process.argv[2] ?? 'demo2';
const doc = new Y.Doc();
await loadRoom(roomId, doc);

console.log(`=== Y.Doc snapshot for room "${roomId}" ===`);
console.log(`State vector bytes: ${Y.encodeStateAsUpdate(doc).length}`);
console.log();

const tables = doc.getMap('tables');
console.log(`tables map size: ${tables.size}`);
tables.forEach((value, key) => {
  if (value instanceof Y.Array) {
    console.log(`  ${key}: Y.Array length=${value.length}`);
    value.toArray().slice(0, 3).forEach((m, i) => {
      if (m instanceof Y.Map) {
        const fields = {};
        m.forEach((v, k) => {
          if (v instanceof Y.Text) fields[k] = `Y.Text(${v.toString().slice(0, 40)}…)`;
          else if (typeof v === 'string') fields[k] = v.slice(0, 40);
          else fields[k] = v;
        });
        console.log(`    [${i}]`, fields);
      }
    });
    if (value.length > 3) {
      console.log(`    … and ${value.length - 3} more`);
    }
  } else {
    console.log(`  ${key}:`, value);
  }
});
console.log();
const metadata = doc.getMap('metadata');
console.log(`metadata size: ${metadata.size}`);
metadata.forEach((v, k) => console.log(`  ${k}:`, v));

process.exit(0);
