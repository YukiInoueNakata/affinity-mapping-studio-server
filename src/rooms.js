// Room metadata + invitation list management.
// Storage: a single JSON file (data/rooms.json).  For ゼミ規模 this is plenty
// — switching to SQLite is a Phase 4b-3 concern only if it ever matters.
//
// Schema:
// {
//   "rooms": {
//     "<roomId>": {
//       "id": "...",
//       "name": "...",
//       "auditLogging": "off" | "on",
//       "accessControl": "open" | "invite_list",
//       "createdAt": "ISO timestamp",
//       "invitations": [
//         { "email": "alice@example.ac.jp", "role": "editor" | "viewer" | "admin",
//           "invitedAt": "ISO" }
//       ]
//     }
//   }
// }

import { readFile, writeFile, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './paths.js';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { assertValidRoomId, isValidRoomId } from './room-id.js';
import { isIpInCidrs, isTailscaleIp, isTrueLocalhostDirect } from './ip-trust.js';
import { getResolvedConfig, isPublicPreset } from './config.js';
import { getTunnelStatus } from './tunnel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROOMS_FILE = join(DATA_DIR, 'rooms.json');
const SCRAP_DIR = join(DATA_DIR, 'scrap');
const AUDIT_DIR = join(DATA_DIR, 'audit');

// No in-memory cache: kj-admin runs in a separate process and mutates this
// file too, so the server must always observe the latest state on disk.
// For ゼミ規模 (few writes/sec) reading rooms.json each time is fine.
let writeQueue = Promise.resolve();

async function ensureDataDir() {
  try {
    await stat(DATA_DIR);
  } catch {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

async function load() {
  await ensureDataDir();
  let store;
  try {
    const raw = await readFile(ROOMS_FILE, 'utf-8');
    store = JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') {
      store = { rooms: {} };
    } else {
      throw e;
    }
  }
  if (!store.rooms) store.rooms = {};
  return store;
}

async function persist(store) {
  // Serialise writes so concurrent calls don't clobber each other.
  // Note: we deliberately avoid the write-temp + rename pattern because on
  // Windows + OneDrive the destination file is often held open by the sync
  // agent, which makes `rename` fail with EPERM.  Direct writeFile is
  // best-effort but adequate for the PoC's ゼミ-規模 write rate.
  writeQueue = writeQueue.then(async () => {
    await ensureDataDir();
    const payload = JSON.stringify(store, null, 2);
    // Retry briefly on EPERM/EBUSY caused by OneDrive scanning.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await writeFile(ROOMS_FILE, payload, 'utf-8');
        return;
      } catch (e) {
        if ((e.code === 'EPERM' || e.code === 'EBUSY') && attempt < 2) {
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  });
  return writeQueue;
}

function normaliseEmail(e) {
  return (e ?? '').trim().toLowerCase();
}

/** Sec-111 (2026-06-03): 招待ごとの秘密トークン．URL ?t=<token> で渡す形式．
 *  Email 自己申告に代わる正規認証．32 byte の URL-safe random．
 *  予測不可能・収集困難な強度． */
function generateInviteToken() {
  // base64url．32 byte → 43 chars．URL の predefined char と衝突しない．
  return randomBytes(32).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Sec-111 拡張 (2026-06-03): scrypt でパスワードを hash．
 *  format: `scrypt$N$r$p$salt_hex$hash_hex`．rotate / verify 両対応． */
function hashPassword(plain) {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1, keylen = 32;
  const hash = scryptSync(plain, salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [, Ns, rs, ps, saltHex, hashHex] = parts;
  const N = Number(Ns), r = Number(rs), p = Number(ps);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const computed = scryptSync(plain, salt, expected.length, { N, r, p });
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

// ---- public API ----

export async function listRooms() {
  const s = await load();
  return Object.values(s.rooms);
}

export async function getRoom(id) {
  const s = await load();
  return s.rooms[id] ?? null;
}

export async function createRoom(id, opts = {}) {
  // Sec-001: 不正な room ID は即拒否（ファイル名衝突防止）
  assertValidRoomId(id);
  const s = await load();
  if (s.rooms[id]) {
    throw new Error(`room "${id}" already exists`);
  }
  const room = {
    id,
    name: opts.name ?? id,
    auditLogging: opts.auditLogging ?? 'off',
    accessControl: opts.accessControl ?? 'open',
    createdAt: new Date().toISOString(),
    invitations: [],
  };
  s.rooms[id] = room;
  await persist(s);
  return room;
}

/** Sec-006 (2026-06-02 / R5 2026-06-09): 未知 room の自動作成は既定で無効化．
 *  cfg.authPolicy.allowAutoRoomCreate=true のときのみ legacy 挙動 (自動作成)．
 *  既定 false では存在しない room への接続は null を返し，呼び出し側で 401/404 にする．
 *
 *  R5: env 直読みを廃止．caller が serverAuthPolicy.allowAutoRoomCreate を渡す． */
export async function ensureRoom(id, serverAuthPolicy) {
  assertValidRoomId(id);
  const r = await getRoom(id);
  if (r) return r;
  if (!serverAuthPolicy?.allowAutoRoomCreate) return null;
  return createRoom(id, { name: id, auditLogging: 'off', accessControl: 'open' });
}

export async function setRoomOptions(id, opts) {
  assertValidRoomId(id);
  const s = await load();
  const r = s.rooms[id];
  if (!r) throw new Error(`room "${id}" not found`);
  if (opts.name !== undefined) r.name = opts.name;
  if (opts.auditLogging !== undefined) {
    if (opts.auditLogging !== 'on' && opts.auditLogging !== 'off') {
      throw new Error("auditLogging must be 'on' or 'off'");
    }
    r.auditLogging = opts.auditLogging;
  }
  if (opts.accessControl !== undefined) {
    if (opts.accessControl !== 'open' && opts.accessControl !== 'invite_list') {
      throw new Error("accessControl must be 'open' or 'invite_list'");
    }
    r.accessControl = opts.accessControl;
  }
  // R1 + A1 (2026-06-09): authPolicy (authMethods + requirementGroups) も受付
  if (opts.authPolicy !== undefined) {
    if (opts.authPolicy === null) {
      delete r.authPolicy;
    } else {
      r.authPolicy = r.authPolicy ?? {};
      if (opts.authPolicy.authMethods !== undefined) {
        const validStates = new Set(['on', 'off', 'inherit']);
        const validMethods = new Set([
          'inviteToken', 'roomPassword', 'trustedProxy', 'tailscale',
          'ipCidr', 'emailLegacy', 'noneOpen', 'localhostAuto',
        ]);
        const nextMethods = { ...(r.authPolicy.authMethods ?? {}) };
        for (const [k, v] of Object.entries(opts.authPolicy.authMethods)) {
          if (!validMethods.has(k)) throw new Error(`unknown authMethod: ${k}`);
          if (!validStates.has(v)) throw new Error(`invalid state for ${k}: ${v}`);
          nextMethods[k] = v;
        }
        r.authPolicy.authMethods = nextMethods;
      }
      if (opts.authPolicy.requirementGroups !== undefined) {
        if (opts.authPolicy.requirementGroups === null) {
          delete r.authPolicy.requirementGroups;
        } else if (!Array.isArray(opts.authPolicy.requirementGroups)) {
          throw new Error('requirementGroups must be array of arrays');
        } else {
          r.authPolicy.requirementGroups = opts.authPolicy.requirementGroups;
        }
      }
    }
  }
  await persist(s);
  return r;
}

export async function inviteEmail(roomId, email, role = 'editor', opts = {}) {
  assertValidRoomId(roomId);
  if (role !== 'editor' && role !== 'viewer' && role !== 'admin') {
    throw new Error("role must be 'editor', 'viewer', or 'admin'");
  }
  const s = await load();
  const r = s.rooms[roomId];
  if (!r) throw new Error(`room "${roomId}" not found`);
  const normEmail = normaliseEmail(email);
  if (!normEmail) throw new Error('email is required');
  // Sec-111 拡張: token 有効期限・最大使用回数 (opts)
  const expiresAt = opts.expiresAt ?? null; // ISO string or null
  const maxUses = opts.maxUses ?? null; // number or null (無制限)
  const existing = r.invitations.find((i) => normaliseEmail(i.email) === normEmail);
  if (existing) {
    existing.role = role;
    existing.invitedAt = new Date().toISOString();
    if (!existing.token) existing.token = generateInviteToken();
    if (opts.expiresAt !== undefined) existing.expiresAt = expiresAt;
    if (opts.maxUses !== undefined) existing.maxUses = maxUses;
  } else {
    r.invitations.push({
      email: normEmail,
      role,
      invitedAt: new Date().toISOString(),
      token: generateInviteToken(),
      expiresAt,
      maxUses,
      usedCount: 0,
    });
  }
  await persist(s);
  return r;
}

/** Sec-111 拡張: ルーム共通パスワード設定 (room-password 認証用)．
 *  既に設定済みの場合は上書き．null/'' で削除． */
export async function setRoomPassword(roomId, password) {
  assertValidRoomId(roomId);
  const s = await load();
  const r = s.rooms[roomId];
  if (!r) throw new Error(`room "${roomId}" not found`);
  if (!password || password.length === 0) {
    delete r.passwordHash;
    delete r.passwordSetAt;
  } else {
    if (password.length < 4) throw new Error('password must be at least 4 chars');
    r.passwordHash = hashPassword(password);
    r.passwordSetAt = new Date().toISOString();
  }
  await persist(s);
  return { hasPassword: !!r.passwordHash };
}

/** Sec-111: 招待 token を再発行（漏洩時の rotate 用） */
export async function rotateInviteToken(roomId, email) {
  assertValidRoomId(roomId);
  const s = await load();
  const r = s.rooms[roomId];
  if (!r) throw new Error(`room "${roomId}" not found`);
  const normEmail = normaliseEmail(email);
  const inv = r.invitations.find((i) => normaliseEmail(i.email) === normEmail);
  if (!inv) throw new Error(`invitation for "${email}" not found`);
  const oldToken = inv.token;
  inv.token = generateInviteToken();
  inv.rotatedAt = new Date().toISOString();
  await persist(s);
  return { newToken: inv.token, hadOldToken: !!oldToken };
}

export async function revokeEmail(roomId, email) {
  assertValidRoomId(roomId);
  const s = await load();
  const r = s.rooms[roomId];
  if (!r) throw new Error(`room "${roomId}" not found`);
  const normEmail = normaliseEmail(email);
  const before = r.invitations.length;
  r.invitations = r.invitations.filter((i) => normaliseEmail(i.email) !== normEmail);
  if (r.invitations.length === before) {
    return { removed: false };
  }
  await persist(s);
  return { removed: true };
}

// ============================================================
// R1+A1+A2+R13 (2026-06-09): authPolicy schema + policy-driven checkAccess
// ============================================================

/** R1: provider 名 (8 種)．順序が「成功時にどの role を採用するか」の優先度になる． */
const PROVIDERS_IN_ORDER = [
  'trustedProxy',
  'localhostAuto',
  'inviteToken',
  'roomPassword',
  'tailscale',
  'ipCidr',
  'emailLegacy',
  'noneOpen',
];

/** R1: per-room authMethods schema の項目．`on | off | inherit` */
const DEFAULT_AUTH_METHODS = {
  inviteToken: 'on',     // 常時 on．off にすると token 経路が完全閉鎖
  roomPassword: 'on',    // 常時 on
  trustedProxy: 'inherit',
  tailscale: 'inherit',
  ipCidr: 'inherit',
  emailLegacy: 'inherit',
  noneOpen: 'inherit',
  localhostAuto: 'inherit',
};

/** R1: per-room authMethods の effective 値を返す．
 *  'on' → true, 'off' → false, 'inherit' (or undefined) → globalDefault */
function resolveAuthMethod(roomAuthMethods, name, globalDefault) {
  const v = roomAuthMethods?.[name];
  if (v === 'on') return true;
  if (v === 'off') return false;
  return !!globalDefault;
}

/** R1 + R13: 自動推論．既存 room の accessControl / passwordHash から
 *  requirementGroups を生成する．
 *
 *  | passwordHash | accessControl | requirementGroups |
 *  | なし         | open          | []                |
 *  | なし         | invite_list   | [['inviteToken']] |
 *  | あり         | open          | [['inviteToken', 'roomPassword']] |
 *  | あり         | invite_list   | [['inviteToken']] |
 *
 *  room.authPolicy.requirementGroups が明示設定されていればそれを優先する．
 */
function inferRequirementGroups(room) {
  if (room.authPolicy?.requirementGroups) {
    return room.authPolicy.requirementGroups;
  }
  const hasPassword = !!room.passwordHash;
  const isInviteList = room.accessControl === 'invite_list';
  if (!hasPassword && !isInviteList) return [];
  if (!hasPassword && isInviteList) return [['inviteToken']];
  if (hasPassword && !isInviteList) return [['inviteToken', 'roomPassword']];
  // hasPassword && isInviteList
  return [['inviteToken']];
}

/** R1 + R13: room + serverPolicy から effective authPolicy を生成．
 *  外部からは Admin UI / audit log 用に publicly export． */
export function inferAuthPolicy(room, serverAuthPolicy) {
  const roomAuthMethods = room?.authPolicy?.authMethods ?? {};
  const effective = {
    inviteToken: resolveAuthMethod(roomAuthMethods, 'inviteToken', serverAuthPolicy?.inviteTokenEnabled ?? true),
    roomPassword: resolveAuthMethod(roomAuthMethods, 'roomPassword', serverAuthPolicy?.roomPasswordEnabled ?? true),
    trustedProxy: resolveAuthMethod(roomAuthMethods, 'trustedProxy', !!serverAuthPolicy?.trustedProxyHeader),
    tailscale: resolveAuthMethod(roomAuthMethods, 'tailscale', !!serverAuthPolicy?.tailscaleEnabled),
    ipCidr: resolveAuthMethod(roomAuthMethods, 'ipCidr', (serverAuthPolicy?.allowedCidrs?.length ?? 0) > 0),
    emailLegacy: resolveAuthMethod(roomAuthMethods, 'emailLegacy', !!serverAuthPolicy?.legacyEmailEnabled),
    noneOpen: resolveAuthMethod(roomAuthMethods, 'noneOpen', !!serverAuthPolicy?.noneOpenEnabled),
    localhostAuto: resolveAuthMethod(roomAuthMethods, 'localhostAuto', !!serverAuthPolicy?.localhostAutoEnabled),
  };
  return {
    authMethods: effective,
    requirementGroups: inferRequirementGroups(room),
  };
}

/** localhostAuto を止める理由 (公開中なら理由の文字列，そうでなければ null)．
 *  設定や状態を読めないときは，安全側に倒して止める． */
async function localhostAutoBlockReason() {
  let presetName;
  try {
    presetName = getResolvedConfig().preset.name;
  } catch {
    return 'config-not-loaded';
  }
  if (isPublicPreset(presetName)) return `preset=${presetName}`;
  try {
    const t = await getTunnelStatus();
    if (t.running) return 'tunnel-running';
  } catch {
    return 'tunnel-status-unknown';
  }
  return null;
}

/** R1: 1 つの provider を試して { passed, role?, identity?, reason? } を返す．
 *  passed=false の場合 reason に「なぜ通らなかったか」を入れる． */
async function tryProvider(name, ctx, room, effectivePolicy, serverAuthPolicy) {
  const { email, token, password, directIp, judgeIp, trustedProxyUser } = ctx;

  if (!effectivePolicy.authMethods[name]) {
    return { passed: false, reason: 'method-disabled' };
  }

  switch (name) {
    case 'trustedProxy': {
      if (!trustedProxyUser) return { passed: false, reason: 'no-header' };
      const normTpu = normaliseEmail(trustedProxyUser);
      const inv = room.invitations.find((i) => normaliseEmail(i.email) === normTpu);
      return {
        passed: true,
        role: inv?.role ?? 'editor',
        identity: inv?.email ?? trustedProxyUser,
      };
    }

    case 'localhostAuto': {
      // R3: directIp で判定 (judgeIp ではない．XFF spoof 防御)
      if (!isTrueLocalhostDirect(directIp)) return { passed: false, reason: 'not-localhost' };
      // 2026-11-11: 外に公開しているときは localhostAuto で通さない．
      // cloudflared などのトンネルは外部の接続を 127.0.0.1 から中継するので，
      // 部屋の設定が on のままトンネルを張ると，外の人が認証なしで editor になれてしまう．
      // 公開系 preset のときとトンネルが動いているときは，部屋の設定にかかわらず拒否する．
      const exposure = await localhostAutoBlockReason();
      if (exposure) return { passed: false, reason: `localhost-auto-blocked:${exposure}` };
      return { passed: true, role: 'editor', identity: `localhost:${directIp}` };
    }

    case 'inviteToken': {
      if (!token) return { passed: false, reason: 'no-token' };
      const inv = room.invitations.find((i) => i.token && i.token === token);
      if (!inv) return { passed: false, reason: 'invalid-token' };
      if (inv.expiresAt) {
        const now = new Date().toISOString();
        if (now > inv.expiresAt) return { passed: false, reason: 'token-expired' };
      }
      if (inv.maxUses != null && (inv.usedCount ?? 0) >= inv.maxUses) {
        return { passed: false, reason: 'token-exhausted' };
      }
      // R1: 使用回数を加算 (eventually consistent persist)
      inv.usedCount = (inv.usedCount ?? 0) + 1;
      inv.lastUsedAt = new Date().toISOString();
      persist({ rooms: { ...(await load()).rooms, [room.id]: room } }).catch((e) =>
        console.error(`[checkAccess ${room.id}] persist usedCount failed:`, e.message)
      );
      return { passed: true, role: inv.role, identity: inv.email };
    }

    case 'roomPassword': {
      if (!password || !room.passwordHash) return { passed: false, reason: 'no-password' };
      if (!verifyPassword(password, room.passwordHash)) {
        return { passed: false, reason: 'invalid-password' };
      }
      return {
        passed: true,
        role: 'editor',
        identity: email ? normaliseEmail(email) : `pw:${judgeIp}`,
      };
    }

    case 'tailscale': {
      if (!isTailscaleIp(judgeIp)) return { passed: false, reason: 'not-tailscale' };
      return { passed: true, role: 'editor', identity: `tailnet:${judgeIp}` };
    }

    case 'ipCidr': {
      const cidrs = serverAuthPolicy?.allowedCidrs ?? [];
      if (cidrs.length === 0) return { passed: false, reason: 'no-allowed-cidrs' };
      if (!isIpInCidrs(judgeIp, cidrs)) return { passed: false, reason: 'not-in-allowed-cidrs' };
      return { passed: true, role: 'editor', identity: `cidr:${judgeIp}` };
    }

    case 'emailLegacy': {
      const normEmail = normaliseEmail(email);
      if (room.accessControl === 'open') {
        // Sec (2026-07-14 レビュー critical#1): open ルームでは自己申告 email から
        // 招待 role を昇格させない．email は資格情報ではなく，一致しても inv.role
        // (admin を含む) を返すと第三者が ?email=<admin の email> だけで admin 化し，
        // 破壊的 restore と監査偽装まで到達する．open の既定 role (editor) に固定し，
        // 招待 role の付与は本人性を確認できる provider (inviteToken/roomPassword/
        // trustedProxy) に限定する．
        return { passed: true, role: 'editor', identity: normEmail || null };
      }
      // invite_list
      if (!normEmail) return { passed: false, reason: 'no-email' };
      const inv = room.invitations.find((i) => normaliseEmail(i.email) === normEmail);
      if (!inv) return { passed: false, reason: 'not-in-invite-list' };
      return { passed: true, role: inv.role, identity: inv.email };
    }

    case 'noneOpen': {
      if (room.accessControl !== 'open') return { passed: false, reason: 'not-open-room' };
      return { passed: true, role: 'editor', identity: null };
    }

    default:
      return { passed: false, reason: `unknown-provider:${name}` };
  }
}

/** R1 + R13: policy-driven checkAccess
 *
 *  @param {string} roomId
 *  @param {object} ctx - { email?, token?, password?, judgeIp?, directIp?, trustedProxyUser? }
 *  @param {object} serverAuthPolicy - cfg.authPolicy (R5 で resolved config から取得)
 *  @returns {Promise<object>} verdict:
 *    allow: { allowed: true, role, via, identity, satisfied, effectivePolicy, matchedRule }
 *    deny:  { allowed: false, reason, effectivePolicy?, satisfied?, failedGroups?, deniedReasons? }
 */
export async function checkAccess(roomId, ctx, serverAuthPolicy) {
  // 後方互換: ctx が string なら旧 signature (roomId, email)
  if (typeof ctx === 'string') ctx = { email: ctx };
  ctx = ctx ?? {};

  if (!isValidRoomId(roomId)) {
    return { allowed: false, reason: 'invalid-room-id' };
  }
  const room = await getRoom(roomId);
  if (!room) {
    if (serverAuthPolicy?.allowAutoRoomCreate) {
      return {
        allowed: true,
        role: 'editor',
        via: 'auto-create',
        identity: null,
        satisfied: [],
        matchedRule: 'auto-create (KJ_ALLOW_AUTO_ROOM_CREATE)',
      };
    }
    return { allowed: false, reason: 'room-not-found' };
  }

  // judgeIp が無ければ旧名 ip にフォールバック (互換)
  if (ctx.judgeIp === undefined && ctx.ip !== undefined) {
    ctx.judgeIp = ctx.ip;
  }
  if (ctx.directIp === undefined && ctx.ip !== undefined) {
    ctx.directIp = ctx.ip;
  }

  const effectivePolicy = inferAuthPolicy(room, serverAuthPolicy ?? {});

  // 1. 各 provider を順に試して satisfied set + providerResults を作る
  const satisfied = new Set();
  const providerResults = {};
  for (const name of PROVIDERS_IN_ORDER) {
    // emailLegacy は room.accessControl === 'open' で email 未送信でも passed する特殊ケースがあるため
    // ctx に email がない場合は skip するという最適化はしない (provider 内で評価)
    const result = await tryProvider(name, ctx, room, effectivePolicy, serverAuthPolicy);
    providerResults[name] = result;
    if (result.passed) satisfied.add(name);
  }

  // 2. requirementGroups を AND 評価 (全 group 内 OR 満たす必要あり)
  const failedGroups = [];
  for (const group of effectivePolicy.requirementGroups) {
    if (group.length === 0) continue;
    const groupSatisfied = group.some((p) => satisfied.has(p));
    if (!groupSatisfied) failedGroups.push(group);
  }

  if (failedGroups.length > 0) {
    return {
      allowed: false,
      reason: 'requirement-group-failed',
      effectivePolicy,
      satisfied: [...satisfied],
      failedGroups,
      deniedReasons: failedGroups.map(
        (g) => `requirement: required one of [${g.join('|')}], satisfied: [${[...satisfied].filter((s) => g.includes(s)).join(',')}]`
      ),
    };
  }

  // 3. requirements が無い + どの provider も passed しない → loose accessControl 判定
  if (satisfied.size === 0) {
    if (effectivePolicy.requirementGroups.length === 0) {
      // open room with no provider matched. accessControl='open' なら入れたい?
      // → 設計上「明示的に許可する provider が必要」．よって reject．
      if (room.accessControl === 'invite_list') {
        return { allowed: false, reason: 'no-valid-credentials-invite-list', effectivePolicy };
      }
      return { allowed: false, reason: 'no-valid-credentials', effectivePolicy };
    }
    // requirementGroups あり + 全部 group は満たした (=空 group のみ) ケースは上で処理済
    return { allowed: false, reason: 'no-valid-credentials', effectivePolicy };
  }

  // 4. allow．role は最初に satisfied した provider (= PROVIDERS_IN_ORDER の優先度)
  const first = PROVIDERS_IN_ORDER.find((p) => satisfied.has(p));
  const firstResult = providerResults[first];
  return {
    allowed: true,
    role: firstResult.role,
    via: first,
    identity: firstResult.identity,
    satisfied: [...satisfied],
    effectivePolicy,
    matchedRule:
      effectivePolicy.requirementGroups.length > 0
        ? `requirementGroups satisfied; via=${first}`
        : `loose; via=${first}`,
  };
}

/** Sec-007 (2026-06-02): メタデータだけでなく，.bin / .bak / audit ログも
 *  scrap/<id>_<timestamp>/ へ MOVE する．即座に物理削除はせず誤削除時の
 *  リカバリ余地を残す．完全削除は管理者が scrap を手動で消す． */
async function ensureScrapDir() {
  try { await stat(SCRAP_DIR); } catch { await mkdir(SCRAP_DIR, { recursive: true }); }
}

async function moveIfExists(src, dst) {
  try {
    await stat(src);
  } catch {
    return false;
  }
  await rename(src, dst);
  return true;
}

export async function deleteRoom(id) {
  assertValidRoomId(id);
  const s = await load();
  if (!s.rooms[id]) return { removedMetadata: false, archivedPath: null };
  delete s.rooms[id];
  await persist(s);

  // データ・監査ログを scrap/<id>_<ts>/ へ move
  await ensureScrapDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = join(SCRAP_DIR, `${id}_${stamp}`);
  await mkdir(archiveDir, { recursive: true });
  // 1) data/<id>.bin
  await moveIfExists(join(DATA_DIR, `${id}.bin`), join(archiveDir, `${id}.bin`));
  // 2) data/<id>.bin.*.bak (任意の数)
  try {
    const entries = await (await import('node:fs/promises')).readdir(DATA_DIR);
    for (const name of entries) {
      if (name.startsWith(`${id}.bin.`) && name.endsWith('.bak')) {
        await moveIfExists(join(DATA_DIR, name), join(archiveDir, name));
      }
    }
  } catch (e) {
    console.warn(`[deleteRoom ${id}] backup scan failed:`, e.message);
  }
  // 3) data/audit/<id>.jsonl
  await moveIfExists(join(AUDIT_DIR, `${id}.jsonl`), join(archiveDir, `${id}.jsonl`));

  return { removedMetadata: true, archivedPath: archiveDir };
}

/** Sec-007: 完全削除（archive を物理削除）．管理者が明示的に呼ぶ場合のみ． */
export async function purgeArchive(archivePath) {
  if (!archivePath.startsWith(SCRAP_DIR)) {
    throw new Error('refusing to purge: path is outside scrap dir');
  }
  // 中身を 1 つずつ消してから dir を消す（rmdir -rf が node に無いため）
  const fs = await import('node:fs/promises');
  const entries = await fs.readdir(archivePath);
  for (const name of entries) {
    await unlink(join(archivePath, name)).catch(() => {});
  }
  await fs.rmdir(archivePath);
}
