// Affinity Mapping Studio Server (旧名: kj-trace-server，Phase 4b-1〜)
//
// WebSocket-based Yjs sync server with:
//   - Room metadata + invitation list (src/rooms.js)
//   - Append-only audit log per room (src/audit.js)
//   - Connection-time email validation when room.accessControl === 'invite_list'
//   - Per-transaction audit recording when room.auditLogging === 'on'
//
// URL form:
//   ws://host:1234/<roomId>?email=alice@xxx&nick=Alice
//
// - email & nick are query-string params (no TLS / encrypted body needed in PoC).
//   We rely on the upstream VPN as the first authentication layer; this server
//   just records who claimed to be whom and (optionally) checks against the
//   invitation list.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { loadRoom, persistUpdate, compactRoom, ensureEpoch, roomFileBytes, rotateEpoch, backupRoomFile } from './persistence.js';
import { takeSnapshot, takeSnapshotFromState, listSnapshots, restoreSnapshot } from './snapshots.js';
import { ensureEmptyTables } from './yjs-schema.js';
import { failLoud } from './notify.js';
import { ensureRoom, checkAccess, getRoom } from './rooms.js';
import { logEvent, logStructural } from './audit.js';
import { structuralFingerprint, diffFingerprints, hasStructuralChange, assessImpact } from './structural.js';
import { evaluateSeedClaim } from './seed-claim.js';
import { handleAdminRequest, isAdminConfigured, registerRoomInstances } from './admin-router.js';
import { isValidRoomId } from './room-id.js';
import { bootConfig, getResolvedConfig, printStartupBanner } from './config.js';
import { resolveClientIp } from './ip-trust.js';

// R5 (2026-06-09): bootConfig() で resolved config を 1 度だけ読み込み，
// 以降は getResolvedConfig() で参照する．env 直読みは廃止．
const cfg = await bootConfig();

// Sec-004: 共同作業 (WS+API) と管理 (/admin) を別ポートに分離．
const PORT = cfg.network.appPort;
const ADMIN_PORT = cfg.network.adminPort;
const ADMIN_BIND_HOST = cfg.network.adminBindHost;
const APP_BIND_HOST = cfg.network.appBindHost;

// Sec-005: DoS 上限
const MAX_PAYLOAD_BYTES = cfg.limits.maxPayloadBytes;
const MAX_CONNECTIONS_PER_IP = cfg.limits.maxConnectionsPerIp;
const MAX_CONNECTIONS_PER_ROOM = cfg.limits.maxConnectionsPerRoom;
const MAX_UPDATES_PER_SECOND = cfg.limits.maxUpdatesPerSecond;

// 自動コンパクション
const COMPACT_ON_STARTUP = cfg.compact.onStartup;
const COMPACT_AFTER_UPDATES = cfg.compact.afterUpdates;
// バイト基準トリガ + 肥大早期警告 (count トリガは update サイズに盲目なので
// 肥大 update で 200MB まで膨らみうる．whichever-first で size 基準も併用)．
const COMPACT_AFTER_BYTES = cfg.compact.afterBytes;
const WARN_UPDATE_BYTES = cfg.compact.warnUpdateBytes;
const WARN_FILE_BYTES = cfg.compact.warnFileBytes;

// 段階1 (2026-07-03): サーバー側スナップショット (compact 独立の履歴保全).
const SNAPSHOTS_ENABLED = cfg.snapshots.enabled;
const SNAPSHOT_EVERY_N_OPS = cfg.snapshots.everyNOps;
const SNAPSHOT_EVERY_MINUTES = cfg.snapshots.everyMinutes;
const SNAPSHOT_RETENTION = cfg.snapshots.retention;
const SNAPSHOT_MIRROR_DIR = cfg.snapshots.mirrorDir; // 対策6

// 対策2 (2026-07-03): サーキットブレーカー (大規模構造変更の検知・安全版).
const CIRCUIT_BREAKER_ENABLED = cfg.circuitBreaker.enabled;
const CIRCUIT_BREAKER_THRESHOLD = cfg.circuitBreaker.threshold;

// 対策3 (2026-07-03): seed-claim．空ルームへの seed を 1 クライアントに限定し，
// 「既にデータのあるルームを別クライアントが上書き seed」する事故を防ぐ．
// roomId → { clientId, ts }．TTL 経過で失効 (掴んだまま切断されても解放される).
const SEED_CLAIM_TTL_MS = 30_000;
const seedClaims = new Map();

// Codex#1: restore 進行中の room．新規接続を弾き，既存接続の apply を止めて
// 「restore の書き込みと旧 update / 新規ロードが混ざる」競合を防ぐ．
const restoringRooms = new Set();
// Codex#4: snapshot id のファイル名安全性 (path traversal 防止)．
const SNAPSHOT_ID_RE = /^[0-9A-Za-z_-]+$/;

// Sec-003 strict viewer
const STRICT_VIEWER = cfg.protocol.strictViewer;

// Sec-008 Layer 1: WebSocket subprotocol `kj-studio.v1`
const REQUIRE_KJ_STUDIO_PROTOCOL = cfg.protocol.requireKjStudio;
const ACCEPTED_PROTOCOL = 'kj-studio.v1';

// Sec-008 Layer 2: Origin allowlist
const ALLOWED_ORIGINS = new Set(cfg.origins.allowedExplicit);
const ALLOW_EMPTY_ORIGIN = cfg.origins.allowEmpty;
const ALLOW_LOCALHOST_ANY_PORT = cfg.origins.allowLocalhostAnyPort;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Sec-003/009 (2026-06-03): KJ Studio 独自メッセージ．サーバー → クライアント単方向で
// 接続確立直後に role / via / strict フラグなどを通知．JSON ペイロード．
// 未対応クライアント (v0.2.x 以前) は default 分岐で warning が出るだけで害なし．
const MESSAGE_KJ_META = 2;
// #2 (2026-06-23) / 対策3: seed-claim．双方向 JSON．
//   client → server: { kind: 'seed-claim', clientId }
//   server → client: { kind: 'seed-claim-result', granted, reason }
const MESSAGE_SEED_CLAIM = 3;

// Sec-005 IP ごとの同時接続数
const connectionsByIp = new Map();
function incIpCount(ip) {
  connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
}
function decIpCount(ip) {
  const n = connectionsByIp.get(ip) ?? 0;
  if (n <= 1) connectionsByIp.delete(ip);
  else connectionsByIp.set(ip, n - 1);
}

/** Map<roomId, Room>.  Exported so the admin router can introspect presence. */
export const rooms = new Map();
registerRoomInstances(rooms);

