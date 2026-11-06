// Sec-102 + R5 (2026-06-09): Affinity Mapping Studio Server の設定読み込みと resolved config．
//
// 優先順位（後者が前者を上書き）:
//   1. ハードコードの安全側既定 (DEFAULTS)
//   2. config/server.json があれば読込
//   3. 環境変数 KJ_* (config 優先のため override は admin token のみ例外)
//
// R5 設計方針:
//   - config 優先．config/server.json に明示値があれば env を無視
//   - 例外: KJ_ADMIN_TOKEN は env があれば override (CI/test 用)
//   - getResolvedConfig() で全モジュールが同じ resolved config を参照
//   - checkAccess(roomId, ctx, authPolicy) に authPolicy を明示引数で渡す
//   - R3: 公開系 preset では localhostAuto を強制 OFF
//   - admin token は config/admin-token.txt を一次ソース．無ければ自動生成

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');
const CONFIG_PATH = join(CONFIG_DIR, 'server.json');
const ADMIN_TOKEN_PATH = join(CONFIG_DIR, 'admin-token.txt');

/** 公開方式 (exposure) のプリセット．R2/R3 で trustedProxySources も追加． */
export const EXPOSURE_PRESETS = {
  'local': {
    label: '自分だけ',
    description: '127.0.0.1 でだけ待ち受け．自分の PC からのみ接続可．',
    suggestedBindHost: '127.0.0.1',
    requireAuth: false,
    trustedProxySources: ['127.0.0.1/32', '::1/128'],
  },
  'lan': {
    label: '研究室 LAN',
    description: '0.0.0.0 で待ち受け．LAN 内の人から接続可．KJ_ALLOWED_CIDRS と組み合わせて IP 制限を推奨．',
    suggestedBindHost: '0.0.0.0',
    requireAuth: false,
    trustedProxySources: [],
  },
  'tailscale-serve': {
    label: 'Tailscale 内だけ',
    description: 'Tailscale tailnet 内に公開．tailscale serve コマンドで起動．',
    suggestedBindHost: '127.0.0.1',
    requireAuth: false,
    trustedProxySources: ['127.0.0.1/32', '::1/128'],
  },
  'tailscale-funnel': {
    label: 'Tailscale Funnel 経由で公開',
    description: 'Tailscale 経由で公開インターネットへ．tailscale funnel コマンドで起動．認証必須．',
    suggestedBindHost: '127.0.0.1',
    requireAuth: true,
    trustedProxySources: ['127.0.0.1/32', '::1/128'],
  },
  'cloudflare-quick': {
    label: '一時デモ公開 (Cloudflare Quick Tunnel)',
    description: 'trycloudflare.com のランダム URL．毎回 URL が変わる．デモ用．',
    suggestedBindHost: '127.0.0.1',
    requireAuth: true,
    trustedProxySources: ['127.0.0.1/32', '::1/128'],
  },
  'cloudflare-named': {
    label: '固定 URL 公開 (Cloudflare Named Tunnel)',
    description: '独自ドメインで公開．Cloudflare アカウント + DNS 設定が必要．',
    suggestedBindHost: '127.0.0.1',
    requireAuth: true,
    trustedProxySources: ['127.0.0.1/32', '::1/128'],
  },
  'reverse-proxy': {
    label: 'reverse-proxy 経由 (nginx / Caddy / Traefik)',
    description: '前段 proxy で TLS 終端と認証．KJ_TRUSTED_PROXY_HEADER と組み合わせ可．',
    suggestedBindHost: '127.0.0.1',
    requireAuth: true,
    trustedProxySources: ['127.0.0.1/32', '::1/128'],
  },
  'custom': {
    label: '上級者カスタム',
    description: 'env を直接指定．preset 推奨値は無視される．',
    suggestedBindHost: null,
    requireAuth: false,
    trustedProxySources: [],
  },
};

