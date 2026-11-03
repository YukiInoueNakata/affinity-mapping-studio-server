// 指定ルームの指定カード ID (code) ペアを入れ替える．
// WebSocket 経由で通常クライアントとして接続し，Y.Map の code / serialNumber
// を atomic な transaction で swap → サーバー persistence + 接続中の他クライアント
// にも自動伝播 (CRDT update として配信)．
//
// 使い方:
//   node scripts/swap-card-codes.mjs <roomId> <code1> <code2> [<code3> <code4> ...]
//   ペアごとに 2 つずつ並べる（偶数個必須）．
//
// 例: P02-001 ↔ P02-040 と P02-002 ↔ P02-041
//   node scripts/swap-card-codes.mjs myroom P02-001 P02-040 P02-002 P02-041

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const roomId = args[0];
const codes = args.slice(1);
if (!roomId || codes.length === 0 || codes.length % 2 !== 0) {
  console.error('usage: node swap-card-codes.mjs <roomId> <codeA> <codeB> [<codeC> <codeD> ...]');
  console.error('  ペアごとに偶数個指定してください．');
  process.exit(1);
}
const pairs = [];
for (let i = 0; i < codes.length; i += 2) {
  pairs.push([codes[i], codes[i + 1]]);
}
console.log(`[info] room=${roomId}  swap pairs:`);
for (const [a, b] of pairs) console.log(`  ${a}  <-->  ${b}`);

const port = 1234;
const url = `ws://localhost:${port}/${roomId}?email=swap-script@local&nick=swap-script`;
console.log(`[ws] connecting: ${url}`);

const doc = new Y.Doc();
const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';

const MSG_SYNC = 0;
let syncedReceived = false;

ws.on('open', () => {
  console.log('[ws] open. sending sync-step-1');
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  ws.send(encoding.toUint8Array(enc));
});

ws.on('message', (buf) => {
  const data = new Uint8Array(buf);
  const dec = decoding.createDecoder(data);
  const type = decoding.readVarUint(dec);
  if (type !== MSG_SYNC) return;
  const reply = encoding.createEncoder();
  encoding.writeVarUint(reply, MSG_SYNC);
  const subType = syncProtocol.readSyncMessage(dec, reply, doc, 'swap-script');
  if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
  if (subType === syncProtocol.messageYjsSyncStep2 && !syncedReceived) {
    syncedReceived = true;
    setTimeout(performSwap, 100); // give a moment for any trailing updates
  }
});

ws.on('error', (e) => {
  console.error('[ws] error:', e.message);
  process.exit(1);
});

function performSwap() {
  const cardsArr = doc.getMap('tables').get('cards');
  if (!cardsArr || typeof cardsArr.toArray !== 'function') {
    console.error('[error] cards table not found');
    ws.close();
    process.exit(1);
  }
  // 各カード Y.Map を code で索引．元配列を保持して値を取得．
  const allCards = cardsArr.toArray();
  const byCode = new Map();
  for (const m of allCards) {
    if (m && typeof m.get === 'function') {
      const code = m.get('code');
      if (typeof code === 'string') byCode.set(code, m);
    }
  }
  // 事前検証: 全ペアの両側が見つかるか
  for (const [a, b] of pairs) {
    if (!byCode.has(a)) {
      console.error(`[error] card not found: ${a}`);
      ws.close();
      process.exit(1);
    }
    if (!byCode.has(b)) {
      console.error(`[error] card not found: ${b}`);
      ws.close();
      process.exit(1);
    }
  }
  // serialNumber は code から末尾連番をパース．code = `${prefix}-${nnn}`．
  function parseSerial(code) {
    const m = /-([0-9]+)$/.exec(code);
    return m ? parseInt(m[1], 10) : null;
  }

  console.log('[swap] applying...');
  const now = new Date().toISOString();
  // Y.transact でひとまとめにする．origin=swap-script (provider が echo
  // しないように tag) ．サーバーは origin に関係なく applyUpdate→persist
  // しつつ他クライアントへ relay する．
  Y.transact(
    doc,
    () => {
      for (const [a, b] of pairs) {
        const mA = byCode.get(a);
        const mB = byCode.get(b);
        const serA = parseSerial(a);
        const serB = parseSerial(b);
        // 入れ替え (atomic な per-cell set だが transact でひとまとめ)
        mA.set('code', b);
        if (serB !== null) mA.set('serialNumber', serB);
        mA.set('updatedAt', now);
        mB.set('code', a);
        if (serA !== null) mB.set('serialNumber', serA);
        mB.set('updatedAt', now);
        console.log(`  ${a} -> ${b}  /  ${b} -> ${a}  (serial ${serA} <-> ${serB})`);
      }
    },
    'swap-script'
  );

  // 更新が provider 経由でサーバーへ送られるのを待ってから close
  setTimeout(() => {
    console.log('[done] closing');
    ws.close();
    process.exit(0);
  }, 600);
}

// Echo local doc updates back to the server (one-way provider impl)
doc.on('update', (update, origin) => {
  if (origin === 'swap-script' || origin === null) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    if (ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(enc));
  }
});
