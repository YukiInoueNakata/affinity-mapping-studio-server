// Yjs WebSocket クライアントをエミュレートして指定ルームからデータを取得し，
// 受信した tables のレコード数を表示する．これで「サーバーが本当にデータを
// 送っているか」「kj-studio のクライアント側が受信できているか」を切り分けられる．
//
// 使い方: node scripts/probe-client.mjs <roomId>

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import WebSocket from 'ws';

const roomId = process.argv[2] ?? 'myroom';
const baseUrl = process.argv[3] ?? `ws://localhost:1234`;
const url = `${baseUrl}/${roomId}?email=probe@test&nick=probe`;
console.log(`[probe] connecting to ${url}`);

const doc = new Y.Doc();
const awareness = new awarenessProtocol.Awareness(doc);

const messageSync = 0;
const messageAwareness = 1;

const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';

let stopTimer = null;

ws.on('open', () => {
  console.log(`[ws] open: ${url}`);
  // Send sync-step-1: tell server our state vector (empty so server sends all)
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeSyncStep1(encoder, doc);
  ws.send(encoding.toUint8Array(encoder));
  console.log('[ws] sent sync-step-1');
  // Auto-quit after 5 seconds of no activity
  stopTimer = setTimeout(() => {
    console.log('\n[ws] 5s timeout, closing');
    ws.close();
  }, 5000);
});

ws.on('message', (buf) => {
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = setTimeout(() => ws.close(), 1000); }
  const data = new Uint8Array(buf);
  const decoder = decoding.createDecoder(data);
  const messageType = decoding.readVarUint(decoder);
  console.log(`[ws] received message type=${messageType} (${data.length} bytes)`);
  if (messageType === messageSync) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, doc, 'probe');
    console.log(`  syncSubType=${syncMessageType}`);
    if (encoding.length(encoder) > 1) {
      ws.send(encoding.toUint8Array(encoder));
      console.log('  sent reply');
    }
  } else if (messageType === messageAwareness) {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(awareness, update, 'probe');
    console.log('  awareness update');
  }
});

ws.on('close', () => {
  console.log('\n[ws] closed');
  console.log('\n=== final Y.Doc state ===');
  const tables = doc.getMap('tables');
  console.log(`tables.size = ${tables.size}`);
  for (const [name, arr] of tables.entries()) {
    if (arr && typeof arr.toJSON === 'function') {
      const a = arr.toJSON();
      if (Array.isArray(a) && a.length > 0) {
        console.log(`  ${name}: ${a.length} records`);
      }
    }
  }
  const meta = doc.getMap('metadata');
  console.log(`metadata.size = ${meta.size}`);
  for (const [k, v] of meta.entries()) {
    console.log(`  ${k}: ${String(v).slice(0, 60)}`);
  }
  process.exit(0);
});

ws.on('error', (e) => {
  console.error('[ws] error:', e.message);
  process.exit(1);
});
