// Simple append-only update log per room, persisted to disk.
// Storage layout:
//   data/<roomId>.bin   ← concatenation of length-prefixed Yjs updates
//
// On startup we read the file once and apply each update to the in-memory
// Y.Doc.  On every update event we append the new update bytes to the file.
// A future compaction step (out of scope for the PoC) would rewrite the
// entire file as a single state-vector update.

import { readFile, writeFile, mkdir, appendFile, stat, rename, unlink, copyFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { failLoud } from './notify.js';
import { assertValidRoomId } from './room-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
// Codex#7: restore 前退避 .bin.<tag>.bak の保持世代数．
const BACKUP_RETENTION = 20;

function fileForRoom(roomId) {
  // Sec-001 (2026-06-02): 旧実装は `[^A-Za-z0-9_-]` → `_` で replace していたが，
  // 異なる ID が同じファイル名に衝突する致命的な脆弱性があった
  // (例: `secret.room` と `secret_room` が同一 .bin を共有)．
  // 厳格バリデーションで不正 ID は throw する．呼び出し側 (ensureRoom / WS upgrade)
  // で先に validate 済のはずだが，多層防御として ここでも assert．
  assertValidRoomId(roomId);
  return join(DATA_DIR, `${roomId}.bin`);
}

function epochFileForRoom(roomId) {
  assertValidRoomId(roomId);
  return join(DATA_DIR, `${roomId}.epoch`);
}

/** Read the room's docEpoch (lineage generation id). Returns null if absent. */
export async function loadEpoch(roomId) {
  await ensureDataDir();
  try {
    const raw = await readFile(epochFileForRoom(roomId), 'utf8');
    const v = raw.trim();
    return v.length > 0 ? v : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Atomically write the room's docEpoch. */
export async function writeEpoch(roomId, epoch) {
  await ensureDataDir();
  const target = epochFileForRoom(roomId);
  const tmp = `${target}.tmp-${Date.now()}-${process.pid}`;
  await writeFile(tmp, `${epoch}\n`, 'utf8');
  try {
    await rename(tmp, target);
  } catch (e) {
    try { await unlink(tmp); } catch {}
    throw e;
  }
}

/** Load the room's docEpoch, generating + persisting a fresh one if absent.
 *  Used at room load: a room that predates the epoch mechanism (or a freshly
 *  created room) gets a stable epoch on first touch.  Returns the epoch. */
export async function ensureEpoch(roomId) {
  const existing = await loadEpoch(roomId);
  if (existing) return existing;
  const fresh = randomUUID();
  await writeEpoch(roomId, fresh);
  return fresh;
}

/** Generate + persist a NEW epoch, invalidating all client caches for the room.
 *  Call this ONLY when the doc's Yjs lineage is rebuilt out-of-band
 *  (dedup-room, clone) — NOT on lineage-preserving compactRoom. Returns it. */
export async function rotateEpoch(roomId) {
  const fresh = randomUUID();
  await writeEpoch(roomId, fresh);
  return fresh;
}

async function ensureDataDir() {
  try {
    await stat(DATA_DIR);
  } catch {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

// ---- per-room IO 直列化 (2026-06-16 durability fix) ----
// persistUpdate(append) と compactRoom(encode→write tmp→rename) は同一 .bin を
// 触るため直列化が必須．非直列だと「encode と rename の隙間」に来た append が
// rename で旧ファイルごと捨てられ，再起動後に消失する (data-loss)．
// roomId ごとに promise chain を作り，append / compact を厳密な発行順で実行する．
const _ioChains = new Map();

function enqueueIo(roomId, op) {
  const prev = _ioChains.get(roomId) ?? Promise.resolve();
  // 直前が reject でも op は必ず走らせる (op に append/compact の本体が入る)．
  const run = prev.then(op, op);
  // chain の tail は握り潰して「1 件の失敗で以降が全部詰まる」のを防ぐ．
  // caller には run (実 result / 実 reject) をそのまま返す．
  _ioChains.set(
    roomId,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}

/** Read all stored updates for a room and apply them to `doc`. */
export async function loadRoom(roomId, doc) {
  await ensureDataDir();
  let buf;
  try {
    buf = await readFile(fileForRoom(roomId));
  } catch (e) {
    if (e.code === 'ENOENT') return; // new room, nothing to load
    throw e;
  }
  // Parse length-prefixed entries: [u32 len][bytes...]
  let off = 0;
  Y.transact(
    doc,
    () => {
      while (off + 4 <= buf.length) {
        const recordStart = off;
        const len = buf.readUInt32BE(off);
        off += 4;
        if (off + len > buf.length) {
          // レビュー rank7: 長さプレフィックス不整合を無警告で break していた．末尾の
          // torn write (クラッシュ/電源断) なら直近 update の無言消失，中間レコードの
          // ビット化けなら有効な後続レコードごと全消失する．いずれも fail-loud で可視化し，
          // 監査ログと実 doc の乖離に運用者が気づけるようにする．
          const remaining = buf.length - recordStart;
          failLoud(
            'persistence',
            `room=${roomId} loadRoom: 長さ不整合で打ち切り — 以降の update を破棄` +
              ` (offset=${recordStart}, len=${len}, remaining=${remaining} bytes)．` +
              `末尾なら torn write，中間なら .bin 破損の可能性．直近スナップショットからの復元を検討．`,
          );
          break;
        }
        const update = buf.subarray(off, off + len);
        Y.applyUpdate(doc, update, 'persistence');
        off += len;
      }
    },
    'persistence'
  );
}

/** Current on-disk size (bytes) of the room's append log, or 0 if absent.
 *  Used to seed the in-memory bloat baseline when startup-compaction is off. */
export async function roomFileBytes(roomId) {
  try {
    return (await stat(fileForRoom(roomId))).size;
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
}

/** Append a single Y.js update to the room's storage.
 *  per-room IO chain 経由で直列化される (compactRoom と順序保証)． */
export function persistUpdate(roomId, update) {
  return enqueueIo(roomId, async () => {
    await ensureDataDir();
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(update.length, 0);
    await appendFile(fileForRoom(roomId), Buffer.concat([lenBuf, Buffer.from(update)]));
  });
}

/** Rewrite the file as a single compact "current state" update.
 *  2026-06-02 Sec-incident 後改修:
 *  - atomic rename で書き込み途中の crash 耐性
 *  - before/after サイズと圧縮率を返す（caller が audit ログ用）
 *
 *  返り値: { beforeBytes, afterBytes, ratio } */
export function compactRoom(roomId, doc) {
  assertValidRoomId(roomId); // 不正 ID は enqueue 前に即 throw
  return enqueueIo(roomId, async () => {
    await ensureDataDir();
    const target = fileForRoom(roomId);
    let beforeBytes = 0;
    try {
      beforeBytes = (await stat(target)).size;
    } catch {
      // ファイル未存在は OK
    }
    // encode は IO chain の op 内 (= 先行 append 完了後) に実行する．これで
    // 「ロック保持中の doc 状態」をスナップショットでき，compaction 実行中に
    // 来た append は chain 上で後ろに並ぶため rename 後の新ファイルへ追記される．
    // 結果，encode↔rename 間の append 損失が起きない．
    const encoded = Y.encodeStateAsUpdate(doc);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(encoded.length, 0);
    const payload = Buffer.concat([lenBuf, Buffer.from(encoded)]);
    const tmp = `${target}.tmp-${Date.now()}-${process.pid}`;
    await writeFile(tmp, payload);
    try {
      // atomic rename (POSIX). Windows でも同 volume 内なら near-atomic．
      await rename(tmp, target);
    } catch (e) {
      // 失敗時は tmp を削除して落とす．元 .bin はそのまま残る．
      try { await unlink(tmp); } catch {}
      throw e;
    }
    return {
      beforeBytes,
      afterBytes: payload.length,
      ratio: beforeBytes > 0 ? payload.length / beforeBytes : 1,
    };
  });
}

/** 対策5 (2026-07-03): restore 前に現 .bin を .bin.<tag>.bak へ退避する．
 *  ファイルが無ければ何もしない (新規 room)．退避先パスを返す (無ければ null)． */
export function backupRoomFile(roomId, tag) {
  assertValidRoomId(roomId);
  return enqueueIo(roomId, async () => {
    const src = fileForRoom(roomId);
    try {
      await stat(src);
    } catch {
      return null; // .bin 未存在
    }
    const safeTag = String(tag ?? 'bak').replace(/[^A-Za-z0-9_-]/g, '');
    const dst = `${src}.${safeTag}.bak`;
    await copyFile(src, dst);
    // Codex#7: .bin.<tag>.bak が restore の度に増えるので直近 BACKUP_RETENTION 世代だけ残す．
    try {
      const prefix = `${roomId}.bin.`;
      const names = (await readdir(DATA_DIR)).filter(
        (n) => n.startsWith(prefix) && n.endsWith('.bak')
      );
      if (names.length > BACKUP_RETENTION) {
        const withTime = [];
        for (const n of names) {
          try { withTime.push({ n, t: (await stat(join(DATA_DIR, n))).mtimeMs }); } catch {}
        }
        withTime.sort((a, b) => a.t - b.t); // 古い順
        for (const e of withTime.slice(0, withTime.length - BACKUP_RETENTION)) {
          try { await unlink(join(DATA_DIR, e.n)); } catch {}
        }
      }
    } catch (e) {
      console.warn(`[persistence] backup prune 失敗 (${roomId}):`, e.message);
    }
    return dst;
  });
}
