// C3: Cloudflare Quick Tunnel パネル．
//
// 機能:
//   - runtime.json polling (3s 毎)
//   - 起動ボタン (R16 confirm warning 必須)
//   - 停止ボタン
//   - URL コピー
//   - 状態 (running / URL / pid / uptime / target / mode)
//   - cloudflared 未検出時は InstallCloudflareDialog を出す

import { useEffect, useRef, useState } from 'react';
import {
  detectCloudflared,
  readRuntime,
  tunnelStart,
  tunnelStop,
  type CloudflareRuntime,
} from '../api/tauri';
import InstallCloudflareDialog from './InstallCloudflareDialog';

interface Props {
  serverPath: string | null;
  serverRunning: boolean;
}

export default function TunnelPanel({ serverPath, serverRunning }: Props) {
  const [cf, setCf] = useState<CloudflareRuntime>({
    running: false,
    url: null,
    pid: null,
    startedAt: null,
    target: null,
    targetPort: null,
    mode: null,
  });
  const [cloudflaredPath, setCloudflaredPath] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    detectCloudflared().then(setCloudflaredPath).catch(() => setCloudflaredPath(null));
  }, []);

  // poll runtime.json
  useEffect(() => {
    if (!serverPath) {
      if (pollRef.current) window.clearInterval(pollRef.current);
      return;
    }
    const tick = async () => {
      try {
        const r = await readRuntime(serverPath);
        setCf(r.cloudflare);
      } catch {
        /* runtime.json なしは正常 */
      }
    };
    tick();
    pollRef.current = window.setInterval(tick, 3000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [serverPath]);

  const uptime = cf.running && cf.startedAt
    ? Math.floor((now - new Date(cf.startedAt).getTime()) / 1000)
    : 0;
  const fmtUp = (s: number) => {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };

  async function handleStart() {
    if (!serverPath) {
      setErr('サーバーパスが未設定です');
      return;
    }
    if (!cloudflaredPath) {
      setInstallOpen(true);
      return;
    }
    const ok = window.confirm(
      'Cloudflare Quick Tunnel を起動します．\n\n' +
        '⚠ デモ用途モード\n' +
        '- この URL は毎回ランダムに発行されます\n' +
        '- cloudflared 終了で URL が変わります\n' +
        '- 7 日間の使用制限あり (Cloudflare 規約)\n' +
        '- 長期運用には Named Tunnel を推奨\n\n' +
        '起動しますか?',
    );
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await tunnelStart(serverPath);
      if (!res.ok) setErr(res.message || 'tunnel start failed');
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    if (!serverPath) return;
    setBusy(true);
    setErr(null);
    try {
      await tunnelStop(serverPath);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!cf.url) return;
    try {
      await navigator.clipboard.writeText(cf.url);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="panel">
      <h2>Cloudflare Quick Tunnel</h2>

      <div className="status-row">
        <span className={`status-badge ${cf.running ? 'running' : 'stopped'}`}>
          {cf.running ? 'RUNNING' : 'STOPPED'}
        </span>
        {cf.running && cf.pid != null && (
          <span className="status-meta">
            pid {cf.pid} · uptime {fmtUp(uptime)} · target {cf.target ?? 'app'}:{cf.targetPort ?? '?'}
          </span>
        )}
        {!cloudflaredPath && (
          <span className="status-meta" style={{ color: 'var(--warn)' }}>
            cloudflared 未検出
          </span>
        )}
      </div>

      {cf.running && cf.url && (
        <div className="form-row" style={{ marginTop: 6 }}>
          <label>URL</label>
          <code
            style={{
              flex: 1,
              padding: '4px 8px',
              background: '#fafafa',
              border: '1px solid var(--border)',
              borderRadius: 3,
              fontSize: 11,
              wordBreak: 'break-all',
            }}
          >
            {cf.url}
          </code>
          <button onClick={handleCopy}>コピー</button>
        </div>
      )}

      <div className="btn-row">
        {!cf.running ? (
          <button
            className="primary"
            onClick={handleStart}
            disabled={busy || !serverPath || !serverRunning}
            title={
              !serverRunning ? 'サーバーが停止中です．先にサーバーを起動してください' : ''
            }
          >
            {cloudflaredPath ? '起動 (Quick Tunnel)' : 'cloudflared をインストール'}
          </button>
        ) : (
          <button className="danger" onClick={handleStop} disabled={busy}>
            停止
          </button>
        )}
        {!cloudflaredPath && (
          <button onClick={() => setInstallOpen(true)} disabled={busy}>
            インストール手順
          </button>
        )}
      </div>

      {err && <div className="err">{err}</div>}

      {installOpen && (
        <InstallCloudflareDialog
          onClose={() => setInstallOpen(false)}
          onInstalled={async () => {
            const p = await detectCloudflared();
            setCloudflaredPath(p);
            setInstallOpen(false);
          }}
        />
      )}
    </div>
  );
}
