// 共通の room ID バリデーション．persistence / audit / admin-router / rooms /
// WebSocket upgrade のすべての入口でこの 1 箇所を経由させる．
//
// 旧実装は箇所ごとに `[^A-Za-z0-9_-]` を `_` に replace するだけだったため，
// 「secret.room」と「secret_room」が同じ .bin に保存されて第三者が secret_room
// で接続することで invite-only な secret.room のデータを読めるという致命的な
// 衝突が発生していた．これを塞ぐため，ID を厳格な正規表現で validate し，
// 不一致はサーバーが 400/422 で拒否する．
//
// パターン:
//   - 先頭は英数字（hyphen / underscore は不可）
//   - 続きは英数字 / hyphen / underscore のみ
//   - 1〜64 文字
//
// この pattern はファイル名としても安全．replacement 不要．

export const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidRoomId(id) {
  return typeof id === 'string' && ROOM_ID_PATTERN.test(id);
}

/**
 * Strict version: 不正な ID をそのまま渡されたら Error を throw する．
 * 内部処理（persistence / audit）で誤って不正 ID を受け取った場合に
 * silent な衝突を起こさないための防御線．
 */
export function assertValidRoomId(id) {
  if (!isValidRoomId(id)) {
    const e = new Error(`invalid room id: ${JSON.stringify(id)}`);
    e.code = 'ERR_INVALID_ROOM_ID';
    throw e;
  }
  return id;
}
