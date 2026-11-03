#!/usr/bin/env node
// kj-admin — management CLI for Affinity Mapping Studio Server (旧名: kj-trace-server).
//
// 全コマンド:
//   room list
//   room create <id> [--name NAME] [--audit on|off] [--access open|invite_list]
//   room set <id> [--name NAME] [--audit on|off] [--access open|invite_list]
//   room delete <id>
//   room show <id>
//   invite <roomId> <email> [--role editor|viewer|admin] [--expires-at ISO] [--max-uses N]
//   revoke <roomId> <email>
//   rotate <roomId> <email>                   token を再発行
//   url <roomId> <email> [--host wss://...]   招待 URL を出力 (token 込)
//   password <roomId> [<password>]            ルーム共通パスワード設定．省略で削除
//   audit <roomId> [--since YYYY-MM-DD] [--csv path] [--tail N]
//   snapshot list <roomId>                     スナップショット一覧
//   snapshot create <roomId> [--label L]       手動スナップショット作成
//   snapshot restore <roomId> <id>             スナップショットへ復元 (要再起動)
//   preset list                                利用可能なプリセット一覧
//   preset show                                現在の設定
//   preset set <name>                          プリセットを切替 (要再起動)
//   scrap list                                 scrap/ の中身一覧
//   scrap purge <archive-name>                 完全削除 (要 --confirm)
//   token gen                                  admin token を再生成 (要 --confirm)
//   help
//
// Sec-011 で計画した CLI ツールの実装．Win/Mac/Linux で `node bin/kj-admin.js ...`
// または `npm run admin -- ...` で動く．

import {
  listRooms,
  getRoom,
  createRoom,
  setRoomOptions,
  inviteEmail,
  revokeEmail,
  deleteRoom,
  rotateInviteToken,
  setRoomPassword,
  inferAuthPolicy,
} from '../src/rooms.js';
import { exportCsv, readEvents } from '../src/audit.js';
import { loadServerConfig, applyExposurePreset, EXPOSURE_PRESETS, bootConfig } from '../src/config.js';
import { spawnTunnel, killTunnel, getTunnelStatus, detectCloudflared } from '../src/tunnel.js';
import { loadRoom, rotateEpoch } from '../src/persistence.js';
import { listSnapshots, takeSnapshot, restoreSnapshot } from '../src/snapshots.js';
import * as Y from 'yjs';
import { writeFile, readdir, stat, rmdir, unlink, mkdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, '..');
const DATA_DIR = join(SERVER_ROOT, 'data');
const SCRAP_DIR = join(DATA_DIR, 'scrap');
const CONFIG_DIR = join(SERVER_ROOT, 'config');
const TOKEN_PATH = join(CONFIG_DIR, 'admin-token.txt');

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function printHelp() {
  process.stdout.write(`kj-admin — Affinity Mapping Studio Server 管理 CLI

Room 管理:
  room list
  room show <id>
  room create <id> [--name NAME] [--audit on|off] [--access open|invite_list]
  room set <id> [--name NAME] [--audit on|off] [--access open|invite_list]
  room delete <id>                  ※データは data/scrap/ にアーカイブされる

招待・認証:
  invite <roomId> <email> [--role editor|viewer|admin]
                          [--expires-at ISO] [--max-uses N]
  revoke <roomId> <email>
  rotate <roomId> <email>           token を再発行 (旧 token は無効化)
  url <roomId> <email> [--host wss://example/]
                                    招待 URL を組み立て stdout に出力
  password <roomId> [<password>]    ルーム共通パスワード．省略で削除

監査ログ:
  audit <roomId> [--since YYYY-MM-DD] [--tail N] [--csv path]

公開方式プリセット:
  preset list                       8 種類のプリセット表示
  preset show                       現在の設定 + 警告表示
  preset set <name>                 切替 (config/server.json 書き換え．要再起動)

設定確認 (R5):
  config show                       resolved config (preset / network / authPolicy / source) 表示

Cloudflare Tunnel (R8):
  tunnel start [--target app|custom] [--port N]   起動 (admin port は拒否)
  tunnel stop                                      停止 (SIGTERM → SIGKILL fallback)
  tunnel status                                    起動中の URL / PID / target
  tunnel url                                       URL のみ出力

認証ポリシー per-room (R1):
  auth <roomId>                                    raw + effective マトリクス表示
  auth <roomId> --show                             同上 (明示)
  auth <roomId> --method <name> --state on|off|inherit  per-room 認証方式切替
                                                   method: inviteToken / roomPassword /
                                                          trustedProxy / tailscale /
                                                          ipCidr / emailLegacy /
                                                          noneOpen / localhostAuto

スナップショット (段階1・データ破損復旧用):
  snapshot list <roomId>            保存済みスナップショット一覧 (新しい順)
  snapshot create <roomId> [--label L]   手動でスナップショットを 1 件作成
  snapshot restore <roomId> <id>    指定スナップショットへ復元 (現 .bin は .bak 退避
                                    + epoch 更新．反映にはサーバー再起動が必要)

データ管理:
  scrap list                        data/scrap/ の中身
  scrap purge <archive-name> --confirm   完全削除

セキュリティ:
  token gen --confirm               admin token を 32-byte ランダムで再生成

例:
  kj-admin room create kjlab2026 --name "KJ Lab" --audit on --access invite_list
  kj-admin invite kjlab2026 alice@uni.ac.jp --role editor --max-uses 1
  kj-admin url kjlab2026 alice@uni.ac.jp --host wss://kj.example.com
  kj-admin audit kjlab2026 --since 2026-06-01 --csv ./audit.csv
  kj-admin preset set tailscale-serve
`);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
  printHelp();
  process.exit(0);
}

