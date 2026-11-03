// Append-only audit log per room.
// Storage: data/audit/<roomId>.jsonl  (one JSON event per line)
//
// Events are written only when the room's `auditLogging === 'on'`.
//
// Event schema (all fields optional except ts / event):
// {
//   "ts": "2026-05-23T12:00:00.000Z",
//   "event": "connect" | "disconnect" | "auth-denied" | "transaction",
//   "user": "alice@example.ac.jp",
//   "nick": "alice",
//   "ip":   "10.0.0.5",
//   "role": "editor",
//   "bytes": 412,           // for "transaction" events: size of the Yjs update
//   "reason": "..."         // for "auth-denied" events
// }

import { appendFile, mkdir, stat, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidRoomId } from './room-id.js';
import { failLoud } from './notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = join(__dirname, '..', 'data', 'audit');

async function ensureAuditDir() {
  try {
    await stat(AUDIT_DIR);
  } catch {
    await mkdir(AUDIT_DIR, { recursive: true });
  }
}

function fileForRoom(roomId) {
  // Sec-001: replace 方式は衝突するため厳格 validate に変更
  assertValidRoomId(roomId);
  return join(AUDIT_DIR, `${roomId}.jsonl`);
}

/** Append a single audit event for the given room.  Safe to call without
 *  awaiting (errors are logged but never thrown to the caller). */
export function logEvent(roomId, event) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  ensureAuditDir()
    .then(() => appendFile(fileForRoom(roomId), line, 'utf-8'))
    // レビュー rank12: 監査書き込み失敗を fail-loud．IRB 監査証跡が silent に欠落
    // すると事故後に誰が何をしたか追跡不能になる．
    .catch((e) => failLoud('audit', `room=${roomId} 監査ログ書き込み失敗`, e));
}

/** 対策7 (2026-07-03): 構造差分ログ．group/membership/カードの増減を
 *  data/audit/<roomId>-structural.jsonl に 1 行ずつ追記する．通常の監査ログ
 *  (auditLogging 設定に依存) とは独立に，常に記録して事故の即時解析を可能にする．
 *  Safe to call without awaiting (errors are logged but never thrown). */
export function logStructural(roomId, event) {
  assertValidRoomId(roomId);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  ensureAuditDir()
    .then(() => appendFile(join(AUDIT_DIR, `${roomId}-structural.jsonl`), line, 'utf-8'))
    // レビュー rank12: 構造差分ログ (破壊操作追跡の当のレコード) の書き込み失敗も fail-loud．
    .catch((e) => failLoud('audit', `room=${roomId} 構造差分ログ書き込み失敗`, e));
}

/** Read all events for a room.  Returns Array<Event>. */
export async function readEvents(roomId) {
  try {
    const raw = await readFile(fileForRoom(roomId), 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e !== null);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/** Export events as CSV (string).  Pass `since` (ISO string) to filter. */
export async function exportCsv(roomId, since = null) {
  const events = await readEvents(roomId);
  const filtered = since ? events.filter((e) => e.ts >= since) : events;
  const cols = ['ts', 'event', 'user', 'nick', 'ip', 'role', 'bytes', 'reason'];
  const escape = (v) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [cols.join(',')];
  for (const e of filtered) lines.push(cols.map((c) => escape(e[c])).join(','));
  return lines.join('\n') + '\n';
}