class Room {
  constructor(id) {
    this.id = id;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    /** @type {Set<import('ws').WebSocket>} */
    this.clients = new Set();
    this.loaded = false;
    // docEpoch (lineage generation id). ensureLoaded() で読み込み．
    // dedup/clone で lineage を作り直したときだけ rotate される．
    // クライアントは保存済 epoch と不一致なら IndexedDB を破棄して download-only 同期する．
    this.epoch = null;
    // 自動コンパクション用カウンタ．閾値超過で compactRoom() を発火し counter リセット
    this.appendsSinceCompact = 0;
    // バイト基準トリガ + 肥大監視．bytesSinceCompact は前回コンパクト以降に追記した
    // update バイト総和（in-memory，stat 不要）．fileBytes は最後に確定したファイル
    // サイズ（startup compact / load 時の stat / auto-compact afterBytes で更新）．
    // 現在のおおよそのファイルサイズ = fileBytes + bytesSinceCompact．
    this.bytesSinceCompact = 0;
    this.fileBytes = 0;
    this.warnedFileBytes = false; // 同一肥大局面で警告ログを連発しないラッチ
    this.compactInFlight = false;
    // 段階1: スナップショット用．snapshotOpCounter は前回スナップショット以降の実編集数．
    // dirtySinceSnapshot は時間トリガ用 (前回スナップショット以降に変更があったか)．
    this.snapshotOpCounter = 0;
    this.dirtySinceSnapshot = false;
    // 対策7/2: 構造フィンガープリントと「最後の安全状態」．ensureLoaded で初期化．
    this.structFp = null;
    this.lastSafeState = null;
    // Codex#5: サーキットブレーカーが一度 trip したら，破損後の状態を lastSafeState に
    // 採り込まない (良状態を保持し続ける)．restore で room が再ロードされるとリセット．
    this.breakerTripped = false;
    // Codex#1: restore 中はこの room の doc.on('update') を無効化する (persistUpdate/
    // 構造解析を止め，restore の書き込みと混ざらないようにする)．
    this.detached = false;

    this.doc.on('update', (update, origin) => {
      // Codex#1: restore 進行中はこの旧 room の update を一切処理しない．
      if (this.detached) return;
      // Broadcast to everyone except originator
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, MESSAGE_SYNC);
      syncProtocol.writeUpdate(message, update);
      const bytes = encoding.toUint8Array(message);
      for (const ws of this.clients) {
        if (ws !== origin && ws.readyState === ws.OPEN) ws.send(bytes);
      }
      if (origin !== 'persistence') {
        persistUpdate(this.id, update).catch((err) =>
          // レビュー rank6: 書き込み失敗は fail-loud．update は broadcast 済みだが
          // .bin 未反映 = クライアントは「保存された」と錯覚する．silent にしない．
          failLoud('persist', `room=${this.id} persistUpdate 失敗 (update 未永続化)`, err),
        );
        // 自動コンパクション: count トリガ OR バイトトリガの whichever-first で発火．
        // 多重起動を防ぐため compactInFlight フラグでガード．
        const updateBytes = update.length;
        this.appendsSinceCompact++;
        this.bytesSinceCompact += updateBytes + 4; // +4 = length prefix

        // 対策7/2 (2026-07-03): 構造差分の監査ログ + サーキットブレーカー．
        // doc は update 適用後の状態．前回フィンガープリント (this.structFp) と差分して
        // 構造変化を検出する．this.lastSafeState は最後に「安全」と判定した完全状態
        // (= この update より前) を保持し，大規模変更を検知したら即保全する．
        if (this.structFp) {
          try {
            const ctx = origin && typeof origin === 'object' ? origin.__kjctx : null;
            const curFp = structuralFingerprint(this.doc);
            const diff = diffFingerprints(this.structFp, curFp);
            const structural = hasStructuralChange(diff);
            if (structural || diff.cardsMoved >= 10) {
              logStructural(this.id, {
                event: 'structural-change',
                user: ctx?.email,
                nick: ctx?.nick,
                updateBytes,
                groupsAdded: diff.groupsAdded,
                groupsRemoved: diff.groupsRemoved,
                membershipsRepointed: diff.membershipsRepointed,
                membershipsAdded: diff.membershipsAdded,
                membershipsRemoved: diff.membershipsRemoved,
                cardsMoved: diff.cardsMoved,
                cardsAdded: diff.cardsAdded,
                cardsRemoved: diff.cardsRemoved,
              });
            }
            let suspicious = false;
            if (CIRCUIT_BREAKER_ENABLED && (structural || diff.cardsMoved > 0)) {
              const imp = assessImpact(this.structFp, curFp, diff);
              if (imp.impact >= CIRCUIT_BREAKER_THRESHOLD) {
                suspicious = true;
                this.breakerTripped = true;
                console.error(
                  `[room=${this.id}] CIRCUIT-BREAKER: 大規模構造変更を検知 ` +
                    `(impact=${(imp.impact * 100).toFixed(0)}% ` +
                    `repointed=${diff.membershipsRepointed}/${imp.totalMem} ` +
                    `moved=${diff.cardsMoved}/${imp.totalCards} newGroups=${diff.groupsAdded.length}) ` +
                    `by ${ctx?.email ?? 'unknown'} — 直前状態を保全します`
                );
                logStructural(this.id, {
                  event: 'circuit-breaker',
                  user: ctx?.email,
                  nick: ctx?.nick,
                  impact: imp.impact,
                  membershipsRepointed: diff.membershipsRepointed,
                  cardsMoved: diff.cardsMoved,
                  groupsAdded: diff.groupsAdded,
                  updateBytes,
                });
                if (this.lastSafeState) {
                  takeSnapshotFromState(this.id, this.lastSafeState, {
                    trigger: 'circuit-breaker-prestate',
                    label: `impact ${(imp.impact * 100).toFixed(0)}% before mass change`,
                    retention: SNAPSHOT_RETENTION,
                    mirrorDir: SNAPSHOT_MIRROR_DIR,
                  }).catch(() => {});
                }
              }
            }
            // Codex#5: 「安全状態」は非 suspicious かつ breaker 未 trip のとき，
            // 影響のある編集 (構造変化 or カード移動) ごとに毎回更新し，常に「直前の
            // 良状態」を指すようにする (従来は構造変化時のみ → カード移動だけの編集で
            // 古くなっていた)．一度 trip したら破損後状態を採り込まない．
            if (!suspicious && !this.breakerTripped && (structural || diff.cardsMoved > 0)) {
              this.lastSafeState = Y.encodeStateAsUpdate(this.doc);
            }
            this.structFp = curFp;
          } catch (e) {
            console.warn(`[room=${this.id}] structural analysis error:`, e.message);
          }
        }

        // 段階1: スナップショット (N 操作トリガ)．compact とは独立に完全状態を保存し，
        // 「巨大 diff で壊れ → compact で履歴消失」から復元できる過去世代を残す．
        if (SNAPSHOTS_ENABLED) {
          this.dirtySinceSnapshot = true;
          this.snapshotOpCounter++;
          if (SNAPSHOT_EVERY_N_OPS > 0 && this.snapshotOpCounter >= SNAPSHOT_EVERY_N_OPS) {
            this.snapshotOpCounter = 0;
            this.dirtySinceSnapshot = false;
            takeSnapshot(this.id, this.doc, {
              trigger: 'count',
              retention: SNAPSHOT_RETENTION,
              mirrorDir: SNAPSHOT_MIRROR_DIR,
            }).catch(() => {});
          }
        }

        // 早期警告 (1): 異常に大きな単一 update（全書き換え等の肥大シグナル）．
        if (WARN_UPDATE_BYTES > 0 && updateBytes > WARN_UPDATE_BYTES) {
          console.warn(
            `[room=${this.id}] large single update: ${updateBytes} bytes ` +
              `(> ${WARN_UPDATE_BYTES}) — 全書き換え/肥大の兆候を確認してください`
          );
        }
        // 早期警告 (2): ファイル推定サイズが閾値超過．同一局面で連発しないようラッチ．
        if (
          WARN_FILE_BYTES > 0 &&
          this.approxFileBytes() > WARN_FILE_BYTES &&
          !this.warnedFileBytes
        ) {
          this.warnedFileBytes = true;
          console.warn(
            `[room=${this.id}] room file ~${this.approxFileBytes()} bytes ` +
              `(> ${WARN_FILE_BYTES}) — CRDT 肥大の可能性．clients を確認してください`
          );
        }

        const countHit =
          COMPACT_AFTER_UPDATES > 0 && this.appendsSinceCompact >= COMPACT_AFTER_UPDATES;
        const byteHit =
          COMPACT_AFTER_BYTES > 0 && this.bytesSinceCompact >= COMPACT_AFTER_BYTES;
        if ((countHit || byteHit) && !this.compactInFlight) {
          this.compactInFlight = true;
          const triggeredAfter = this.appendsSinceCompact;
          const triggeredBytes = this.bytesSinceCompact;
          const reason = byteHit
            ? `triggered-after-${triggeredBytes}-bytes`
            : `triggered-after-${triggeredAfter}-updates`;
          this.appendsSinceCompact = 0;
          this.bytesSinceCompact = 0;
          // 段階1: compact は append-log を現在状態で上書きし過去履歴を捨てる．
          // その直前に完全状態スナップショットを保存し，compact 後も過去世代を復元可能にする．
          if (SNAPSHOTS_ENABLED) {
            this.snapshotOpCounter = 0;
            this.dirtySinceSnapshot = false;
            takeSnapshot(this.id, this.doc, {
              trigger: 'pre-compact',
              retention: SNAPSHOT_RETENTION,
              mirrorDir: SNAPSHOT_MIRROR_DIR,
            }).catch(() => {});
          }
          compactRoom(this.id, this.doc)
            .then((stat) => {
              // 確定サイズで基準を更新し，肥大警告ラッチを解除．
              this.fileBytes = stat.afterBytes;
              this.warnedFileBytes = false;
              console.log(
                `[room=${this.id}] auto-compact (${reason}): ` +
                  `${stat.beforeBytes} → ${stat.afterBytes} bytes ` +
                  `(${(stat.ratio * 100).toFixed(1)}%)`
              );
              // 監査ログに記録．auditLogging=off でも内部運用ログとしては残す
              getRoom(this.id).then((meta) => {
                if (meta?.auditLogging === 'on') {
                  logEvent(this.id, {
                    event: 'auto-compact',
                    bytes: stat.afterBytes,
                    reason,
                  });
                }
              });
            })
            .catch((err) => {
              console.error(`[room=${this.id}] auto-compact failed:`, err);
              // 失敗してもサービスは継続．次の閾値到達で再試行できるようカウンタを復元
              this.appendsSinceCompact = triggeredAfter;
              this.bytesSinceCompact = triggeredBytes;
            })
            .finally(() => {
              this.compactInFlight = false;
            });
        }
        // Audit: only if the room currently has logging enabled.  Re-read each
        // time so toggling via kj-admin takes effect without restart.
        getRoom(this.id).then((meta) => {
          if (meta?.auditLogging === 'on') {
            const ctx = origin && typeof origin === 'object' ? origin.__kjctx : null;
            logEvent(this.id, {
              event: 'transaction',
              user: ctx?.email,
              nick: ctx?.nick,
              ip: ctx?.ip,
              role: ctx?.role,
              bytes: update.length,
            });
          }
        });
      }
    });

    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        message,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
      );
      const bytes = encoding.toUint8Array(message);
      for (const ws of this.clients) {
        if (ws !== origin && ws.readyState === ws.OPEN) ws.send(bytes);
      }
    });
  }

  async ensureLoaded() {
    if (this.loaded) return;
    await loadRoom(this.id, this.doc);
    // epoch を読み込み (未存在なら生成して永続化)．lineage を作り直す
    // dedup/clone のみがこれを rotate する．compactRoom は据え置き．
    this.epoch = await ensureEpoch(this.id);
    // ルーム doc を 1 度だけ正規化: 全 mapped table に root Y.Array を用意する．
    // これにより client は `tables.set(name, new Y.Array())` する必要がなくなり，
    // 空ルームへの同時 upload で起きる「Y.Map.set の last-writer-wins で相手の
    // 全行が clobber される」事故を構造的に防ぐ (client は既存 array に push する
    // だけ → 同時 upload は union になる)．冪等なので再 seed の churn は無い．
    ensureEmptyTables(this.doc);
    // 対策7/2: ロード直後の状態を構造フィンガープリント + 安全状態の基準にする．
    try {
      this.structFp = structuralFingerprint(this.doc);
      this.lastSafeState = Y.encodeStateAsUpdate(this.doc);
    } catch (e) {
      console.warn(`[room=${this.id}] fingerprint init failed:`, e.message);
    }
    this.loaded = true;
    // 起動時コンパクション: 初回 load で .bin が肥大化していたら即座に圧縮．
    // これで「サーバー再起動 = サイズリセット」の運用が成立．
    if (COMPACT_ON_STARTUP) {
      try {
        // 段階1: startup-compact も履歴を捨てるので，その前にロード直後の状態を保存．
        // サーバー再起動のたびに「起動時点の完全状態」が 1 世代残る．
        if (SNAPSHOTS_ENABLED) {
          await takeSnapshot(this.id, this.doc, {
            trigger: 'startup',
            retention: SNAPSHOT_RETENTION,
            mirrorDir: SNAPSHOT_MIRROR_DIR,
          }).catch(() => {});
        }
        const stat = await compactRoom(this.id, this.doc);
        // 確定ファイルサイズを記録（以降の肥大監視の基準）．
        this.fileBytes = stat.afterBytes;
        this.bytesSinceCompact = 0;
        if (stat.beforeBytes > stat.afterBytes) {
          console.log(
            `[room=${this.id}] startup-compact: ${stat.beforeBytes} → ${stat.afterBytes} bytes ` +
              `(${(stat.ratio * 100).toFixed(1)}%)`
          );
          getRoom(this.id).then((meta) => {
            if (meta?.auditLogging === 'on') {
              logEvent(this.id, {
                event: 'startup-compact',
                bytes: stat.afterBytes,
                reason: `from-${stat.beforeBytes}-bytes`,
              });
            }
          });
        }
      } catch (e) {
        console.error(`[room=${this.id}] startup-compact failed:`, e);
      }
    } else {
      // 起動コンパクト無効時も肥大監視の基準は必要．現在のファイルサイズを seed．
      try {
        this.fileBytes = await roomFileBytes(this.id);
        this.bytesSinceCompact = 0;
      } catch (e) {
        console.error(`[room=${this.id}] file-size probe failed:`, e);
      }
    }
  }

  /** おおよその現在ファイルサイズ（stat なしの推定値）． */
  approxFileBytes() {
    return this.fileBytes + this.bytesSinceCompact;
  }
}

