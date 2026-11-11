// C6 (2026-06-10): 初回 bootstrap モーダル．
//
// 起動時 bundle_paths() を呼び:
//   - serverPath / nodePath が解決でき && installed=false → このモーダルを開いて
//     bootstrap_install() を spawn + setup:log を live tail
//   - installed=true → 何もしない
//   - serverPath null → 何もしない (dev mode で resources なし．手動 settings 必須)

import { useEffect, useRef, useState } from 'react';
import {
  bootstrapInstall,
  bundlePaths,
  onSetupLog,
  type BundlePaths,
  type SetupLogLine,
} from '../api/tauri';
import type { UnlistenFn } from '@tauri-apps/api/event';

interface Props {
  onDone: (paths: BundlePaths) => void;
}

export default function SetupModal({ onDone }: Props) {
  const [paths, setPaths] = useState<BundlePaths | null>(null);
  const [lines, setLines] = useState<SetupLogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const p = await bundlePaths();
        setPaths(p);
        if (p.installed || !p.serverPath || !p.nodePath) {
          // 既に install 済 or 解決不能 → 何もしない
          onDone(p);
          return;
        }
        // setup:log 購読してから install 起動
        const un = await onSetupLog((l) => {
          setLines((prev) => [...prev.slice(-499), l]);
        });
        unlistenRef.current = un;
        if (startedRef.current) return;
        startedRef.current = true;
        setRunning(true);
        const r = await bootstrapInstall();
        setRunning(false);
        if (r.success) {
          setDone(true);
          // installed=true で再取得 → 親に通知
          const updated = await bundlePaths();
          setPaths(updated);
          setTimeout(() => onDone(updated), 500);
        } else {
          setErr(`npm install 失敗 (exit ${r.code})．ログを確認してください．`);
        }
      } catch (e) {
        setErr(String(e));
        setRunning(false);
      }
    })();
    return () => {
      if (unlistenRef.current) unlistenRef.current();
    };
  }, [onDone]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  // serverPath null は表示しない (modal 不要．通常 settings 経由)
  if (!paths || paths.installed || !paths.serverPath) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-header">
          <h2 style={{ margin: 0, fontSize: 14 }}>初回セットアップ</h2>
        </div>
        <div className="modal-body">
          <p style={{ margin: '4px 0', fontSize: 12 }}>
            サーバの依存パッケージをインストールしています (1〜2 分)．
          </p>
          <p className="small muted" style={{ margin: '4px 0' }}>
            実行: <code>{paths.nodePath} npm install --omit=dev</code>
            <br />
            作業ディレクトリ: <code>{paths.serverPath}</code>
          </p>

          <div
            ref={logRef}
            style={{
              marginTop: 8,
              background: '#1e1e1e',
              color: '#ddd',
              fontFamily: 'ui-monospace, Consolas, monospace',
              fontSize: 11,
              padding: '6px 8px',
              borderRadius: 4,
              maxHeight: 220,
              minHeight: 140,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {lines.map((l, i) => (
              <div key={i} style={{ color: l.stream === 'stderr' ? '#ffb080' : '#ddd' }}>
                {l.line}
              </div>
            ))}
            {running && <div style={{ opacity: 0.6 }}>...</div>}
          </div>

          {done && (
            <div className="small" style={{ marginTop: 6, color: 'var(--ok)' }}>
              完了．コントロールパネルを開きます．
            </div>
          )}
          {err && <div className="err">{err}</div>}
        </div>
        {err && (
          <div className="modal-footer">
            <button onClick={() => onDone(paths)}>閉じる (後で再試行)</button>
          </div>
        )}
      </div>
    </div>
  );
}
