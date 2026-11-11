import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  serverStatus,
  serverStart,
  serverStop,
  loadSettings,
  saveSettings,
  onServerStatus,
  adminUrl,
  bundlePaths,
  type ServerStatusPayload,
} from '../api/tauri';

interface Props {
  onStatusChange?: (s: ServerStatusPayload) => void;
}

function fmtUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${secs % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ServerStatus({ onStatusChange }: Props) {
  const [status, setStatus] = useState<ServerStatusPayload>({
    running: false,
    pid: null,
    startedAt: null,
    serverPath: null,
  });
  const [serverPath, setServerPath] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [err, setErr] = useState<string | null>(null);

  // 初期 settings 読込 + status poll + status event subscribe
  useEffect(() => {
    (async () => {
      try {
        // 同梱のサーバがあれば常にそれを使う (インストール先が変わっても古い設定に引きずられない)．
        const b = await bundlePaths().catch(() => null);
        const s = await loadSettings();
        if (b?.serverPath) {
          setServerPath(b.serverPath);
        } else if (s.serverPath) {
          setServerPath(s.serverPath);
        }
        const cur = await serverStatus();
        setStatus(cur);
        onStatusChange?.(cur);
      } catch (e) {
        setErr(`init: ${e}`);
      }
    })();
    let unlistenFn: (() => void) | undefined;
    onServerStatus((s) => {
      setStatus(s);
      onStatusChange?.(s);
    }).then((f) => {
      unlistenFn = f;
    });
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      clearInterval(tick);
      unlistenFn?.();
    };
  }, [onStatusChange]);

  const pickServerPath = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'サーバのフォルダを選択',
      defaultPath: serverPath || undefined,
    });
    if (typeof selected === 'string' && selected) {
      setServerPath(selected);
      await saveSettings({ serverPath: selected });
    }
  };

  const doStart = async () => {
    setErr(null);
    if (!serverPath) {
      setErr('サーバのフォルダが分かりません．インストールし直してください');
      return;
    }
    setBusy(true);
    try {
      await serverStart(serverPath);
    } catch (e) {
      setErr(`start: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const doStop = async () => {
    setErr(null);
    setBusy(true);
    try {
      await serverStop();
    } catch (e) {
      setErr(`stop: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const doRestart = async () => {
    await doStop();
    setTimeout(() => doStart(), 500);
  };

  // C5: 起動 + admin を開く (poll で running になったら自動 open)
  const doQuickLaunch = async () => {
    setErr(null);
    if (!serverPath) {
      setErr('サーバのフォルダが分かりません．インストールし直してください');
      return;
    }
    setBusy(true);
    try {
      if (!status.running) await serverStart(serverPath);
      // 起動完了まで待機 (admin token / port が立ち上がるまで最大 8s polling)
      const start = Date.now();
      while (Date.now() - start < 8000) {
        try {
          const url = await adminUrl(serverPath, undefined);
          await openUrl(url);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      setErr('admin URL が 8 秒以内に取得できませんでした');
    } catch (e) {
      setErr(`quick-launch: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const uptime = status.startedAt ? fmtUptime(now - status.startedAt) : '-';

  return (
    <section className="panel">
      <h2>サーバー</h2>
      <div className="status-row">
        <span
          className={`status-badge ${status.running ? 'running' : 'stopped'}`}
        >
          {status.running ? '● 稼働中' : '○ 停止'}
        </span>
        {status.running && (
          <span className="status-meta">
            PID: {status.pid} / uptime: {uptime}
          </span>
        )}
      </div>

      <div className="form-row">
        <label>server path:</label>
        <input
          type="text"
          value={serverPath}
          readOnly
          placeholder="サーバのフォルダ"
          style={{ flex: 1 }}
        />
        <button onClick={pickServerPath} disabled={busy}>
          ▤ 選択
        </button>
      </div>

      <div className="btn-row">
        {!status.running ? (
          <>
            <button className="primary" onClick={doStart} disabled={busy}>
              ▶ 起動
            </button>
            <button onClick={doQuickLaunch} disabled={busy} title="起動して admin を開く">
              ▶ 起動 + admin を開く
            </button>
          </>
        ) : (
          <>
            <button className="danger" onClick={doStop} disabled={busy}>
              ◼ 停止
            </button>
            <button onClick={doRestart} disabled={busy}>
              ↻ 再起動
            </button>
            <button onClick={doQuickLaunch} disabled={busy}>
              ▤ admin を開く
            </button>
          </>
        )}
      </div>

      {err && <div className="err">{err}</div>}
    </section>
  );
}