function getOrCreateRoomInstance(id) {
  let r = rooms.get(id);
  if (!r) {
    r = new Room(id);
    rooms.set(id, r);
  }
  return r;
}

function send(ws, bytes) {
  if (ws.readyState === ws.OPEN) ws.send(bytes);
}

/** Sec-003/009 (2026-06-03): クライアントに role を通知．
 *  クライアント側はこの情報を元に viewer のとき編集 UI を disable する協調モデル．
 *  strict=true のときはサーバー側でも sync を block するので二段防御．
 *  未対応クライアントは MESSAGE_KJ_META を unknown として無視するだけ． */
function sendKjMeta(ws, ctx, room) {
  const meta = {
    kind: 'role-assigned',
    role: ctx.role,
    via: ctx.via,
    identity: ctx.email,
    strict: STRICT_VIEWER && ctx.role === 'viewer',
    serverVersion: '0.2.0',
    // CA3 (2026-06-09): matchedRule を追加 (verdict から transit)
    matchedRule: ctx.matchedRule,
    // v0.2.16: docEpoch (lineage generation). クライアントは保存済 epoch と
    // 不一致なら接続前に IndexedDB を破棄して download-only 同期する．
    // sendSyncStep1 より先に送られるので (TCP 順序保証)，クライアントは
    // SyncStep1 への reply 前に upload 抑止を同期的に決定できる．
    docEpoch: room?.epoch ?? null,
  };
  // CA2 (2026-06-09): legacy client (subprotocol kj-studio.v1 なし) には
  // upgradeRecommended を添付して banner 表示を促す．
  if (ctx.speaksKjStudio === false) {
    meta.upgradeRecommended = {
      reason: 'legacy-client',
      message: 'お使いのバージョンは古くなっています．v0.2.12 _viewer-v2 以降への更新を推奨します．',
      downloadHint: '管理者から最新版を入手してください．',
    };
  }
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_KJ_META);
  encoding.writeVarString(encoder, JSON.stringify(meta));
  send(ws, encoding.toUint8Array(encoder));
}