/** R3 (2026-06-09): localhostAuto を強制 OFF する公開系 preset． */
const PUBLIC_PRESETS = new Set([
  'cloudflare-quick',
  'cloudflare-named',
  'tailscale-funnel',
  'reverse-proxy',
]);

/** Hard-coded defaults (ハードコード既定値．config も env も無い時の最終 fallback) */
const DEFAULTS = {
  network: {
    appBindHost: '0.0.0.0',
    appPort: 1234,
    adminBindHost: '127.0.0.1',
    adminPort: 1235,
    trustedProxySources: [],
  },
  limits: {
    maxPayloadBytes: 1 * 1024 * 1024,         // 1 MB
    maxConnectionsPerIp: 5,
    maxConnectionsPerRoom: 30,
    maxUpdatesPerSecond: 50,
  },
  compact: {
    onStartup: true,
    afterUpdates: 200,
    // Byte-based compaction (size-aware backstop to the count trigger).  The
    // count trigger alone is blind to update size: 200 bloated updates can grow
    // a room file to hundreds of MB before compaction fires.  Whichever trigger
    // (count OR accumulated bytes) hits first runs compaction.
    afterBytes: 16 * 1024 * 1024,             // 16 MB of appended updates → compact
    // Early-warning observability thresholds (log only; never block service).
    warnUpdateBytes: 256 * 1024,              // single update > 256 KB → warn
    warnFileBytes: 64 * 1024 * 1024,          // persisted file > 64 MB → warn
  },
  // 段階1 (2026-07-03): サーバー側スナップショット (compact とは独立の履歴保全).
  snapshots: {
    enabled: true,
    everyNOps: 20,        // N 操作ごとに 1 スナップショット
    everyMinutes: 5,      // T 分ごと (変更のあった room のみ)
    retention: 200,       // room ごとに直近 N 世代を保持
    mirrorDir: null,      // 対策6: 設定すると snapshots を別ディスク/OneDrive へ複製
  },
  // 対策2 (2026-07-03): サーキットブレーカー (大規模構造変更の検知).
  // 1 トランザクションで threshold(割合) を超えるメンバーシップ付替/カード移動が
  // 起きたら「破損直前状態」を即スナップショットし警告する (適用は止めない安全版).
  circuitBreaker: {
    enabled: true,
    threshold: 0.4,
  },
  origins: {
    allowedExplicit: [
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
      'https://kj-trace.localhost',
      'http://kj-trace.localhost',
      'http://localhost:1420',
      'http://127.0.0.1:1420',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:1234',
      'http://127.0.0.1:1234',
    ],
    allowEmpty: true,
    allowLocalhostAnyPort: true,
  },
  protocol: {
    requireKjStudio: false,
    strictViewer: false,
  },
  authPolicy: {
    inviteTokenEnabled: true,          // 常時 true
    roomPasswordEnabled: true,         // 常時 true
    legacyEmailEnabled: true,          // 環境変数で OFF 可能
    tailscaleEnabled: true,
    allowedCidrs: [],
    trustedProxyHeader: null,
    noneOpenEnabled: false,
    localhostAutoEnabled: false,       // R0/R3: 既定 false
    allowAutoRoomCreate: false,
  },
};

/** config/server.json を読む (なければ null) */
async function readConfigFile() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    console.warn('[config] failed to read config/server.json:', e.message);
    return null;
  }
}

/** admin token の解決．config/admin-token.txt を一次．env が override 可能． */
async function resolveAdminToken() {
  // 1. env override (CI/test 用)
  if (process.env.KJ_ADMIN_TOKEN) {
    return { token: process.env.KJ_ADMIN_TOKEN, source: 'env' };
  }
  // 2. file から読込 (start-server.bat が生成)
  try {
    const raw = await readFile(ADMIN_TOKEN_PATH, 'utf-8');
    const t = raw.trim();
    if (t.length > 0) return { token: t, source: 'file' };
  } catch (e) {
    // not exists
  }
  // 3. 自動生成 + 永続化
  try { await stat(CONFIG_DIR); } catch { await mkdir(CONFIG_DIR, { recursive: true }); }
  const generated = randomBytes(32).toString('hex'); // 64 hex
  try {
    await writeFile(ADMIN_TOKEN_PATH, generated, 'utf-8');
  } catch (e) {
    console.warn('[config] failed to persist admin-token.txt:', e.message);
  }
  return { token: generated, source: 'generated' };
}

