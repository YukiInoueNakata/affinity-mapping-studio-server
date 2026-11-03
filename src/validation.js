// R4 (2026-06-09): 認証ポリシー / 公開方式の整合性 validation．
//
// errors (保存拒否) / warnings (警告のみ) の 2 レベル．

/** R4 危険組合せ table．preset と authPolicy / room の組合せから errors/warnings を返す．
 *
 *  @param {object} room - target room (accessControl / passwordHash / authPolicy など)
 *  @param {object} effectivePolicy - inferAuthPolicy(room, serverPolicy) の結果
 *  @param {object} serverConfig - resolved server config (preset + authPolicy + network)
 *  @returns {{ errors: string[], warnings: string[] }}
 */
export function validateAuthPolicy(room, effectivePolicy, serverConfig) {
  const errors = [];
  const warnings = [];
  const presetName = serverConfig?.preset?.name ?? 'custom';
  const PUBLIC_PRESETS = new Set([
    'cloudflare-quick', 'cloudflare-named',
    'tailscale-funnel', 'reverse-proxy',
  ]);
  const isPublic = PUBLIC_PRESETS.has(presetName);

  // === errors (保存拒否) ===

  // 1. 公開系 + noneOpen=on → 誰でも認証なし入室
  if (isPublic && effectivePolicy?.authMethods?.noneOpen === true) {
    errors.push(
      `公開系 preset '${presetName}' で noneOpen=on は誰でも認証なしで入室可能になります．保存を拒否します．`
    );
  }

  // 2. invite_list + inviteToken=off → room がロック
  if (room?.accessControl === 'invite_list' &&
      effectivePolicy?.authMethods?.inviteToken === false) {
    errors.push(
      `accessControl='invite_list' で inviteToken=off の組合せは room がロックされます．保存を拒否します．`
    );
  }

  // === warnings (警告のみ) ===

  // 3. 公開系 + emailLegacy=on → スプーフ可能
  if (isPublic && effectivePolicy?.authMethods?.emailLegacy === true) {
    warnings.push(
      `公開系 preset '${presetName}' で emailLegacy=on はスプーフ可能．OFF を推奨．`
    );
  }

  // 4. reverse-proxy + trustedProxy=on + appBindHost=0.0.0.0
  if (presetName === 'reverse-proxy' &&
      effectivePolicy?.authMethods?.trustedProxy === true &&
      serverConfig?.network?.appBindHost === '0.0.0.0') {
    warnings.push(
      `reverse-proxy preset で trustedProxy=on かつ appBindHost=0.0.0.0．` +
      `proxy 経由想定だが、直接アクセスでも trustedProxy ヘッダを偽装可能になる．`
    );
  }

  // 5. passwordHash あり + roomPassword=off → 運用ミス
  if (room?.passwordHash && effectivePolicy?.authMethods?.roomPassword === false) {
    warnings.push(
      `password 設定済の room で roomPassword=off．運用ミスの可能性．password を削除するか roomPassword=on にしてください．`
    );
  }

  // 6. requirementGroups=[] + 公開系 → 誰でも入れる
  if (isPublic && (!effectivePolicy?.requirementGroups || effectivePolicy.requirementGroups.length === 0)) {
    warnings.push(
      `公開系 preset で必須条件 (requirementGroups) が空．何らかの認証を要求することを推奨．`
    );
  }

  return { errors, warnings };
}
