// Headless smoke test for Phase 4b-1.
// Verifies:
//   1. OPEN room: client can connect without email, edits sync
//   2. INVITE_LIST room: client with no invitation is rejected
//   3. INVITE_LIST room: invited client is accepted, edits sync
//   4. Audit log captures connect / disconnect / transaction events when ON
//   5. Persistence file is written for the doc

import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { rm, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 12345;
const OPEN_ROOM = 'smoke-open-' + Date.now();
const INVITE_ROOM = 'smoke-invite-' + Date.now();

const MESSAGE_SYNC = 0;

function bin(p) { return join(__dirname, 'bin', p); }
function dataFile(name) { return join(__dirname, 'data', name); }

let server;
let pass = true;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    pass = false;
  }
}

async function adminCmd(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin('kj-admin.js'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (err += b));
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`kj-admin ${args.join(' ')} failed: ${err}`));
    });
  });
}

function connect(roomId, email = '', nick = '') {
  const doc = new Y.Doc();
  const qs = new URLSearchParams();
  if (email) qs.set('email', email);
  if (nick) qs.set('nick', nick);
  const url = `ws://localhost:${PORT}/${roomId}${qs.size ? '?' + qs : ''}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  doc.on('update', (update, origin) => {
    if (origin === ws) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  return new Promise((resolve) => {
    let resolved = false;
    ws.on('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, doc);
      ws.send(encoding.toUint8Array(enc));
      if (!resolved) { resolved = true; resolve({ doc, ws, denied: false }); }
    });
    // Server rejected the WebSocket upgrade (HTTP 401 etc.)
    ws.on('unexpected-response', (_req, res) => {
      if (!resolved) {
        resolved = true;
        resolve({
          doc,
          ws,
          denied: true,
          httpStatus: res.statusCode,
          reason: res.statusMessage,
        });
      }
    });
    ws.on('close', (code, reason) => {
      if (!resolved) {
        resolved = true;
        resolve({ doc, ws, denied: true, code, reason: reason.toString() });
      }
    });
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
      const dec = decoding.createDecoder(bytes);
      const t = decoding.readVarUint(dec);
      if (t === MESSAGE_SYNC) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(dec, reply, doc, ws);
        if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
      }
    });
  });
}

// Clean test artifacts from any previous run
for (const f of [
  `${OPEN_ROOM}.bin`,
  `${INVITE_ROOM}.bin`,
  `audit/${OPEN_ROOM}.jsonl`,
  `audit/${INVITE_ROOM}.jsonl`,
  'rooms.json.tmp',
]) {
  await rm(dataFile(f), { force: true });
}
// Remove only our test rooms from rooms.json (keep any existing)
try {
  const raw = await readFile(dataFile('rooms.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  delete parsed.rooms?.[OPEN_ROOM];
  delete parsed.rooms?.[INVITE_ROOM];
  const { writeFile } = await import('node:fs/promises');
  await writeFile(dataFile('rooms.json'), JSON.stringify(parsed, null, 2));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

console.log(`[smoke] spawning server (port=${PORT})`);
server = spawn(process.execPath, [join(__dirname, 'src', 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (b) => process.stdout.write(`  [srv] ${b}`));
server.stderr.on('data', (b) => process.stderr.write(`  [srv-err] ${b}`));
await wait(600);

try {
  console.log('\n--- Test 1: OPEN room sync ---');
  const a = await connect(OPEN_ROOM, '', 'alice');
  const b = await connect(OPEN_ROOM, '', 'bob');
  await wait(120);
  const seenA = new Promise((res) => b.doc.getArray('cards').observeDeep(() => res(true)));
  const card = new Y.Map();
  card.set('body', 'open-room test');
  a.doc.getArray('cards').push([card]);
  const r1 = await Promise.race([seenA, wait(1200).then(() => 'timeout')]);
  check('OPEN room: cross-client sync', r1 !== 'timeout');
  check('OPEN room: b sees 1 card', b.doc.getArray('cards').toArray().length === 1);
  a.ws.close(); b.ws.close();
  await wait(150);

  console.log('\n--- Test 2: INVITE_LIST rejects non-invitee ---');
  // Create the invite-list room via admin CLI
  await adminCmd(['room', 'create', INVITE_ROOM, '--audit', 'on', '--access', 'invite_list']);
  const denied = await connect(INVITE_ROOM, 'stranger@example.com', 'stranger');
  check('INVITE: stranger denied', denied.denied === true);
  check(
    'INVITE: HTTP 401 on upgrade',
    denied.httpStatus === 401,
    `got httpStatus=${denied.httpStatus} code=${denied.code}`
  );
  denied.ws.close();
  await wait(120);

  console.log('\n--- Test 3: INVITE_LIST accepts invited user ---');
  await adminCmd(['invite', INVITE_ROOM, 'alice@example.ac.jp', '--role', 'editor']);
  const inv = await connect(INVITE_ROOM, 'alice@example.ac.jp', 'alice');
  check('INVITE: alice connected', inv.denied === false);
  // Push a card so we trigger a "transaction" audit event
  const c2 = new Y.Map();
  c2.set('body', 'invite-only test');
  inv.doc.getArray('cards').push([c2]);
  await wait(250);
  inv.ws.close();
  await wait(250);

  console.log('\n--- Test 4: Audit log captures events ---');
  const auditPath = dataFile(`audit/${INVITE_ROOM}.jsonl`);
  const auditStat = await stat(auditPath).catch(() => null);
  check('audit file exists', auditStat !== null);
  if (auditStat) {
    const raw = await readFile(auditPath, 'utf-8');
    const events = raw.trim().split('\n').map((l) => JSON.parse(l));
    const kinds = events.map((e) => e.event);
    check('logged auth-denied for stranger', kinds.includes('auth-denied'));
    check('logged connect for alice', kinds.includes('connect'));
    check('logged transaction (card push)', kinds.includes('transaction'));
    check('logged disconnect for alice', kinds.includes('disconnect'));
    const aliceTxn = events.find((e) => e.event === 'transaction');
    check(
      'transaction event has user/nick/bytes',
      aliceTxn && aliceTxn.user === 'alice@example.ac.jp' &&
        aliceTxn.nick === 'alice' && typeof aliceTxn.bytes === 'number',
      JSON.stringify(aliceTxn)
    );
  }

  console.log('\n--- Test 5: CLI audit --csv ---');
  const csvPath = dataFile(`audit/${INVITE_ROOM}.csv`);
  await adminCmd(['audit', INVITE_ROOM, '--csv', csvPath]);
  const csv = await readFile(csvPath, 'utf-8');
  check('csv has header', csv.startsWith('ts,event,user'));
  check('csv has at least 3 data rows', csv.split('\n').filter(Boolean).length >= 4);
  await rm(csvPath, { force: true });

  console.log('\n--- Test 6: Persistence ---');
  const persistA = await stat(dataFile(`${OPEN_ROOM}.bin`)).catch(() => null);
  const persistB = await stat(dataFile(`${INVITE_ROOM}.bin`)).catch(() => null);
  check('OPEN room persistence file written', persistA && persistA.size > 0);
  check('INVITE room persistence file written', persistB && persistB.size > 0);

  console.log(`\n[smoke] ${pass ? 'OK' : 'FAIL'}`);
} catch (e) {
  console.error('[smoke] error:', e);
  pass = false;
} finally {
  server.kill();
  await wait(300);
  // Clean test artifacts
  for (const f of [
    `${OPEN_ROOM}.bin`,
    `${INVITE_ROOM}.bin`,
    `audit/${OPEN_ROOM}.jsonl`,
    `audit/${INVITE_ROOM}.jsonl`,
  ]) {
    await rm(dataFile(f), { force: true });
  }
  // Remove test rooms from rooms.json (leave any other rooms intact)
  try {
    const raw = await readFile(dataFile('rooms.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    delete parsed.rooms?.[OPEN_ROOM];
    delete parsed.rooms?.[INVITE_ROOM];
    const { writeFile } = await import('node:fs/promises');
    await writeFile(dataFile('rooms.json'), JSON.stringify(parsed, null, 2));
  } catch {}
  process.exit(pass ? 0 : 1);
}
