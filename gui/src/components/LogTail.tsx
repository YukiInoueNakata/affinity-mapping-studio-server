import { useEffect, useRef, useState } from 'react';
import { onServerLog, type LogLinePayload } from '../api/tauri';

const MAX_LINES = 2000;

export function LogTail() {
  const [lines, setLines] = useState<LogLinePayload[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onServerLog((l) => {
      setLines((prev) => {
        const next = [...prev, l];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }).then((f) => {
      unlisten = f;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const clear = () => setLines([]);
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(lines.map((l) => l.line).join('\n'));
    } catch {
      // ignore
    }
  };

  return (
    <section className="panel log-panel">
      <div className="log-header">
        <h2>ログ</h2>
        <span className="status-meta">{lines.length} 行</span>
        <label style={{ marginLeft: 'auto', fontSize: 11 }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          autoscroll
        </label>
        <button onClick={copyAll} disabled={lines.length === 0}>
          📋 全コピー
        </button>
        <button onClick={clear} disabled={lines.length === 0}>
          ✕ クリア
        </button>
      </div>
      <div className="log-body" ref={containerRef}>
        {lines.length === 0 ? (
          <div className="muted small">サーバー出力はここに表示されます</div>
        ) : (
          lines.map((l, i) => (
            <div
              key={i}
              className={`log-line log-${l.stream}`}
            >
              {l.line}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