function sendSyncStep1(ws, room) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, room.doc);
  send(ws, encoding.toUint8Array(encoder));
  const states = Array.from(room.awareness.getStates().keys());
  if (states.length > 0) {
    const awEnc = encoding.createEncoder();
    encoding.writeVarUint(awEnc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awEnc,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, states)
    );
    send(ws, encoding.toUint8Array(awEnc));
  }
}

function handleMessage(ws, room, bytes) {
  // Sec-005: payload サイズ上限
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
    console.warn(`[room=${room.id}] payload too large (${bytes.byteLength} > ${MAX_PAYLOAD_BYTES}) — disconnect`);
    ws.close(1009, 'payload-too-large');
    return;
  }
  const decoder = decoding.createDecoder(bytes);
  const messageType = decoding.readVarUint(decoder);
  const role = ws.__kjctx?.role ?? 'editor';
  switch (messageType) {
    case MESSAGE_SYNC: {
      // Sec-003 + Sec-009 (2026-06-02 / 2026-06-03 更新):
      // 既定は協調モデル．viewer の Yjs sync を通し，UI 側で編集を disable する．
      // 理由: Yjs update を中身解析しないと「コメントか / 編集か」が判別できないため，
      // 一律 block するとコメント (Sec-009 要件) も止まる．
      // KJ_STRICT_VIEWER=true で strict モード．viewer の sync を完全 block する．
      // 将来コメントを別チャネル (REST or 専用 message type) にした時点で
      // strict が既定になる予定．
      if (role === 'viewer') {
        if (STRICT_VIEWER) {
          // strict: 完全 block．audit にも記録．
          console.warn(`[room=${room.id}] strict-viewer: drop sync from ${ws.__kjctx?.email}`);
          getRoom(room.id).then((m) => {
            if (m?.auditLogging === 'on') {
              logEvent(room.id, {
                event: 'viewer-write-rejected',
                user: ws.__kjctx?.email,
                nick: ws.__kjctx?.nick,
                role,
                bytes: bytes.byteLength,
                reason: 'strict-viewer',
              });
            }
          });
          return; // sync を block．awareness は別 case で通る
        }
        // 非 strict (協調モデル): audit に viewer-write を残して fall through
        getRoom(room.id).then((m) => {
          if (m?.auditLogging === 'on') {
            logEvent(room.id, {
              event: 'viewer-write',
              user: ws.__kjctx?.email,
              nick: ws.__kjctx?.nick,
              role,
              bytes: bytes.byteLength,
            });
          }
        });
        // fall through: viewer の write も通す
      }

      // Sec-005: クライアントあたりレート制限 (1 秒ウィンドウ)
      const now = Date.now();
      if (!ws.__rateWindow || now - ws.__rateWindow >= 1000) {
        ws.__rateWindow = now;
        ws.__rateCount = 0;
      }
      ws.__rateCount = (ws.__rateCount ?? 0) + 1;
      if (ws.__rateCount > MAX_UPDATES_PER_SECOND) {
        console.warn(`[room=${room.id}] rate limit exceeded by ${ws.__kjctx?.email} — disconnect`);
        ws.close(1008, 'rate-limit');
        return;
      }

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
      if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder));
      break;
    }
    case MESSAGE_AWARENESS: {
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        decoding.readVarUint8Array(decoder),
        ws
      );
      break;
    }
    case MESSAGE_KJ_META: {
      // クライアント → サーバー方向は現状未使用 (将来 hello / version 検出に使うかも)．
      // 受信したら drain だけして無視．
      try { decoding.readVarString(decoder); } catch {}
      break;
    }
    case MESSAGE_SEED_CLAIM: {
      // 対策3: 空ルームへの seed を 1 クライアントに限定する claim．
      let payload = {};
      try { payload = JSON.parse(decoding.readVarString(decoder)); } catch {}
      const clientId = payload?.clientId;
      // Codex#9: roomHasData をクライアント docHasData と揃えて厳格化する．
      // cards/groups だけでなく card_positions / group_memberships / metadata も見る
      // (部分破損・部分ロードで cards/groups だけ空になった状態を「空部屋」扱いして
      //  別クライアントの空 seed を許してしまう抜けを塞ぐ)．
      const tables = room.doc.getMap('tables');
      const meta = room.doc.getMap('metadata');
      const roomHasData =
        (tables.get('cards')?.length ?? 0) > 0 ||
        (tables.get('groups')?.length ?? 0) > 0 ||
        (tables.get('card_positions')?.length ?? 0) > 0 ||
        (tables.get('group_memberships')?.length ?? 0) > 0 ||
        (meta?.size ?? 0) > 0;
      const existing = seedClaims.get(room.id);
      const now = Date.now();
      const verdict = evaluateSeedClaim({
        role,
        roomHasData,
        existingClaim: existing ?? null,
        clientId,
        ttlMs: SEED_CLAIM_TTL_MS,
        now,
      });
      if (verdict.keepClaim) seedClaims.set(room.id, { clientId, ts: now });
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SEED_CLAIM);
      encoding.writeVarString(
        enc,
        JSON.stringify({ kind: 'seed-claim-result', granted: verdict.granted, reason: verdict.reason })
      );
      send(ws, encoding.toUint8Array(enc));
      break;
    }
    default:
      console.warn(`[room=${room.id}] unknown message type:`, messageType);
  }
}