/** config 優先で値を解決．config に明示値があれば env を無視．
 *  configValue が undefined のとき envValue (parser) を試し，それも無ければ defaultValue． */
function resolveValue(configValue, envName, parser, defaultValue) {
  if (configValue !== undefined && configValue !== null) return configValue;
  const envRaw = process.env[envName];
  if (envRaw !== undefined && envRaw !== '') {
    return parser(envRaw);
  }
  return defaultValue;
}

const asNumber = (s) => Number(s);
const asBoolean = (s) => s !== 'false';        // 既定 true な変数用
const asBooleanStrict = (s) => s === 'true';   // 既定 false な変数用
const asString = (s) => s;
const asStringArray = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Phase 0 R5 + R2 + R3 + R6 + R1 統合の resolved config を返す．
 *  bootConfig() で全モジュール共通の resolved config を作る．
 *  以降は getResolvedConfig() で参照する． */
export async function loadServerConfig() {
  const fileCfg = (await readConfigFile()) ?? {};
  return resolveServerConfig(fileCfg);
}

/** 旧ウィザード (2026-11-07 修正前) は authPolicy ではなく auth.{legacyEmail,allowedCidrs,
 *  trustedProxyHeader} に書いていたため，サーバーに黙って無視されていた．
 *  authPolicy に明示値が無い項目だけ auth から読み替え，必ず警告を出す (fail-loud)． */
function readLegacyAuthSection(fileCfg) {
  const legacy = fileCfg.auth;
  if (!legacy || typeof legacy !== 'object') return { values: {}, warning: null };
  const ap = fileCfg.authPolicy ?? {};
  const values = {};
  const mapped = [];
  if (typeof legacy.legacyEmail === 'boolean' && ap.legacyEmailEnabled == null) {
    values.legacyEmailEnabled = legacy.legacyEmail;
    mapped.push(`auth.legacyEmail→authPolicy.legacyEmailEnabled=${legacy.legacyEmail}`);
  }
  if (Array.isArray(legacy.allowedCidrs) && legacy.allowedCidrs.length > 0 && ap.allowedCidrs == null) {
    values.allowedCidrs = legacy.allowedCidrs;
    mapped.push(`auth.allowedCidrs→authPolicy.allowedCidrs`);
  }
  if (typeof legacy.trustedProxyHeader === 'string' && legacy.trustedProxyHeader && ap.trustedProxyHeader == null) {
    values.trustedProxyHeader = legacy.trustedProxyHeader;
    mapped.push(`auth.trustedProxyHeader→authPolicy.trustedProxyHeader`);
  }
  const warning =
    'config/server.json の "auth" は旧形式 (旧ウィザードの不具合で無視されていた)．' +
    (mapped.length ? `読み替えた: ${mapped.join(', ')}．` : '読み替える項目は無かった．') +
    ' npm run setup をやり直すか "authPolicy" に書き換えてください';
  return { values, warning };
}

/** fileCfg (config/server.json の中身) と env から resolved config を組み立てる．
 *  テストでは fileCfg と adminTokenInfo を直接渡せる (本物の config/ を読まない)． */
