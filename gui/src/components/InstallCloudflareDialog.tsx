// R9: cloudflared install ダイアログ．
//
// Windows: 「自動インストール」ボタン → winget spawn + stdout/stderr live tail．
// Mac/Linux: コマンド表示のみ (コピー)．
// confirm 必須 + 実行コマンドを明示．

import { useEffect, useRef, useState } from 'react';
import { installCloudflared, onInstallLog, type InstallLogLine } from '../api/tauri';
import type { UnlistenFn } from '@tauri-apps/api/event';

interface Props {
  onClose: () => void;
  onInstalled: () => void;
}

const isWindows = navigator.userAgent.toLowerCase().includes('win');

const MANUAL_COMMANDS: { os: string; cmd: string }[] = [
  {
    os: 'Windows (winget)',
    cmd: 'winget install --id Cloudflare.cloudflared -e',
  },
  { os: 'macOS (Homebrew)', cmd: 'brew install cloudflared' },
  { os: 'Linux (Debian/Ubuntu)', cmd: 'sudo apt install cloudflared' },
];

export default function InstallCloudflareDialog({ onClose, onInstalled }: Props) {
  const [lines, setLines] = useState<InstallLogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; code: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    onInstallLog((l) => {
      setLines((prev) => [...prev.slice(-499), l]);
    }).then((un) => {
      unlistenRef.current = un;
    });
    return () => {
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  async function handleAutoInstall() {
    const ok = window.confirm(
      '以下のコマンドを実行します:\n\n' +
        'winget install --id Cloudflare.cloudflared -e --silent\n\n' +
        '実行しますか?',
    );
    if (!ok) return;
    setRunning(true);
    setErr(null);
    setLines([]);
    setResult(null);
    try {
      const r = await installCloudflared();
      setResult({ ok: r.success, code: r.code });
      if (r.success) {
        // 親に検出再試行を促す
        setTimeout(onInstalled, 800);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setRunning(false);
    }
  }

  async function copyCmd(cmd: string) {
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ margin: 0, fontSize: 14 }}>cloudflared インストール</h2>
          <button onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {isWindows && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ margin: '4px 0', fontSize: 12 }}>
                <b>自動インストール (Windows / winget)</b>
              </p>
              <p className="small muted" style={{ margin: '4px 0' }}>
                実行コマンド: <code>winget install --id Cloudflare.cloudflared -e --silent</code>
              </p>
              <button
                className="primary"
                onClick={handleAutoInstall}
                disabled={running}
                style={{ marginTop: 4 }}
              >
                {running ? 'インストール中...' : '自動インストール実行'}
              </button>
              {result && (
                <div
                  className={result.ok ? 'small' : 'err'}
                  style={{
                    marginTop: 6,
                    color: result.ok ? 'var(--ok)' : undefined,
                  }}
                >
                  {result.ok
                    ? `成功 (exit ${result.code})．cloudflared を再検出します...`
                    : `失敗 (exit ${result.code})．以下の手動手順を試してください．`}
                </div>
              )}
              {err && <div className="err">{err}</div>}
            </div>
          )}

          <div>
            <p style={{ margin: '4px 0', fontSize: 12 }}>
              <b>手動インストール (PowerShell / Terminal で実行)</b>
            </p>
            {MANUAL_COMMANDS.map(({ os, cmd }) => (
              <div className="form-row" key={os} style={{ margin: '4px 0' }}>
                <label style={{ minWidth: 160 }}>{os}</label>
                <code
                  style={{
                    flex: 1,
                    padding: '3px 6px',
                    background: '#fafafa',
                    border: '1px solid var(--border)',
                    borderRadius: 3,
                    fontSize: 11,
                  }}
                >
                  {cmd}
                </code>
                <button onClick={() => copyCmd(cmd)}>📋</button>
              </div>
            ))}
          </div>

          {(running || lines.length > 0) && (
            <div style={{ marginTop: 10 }}>
              <p style={{ margin: '4px 0', fontSize: 12 }}>
                <b>ログ</b>
              </p>
              <div
                ref={logRef}
                style={{
                  background: '#1e1e1e',
                  color: '#ddd',
                  fontFamily: 'ui-monospace, Consolas, monospace',
                  fontSize: 11,
                  padding: '6px 8px',
                  borderRadius: 4,
                  maxHeight: 200,
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {lines.map((l, i) => (
                  <div
                    key={i}
                    style={{ color: l.stream === 'stderr' ? '#ff8b8b' : '#ddd' }}
                  >
                    {l.line}
                  </div>
                ))}
                {running && <div style={{ opacity: 0.6 }}>...</div>}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>閉じる</button>
          <button onClick={onInstalled}>再検出</button>
        </div>
      </div>
    </div>
  );
}
