// HTTP admin API + UI for Affinity Mapping Studio Server (旧名: kj-trace-server).
//
// Endpoints (all prefixed /admin):
//   GET    /admin                                 → admin UI HTML (no auth — UI prompts for token)
//   GET    /admin/api/rooms                       → list rooms
//   POST   /admin/api/rooms                       → create room (body: { id, name, access, audit })
//   PATCH  /admin/api/rooms/:id                   → update room metadata
//   DELETE /admin/api/rooms/:id                   → delete room
//   POST   /admin/api/rooms/:id/invitations       → invite email (body: { email, role })
//   DELETE /admin/api/rooms/:id/invitations/:email → revoke email
//   GET    /admin/api/rooms/:id/audit             → audit events
//
// Auth: every /admin/api/* call requires `Authorization: Bearer <KJ_ADMIN_TOKEN>`.
// The token is read from the env var at startup.  If unset, /admin/* returns 503
// so an unconfigured server cannot accidentally expose management endpoints.

import {
  listRooms,
  createRoom,
  setRoomOptions,
  inviteEmail,
  revokeEmail,
  deleteRoom,
  rotateInviteToken,
  setRoomPassword,
} from './rooms.js';
import { loadServerConfig, EXPOSURE_PRESETS, applyExposurePreset, getResolvedConfig } from './config.js';
import { spawnTunnel, killTunnel, getTunnelStatus, detectCloudflared } from './tunnel.js';
import { inferAuthPolicy, getRoom } from './rooms.js';
import { listScenarios, getScenario, AUTH_SCENARIOS } from './scenarios.js';
import { validateAuthPolicy } from './validation.js';
import { networkInterfaces } from 'node:os';
import { readEvents } from './audit.js';
import { roomFileBytes } from './persistence.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolved lazily to avoid a circular import at module-init time.
let _roomInstances = null;
export function registerRoomInstances(roomsMap) {
  _roomInstances = roomsMap;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, 'admin-ui.html');

// R5 (2026-06-09): admin token は resolved config から取得．bootConfig() 後に有効．
function getAdminToken() {
  try {
    return getResolvedConfig().admin.token ?? '';
  } catch {
    return '';
  }
}

export function isAdminConfigured() {
  return getAdminToken().length > 0;
}