export async function resolveServerConfig(fileCfg = {}, opts = {}) {
  const legacyAuth = readLegacyAuthSection(fileCfg);
  const presetName = resolveValue(
    fileCfg.exposure?.preset,
    'KJ_EXPOSURE_PRESET',
    asString,
    'custom'
  );
  const preset = EXPOSURE_PRESETS[presetName] ?? EXPOSURE_PRESETS.custom;

  // network
  const appBindHost = resolveValue(
    fileCfg.network?.appBindHost,
    'KJ_APP_BIND_HOST',
    asString,
    preset.suggestedBindHost ?? DEFAULTS.network.appBindHost
  );
  const appPort = resolveValue(
    fileCfg.network?.appPort,
    'PORT',
    asNumber,
    DEFAULTS.network.appPort
  );
  const adminBindHost = resolveValue(
    fileCfg.network?.adminBindHost,
    'KJ_ADMIN_BIND_HOST',
    asString,
    DEFAULTS.network.adminBindHost
  );
  const adminPort = resolveValue(
    fileCfg.network?.adminPort,
    'KJ_ADMIN_PORT',
    asNumber,
    DEFAULTS.network.adminPort
  );
  const trustedProxySources = resolveValue(
    fileCfg.network?.trustedProxySources,
    'KJ_TRUSTED_PROXY_SOURCES',
    asStringArray,
    preset.trustedProxySources ?? DEFAULTS.network.trustedProxySources
  );

  // limits
  const limits = {
    maxPayloadBytes: resolveValue(
      fileCfg.limits?.maxPayloadBytes,
      'KJ_MAX_PAYLOAD_BYTES',
      asNumber,
      DEFAULTS.limits.maxPayloadBytes
    ),
    maxConnectionsPerIp: resolveValue(
      fileCfg.limits?.maxConnectionsPerIp,
      'KJ_MAX_CONN_PER_IP',
      asNumber,
      DEFAULTS.limits.maxConnectionsPerIp
    ),
    maxConnectionsPerRoom: resolveValue(
      fileCfg.limits?.maxConnectionsPerRoom,
      'KJ_MAX_CONN_PER_ROOM',
      asNumber,
      DEFAULTS.limits.maxConnectionsPerRoom
    ),
    maxUpdatesPerSecond: resolveValue(
      fileCfg.limits?.maxUpdatesPerSecond,
      'KJ_MAX_UPDATES_PER_SEC',
      asNumber,
      DEFAULTS.limits.maxUpdatesPerSecond
    ),
  };

  // compact
  const compact = {
    onStartup: resolveValue(
      fileCfg.compact?.onStartup,
      'KJ_COMPACT_ON_STARTUP',
      asBoolean,
      DEFAULTS.compact.onStartup
    ),
    afterUpdates: resolveValue(
      fileCfg.compact?.afterUpdates,
      'KJ_COMPACT_AFTER_UPDATES',
      asNumber,
      DEFAULTS.compact.afterUpdates
    ),
    afterBytes: resolveValue(
      fileCfg.compact?.afterBytes,
      'KJ_COMPACT_AFTER_BYTES',
      asNumber,
      DEFAULTS.compact.afterBytes
    ),
    warnUpdateBytes: resolveValue(
      fileCfg.compact?.warnUpdateBytes,
      'KJ_COMPACT_WARN_UPDATE_BYTES',
      asNumber,
      DEFAULTS.compact.warnUpdateBytes
    ),
    warnFileBytes: resolveValue(
      fileCfg.compact?.warnFileBytes,
      'KJ_COMPACT_WARN_FILE_BYTES',
      asNumber,
      DEFAULTS.compact.warnFileBytes
    ),
  };

  // snapshots (段階1)
  const snapshots = {
    enabled: resolveValue(
      fileCfg.snapshots?.enabled,
      'KJ_SNAPSHOTS_ENABLED',
      asBoolean,
      DEFAULTS.snapshots.enabled
    ),
    everyNOps: resolveValue(
      fileCfg.snapshots?.everyNOps,
      'KJ_SNAPSHOT_EVERY_OPS',
      asNumber,
      DEFAULTS.snapshots.everyNOps
    ),
    everyMinutes: resolveValue(
      fileCfg.snapshots?.everyMinutes,
      'KJ_SNAPSHOT_EVERY_MINUTES',
      asNumber,
      DEFAULTS.snapshots.everyMinutes
    ),
    retention: resolveValue(
      fileCfg.snapshots?.retention,
      'KJ_SNAPSHOT_RETENTION',
      asNumber,
      DEFAULTS.snapshots.retention
    ),
    mirrorDir: resolveValue(
      fileCfg.snapshots?.mirrorDir,
      'KJ_SNAPSHOT_MIRROR_DIR',
      asString,
      DEFAULTS.snapshots.mirrorDir
    ),
  };

  // circuitBreaker (対策2)
  const circuitBreaker = {
    enabled: resolveValue(
      fileCfg.circuitBreaker?.enabled,
      'KJ_CIRCUIT_BREAKER_ENABLED',
      asBoolean,
      DEFAULTS.circuitBreaker.enabled
    ),
    threshold: resolveValue(
      fileCfg.circuitBreaker?.threshold,
      'KJ_CIRCUIT_BREAKER_THRESHOLD',
      asNumber,
      DEFAULTS.circuitBreaker.threshold
    ),
  };

  // origins
  const origins = {
    allowedExplicit: resolveValue(
      fileCfg.origins?.allowedExplicit,
      'KJ_ALLOWED_ORIGINS',
      asStringArray,
      DEFAULTS.origins.allowedExplicit
    ),
    allowEmpty: resolveValue(
      fileCfg.origins?.allowEmpty,
      'KJ_ALLOW_EMPTY_ORIGIN',
      asBoolean,
      DEFAULTS.origins.allowEmpty
    ),
    allowLocalhostAnyPort: resolveValue(
      fileCfg.origins?.allowLocalhostAnyPort,
      'KJ_ALLOW_LOCALHOST_ANY_PORT',
      asBoolean,
      DEFAULTS.origins.allowLocalhostAnyPort
    ),
  };

  // protocol
  const protocol = {
    requireKjStudio: resolveValue(
      fileCfg.protocol?.requireKjStudio,
      'KJ_REQUIRE_KJ_STUDIO_PROTOCOL',
      asBooleanStrict,
      DEFAULTS.protocol.requireKjStudio
    ),
    strictViewer: resolveValue(
      fileCfg.protocol?.strictViewer,
      'KJ_STRICT_VIEWER',
      asBooleanStrict,
      DEFAULTS.protocol.strictViewer
    ),
  };

  // authPolicy
  const authPolicy = {
    inviteTokenEnabled: true,   // 常時
    roomPasswordEnabled: true,  // 常時
    // 2026-11-07: 公開系 preset では既定 false (自己申告の email はなりすませるため)．
    // 明示 (config / env) すれば従来どおり true にもできる．
    legacyEmailEnabled: resolveValue(
      fileCfg.authPolicy?.legacyEmailEnabled ?? legacyAuth.values.legacyEmailEnabled,
      'KJ_AUTH_LEGACY_EMAIL',
      asBoolean,
      PUBLIC_PRESETS.has(presetName) ? false : DEFAULTS.authPolicy.legacyEmailEnabled
    ),
    tailscaleEnabled: resolveValue(
      fileCfg.authPolicy?.tailscaleEnabled,
      'KJ_TAILSCALE_NETWORK_OK',
      asBoolean,
      DEFAULTS.authPolicy.tailscaleEnabled
    ),
    allowedCidrs: resolveValue(
      fileCfg.authPolicy?.allowedCidrs ?? legacyAuth.values.allowedCidrs,
      'KJ_ALLOWED_CIDRS',
      asStringArray,
      DEFAULTS.authPolicy.allowedCidrs
    ),
    trustedProxyHeader: resolveValue(
      fileCfg.authPolicy?.trustedProxyHeader ?? legacyAuth.values.trustedProxyHeader,
      'KJ_TRUSTED_PROXY_HEADER',
      asString,
      DEFAULTS.authPolicy.trustedProxyHeader
    ),
    noneOpenEnabled: resolveValue(
      fileCfg.authPolicy?.noneOpenEnabled,
      'KJ_ALLOW_NO_AUTH_OPEN_ROOM',
      asBooleanStrict,
      DEFAULTS.authPolicy.noneOpenEnabled
    ),
    localhostAutoEnabled: resolveValue(
      fileCfg.authPolicy?.localhostAutoEnabled,
      'KJ_LOCALHOST_AUTO_TRUST',
      asBooleanStrict,
      DEFAULTS.authPolicy.localhostAutoEnabled
    ),
    allowAutoRoomCreate: resolveValue(
      fileCfg.authPolicy?.allowAutoRoomCreate,
      'KJ_ALLOW_AUTO_ROOM_CREATE',
      asBooleanStrict,
      DEFAULTS.authPolicy.allowAutoRoomCreate
    ),
  };

  // R3: 公開系 preset では localhostAuto を強制 OFF
  const warnings = [];
  if (legacyAuth.warning) warnings.push(legacyAuth.warning);
  if (PUBLIC_PRESETS.has(presetName)) {
    if (authPolicy.localhostAutoEnabled) {
      warnings.push(
        `exposure='${presetName}': localhostAuto を強制 OFF にしました ` +
        `(proxy/tunnel 経由で 127.0.0.1 に見える誤判定リスク)`
      );
    }
    authPolicy.localhostAutoEnabled = false;
  }

  // Sec-112: 整合性チェック
  if (preset.requireAuth && authPolicy.noneOpenEnabled) {
    warnings.push(
      `exposure='${presetName}' は公開インターネット用だが noneOpenEnabled=true → ` +
      `誰でも編集できる open room が作られる危険`
    );
  }
  if (preset.requireAuth && authPolicy.legacyEmailEnabled) {
    warnings.push(
      `exposure='${presetName}' で email-legacy 認証が有効．スプーフィング可能な経路なので ` +
      `公開用には Cloudflare Access / room-token への移行を推奨`
    );
  }
  if (appBindHost === '0.0.0.0' && presetName === 'local') {
    warnings.push(`exposure='local' なのに appBindHost=0.0.0.0．LAN 全体に公開されている`);
  }

  // admin token 解決
  const adminTokenInfo = opts.adminTokenInfo ?? await resolveAdminToken();

  // active providers (banner 用)
  const providers = ['room-token'];
  if (authPolicy.legacyEmailEnabled) providers.push('email-legacy');
  if (authPolicy.tailscaleEnabled) providers.push('tailscale-network');
  if (authPolicy.allowedCidrs.length > 0) providers.push('ip-cidr');
  if (authPolicy.trustedProxyHeader) providers.push('trusted-proxy');
  if (authPolicy.noneOpenEnabled) providers.push('none-open-room');
  if (authPolicy.localhostAutoEnabled) providers.push('localhost-auto');
  providers.push('room-password');

  return {
    preset: { name: presetName, ...preset },
    network: { appBindHost, appPort, adminBindHost, adminPort, trustedProxySources },
    limits,
    compact,
    snapshots,
    circuitBreaker,
    origins,
    protocol,
    authPolicy,
    admin: { token: adminTokenInfo.token, tokenSource: adminTokenInfo.source },
    auth: { providers },  // banner 用 (旧互換 + 表示用)
    warnings,
    rawFileConfig: fileCfg,
  };
}

