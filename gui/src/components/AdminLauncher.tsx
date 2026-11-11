// C4: 管理画面ランチャ．admin URL を fragment 付きで開く．

import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { adminUrl, readAdminToken } from '../api/tauri';

interface Props {
  serverPath: string | null;
  serverRunning: boolean;
}

export default function AdminLauncher({ serverPath, serverRunning }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  async function handleOpen() {
    if (!serverPath) {
      setErr('サーバーパスが未設定です');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const url = await adminUrl(serverPath, undefined);
      await openUrl(url);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleShowToken() {
    if (!serverPath) {
      setErr('サーバーパスが未設定です');
      return;
    }
    try {
      const t = await readAdminToken(serverPath);
      setToken(t);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function handleCopyToken() {
    if (!serverPath) return;
    try {
      const t = token ?? (await readAdminToken(serverPath));
      await navigator.clipboard.writeText(t);
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="panel">
      <h2>管理画面 (Browser Admin)</h2>

      <div className="btn-row">
        <button
          className="primary"
          onClick={handleOpen}
          disabled={busy || !serverPath || !serverRunning}
          title={
            !serverRunning ? 'サーバーが停止中です．先にサーバーを起動してください' : ''
          }
        >
          管理画面を開く
        </button>
        <button onClick={handleCopyToken} disabled={!serverPath || busy}>
          admin token コピー
        </button>
        <button onClick={handleShowToken} disabled={!serverPath || busy}>
          {token ? 'token を隠す' : 'token を表示'}
        </button>
      </div>

      {token && (
        <div className="form-row" style={{ marginTop: 6 }}>
          <label>token</label>
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
            {token}
          </code>
          <button onClick={() => setToken(null)}>×</button>
        </div>
      )}

      <p className="small muted" style={{ marginTop: 6 }}>
        ブラウザで <code>#_t=&lt;token&gt;</code> 付き URL を開きます (fragment は server に送らず
        access.log にも残りません)．
      </p>

      {err && <div className="err">{err}</div>}
    </div>
  );
}
