// 段階1: サーバー側スナップショット (2026-07-03 データ破損インシデント後の再発防止).
//
// 背景: 片方のクライアントが巨大 diff を push し，全 group_membership が 1 グループへ
// 集約された．その直後に auto-compact が走り，履歴 (=復元可能な過去状態) が消えた．
// compact は現在状態のみを残すため，compact で「壊れた現在」しか残らない状況を作る．
//
// この仕組みは compact とは独立に，Y.Doc の完全状態スナップショットを
//   data/snapshots/<roomId>/<id>.snap.gz  (gzip 圧縮した encodeStateAsUpdate)
//   data/snapshots/<roomId>/manifest.json (メタデータ一覧)
// として保存する．トリガ: N 操作ごと / T 分ごと / auto-compact 直前 / 手動．
// admin CLI で一覧・復元できる (kj-admin snapshot ...)．
//
// 設計方針: 失敗してもサービス本体を止めない (例外は握って warn)．storage 効率より
// 復元の確実性を優先し，各スナップショットは完全状態 (差分チェーンではない) を持つ．

import { readFile, writeFile, mkdir, readdir, stat, unlink, rename, copyFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './paths.js';
import { randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import { assertValidRoomId } from './room-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SNAP_ROOT = join(DATA_DIR, 'snapshots');

const DEFAULT_RETENTION = 200;

function snapDir(roomId) {
  assertValidRoomId(roomId);
  return join(SNAP_ROOT, roomId);
}

function manifestPath(roomId) {
  return join(snapDir(roomId), 'manifest.json');
}

/** 2 桁ゼロ埋め (Date 由来の値専用の軽量ヘルパ). */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** ソート可能・ファイル名安全な id を生成 (例: 20260703-145530-123-a1b2). */
function makeSnapshotId(now) {
  const d = now ?? new Date();
  const ymd = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const hms = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const rand = randomBytes(2).toString('hex');
  return `${ymd}-${hms}-${ms}-${rand}`;
}

/** doc の tables から代表的な行数を拾う (一覧表示用の軽量メタ). */
function docCounts(doc) {
  const tables = doc.getMap('tables');
  const len = (k) => {
    const arr = tables.get(k);
    return arr && typeof arr.length === 'number' ? arr.length : 0;
  };
  return { cards: len('cards'), groups: len('groups'), memberships: len('group_memberships') };
}

async function ensureSnapDir(roomId) {
  await mkdir(snapDir(roomId), { recursive: true });
}

async function readManifest(roomId) {
  try {
    const raw = await readFile(manifestPath(roomId), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.warn(`[snapshots] manifest 読込失敗 (${roomId}):`, e.message);
    return [];
  }
}

/** manifest を atomic に書き込む (tmp→rename). */
async function writeManifest(roomId, entries) {
  const target = manifestPath(roomId);
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(entries, null, 2), 'utf-8');
  try {
    await rename(tmp, target);
  } catch (e) {
    try { await unlink(tmp); } catch {}
    throw e;
  }
}

// ---- per-room 直列化 (manifest の read-modify-write を競合させない) ----
const _chains = new Map();

function enqueue(roomId, op) {
  const prev = _chains.get(roomId) ?? Promise.resolve();
  const run = prev.then(op, op);
  _chains.set(roomId, run.then(() => {}, () => {}));
  return run;
}

/** retention を超えた古いスナップショットを削除 (entries は時系列昇順を想定). */
async function pruneOld(roomId, entries, retention) {
  const keep = Number.isFinite(retention) && retention > 0 ? retention : DEFAULT_RETENTION;
  if (entries.length <= keep) return entries;
  const remove = entries.slice(0, entries.length - keep);
  for (const e of remove) {
    try {
      await unlink(join(snapDir(roomId), `${e.id}.snap.gz`));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[snapshots] 古いファイル削除失敗 ${e.id}:`, err.message);
    }
  }
  return entries.slice(entries.length - keep);
}

/** 対策6 (2026-07-03): mirrorDir が設定されていれば .snap.gz と manifest.json を
 *  <mirrorDir>/<roomId>/ にも複製する．ディスク障害でスナップショットを失わない冗長化．
 *  失敗しても本体を止めない (warn して握る)． */
async function mirrorSnapshot(roomId, id, mirrorDir, keptEntries) {
  if (!mirrorDir) return;
  try {
    const dstDir = join(mirrorDir, roomId);
    await mkdir(dstDir, { recursive: true });
    await copyFile(join(snapDir(roomId), `${id}.snap.gz`), join(dstDir, `${id}.snap.gz`));
    await copyFile(manifestPath(roomId), join(dstDir, 'manifest.json'));
    // Codex#7: mirror 側にも retention を効かせる (primary で prune された分を削除)．
    if (Array.isArray(keptEntries)) {
      const keepIds = new Set(keptEntries.map((e) => e.id));
      let files = [];
      try { files = await readdir(dstDir); } catch { files = []; }
      for (const f of files) {
        if (!f.endsWith('.snap.gz')) continue;
        const fid = f.slice(0, -'.snap.gz'.length);
        if (!keepIds.has(fid)) {
          try { await unlink(join(dstDir, f)); } catch {}
        }
      }
    }
  } catch (e) {
    console.warn(`[snapshots] mirror コピー失敗 (${roomId} → ${mirrorDir}):`, e.message);
  }
}

/** state(encodeStateAsUpdate の生バイト) と counts から 1 世代を保存する共通処理． */
async function persistState(roomId, state, counts, { trigger, author, label, retention, mirrorDir }) {
  await ensureSnapDir(roomId);
  const now = new Date();
  const id = makeSnapshotId(now);
  const gz = gzipSync(Buffer.from(state));
  const file = join(snapDir(roomId), `${id}.snap.gz`);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  await writeFile(tmp, gz);
  await rename(tmp, file);

  const entry = {
    id,
    ts: now.toISOString(),
    trigger: trigger ?? 'manual',
    author: author ?? null,
    label: label ?? null,
    bytes: gz.length,
    stateBytes: state.length,
    counts,
  };
  const entries = await readManifest(roomId);
  entries.push(entry);
  const pruned = await pruneOld(roomId, entries, retention);
  await writeManifest(roomId, pruned);
  await mirrorSnapshot(roomId, id, mirrorDir, pruned);
  return entry;
}

/** room の完全状態スナップショットを保存する．
 *  失敗してもサービスを止めないよう，呼び出し側は .catch(() => {}) して使う想定だが，
 *  内部でも例外は握って warn し，null を返す． */
export function takeSnapshot(roomId, doc, { trigger, author = null, label = null, retention = DEFAULT_RETENTION, mirrorDir = null } = {}) {
  return enqueue(roomId, async () => {
    try {
      const state = Y.encodeStateAsUpdate(doc);
      return await persistState(roomId, state, docCounts(doc), { trigger, author, label, retention, mirrorDir });
    } catch (e) {
      console.warn(`[snapshots] takeSnapshot 失敗 (${roomId}):`, e.message);
      return null;
    }
  });
}

/** 対策2 (2026-07-03): 生の状態バイト (Y.encodeStateAsUpdate の結果) から保存する．
 *  サーキットブレーカーが「大規模変更の直前に保持していた安全状態」を保存するのに使う． */
export function takeSnapshotFromState(roomId, state, { trigger, author = null, label = null, retention = DEFAULT_RETENTION, mirrorDir = null } = {}) {
  return enqueue(roomId, async () => {
    try {
      // counts は state を一時 doc に展開して算出．
      const tmpDoc = new Y.Doc();
      Y.applyUpdate(tmpDoc, state instanceof Uint8Array ? state : new Uint8Array(state));
      return await persistState(roomId, state, docCounts(tmpDoc), { trigger, author, label, retention, mirrorDir });
    } catch (e) {
      console.warn(`[snapshots] takeSnapshotFromState 失敗 (${roomId}):`, e.message);
      return null;
    }
  });
}

/** manifest の一覧を新しい順で返す． */
export async function listSnapshots(roomId) {
  const entries = await readManifest(roomId);
  return entries.slice().reverse();
}

/** 指定 id のスナップショットを展開し，Y update (Uint8Array) を返す． */
export async function restoreSnapshot(roomId, id) {
  const file = join(snapDir(roomId), `${id}.snap.gz`);
  const gz = await readFile(file);
  return new Uint8Array(gunzipSync(gz));
}