// 段階2: アプリ内スナップショット UI 用 HTTP API (/api/snapshots)．
// Yjs 同期プロトコルには触れず，別経路の REST で create / list のみ提供する
// (restore は admin CLI 限定)．認証は WS と同じルームトークン (?t=) を流用．
function setSnapshotCors(req, res) {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin)) {
    // credentials は使わない (token は query) ので origin を echo で十分．
    res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** /api/snapshots を処理．該当しなければ false を返す． */
async function handleSnapshotApi(req, res, url) {
  if (url.pathname !== '/api/snapshots') return false;

  setSnapshotCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return true;
  }

  const roomId = url.searchParams.get('room') ?? '';
  const token = url.searchParams.get('t') ?? '';
  if (!isValidRoomId(roomId)) {
    sendJson(res, 400, { error: 'invalid-room-id' });
    return true;
  }

  // WS の upgrade と同じ IP 解決 + checkAccess でトークンを検証する．
  const ipInfo = resolveClientIp(req, cfg.network.trustedProxySources);
  const trustedProxyHeaderName = cfg.authPolicy.trustedProxyHeader ?? '';
  // Sec (2026-07-14 レビュー critical#2): trusted-proxy 認証ヘッダは，直接接続元
  // (socket.remoteAddress) が trustedProxySources の CIDR に属するときだけ採用する．
  // ipInfo.directIsTrusted を確認しないと，前段 proxy を経由しない位置 (LAN 隣接・
  // 同一ホスト別プロセス・SSRF) から X-Authenticated-User: <admin> を付けて admin へ
  // 昇格し破壊的 restore まで到達できる．未trusted ならヘッダを無視 (空扱い)．
  const trustedProxyUser = trustedProxyHeaderName && ipInfo.directIsTrusted
    ? (req.headers[trustedProxyHeaderName.toLowerCase()] ?? '').toString()
    : '';
  await ensureRoom(roomId, cfg.authPolicy);
  const verdict = await checkAccess(
    roomId,
    {
      email: url.searchParams.get('email') ?? '',
      token,
      password: url.searchParams.get('pw') ?? '',
      judgeIp: ipInfo.judgeIp,
      directIp: ipInfo.directIp,
      trustedProxyUser,
    },
    cfg.authPolicy
  );
  if (!verdict.allowed) {
    sendJson(res, 403, { error: 'forbidden', reason: verdict.reason });
    return true;
  }

  if (req.method === 'GET') {
    const items = await listSnapshots(roomId);
    sendJson(res, 200, { room: roomId, snapshots: items });
    return true;
  }

  // POST = 手動スナップショット作成 (editor / admin のみ)
  if (verdict.role !== 'editor' && verdict.role !== 'admin') {
    sendJson(res, 403, { error: 'editor-required', role: verdict.role });
    return true;
  }
  if (!SNAPSHOTS_ENABLED) {
    sendJson(res, 409, { error: 'snapshots-disabled' });
    return true;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { error: 'invalid-body' });
    return true;
  }
  const label = typeof body.label === 'string' ? body.label.slice(0, 200) : null;
  const author = verdict.identity ?? url.searchParams.get('email') ?? null;
  // レビュー rank9: restore 進行中はスナップショット作成 POST を弾く．弾かないと
  // getOrCreateRoomInstance が削除済み room を pre-restore .bin から復活させ，
  // rotateEpoch 前の旧 epoch を掴んで復元結果を巻き戻す (実運用で起きた stale 再注入)．
  // WS 接続は既に restoringRooms.has で弾いているが，この HTTP 経路は素通りしていた．
  if (restoringRooms.has(roomId)) {
    sendJson(res, 409, { error: 'room-restoring' });
    return true;
  }
  // ライブの Room doc を使う (未ロードなら loadRoom される)．
  const room = getOrCreateRoomInstance(roomId);
  await room.ensureLoaded();
  const entry = await takeSnapshot(roomId, room.doc, {
    trigger: 'manual',
    author,
    label,
    retention: SNAPSHOT_RETENTION,
    mirrorDir: SNAPSHOT_MIRROR_DIR,
  });
  sendJson(res, 200, { room: roomId, snapshot: entry });
  return true;
}

/** 対策5 (2026-07-03): POST /api/snapshots/restore．指定スナップショットへ復元する．
 *  editor/admin のみ．手順: pre-restore 退避 → 復元状態を .bin へ書き出し →
 *  ライブ room を落として epoch 更新 → クライアントは再接続で復元状態を取得する．
 *  該当しなければ false を返す． */
async function handleSnapshotRestoreApi(req, res, url) {
  if (url.pathname !== '/api/snapshots/restore') return false;
  setSnapshotCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method-not-allowed' }); return true; }

  const roomId = url.searchParams.get('room') ?? '';
  const id = url.searchParams.get('id') ?? '';
  const token = url.searchParams.get('t') ?? '';
  if (!isValidRoomId(roomId)) { sendJson(res, 400, { error: 'invalid-room-id' }); return true; }
  if (!id) { sendJson(res, 400, { error: 'missing-id' }); return true; }
  // Codex#4: id を厳格検証 (path traversal 防止)．
  if (!SNAPSHOT_ID_RE.test(id)) { sendJson(res, 400, { error: 'invalid-id' }); return true; }

  const ipInfo = resolveClientIp(req, cfg.network.trustedProxySources);
  const trustedProxyHeaderName = cfg.authPolicy.trustedProxyHeader ?? '';
  // Sec (2026-07-14 レビュー critical#2): trusted-proxy 認証ヘッダは，直接接続元
  // (socket.remoteAddress) が trustedProxySources の CIDR に属するときだけ採用する．
  // ipInfo.directIsTrusted を確認しないと，前段 proxy を経由しない位置 (LAN 隣接・
  // 同一ホスト別プロセス・SSRF) から X-Authenticated-User: <admin> を付けて admin へ
  // 昇格し破壊的 restore まで到達できる．未trusted ならヘッダを無視 (空扱い)．
  const trustedProxyUser = trustedProxyHeaderName && ipInfo.directIsTrusted
    ? (req.headers[trustedProxyHeaderName.toLowerCase()] ?? '').toString()
    : '';
  await ensureRoom(roomId, cfg.authPolicy);
  const verdict = await checkAccess(
    roomId,
    {
      email: url.searchParams.get('email') ?? '',
      token,
      password: url.searchParams.get('pw') ?? '',
      judgeIp: ipInfo.judgeIp,
      directIp: ipInfo.directIp,
      trustedProxyUser,
    },
    cfg.authPolicy
  );
  if (!verdict.allowed) { sendJson(res, 403, { error: 'forbidden', reason: verdict.reason }); return true; }
  // Codex#6: restore は全員に影響する破壊的管理操作なので admin 限定 (editor 不可)．
  if (verdict.role !== 'admin') {
    sendJson(res, 403, { error: 'admin-required', role: verdict.role });
    return true;
  }
  // Codex#1: 同一 room の restore を排他する．
  if (restoringRooms.has(roomId)) {
    sendJson(res, 409, { error: 'restore-in-progress' });
    return true;
  }
  restoringRooms.add(roomId);
  try {
    // 1) 現状態を pre-restore スナップショットで退避 (restore 自体を取り消せるように)．
    const room = getOrCreateRoomInstance(roomId);
    await room.ensureLoaded();
    await takeSnapshot(roomId, room.doc, {
      trigger: 'pre-restore',
      author: verdict.identity ?? null,
      label: `before restore ${id}`,
      retention: SNAPSHOT_RETENTION,
      mirrorDir: SNAPSHOT_MIRROR_DIR,
    }).catch(() => {});

    // 2) 復元対象スナップショットを展開．
    let stateUpdate;
    try {
      stateUpdate = await restoreSnapshot(roomId, id);
    } catch (e) {
      sendJson(res, 404, { error: 'snapshot-not-found', id });
      return true;
    }
    const restoredDoc = new Y.Doc();
    Y.applyUpdate(restoredDoc, stateUpdate);

    // 3) ライブ room を落とす．Codex#1: まず doc.on('update') を無効化 (detached) して
    //    以後の persistUpdate/構造解析を止め，接続を閉じ Map から除去する．新規接続は
    //    restoringRooms により弾かれるので，この間 .bin へ書き込むのは下の restore だけ．
    const live = rooms.get(roomId);
    if (live) {
      live.detached = true;
      for (const ws of live.clients) {
        try { ws.close(CLOSE_CODE.ROOM_RESTORED, 'room-restored'); } catch {}
      }
      rooms.delete(roomId);
    }

    // 4) .bin を退避 → 復元状態を書き出し → epoch 更新．compactRoom / persistUpdate は
    //    persistence の per-room IO chain 経由なので，直前までに enqueue された旧 append
    //    が先に流れ切ってから復元状態で上書きされる (順序保証)．
    try {
      await backupRoomFile(roomId, `prerestore-${id}`);
      await compactRoom(roomId, restoredDoc);
      await rotateEpoch(roomId);
    } catch (e) {
      console.error(`[room=${roomId}] restore write failed:`, e);
      sendJson(res, 500, { error: 'restore-write-failed', message: e.message });
      return true;
    }
    console.log(
      `[room=${roomId}] snapshot restored: ${id} by ${verdict.identity ?? 'admin'} — epoch rotated, clients must reconnect`
    );
    getRoom(roomId).then((meta) => {
      if (meta?.auditLogging === 'on') {
        logEvent(roomId, { event: 'snapshot-restore', user: verdict.identity, snapshotId: id });
      }
    });
    sendJson(res, 200, { restored: true, id, epochRotated: true });
    return true;
  } finally {
    restoringRooms.delete(roomId);
  }
}

