import { useCallback, useEffect, useState } from 'react';
import { ServerStatus } from './components/ServerStatus';
import { LogTail } from './components/LogTail';
import TunnelPanel from './components/TunnelPanel';
import AdminLauncher from './components/AdminLauncher';
import SetupModal from './components/SetupModal';
import { bundlePaths, saveSettings, type BundlePaths, type ServerStatusPayload } from './api/tauri';

function fmtUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function App() {
  // G1 (2026-06-09): 時刻表示 + uptime
  const [now, setNow] = useState(new Date());
  const [status, setStatus] = useState<ServerStatusPayload>({
    running: false,
    pid: null,
    startedAt: null,
    serverPath: null,
  });
  // C6 (2026-06-10): 起動時 bundle 解決 + bootstrap
  const [setupDone, setSetupDone] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // 起動時: serverPath 設定無 + bundle 利用可なら settings に書き込んで onboarding を省略
  useEffect(() => {
    (async () => {
      try {
        // 同梱のサーバがあれば常にそれを保存する (古いインストール先の設定を残さない)．
        const p = await bundlePaths();
        if (p.serverPath) {
          await saveSettings({ serverPath: p.serverPath });
        }
      } catch {
        /* dev mode で resources なしのケース．無視 */
      }
    })();
  }, []);

  const handleSetupDone = useCallback((p: BundlePaths) => {
    setSetupDone(true);
    if (p.serverPath) {
      // serverPath を再保存 (上の effect と冪等)
      saveSettings({ serverPath: p.serverPath }).catch(() => {});
    }
  }, []);

  const uptimeSec = status.startedAt
    ? Math.floor(Date.now() / 1000) - status.startedAt
    : 0;

  return (
    <div className="app-root">
      {!setupDone && <SetupModal onDone={handleSetupDone} />}
      <header className="app-header">
        <h1>Affinity Mapping Studio Server</h1>
        <div className="app-clock">
          {now.toLocaleTimeString('ja-JP')}
          {status.running && (
            <span className="uptime-chip"> · uptime {fmtUptime(uptimeSec)}</span>
          )}
        </div>
      </header>
      <main className="app-main">
        <ServerStatus onStatusChange={setStatus} />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 320px', minWidth: 320 }}>
            <AdminLauncher
              serverPath={status.serverPath}
              serverRunning={status.running}
            />
          </div>
          <div style={{ flex: '1 1 320px', minWidth: 320 }}>
            <TunnelPanel
              serverPath={status.serverPath}
              serverRunning={status.running}
            />
          </div>
        </div>
        <LogTail />
      </main>
    </div>
  );
}
