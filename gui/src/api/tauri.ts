// Tauri 2 invoke / event wrappers
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface HelloResponse {
  version: string;
  platform: string;
  arch: string;
}

export interface ServerStatusPayload {
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  serverPath: string | null;
}

export interface LogLinePayload {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface Settings {
  serverPath?: string | null;
}

function camelize<T>(o: unknown): T {
  // serde の snake_case → JS camelCase 変換 (Tauri 2 では自動ではない)
  if (o === null || typeof o !== 'object') return o as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const key = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = v;
  }
  return out as T;
}

export async function hello(): Promise<HelloResponse> {
  return camelize(await invoke<HelloResponse>('hello'));
}

export async function serverStatus(): Promise<ServerStatusPayload> {
  return camelize(await invoke<ServerStatusPayload>('server_status'));
}

export async function serverStart(serverPath: string): Promise<ServerStatusPayload> {
  return camelize(await invoke<ServerStatusPayload>('server_start', { serverPath }));
}

export async function serverStop(): Promise<ServerStatusPayload> {
  return camelize(await invoke<ServerStatusPayload>('server_stop'));
}

export async function loadSettings(): Promise<Settings> {
  return camelize(await invoke<Settings>('settings_load'));
}

export async function saveSettings(settings: Settings): Promise<void> {
  // Rust 側は server_path snake_case を期待
  const payload = {
    settings: {
      server_path: settings.serverPath ?? null,
    },
  };
  return invoke('settings_save', payload);
}

export async function onServerLog(handler: (l: LogLinePayload) => void): Promise<UnlistenFn> {
  return listen<LogLinePayload>('server:log', (ev) => handler(camelize(ev.payload)));
}

export async function onServerStatus(handler: (s: ServerStatusPayload) => void): Promise<UnlistenFn> {
  return listen<ServerStatusPayload>('server:status', (ev) => handler(camelize(ev.payload)));
}

// === C3 / C4: runtime + tunnel ===

export interface CloudflareRuntime {
  running: boolean;
  url: string | null;
  pid: number | null;
  startedAt: string | null;
  target: string | null;
  targetPort: number | null;
  mode: string | null;
}

export interface RuntimeInfo {
  cloudflare: CloudflareRuntime;
  writtenAt: string | null;
}

export interface TunnelResult {
  ok: boolean;
  url: string | null;
  message: string;
}

export async function readRuntime(serverPath: string): Promise<RuntimeInfo> {
  const raw = await invoke<RuntimeInfo>('read_runtime', { serverPath });
  // serde の rename で camelCase に来るはずだが念のため
  const r = raw as unknown as Record<string, unknown>;
  const cf = (r.cloudflare ?? {}) as Record<string, unknown>;
  return {
    cloudflare: {
      running: Boolean(cf.running),
      url: (cf.url as string) ?? null,
      pid: (cf.pid as number) ?? null,
      startedAt: (cf.startedAt as string) ?? (cf.started_at as string) ?? null,
      target: (cf.target as string) ?? null,
      targetPort: (cf.targetPort as number) ?? (cf.target_port as number) ?? null,
      mode: (cf.mode as string) ?? null,
    },
    writtenAt: (r.writtenAt as string) ?? (r.written_at as string) ?? null,
  };
}

export async function readAdminToken(serverPath: string): Promise<string> {
  return invoke<string>('read_admin_token', { serverPath });
}

export async function adminUrl(serverPath: string, port?: number): Promise<string> {
  return invoke<string>('admin_url', { serverPath, port: port ?? null });
}

export async function tunnelStart(serverPath: string): Promise<TunnelResult> {
  return camelize(await invoke<TunnelResult>('tunnel_start', { serverPath }));
}

export async function tunnelStop(serverPath: string): Promise<TunnelResult> {
  return camelize(await invoke<TunnelResult>('tunnel_stop', { serverPath }));
}

// === R9: cloudflared install ===

export interface InstallLogLine {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface InstallResult {
  code: number;
  success: boolean;
}

export async function detectCloudflared(): Promise<string | null> {
  return invoke<string | null>('detect_cloudflared');
}

export async function installCloudflared(): Promise<InstallResult> {
  return camelize(await invoke<InstallResult>('install_cloudflared'));
}

export async function onInstallLog(handler: (l: InstallLogLine) => void): Promise<UnlistenFn> {
  return listen<InstallLogLine>('install:log', (ev) => handler(camelize(ev.payload)));
}

// === C6: bundled resources / bootstrap ===

export interface BundlePaths {
  serverPath: string | null;
  nodePath: string | null;
  cloudflaredPath: string | null;
  installed: boolean;
}

export interface SetupLogLine {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface SetupResult {
  code: number;
  success: boolean;
}

export async function bundlePaths(): Promise<BundlePaths> {
  return camelize(await invoke<BundlePaths>('bundle_paths'));
}

export async function bootstrapInstall(): Promise<SetupResult> {
  return camelize(await invoke<SetupResult>('bootstrap_install'));
}

export async function onSetupLog(handler: (l: SetupLogLine) => void): Promise<UnlistenFn> {
  return listen<SetupLogLine>('setup:log', (ev) => handler(camelize(ev.payload)));
}
