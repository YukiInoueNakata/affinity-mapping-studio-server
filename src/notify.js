// fail-loud 通知ユーティリティ (2026-07-14 レビュー batch C).
//
// CLAUDE の絶対ルール: 失敗は必ず可視化する (silent failure を避ける)．
// このサーバーには従来 notify 機構が無く，永続化・監査・ロードの失敗が
// console.error に埋もれていた．failLoud は:
//   1. 必ず目立つ [FAIL-LOUD] プレフィックスで stderr に出す
//   2. SLACK_WEBHOOK_URL が設定されていれば best-effort で Slack へ POST する
//      (失敗しても握り潰す — 通知自体でプロセスを落とさない)
//
// Node 20+ のグローバル fetch を使う (追加依存なし)．

export function failLoud(scope, message, detail) {
  const detailStr =
    detail == null ? '' : detail instanceof Error ? detail.stack || detail.message : String(detail);
  console.error(`[FAIL-LOUD][${scope}] ${message}`, detailStr);

  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    const text =
      `:rotating_light: AMS Server [${scope}] ${message}` +
      (detailStr ? `\n\`\`\`${detailStr.slice(0, 800)}\`\`\`` : '');
    // fire-and-forget．通知の失敗は本処理に影響させない．
    Promise.resolve(
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    ).catch(() => {});
  } catch {
    /* ignore — 通知でプロセスを落とさない */
  }
}