/** R5 (2026-06-09): bootConfig() で 1 度だけ resolved config を作り，シングルトンとして保持．
 *  以降は getResolvedConfig() で参照する． */
let _resolvedConfig = null;

export async function bootConfig() {
  _resolvedConfig = await loadServerConfig();
  return _resolvedConfig;
}

export function getResolvedConfig() {
  if (!_resolvedConfig) {
    throw new Error('config not loaded: call bootConfig() first (only in tests can you use setResolvedConfigForTest)');
  }
  return _resolvedConfig;
}

/** テスト用: resolved config を上書き．本番では使わない． */
export function setResolvedConfigForTest(cfg) {
  _resolvedConfig = cfg;
}

/** Sec-121〜126: プリセット適用．config/server.json を書き換える． */
export async function applyExposurePreset(presetName, overrides = {}) {
  if (!EXPOSURE_PRESETS[presetName]) {
    throw new Error(`unknown preset: ${presetName}`);
  }
  const preset = EXPOSURE_PRESETS[presetName];
  try { await stat(CONFIG_DIR); } catch { await mkdir(CONFIG_DIR, { recursive: true }); }
  const existing = (await readConfigFile()) ?? {};
  const merged = {
    ...existing,
    // 2026-11-07: 旧コードは { preset, ...existing.exposure } の順で，既存の preset が
    // 新しい preset を上書きし，切り替えが効かなかった．既存を先に広げてから上書きする．
    exposure: { ...(existing.exposure ?? {}), preset: presetName, ...overrides.exposure },
    network: {
      ...(existing.network ?? {}),
      ...(preset.suggestedBindHost && { appBindHost: preset.suggestedBindHost }),
      ...(preset.trustedProxySources && { trustedProxySources: preset.trustedProxySources }),
      ...(overrides.network ?? {}),
    },
    authPolicy: {
      ...(existing.authPolicy ?? {}),
      // preset.requireAuth=true なら自動で noneOpenEnabled=false
      ...(preset.requireAuth && { noneOpenEnabled: false }),
      ...(overrides.authPolicy ?? {}),
    },
    appliedAt: new Date().toISOString(),
  };
  await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

/** Sec-103: 起動時の状態表示 banner */
export function printStartupBanner(cfg) {
  const lines = [];
  lines.push('============================================================');
  lines.push('  Affinity Mapping Studio Server');
  lines.push('------------------------------------------------------------');
  lines.push(`  公開方式 (exposure): ${cfg.preset.name}  ${cfg.preset.label ?? ''}`);
  if (cfg.preset.description) lines.push(`    ${cfg.preset.description}`);
  lines.push(`  共同作業 endpoint  : http://${cfg.network.appBindHost}:${cfg.network.appPort}`);
  lines.push(`  管理 endpoint      : http://${cfg.network.adminBindHost}:${cfg.network.adminPort}/admin  (localhost-only)`);
  lines.push(`  認証方式 (active)  : ${cfg.auth.providers.join(', ')}`);
  lines.push(`  trusted-proxy CIDR : ${cfg.network.trustedProxySources.join(', ') || '(none)'}`);
  lines.push(`  admin token source : ${cfg.admin.tokenSource}`);
  if (cfg.snapshots) {
    lines.push(
      cfg.snapshots.enabled
        ? `  スナップショット   : ${cfg.snapshots.everyNOps}操作 / ${cfg.snapshots.everyMinutes}分 / pre-compact, retention=${cfg.snapshots.retention}`
        : `  スナップショット   : 無効 (KJ_SNAPSHOTS_ENABLED=false)`
    );
    if (cfg.snapshots.enabled && cfg.snapshots.mirrorDir) {
      lines.push(`  スナップショット複製: ${cfg.snapshots.mirrorDir}`);
    }
  }
  if (cfg.circuitBreaker) {
    lines.push(
      cfg.circuitBreaker.enabled
        ? `  サーキットブレーカー: ${Math.round(cfg.circuitBreaker.threshold * 100)}%超の一括構造変更を検知→直前状態を保全`
        : `  サーキットブレーカー: 無効 (KJ_CIRCUIT_BREAKER_ENABLED=false)`
    );
  }
  if (cfg.warnings.length > 0) {
    lines.push('------------------------------------------------------------');
    lines.push('  [WARN] 設定上の警告:');
    for (const w of cfg.warnings) lines.push(`    - ${w}`);
  }
  lines.push('============================================================');
  for (const l of lines) console.log(l);
}
