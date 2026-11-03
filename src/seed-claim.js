// 対策3 (2026-07-03): seed-claim の判定ロジック (純関数・テスト可能).
//
// クライアント (yWebsocketProvider) は空ルームへ自分のローカルを seed する前に
// サーバーへ claim を要求する:
//   client → server: { kind: 'seed-claim', clientId }
//   server → client: { kind: 'seed-claim-result', granted, reason }
// これにより「既にデータのあるルームを別クライアントが空データで上書き seed」
// する事故 (2026-07-03 の一因と同クラス) を防ぐ．
//
// evaluateSeedClaim は状態を持たない．claim レジストリ (roomId→{clientId,ts}) は
// 呼び出し側 (index.js) が保持し，granted のときだけ記録を更新する．

/**
 * @param {object} args
 * @param {string} args.role         接続の role ('viewer' | 'editor' | 'admin')
 * @param {boolean} args.roomHasData ルーム doc に既に cards/groups があるか
 * @param {{clientId:any, ts:number}|null} args.existingClaim 既存 claim (無ければ null)
 * @param {any} args.clientId        要求元の clientId
 * @param {number} args.ttlMs        claim の有効期間
 * @param {number} args.now          現在時刻 (ms)
 * @returns {{granted:boolean, reason:string, keepClaim:boolean}}
 *   keepClaim=true のとき呼び出し側は claim レジストリを {clientId, ts:now} に更新する．
 */
export function evaluateSeedClaim({ role, roomHasData, existingClaim, clientId, ttlMs, now }) {
  // Codex#9: clientId を検証する．未指定/不正だと undefined 同士が同一 client 扱いに
  // なり，壊れた/悪意あるクライアントが claim を多重取得できてしまう．number か
  // 非空 string のみ有効とする．
  const validClient =
    (typeof clientId === 'number' && Number.isFinite(clientId)) ||
    (typeof clientId === 'string' && clientId.length > 0);
  if (!validClient) {
    return { granted: false, reason: 'invalid-client', keepClaim: false };
  }
  if (role === 'viewer') {
    return { granted: false, reason: 'viewer-cannot-seed', keepClaim: false };
  }
  if (roomHasData) {
    return { granted: false, reason: 'room-has-data', keepClaim: false };
  }
  const fresh = existingClaim && now - existingClaim.ts < ttlMs;
  if (fresh && existingClaim.clientId !== clientId) {
    return { granted: false, reason: 'already-claimed', keepClaim: false };
  }
  // 自分の再要求 or 未 claim or 失効 → 付与．
  return { granted: true, reason: 'granted', keepClaim: true };
}