// Sec-004 (2026-06-02): App server (公開 WS) は /admin を返さない．admin は別ポート．
const appHttpServer = createServer(async (req, res) => {
  try {
    // 公開側で /admin* を完全に遮断（Cloudflare tunnel 経由で admin が外に出るのを防ぐ）
    if ((req.url ?? '').startsWith('/admin')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (reqUrl.pathname === '/api/snapshots/restore') {
      const handled = await handleSnapshotRestoreApi(req, res, reqUrl);
      if (handled) return;
    }
    if (reqUrl.pathname === '/api/snapshots') {
      const handled = await handleSnapshotApi(req, res, reqUrl);
      if (handled) return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Affinity Mapping Studio Server is running. WebSocket: ws://host:' + PORT + '/<roomId>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (e) {
    console.error('[http] handler error:', e);
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal Server Error');
  }
});

// Sec-004 (2026-06-02): admin 専用 server．既定で 127.0.0.1 にしか bind しない．
const adminHttpServer = createServer(async (req, res) => {
  try {
    if ((req.url ?? '').startsWith('/admin')) {
      const handled = await handleAdminRequest(req, res);
      if (handled) return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Affinity Mapping Studio Server admin (local-only)');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (e) {
    console.error('[admin-http] handler error:', e);
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal Server Error');
  }
});

// Sec-005: maxPayload で巨大 frame を弾く．
// Sec-008 Layer 1: handleProtocols で client が kj-studio/1 を offer したら echo back．
// 返り値:
//   - 'kj-studio/1' → response header にこれを設定して accept
//   - false         → upgrade を reject (RFC 6455 4.4)
//   - ''            → response header を付けずに accept （legacy 互換）
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD_BYTES,
  handleProtocols: (protocols /* Set<string> */) => {
    if (protocols.has(ACCEPTED_PROTOCOL)) return ACCEPTED_PROTOCOL;
    // ここに来るのは「kj-studio/1 を含まない」ケース．
    // 厳格モード時は上位の upgrade handler が既に 400 で reject しているため，
    // ここで false を返すと「上位で通したのに最後の最後で reject」になり混乱の元．
    // 一律 '' (= header 無しで accept) で逃がす．移行期はこの挙動が必要．
    return '';
  },
});

/** Sec-008 Layer 2: Origin allowlist check．
 *  - Origin ヘッダ無し / 'null' → 通す (native Tauri / Node.js / curl)
 *  - 完全一致で ALLOWED_ORIGINS にあれば通す
 *  - localhost / 127.0.0.1 / 0.0.0.0 で始まる場合は任意ポートで通す (開発用便宜)
 *  - それ以外（公開 URL からのブラウザ等）は拒否 */
function isOriginAllowed(originRaw) {
  if (originRaw == null || originRaw === '' || originRaw === 'null') {
    return ALLOW_EMPTY_ORIGIN;
  }
  if (ALLOWED_ORIGINS.has(originRaw)) return true;
  if (ALLOW_LOCALHOST_ANY_PORT) {
    // localhost or 127.0.0.1 or 0.0.0.0 prefix で，scheme は http/https/ws/wss
    if (
      /^(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/i.test(
        originRaw
      )
    ) {
      return true;
    }
  }
  return false;
}

// CA1 (2026-06-09): WS close code map (server → client への reason 細分化)
// 4xxx range は WebSocket RFC で application-defined．client は code/reason を取得可能．
const CLOSE_CODE = {
  INVALID_TOKEN: 4001,
  TOKEN_EXPIRED: 4002,
  TOKEN_EXHAUSTED: 4003,
  INVALID_PASSWORD: 4004,
  ROOM_NOT_FOUND: 4005,
  INVALID_ROOM_ID: 4006,
  REQUIREMENT_GROUP_FAILED: 4007,
  ROOM_FULL: 4008,
  RATE_LIMIT: 4009,
  FORBIDDEN_ORIGIN: 4010,
  UNSUPPORTED_PROTOCOL: 4011,
  ROOM_RESTORED: 4012,
  UNAUTHORIZED: 4999,
};

/** verdict.reason → close code マッピング (4xxx 範囲) */
function reasonToCloseCode(reason) {
  switch (reason) {
    case 'invalid-token': return CLOSE_CODE.INVALID_TOKEN;
    case 'token-expired': return CLOSE_CODE.TOKEN_EXPIRED;
    case 'token-exhausted': return CLOSE_CODE.TOKEN_EXHAUSTED;
    case 'invalid-password': return CLOSE_CODE.INVALID_PASSWORD;
    case 'room-not-found': return CLOSE_CODE.ROOM_NOT_FOUND;
    case 'invalid-room-id': return CLOSE_CODE.INVALID_ROOM_ID;
    case 'requirement-group-failed': return CLOSE_CODE.REQUIREMENT_GROUP_FAILED;
    default: return CLOSE_CODE.UNAUTHORIZED;
  }
}

/** CA1: upgrade 受け入れて即 close(4xxx, reason) でクライアントに reason を伝える．
 *  reasonDetail: failedGroups 等の追加情報をコロン区切りで付与 (任意)． */
function rejectUpgrade(req, socket, head, code, reason, reasonDetail) {
  const fullReason = reasonDetail ? `${reason}:${reasonDetail}` : reason;
  // ws.close の reason は最大 123 バイトに制限される
  const trimmed = fullReason.slice(0, 120);
  try {
    wss.handleUpgrade(req, socket, head, (ws) => {
      try { ws.close(code, trimmed); } catch {}
    });
  } catch (e) {
    // handleUpgrade が失敗したら従来の socket.write フォールバック
    try {
      socket.write(`HTTP/1.1 401 ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    } catch {}
  }
}

appHttpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const rawRoomId = url.pathname.replace(/^\/+/, '');

  // Sec-008 Layer 2: Origin allowlist (公開トンネル経由のブラウザ攻撃を弾く)
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin)) {
    console.warn(`[upgrade] forbidden origin: ${JSON.stringify(origin)}`);
    rejectUpgrade(req, socket, head, CLOSE_CODE.FORBIDDEN_ORIGIN, 'forbidden-origin');
    return;
  }

  // Sec-008 Layer 1: WebSocket subprotocol kj-studio/1 を要求．
  // 既定 (REQUIRE_KJ_STUDIO_PROTOCOL=false) は legacy v0.2.x クライアント
  // (subprotocol を送らない) も許容．true ならば必須．
  const protocolHeader = req.headers['sec-websocket-protocol'] ?? '';
  const offeredProtocols = protocolHeader
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const clientSpeaksKjStudio = offeredProtocols.includes(ACCEPTED_PROTOCOL);
  if (REQUIRE_KJ_STUDIO_PROTOCOL && !clientSpeaksKjStudio) {
    console.warn(
      `[upgrade] missing required subprotocol; offered=${JSON.stringify(offeredProtocols)}`
    );
    rejectUpgrade(req, socket, head, CLOSE_CODE.UNSUPPORTED_PROTOCOL, 'unsupported-protocol');
    return;
  }

  // Sec-001: room ID を validate．不正なら 400．
  if (!isValidRoomId(rawRoomId)) {
    console.warn(`[upgrade] invalid room id: ${JSON.stringify(rawRoomId)}`);
    rejectUpgrade(req, socket, head, CLOSE_CODE.INVALID_ROOM_ID, 'invalid-room-id');
    return;
  }
  const roomId = rawRoomId;
  const email = url.searchParams.get('email') ?? '';
  const nick = url.searchParams.get('nick') ?? '';
  // Sec-111 (2026-06-03): URL クエリ ?t=<token> で room-token を渡す
  const token = url.searchParams.get('t') ?? '';
  // Sec-111: room-password は URL クエリ ?pw=<password>．URL log に残るので最小限の用途．
  const password = url.searchParams.get('pw') ?? '';
  // R2 (2026-06-09): XFF trust 境界．resolveClientIp で directIp / judgeIp / rateLimitKey を分離．
  const ipInfo = resolveClientIp(req, cfg.network.trustedProxySources);
  const ip = ipInfo.judgeIp; // 認証判定用 (Tailscale / ipCidr / etc)
  // Sec-111: trusted-proxy header (R5: resolved config 経由)
  const trustedProxyHeaderName = cfg.authPolicy.trustedProxyHeader ?? '';
  // Sec (2026-07-14 レビュー critical#2): trusted-proxy 認証ヘッダは，直接接続元
  // (socket.remoteAddress) が trustedProxySources の CIDR に属するときだけ採用する．
  // ipInfo.directIsTrusted を確認しないと，前段 proxy を経由しない位置 (LAN 隣接・
  // 同一ホスト別プロセス・SSRF) から X-Authenticated-User: <admin> を付けて admin へ
  // 昇格し破壊的 restore まで到達できる．未trusted ならヘッダを無視 (空扱い)．
  const trustedProxyUser = trustedProxyHeaderName && ipInfo.directIsTrusted
    ? (req.headers[trustedProxyHeaderName.toLowerCase()] ?? '').toString()
    : '';

  // Sec-005: IP ごとの同時接続数上限 (rateLimitKey 経由 — DoS 偽装防御)
  const ipCount = connectionsByIp.get(ipInfo.rateLimitKey) ?? 0;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) {
    console.warn(`[upgrade] too many connections from ${ipInfo.rateLimitKey} (${ipCount}/${MAX_CONNECTIONS_PER_IP})`);
    rejectUpgrade(req, socket, head, CLOSE_CODE.RATE_LIMIT, 'rate-limit');
    return;
  }

  (async () => {
    try {
      // Sec-006: ensureRoom は既定で null を返す (未知 room は作らない)．
      // R5: serverAuthPolicy を渡して env 直読みを廃止．
      const meta = await ensureRoom(roomId, cfg.authPolicy);
      // R1+A1+A2 (2026-06-09): authPolicy を渡して policy-driven checkAccess
      const verdict = await checkAccess(roomId, {
        email,
        token,
        password,
        judgeIp: ipInfo.judgeIp,    // R2: auth 判定用
        directIp: ipInfo.directIp,   // R3: localhost-auto 判定用 (XFF 無視)
        trustedProxyUser,
      }, cfg.authPolicy);
      if (!verdict.allowed) {
        // meta が null の場合は audit ログを残せないので console のみ
        if (meta?.auditLogging === 'on') {
          logEvent(roomId, {
            event: 'auth-denied',
            user: email,
            nick,
            ip,
            reason: verdict.reason,
            failedGroups: verdict.failedGroups,
            satisfied: verdict.satisfied,
          });
        }
        console.warn(
          `[room=${roomId}] auth denied (${verdict.reason}) email=${email}`
        );
        // CA1: failedGroups から detail を生成 (例: 'requirement-group-failed:inviteToken|roomPassword')
        let detail = '';
        if (verdict.reason === 'requirement-group-failed' && verdict.failedGroups?.length) {
          detail = verdict.failedGroups[0].join('|');
        }
        rejectUpgrade(req, socket, head, reasonToCloseCode(verdict.reason), verdict.reason ?? 'unauthorized', detail);
        return;
      }

      // Sec-005: room ごとの同時接続数上限
      const existingRoom = rooms.get(roomId);
      const roomConnCount = existingRoom ? existingRoom.clients.size : 0;
      if (roomConnCount >= MAX_CONNECTIONS_PER_ROOM) {
        console.warn(`[room=${roomId}] full (${roomConnCount}/${MAX_CONNECTIONS_PER_ROOM})`);
        rejectUpgrade(req, socket, head, CLOSE_CODE.ROOM_FULL, 'room-full');
        return;
      }

      req.__kjAuth = {
        roomId,
        email: verdict.identity ?? email,  // token 認証時は invitation の email を使う
        nick,
        ip,                           // judgeIp (auth 判定済 IP)
        rateLimitKey: ipInfo.rateLimitKey,  // R2: DoS 上限用
        rawXff: ipInfo.xffRaw,         // R2: audit 用
        role: verdict.role,
        via: verdict.via,
        matchedRule: verdict.matchedRule,  // CA3: client に通知
        meta,
        speaksKjStudio: clientSpeaksKjStudio,  // CA2: legacy 検出用
      };
      // Sec-008 Layer 1: クライアントが kj-studio/1 を offer したら echo back．
      // RFC 6455 では server が Sec-WebSocket-Protocol response を返さなければ
      // クライアント側は protocol を選択していない扱い．
      // ws ライブラリは upgrade レスポンス時に req.headers から自動的に選ぶが，
      // 念のため明示的に処理してログを残せるようにする．
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (e) {
      console.error(`[room=${roomId}] verifyClient error:`, e);
      try {
        socket.write('HTTP/1.1 500 server error\r\nConnection: close\r\n\r\n');
      } catch {/* ignore */}
      socket.destroy();
    }
  })();
});

// レビュー rank8: プロセス全体の安全網．想定外の unhandledRejection /
// uncaughtException で全 room を巻き添えにプロセスが落ちるのを防ぐ．fail-loud で
// 可視化しつつプロセスは継続する (単一の破損 room / 一過性 fs 例外で全体を落とさない)．
process.on('unhandledRejection', (reason) => {
  failLoud('process', 'unhandledRejection (プロセスは継続)', reason);
});
process.on('uncaughtException', (err) => {
  failLoud('process', 'uncaughtException (プロセスは継続)', err);
});

// Sec-103: 起動時状態 banner を表示．設定の整合性警告も同時に出す．
// R5: cfg は bootConfig() で読込済．banner を出すだけ
printStartupBanner(cfg);

appHttpServer.listen(PORT, APP_BIND_HOST, () => {
  console.log(`[Affinity Mapping Studio Server] app listening on http://${APP_BIND_HOST}:${PORT}`);
  console.log(`  WebSocket: ws://<host>:${PORT}/<roomId>`);
  console.log(`  /admin* is BLOCKED on this port (admin is on separate port)`);
  console.log(`  Sec-008 subprotocol required: ${REQUIRE_KJ_STUDIO_PROTOCOL ? 'YES (kj-studio.v1)' : 'no (legacy)'}`);
  console.log(`  Sec-008 origin allowlist: ${ALLOWED_ORIGINS.size} fixed origins + localhost:any`);
  console.log(
    `  Auto-compact: on-startup=${COMPACT_ON_STARTUP}, after-updates=${COMPACT_AFTER_UPDATES}, ` +
      `after-bytes=${COMPACT_AFTER_BYTES}`
  );
  console.log(
    `  Bloat warnings: single-update>${WARN_UPDATE_BYTES}B, file>${WARN_FILE_BYTES}B`
  );
  console.log(`  Sec-003 strict viewer: ${STRICT_VIEWER ? 'YES (sync blocked for viewer role)' : 'no (cooperative; UI gate on client)'}`);
});

adminHttpServer.listen(ADMIN_PORT, ADMIN_BIND_HOST, () => {
  if (isAdminConfigured()) {
    console.log(`[Affinity Mapping Studio Server] admin listening on http://${ADMIN_BIND_HOST}:${ADMIN_PORT}`);
    console.log(`  Admin UI:  http://${ADMIN_BIND_HOST}:${ADMIN_PORT}/admin (Bearer token required)`);
  } else {
    console.log(`[Affinity Mapping Studio Server] admin disabled (set KJ_ADMIN_TOKEN to enable)`);
  }
});

// 段階1: 時間トリガのスナップショット．T 分ごとに，前回スナップショット以降に
// 変更のあった (dirtySinceSnapshot) room だけ完全状態を保存する．
// unref() でこのタイマーがプロセス終了を妨げないようにする．
if (SNAPSHOTS_ENABLED && SNAPSHOT_EVERY_MINUTES > 0) {
  const intervalMs = SNAPSHOT_EVERY_MINUTES * 60 * 1000;
  const timer = setInterval(() => {
    for (const room of rooms.values()) {
      if (!room.loaded || !room.dirtySinceSnapshot) continue;
      room.dirtySinceSnapshot = false;
      room.snapshotOpCounter = 0;
      takeSnapshot(room.id, room.doc, {
        trigger: 'time',
        retention: SNAPSHOT_RETENTION,
        mirrorDir: SNAPSHOT_MIRROR_DIR,
      }).catch(() => {});
    }
  }, intervalMs);
  timer.unref();
}

wss.on('connection', async (ws, req) => {
  const auth = req.__kjAuth;
  if (!auth) {
    // Shouldn't happen — verifyClient always sets this on success.
    ws.close(1011, 'no auth context');
    return;
  }
  const { roomId, email, nick, ip, rateLimitKey, rawXff, role, via, meta, speaksKjStudio, matchedRule } = auth;

  // Tag for audit + future role enforcement (CA2/CA3 で speaksKjStudio/matchedRule も保持)
  ws.__kjctx = { email, nick, ip, rateLimitKey, rawXff, role, via, speaksKjStudio, matchedRule };

  // Codex#1: restore 進行中の room への新規接続は弾く (書き込み中の .bin を再ロード
  // してしまう競合を防ぐ)．クライアントは 4012 を受けて再接続し復元状態を取得する．
  if (restoringRooms.has(roomId)) {
    try { ws.close(CLOSE_CODE.ROOM_RESTORED, 'room-restoring'); } catch {}
    return;
  }

  // レビュー rank8: ensureLoaded は loadRoom で破損 .bin / fs 例外により throw し得る．
  // 裸で await すると unhandledRejection でプロセス全体が落ち，全 room の共同編集が
  // 巻き添え切断される (this.loaded は false のままなので再接続で再クラッシュ)．
  // この接続だけを閉じて他 room を守る．
  let room;
  try {
    room = getOrCreateRoomInstance(roomId);
    await room.ensureLoaded();
  } catch (err) {
    failLoud('connection', `room=${roomId} ensureLoaded 失敗 — この接続のみ切断`, err);
    try { ws.close(1011, 'room-load-failed'); } catch {}
    return;
  }
  room.clients.add(ws);
  incIpCount(rateLimitKey); // R2: DoS は rateLimitKey で
  console.log(
    `[room=${roomId}] connect: nick=${nick} email=${email} role=${role} via=${via ?? 'unknown'} total=${room.clients.size}` +
      (speaksKjStudio === false ? ' [legacy-client]' : '')
  );
  if (meta.auditLogging === 'on') {
    logEvent(roomId, {
      event: 'connect',
      user: email,
      nick,
      ip,
      rawXff: rawXff || undefined, // R2: audit に生 XFF 保存
      role,
      legacyClient: speaksKjStudio === false || undefined,
    });
  }
  // CA2: legacy client console.warn (audit + banner と共通フォーマット)
  if (speaksKjStudio === false) {
    console.warn(
      `[room=${roomId}] legacy client (no kj-studio.v1 subprotocol) from ${ip} email=${email} — recommend v0.2.12 _viewer-v2 update`
    );
  }

  ws.binaryType = 'arraybuffer';

  // #132: 'error' リスナーが無いと maxPayload 超過 (WS_ERR_UNSUPPORTED_MESSAGE_LENGTH 等) で
  // unhandled 'error' event になり node process ごと crash する．ws は error 後に自分で
  // close(1009) するので，ここではログのみ．後始末は 'close' ハンドラに任せる．
  ws.on('error', (err) => {
    console.error(`[room=${roomId}] ws error: nick=${nick} email=${email} — ${err.message}`);
    if (meta.auditLogging === 'on') {
      logEvent(roomId, { event: 'ws-error', user: email, nick, ip, error: err.message });
    }
  });

  ws.on('message', (data) => {
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
      handleMessage(ws, room, bytes);
    } catch (e) {
      console.error(`[room=${roomId}] message error:`, e);
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    decIpCount(rateLimitKey); // R2: incIpCount と対応
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      [...room.awareness.getStates().keys()].filter(
        (k) => room.awareness.getStates().get(k)?._clientId === ws
      ),
      ws
    );
    console.log(
      `[room=${roomId}] disconnect: nick=${nick} email=${email} total=${room.clients.size}`
    );
    // Re-check meta in case auditLogging was toggled while connected
    getRoom(roomId).then((m) => {
      if (m?.auditLogging === 'on') {
        logEvent(roomId, { event: 'disconnect', user: email, nick, ip });
      }
    });
  });

  // 5. Sec-003/009: クライアントへロール通知 (新クライアント向け)．
  //    旧クライアントは unknown message type として無視するだけなので互換性 OK．
  sendKjMeta(ws, ws.__kjctx, room);

  // 6. Initial sync handshake
  sendSyncStep1(ws, room);
});