const [cmd, ...rest] = argv;
const { flags, positional } = parseFlags(rest);

function fmtBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

try {
  switch (cmd) {
    case 'room': {
      const sub = positional.shift();
      switch (sub) {
        case 'list': {
          const rooms = await listRooms();
          if (rooms.length === 0) { console.log('(no rooms)'); break; }
          for (const r of rooms) {
            console.log(
              `${r.id}\tname="${r.name}"\taudit=${r.auditLogging}\taccess=${r.accessControl}` +
              `\tinvitations=${r.invitations.length}\tpwd=${r.passwordHash ? 'yes' : 'no'}\tcreated=${r.createdAt}`
            );
          }
          break;
        }
        case 'show': {
          const id = positional[0];
          if (!id) throw new Error('room id required');
          const r = await getRoom(id);
          if (!r) { console.log(`no such room: ${id}`); process.exitCode = 1; break; }
          console.log(JSON.stringify(r, null, 2));
          break;
        }
        case 'create': {
          const id = positional[0];
          if (!id) throw new Error('room id required');
          const r = await createRoom(id, {
            name: flags.name,
            auditLogging: flags.audit,
            accessControl: flags.access,
          });
          console.log(`created room ${r.id} (audit=${r.auditLogging}, access=${r.accessControl})`);
          break;
        }
        case 'set': {
          const id = positional[0];
          if (!id) throw new Error('room id required');
          const r = await setRoomOptions(id, {
            name: flags.name,
            auditLogging: flags.audit,
            accessControl: flags.access,
          });
          console.log(`updated room ${r.id} (audit=${r.auditLogging}, access=${r.accessControl})`);
          break;
        }
        case 'delete': {
          const id = positional[0];
          if (!id) throw new Error('room id required');
          const result = await deleteRoom(id);
          if (!result.removedMetadata) {
            console.log(`no such room: ${id}`);
            process.exitCode = 1;
          } else {
            console.log(`deleted room ${id}, archived to: ${result.archivedPath}`);
          }
          break;
        }
        default:
          printHelp();
          process.exitCode = 1;
      }
      break;
    }

    case 'invite': {
      const roomId = positional[0];
      const email = positional[1];
      if (!roomId || !email) throw new Error('usage: invite <roomId> <email>');
      const opts = {};
      if (flags['expires-at']) opts.expiresAt = flags['expires-at'];
      if (flags['max-uses']) opts.maxUses = Number(flags['max-uses']);
      const r = await inviteEmail(roomId, email, flags.role ?? 'editor', opts);
      const inv = r.invitations.find((i) => i.email.toLowerCase() === email.toLowerCase());
      console.log(`invited ${email} to ${roomId} (role=${inv?.role}, token=${inv?.token?.slice(0, 8)}…)`);
      if (inv?.expiresAt) console.log(`  expires: ${inv.expiresAt}`);
      if (inv?.maxUses != null) console.log(`  max-uses: ${inv.maxUses} (used: ${inv.usedCount ?? 0})`);
      console.log(`  total invitations now: ${r.invitations.length}`);
      break;
    }

    case 'revoke': {
      const roomId = positional[0];
      const email = positional[1];
      if (!roomId || !email) throw new Error('usage: revoke <roomId> <email>');
      const result = await revokeEmail(roomId, email);
      console.log(result.removed ? `revoked ${email} from ${roomId}` : `email not found: ${email}`);
      break;
    }

    case 'rotate': {
      const roomId = positional[0];
      const email = positional[1];
      if (!roomId || !email) throw new Error('usage: rotate <roomId> <email>');
      const result = await rotateInviteToken(roomId, email);
      console.log(`new token: ${result.newToken}`);
      console.log(result.hadOldToken ? '(old token revoked)' : '(no previous token)');
      break;
    }

    case 'url': {
      const roomId = positional[0];
      const email = positional[1];
      if (!roomId || !email) throw new Error('usage: url <roomId> <email> [--host wss://...]');
      const room = await getRoom(roomId);
      if (!room) throw new Error(`no such room: ${roomId}`);
      const inv = room.invitations.find((i) => i.email.toLowerCase() === email.toLowerCase());
      if (!inv) throw new Error(`no invitation for ${email} in ${roomId}`);
      if (!inv.token) throw new Error('invitation has no token (rotate first)');
      const host = (flags.host ?? 'wss://YOUR-HOST').replace(/\/$/, '');
      const nick = encodeURIComponent(email.split('@')[0]);
      const url = `${host}/${encodeURIComponent(roomId)}?t=${inv.token}&nick=${nick}`;
      console.log(url);
      break;
    }

    case 'password': {
      const roomId = positional[0];
      const password = positional[1] ?? '';
      if (!roomId) throw new Error('usage: password <roomId> [<password>]  (空でパスワード削除)');
      const result = await setRoomPassword(roomId, password);
      console.log(result.hasPassword
        ? `password set for ${roomId}`
        : `password removed from ${roomId}`);
      break;
    }

    case 'audit': {
      const roomId = positional[0];
      if (!roomId) throw new Error('usage: audit <roomId>');
      const since = flags.since ?? null;
      const tail = flags.tail ? Number(flags.tail) : 20;
      if (flags.csv) {
        const csv = await exportCsv(roomId, since);
        await writeFile(flags.csv, csv, 'utf-8');
        const lineCount = csv.split('\n').length - 2;
        console.log(`wrote ${lineCount} events to ${flags.csv}`);
      } else {
        const events = await readEvents(roomId);
        const filtered = since ? events.filter((e) => e.ts >= since) : events;
        if (filtered.length === 0) { console.log('(no events)'); break; }
        for (const e of filtered.slice(-tail)) {
          console.log(
            `${e.ts}\t${e.event}\tuser=${e.user ?? '-'}\tnick=${e.nick ?? '-'}\trole=${e.role ?? '-'}\tbytes=${e.bytes ?? '-'}\treason=${e.reason ?? '-'}`
          );
        }
        if (filtered.length > tail) {
          console.log(`... (showing last ${tail} of ${filtered.length}; use --tail N or --csv to export all)`);
        }
      }
      break;
    }

    case 'preset': {
      const sub = positional.shift();
      switch (sub) {
        case 'list': {
          for (const [name, p] of Object.entries(EXPOSURE_PRESETS)) {
            console.log(`${name.padEnd(22)} ${p.label}`);
            console.log(`${' '.repeat(22)} ${p.description}`);
            if (p.requireAuth) console.log(`${' '.repeat(22)} (認証必須)`);
          }
          break;
        }
        case 'show': {
          const cfg = await loadServerConfig();
          console.log(`preset: ${cfg.preset.name}  (${cfg.preset.label ?? ''})`);
          console.log(`  app:   ${cfg.network.appBindHost}:${cfg.network.appPort}`);
          console.log(`  admin: ${cfg.network.adminBindHost}:${cfg.network.adminPort}`);
          console.log(`  auth:  ${cfg.auth.providers.join(', ')}`);
          if (cfg.warnings.length > 0) {
            console.log('警告:');
            for (const w of cfg.warnings) console.log(`  - ${w}`);
          }
          break;
        }
        case 'set': {
          const name = positional[0];
          if (!name) throw new Error('usage: preset set <name>');
          if (!EXPOSURE_PRESETS[name]) throw new Error(`unknown preset: ${name} (use "preset list" to see options)`);
          const applied = await applyExposurePreset(name);
          console.log(`preset set to ${name} (${applied.exposure.preset === name ? 'ok' : 'failed'})`);
          console.log('  config/server.json updated. Restart the server for changes to take effect.');
          break;
        }
        default:
          printHelp();
          process.exitCode = 1;
      }
      break;
    }

    case 'scrap': {
      const sub = positional.shift();
      switch (sub) {
        case 'list': {
          try {
            const entries = await readdir(SCRAP_DIR);
            if (entries.length === 0) { console.log('(scrap/ is empty)'); break; }
            for (const name of entries) {
              const full = join(SCRAP_DIR, name);
              try {
                const st = await stat(full);
                if (st.isDirectory()) {
                  const inner = await readdir(full);
                  let totalSize = 0;
                  for (const f of inner) {
                    try { totalSize += (await stat(join(full, f))).size; } catch {}
                  }
                  console.log(`${name}/  (${inner.length} files, ${fmtBytes(totalSize)})`);
                } else {
                  console.log(`${name}  ${fmtBytes(st.size)}`);
                }
              } catch {}
            }
          } catch (e) {
            if (e.code === 'ENOENT') console.log('(scrap/ directory does not exist yet)');
            else throw e;
          }
          break;
        }
        case 'purge': {
          const name = positional[0];
          if (!name) throw new Error('usage: scrap purge <archive-name> --confirm');
          if (!flags.confirm) { console.error('refusing to purge without --confirm'); process.exitCode = 1; break; }
          const full = join(SCRAP_DIR, name);
          if (!full.startsWith(SCRAP_DIR + '/') && !full.startsWith(SCRAP_DIR + '\\')) {
            throw new Error('refusing: target is outside scrap directory');
          }
          const st = await stat(full).catch(() => null);
          if (!st) { console.log(`no such scrap entry: ${name}`); process.exitCode = 1; break; }
          if (st.isDirectory()) {
            for (const f of await readdir(full)) {
              await unlink(join(full, f)).catch(() => {});
            }
            await rmdir(full);
          } else {
            await unlink(full);
          }
          console.log(`purged: ${full}`);
          break;
        }
        default:
          printHelp();
          process.exitCode = 1;
      }
      break;
    }

    // A6 (2026-06-09): config show — resolved config + source 表示
    case 'config': {
      const sub = positional.shift();
      if (sub === 'show') {
        const cfg = await loadServerConfig();
        console.log('============================================================');
        console.log('  Affinity Mapping Studio Server resolved config');
        console.log('============================================================');
        console.log(`  preset       : ${cfg.preset.name}  (${cfg.preset.label})`);
        console.log(`  appPort      : ${cfg.network.appPort}`);
        console.log(`  appBindHost  : ${cfg.network.appBindHost}`);
        console.log(`  adminPort    : ${cfg.network.adminPort}`);
        console.log(`  adminBindHost: ${cfg.network.adminBindHost}`);
        console.log(`  trustedProxySources: ${JSON.stringify(cfg.network.trustedProxySources)}`);
        console.log('');
        console.log('  authPolicy:');
        for (const [k, v] of Object.entries(cfg.authPolicy)) {
          console.log(`    ${k.padEnd(22)}: ${JSON.stringify(v)}`);
        }
        console.log('');
        console.log(`  admin token source: ${cfg.admin.tokenSource}`);
        if (cfg.warnings.length > 0) {
          console.log('');
          console.log('  warnings:');
          for (const w of cfg.warnings) console.log(`    - ${w}`);
        }
        console.log('============================================================');
      } else {
        printHelp();
        process.exitCode = 1;
      }
      break;
    }

    // A6 (2026-06-09): tunnel コマンド (start / stop / status / url)
    case 'tunnel': {
      await bootConfig(); // tunnel.js は getResolvedConfig 経由なので boot 必要
      const sub = positional.shift();
      switch (sub) {
        case 'start': {
          try {
            const target = flags.target || 'app';
            const port = flags.port ? Number(flags.port) : undefined;
            const result = await spawnTunnel({ target, port });
            console.log(`tunnel started: ${result.url}  pid=${result.pid}`);
          } catch (e) {
            console.error(`error: ${e.message}`);
            process.exitCode = 1;
          }
          break;
        }
        case 'stop': {
          const result = await killTunnel();
          if (result.killed) {
            console.log(result.graceful ? 'tunnel stopped (graceful)' : 'tunnel stopped (SIGKILL)');
          } else {
            console.log(`not stopped: ${result.reason}`);
          }
          break;
        }
        case 'status': {
          const s = await getTunnelStatus();
          console.log(JSON.stringify(s, null, 2));
          break;
        }
        case 'url': {
          const s = await getTunnelStatus();
          if (s.running) console.log(s.url);
          else {
            console.log('(not running)');
            process.exitCode = 1;
          }
          break;
        }
        default:
          printHelp();
          process.exitCode = 1;
      }
      break;
    }

    // A6 (2026-06-09): room auth — authMethods マトリクス + effective policy 表示
    case 'auth': {
      // 形式: kj-admin auth <roomId> --show
      //   or kj-admin auth <roomId> --method <name> --state on|off|inherit
      const roomId = positional[0];
      if (!roomId) {
        console.error('usage: kj-admin auth <roomId> [--show | --method <name> --state on|off|inherit]');
        process.exitCode = 1;
        break;
      }
      const room = await getRoom(roomId);
      if (!room) {
        console.error(`no such room: ${roomId}`);
        process.exitCode = 1;
        break;
      }
      await bootConfig();
      const cfg = await loadServerConfig();
      if (flags.show || (!flags.method && !flags.state)) {
        const eff = inferAuthPolicy(room, cfg.authPolicy);
        console.log(`Room: ${roomId}`);
        console.log(`accessControl: ${room.accessControl}`);
        console.log(`passwordHash : ${room.passwordHash ? '(set)' : '(not set)'}`);
        console.log('');
        console.log('authMethods (raw → effective):');
        for (const name of [
          'inviteToken', 'roomPassword', 'trustedProxy', 'tailscale',
          'ipCidr', 'emailLegacy', 'noneOpen', 'localhostAuto',
        ]) {
          const raw = room.authPolicy?.authMethods?.[name] ?? 'inherit';
          const effv = eff.authMethods[name];
          console.log(`  ${name.padEnd(15)}: ${raw.padEnd(8)} → ${effv ? 'ON ' : 'OFF'}`);
        }
        console.log('');
        console.log(`requirementGroups: ${JSON.stringify(eff.requirementGroups)}`);
      } else if (flags.method && flags.state) {
        const validMethods = new Set([
          'inviteToken', 'roomPassword', 'trustedProxy', 'tailscale',
          'ipCidr', 'emailLegacy', 'noneOpen', 'localhostAuto',
        ]);
        if (!validMethods.has(flags.method)) {
          console.error(`unknown method: ${flags.method}`);
          process.exitCode = 1;
          break;
        }
        if (!['on', 'off', 'inherit'].includes(flags.state)) {
          console.error(`invalid state: ${flags.state} (expected on|off|inherit)`);
          process.exitCode = 1;
          break;
        }
        const updated = await setRoomOptions(roomId, {
          authPolicy: { authMethods: { [flags.method]: flags.state } },
        });
        console.log(`updated room ${roomId}: authMethods.${flags.method} = ${flags.state}`);
      } else {
        console.error('use --show, or both --method and --state');
        process.exitCode = 1;
      }
      break;
    }

    // 段階1 (2026-07-03): サーバー側スナップショットの一覧・作成・復元
    case 'snapshot': {
      const sub = positional.shift();
      switch (sub) {
        case 'list': {
          const roomId = positional[0];
          if (!roomId) {
            console.error('usage: kj-admin snapshot list <roomId>');
            process.exitCode = 1;
            break;
          }
          const entries = await listSnapshots(roomId);
          if (entries.length === 0) {
            console.log(`(no snapshots for ${roomId})`);
            break;
          }
          console.log(`snapshots for ${roomId} (新しい順, ${entries.length} 件):`);
          for (const e of entries) {
            const c = e.counts ?? {};
            console.log(
              `  ${e.id}  ${e.ts}  [${e.trigger}]` +
                `  cards=${c.cards ?? '?'} groups=${c.groups ?? '?'} mem=${c.memberships ?? '?'}` +
                `  ${(e.bytes / 1024).toFixed(1)}KB${e.label ? `  "${e.label}"` : ''}`
            );
          }
          break;
        }
        case 'create': {
          const roomId = positional[0];
          if (!roomId) {
            console.error('usage: kj-admin snapshot create <roomId> [--label L]');
            process.exitCode = 1;
            break;
          }
          const doc = new Y.Doc();
          await loadRoom(roomId, doc);
          const entry = await takeSnapshot(roomId, doc, {
            trigger: 'manual',
            label: typeof flags.label === 'string' ? flags.label : null,
          });
          if (entry) console.log(`snapshot created: ${entry.id} (cards=${entry.counts.cards} groups=${entry.counts.groups} mem=${entry.counts.memberships})`);
          else { console.error('snapshot failed'); process.exitCode = 1; }
          break;
        }
        case 'restore': {
          const roomId = positional[0];
          const id = positional[1];
          if (!roomId || !id) {
            console.error('usage: kj-admin snapshot restore <roomId> <snapshotId>');
            process.exitCode = 1;
            break;
          }
          let update;
          try {
            update = await restoreSnapshot(roomId, id);
          } catch (e) {
            console.error(`snapshot 読込失敗: ${e.message}`);
            process.exitCode = 1;
            break;
          }
          // 復元内容を検証 (Y.Doc に適用して行数を確認)
          const doc = new Y.Doc();
          Y.applyUpdate(doc, update, 'restore');
          const tables = doc.getMap('tables');
          const len = (k) => tables.get(k)?.length ?? 0;
          // 現 .bin を .bak 退避 → [u32 BE len][update] で書き出し
          const binPath = join(DATA_DIR, `${roomId}.bin`);
          const ts = new Date().toISOString().replace(/[:.]/g, '');
          try {
            await copyFile(binPath, `${binPath}.pre-restore-${ts}.bak`);
          } catch (e) {
            if (e.code !== 'ENOENT') { console.error(`退避失敗: ${e.message}`); process.exitCode = 1; break; }
          }
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(update.length, 0);
          await writeFile(binPath, Buffer.concat([lenBuf, Buffer.from(update)]));
          const newEpoch = await rotateEpoch(roomId);
          console.log(`restored ${roomId} from snapshot ${id}`);
          console.log(`  内容: cards=${len('cards')} groups=${len('groups')} memberships=${len('group_memberships')}`);
          console.log(`  epoch 更新: ${newEpoch} (クライアントキャッシュ無効化)`);
          console.log('  注意: サーバー稼働中の場合は再起動して反映してください (メモリ上の room はリロードされません)');
          break;
        }
        default:
          console.error('usage: kj-admin snapshot <list|create|restore> ...');
          process.exitCode = 1;
      }
      break;
    }

    case 'token': {
      const sub = positional.shift();
      if (sub === 'gen') {
        if (!flags.confirm) {
          console.error('refusing: admin token 再生成は全管理画面セッションを無効化する．--confirm を付けてください');
          process.exitCode = 1;
          break;
        }
        try { await stat(CONFIG_DIR); } catch { await mkdir(CONFIG_DIR, { recursive: true }); }
        const tok = randomBytes(32).toString('hex');
        await writeFile(TOKEN_PATH, tok, 'utf-8');
        console.log(`new admin token written to: ${TOKEN_PATH}`);
        console.log(`token: ${tok}`);
        console.log('注: サーバーを再起動して env / start script から読み直してください');
      } else {
        printHelp();
        process.exitCode = 1;
      }
      break;
    }

    default:
      printHelp();
      process.exitCode = 1;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