export async function handleAdminRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const p = url.pathname;
  if (!p.startsWith('/admin')) return false;

  const ADMIN_TOKEN = getAdminToken();
  if (!ADMIN_TOKEN) {
    sendJson(res, 503, {
      error: 'admin disabled: bootConfig() not called yet or admin token missing',
    });
    return true;
  }

  // UI HTML — accessible without token; the UI itself prompts for it and
  // calls /admin/api/* with the Bearer header.
  if (req.method === 'GET' && p === '/admin') {
    try {
      const html = await readFile(HTML_PATH, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
    } catch (e) {
      sendJson(res, 500, { error: 'admin UI not found: ' + e.message });
    }
    return true;
  }

  // R12 (2026-06-09): admin-ui を 3 分割 (.html / .js / .css)．静的配信．
  // CSS/JS は token 不要 (UI 自身がブラウザに読み込まれた後 token を要求するため)．
  if (req.method === 'GET' && (p === '/admin/admin-ui.css' || p === '/admin/admin-ui.js')) {
    try {
      const file = p === '/admin/admin-ui.css' ? 'admin-ui.css' : 'admin-ui.js';
      const body = await readFile(join(__dirname, file), 'utf-8');
      const mime = file.endsWith('.css') ? 'text/css' : 'application/javascript';
      res.writeHead(200, {
        'Content-Type': mime + '; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (e) {
      sendJson(res, 500, { error: `${p} not found: ${e.message}` });
    }
    return true;
  }

  // All /admin/api/* require the bearer token.
  const auth = String(req.headers.authorization ?? '');
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token !== ADMIN_TOKEN) {
    sendJson(res, 401, { error: 'invalid or missing admin token' });
    return true;
  }

  try {
    if (req.method === 'GET' && p === '/admin/api/rooms') {
      // 肥大監視 (review #4 2026-06-15): 各 room の永続ファイルサイズを付与し，
      // Admin UI で肥大を一目で検知できるようにする．
      const list = await listRooms();
      const withSize = await Promise.all(
        (Array.isArray(list) ? list : []).map(async (room) => {
          let fileBytes = null;
          try {
            fileBytes = await roomFileBytes(room.id);
          } catch {
            // サイズ取得失敗は致命的でない．null のまま返す．
          }
          return { ...room, fileBytes };
        })
      );
      sendJson(res, 200, withSize);
      return true;
    }
    if (req.method === 'GET' && p === '/admin/api/presence') {
      const presence = collectPresence();
      sendJson(res, 200, presence);
      return true;
    }
    // A5 (2026-06-09): R5+R8 runtime + tunnel endpoint
    if (req.method === 'GET' && p === '/admin/api/server/runtime') {
      const cfg = getResolvedConfig();
      const cloudflaredPath = await detectCloudflared();
      const tunnelStatus = await getTunnelStatus();
      const lanUrls = collectLanUrls(cfg.network.appPort);
      sendJson(res, 200, {
        adminUrl: `http://${cfg.network.adminBindHost}:${cfg.network.adminPort}/admin`,
        localhostWs: `ws://127.0.0.1:${cfg.network.appPort}`,
        lanUrls,
        cloudflareUrl: tunnelStatus.running ? tunnelStatus.url : null,
        listening: {
          appPort: cfg.network.appPort,
          adminPort: cfg.network.adminPort,
        },
        cloudflaredPath,
        tunnelStatus,
        warnings: cfg.warnings,
      });
      return true;
    }
    // A5 (2026-06-09): tunnel start/stop/status
    if (req.method === 'POST' && p === '/admin/api/tunnel/start') {
      const body = await readJsonBody(req).catch(() => ({}));
      try {
        const { target = 'app', port } = body;
        const result = await spawnTunnel({ target, port });
        sendJson(res, 200, { ok: true, url: result.url, pid: result.pid });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return true;
    }
    if (req.method === 'POST' && p === '/admin/api/tunnel/stop') {
      const result = await killTunnel();
      sendJson(res, 200, result);
      return true;
    }
    if (req.method === 'GET' && p === '/admin/api/tunnel/status') {
      sendJson(res, 200, await getTunnelStatus());
      return true;
    }
    // R13 + R4 (2026-06-09): GET /admin/api/rooms/:id/auth-policy (effective + validation)
    {
      const m = p.match(/^\/admin\/api\/rooms\/([^/]+)\/auth-policy$/);
      if (m && req.method === 'GET') {
        const roomId = decodeURIComponent(m[1]);
        const room = await getRoom(roomId);
        if (!room) {
          sendJson(res, 404, { error: 'room not found' });
          return true;
        }
        const cfg = getResolvedConfig();
        const effective = inferAuthPolicy(room, cfg.authPolicy);
        const validation = validateAuthPolicy(room, effective, cfg);
        sendJson(res, 200, {
          roomId,
          raw: room.authPolicy ?? null,
          effective,
          accessControl: room.accessControl,
          hasPassword: !!room.passwordHash,
          validation,
        });
        return true;
      }
    }
    // R4 (2026-06-09): GET /admin/api/scenarios
    if (req.method === 'GET' && p === '/admin/api/scenarios') {
      sendJson(res, 200, { scenarios: listScenarios() });
      return true;
    }
    // R4: POST /admin/api/scenarios/:id/apply
    {
      const m = p.match(/^\/admin\/api\/scenarios\/([^/]+)\/apply$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const s = getScenario(id);
        if (!s) {
          sendJson(res, 404, { error: 'unknown scenario: ' + id });
          return true;
        }
        if (!s.preset) {
          sendJson(res, 400, { error: 'custom scenario has no preset to apply' });
          return true;
        }
        try {
          const applied = await applyExposurePreset(s.preset);
          sendJson(res, 200, {
            ok: true,
            applied,
            scenario: { id: s.id, label: s.label, preset: s.preset, roomDefaults: s.roomDefaults },
            restartRequired: true,
          });
        } catch (e) {
          sendJson(res, 400, { error: e.message });
        }
        return true;
      }
    }
    // A5 (2026-06-09): PATCH /admin/api/rooms/:id (authPolicy 受付追加)
    {
      const m = p.match(/^\/admin\/api\/rooms\/([^/]+)$/);
      if (m && req.method === 'PATCH') {
        const roomId = decodeURIComponent(m[1]);
        const body = await readJsonBody(req);
        try {
          const r = await setRoomOptions(roomId, body);
          sendJson(res, 200, r);
        } catch (e) {
          sendJson(res, 400, { error: e.message });
        }
        return true;
      }
    }
    // Sec-121〜126: 公開方式プリセット
    if (req.method === 'GET' && p === '/admin/api/server/config') {
      const cfg = await loadServerConfig();
      sendJson(res, 200, {
        current: cfg,
        availablePresets: Object.entries(EXPOSURE_PRESETS).map(([name, v]) => ({
          name,
          label: v.label,
          description: v.description,
          requireAuth: v.requireAuth,
          suggestedBindHost: v.suggestedBindHost,
        })),
      });
      return true;
    }
    if (req.method === 'PUT' && p === '/admin/api/server/config/preset') {
      const body = await readJsonBody(req);
      const preset = String(body.preset ?? '');
      if (!EXPOSURE_PRESETS[preset]) {
        sendJson(res, 400, { error: 'unknown preset' });
        return true;
      }
      const applied = await applyExposurePreset(preset, body.overrides ?? {});
      sendJson(res, 200, { ok: true, applied, restartRequired: true });
      return true;
    }
    if (req.method === 'POST' && p === '/admin/api/rooms') {
      const body = await readJsonBody(req);
      const id = String(body.id ?? '').trim();
      if (!id) {
        sendJson(res, 400, { error: 'id required' });
        return true;
      }
      const opts = {};
      if (body.name) opts.name = String(body.name);
      if (body.access === 'invite_list' || body.access === 'open') opts.accessControl = body.access;
      if (body.audit === 'on' || body.audit === 'off') opts.auditLogging = body.audit;
      const room = await createRoom(id, opts);
      sendJson(res, 201, room);
      return true;
    }
    let m = p.match(/^\/admin\/api\/rooms\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      const id = decodeURIComponent(m[1]);
      const body = await readJsonBody(req);
      const opts = {};
      if (body.name !== undefined) opts.name = String(body.name);
      if (body.access === 'invite_list' || body.access === 'open') opts.accessControl = body.access;
      if (body.audit === 'on' || body.audit === 'off') opts.auditLogging = body.audit;
      const room = await setRoomOptions(id, opts);
      sendJson(res, 200, room);
      return true;
    }
    if (m && req.method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      // Sec-007: メタデータ + データ + 監査ログを scrap/<id>_<ts>/ に MOVE
      const result = await deleteRoom(id);
      sendJson(res, 200, { ok: true, archivedPath: result.archivedPath });
      return true;
    }
    m = p.match(/^\/admin\/api\/rooms\/([^/]+)\/invitations$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readJsonBody(req);
      // 2026-06-02 マルチ invite: body.email がカンマ / 改行 / 空白 区切りでも，
      // または body.emails が配列でも，すべて 1 回の API で処理する．
      const role = body.role || 'editor';
      const rawSrc = body.emails ?? body.email ?? '';
      const rawArr = Array.isArray(rawSrc) ? rawSrc : String(rawSrc).split(/[,\n;\s]+/);
      const emails = rawArr.map((s) => String(s).trim()).filter((s) => s.length > 0);
      if (emails.length === 0) {
        sendJson(res, 400, { error: 'email(s) required' });
        return true;
      }
      // Sec-111 拡張: expiresAt / maxUses も受け付ける (任意)
      const inviteOpts = {};
      if (body.expiresAt !== undefined) inviteOpts.expiresAt = body.expiresAt;
      if (body.maxUses !== undefined) inviteOpts.maxUses = Number(body.maxUses) || null;
      const results = [];
      let lastRoom = null;
      for (const email of emails) {
        try {
          lastRoom = await inviteEmail(id, email, role, inviteOpts);
          results.push({ email, ok: true });
        } catch (e) {
          results.push({ email, ok: false, error: e?.message ?? String(e) });
        }
      }
      sendJson(res, 201, { room: lastRoom, invited: results });
      return true;
    }
    m = p.match(/^\/admin\/api\/rooms\/([^/]+)\/invitations\/(.+)$/);
    if (m && req.method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      const email = decodeURIComponent(m[2]);
      const room = await revokeEmail(id, email);
      sendJson(res, 200, room);
      return true;
    }
    m = p.match(/^\/admin\/api\/rooms\/([^/]+)\/audit$/);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const events = await readEvents(id);
      sendJson(res, 200, events);
      return true;
    }
    // Sec-111: 招待 token の rotate
    m = p.match(/^\/admin\/api\/rooms\/([^/]+)\/invitations\/(.+)\/rotate$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const email = decodeURIComponent(m[2]);
      const result = await rotateInviteToken(id, email);
      sendJson(res, 200, result);
      return true;
    }
    // Sec-111 + B3 (2026-06-09): room-password の設定 / 削除
    // 新規設定直後のみ displayedOnce に plaintext を返す (UI sessionStorage 用)
    m = p.match(/^\/admin\/api\/rooms\/([^/]+)\/password$/);
    if (m && req.method === 'PUT') {
      const id = decodeURIComponent(m[1]);
      const body = await readJsonBody(req);
      const password = String(body.password ?? '');
      const result = await setRoomPassword(id, password);
      // displayedOnce: 新規設定時のみ plaintext を返す．scrypt hash は server-side のみ
      const response = { ...result };
      if (password && password.length > 0) {
        response.displayedOnce = password;
      }
      sendJson(res, 200, response);
      return true;
    }
    sendJson(res, 404, { error: 'admin endpoint not found' });
    return true;
  } catch (e) {
    console.error('[admin] handler error:', e);
    sendJson(res, 500, { error: e.message ?? String(e) });
    return true;
  }
}

/** Walks the live Room instances map and returns per-room connected users.
 *  Empty array if rooms aren't registered yet (server still starting). */
function collectPresence() {
  if (!_roomInstances) return { rooms: {}, totalConnections: 0 };
  const result = {};
  let total = 0;
  for (const [roomId, room] of _roomInstances) {
    const users = [];
    for (const ws of room.clients) {
      const ctx = ws.__kjctx ?? {};
      users.push({
        nick: ctx.nick ?? '',
        email: ctx.email ?? '',
        role: ctx.role ?? '',
        ip: ctx.ip ?? '',
      });
      total += 1;
    }
    result[roomId] = users;
  }
  return { rooms: result, totalConnections: total };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** A5 (2026-06-09): LAN 上で接続できそうな URL を全 NIC から列挙． */
function collectLanUrls(port) {
  const urls = [];
  try {
    const nets = networkInterfaces();
    for (const [name, addrs] of Object.entries(nets ?? {})) {
      for (const a of addrs ?? []) {
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        if (a.internal) continue;
        urls.push(`ws://${a.address}:${port}  (${name})`);
      }
    }
  } catch (e) {
    console.warn('[admin] collectLanUrls failed:', e.message);
  }
  return urls;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('invalid JSON body: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}
