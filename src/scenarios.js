// R4 (2026-06-09): authPolicy のシナリオベース定義．
//
// 5 シナリオ (A-E) + custom = 6 選択肢．
// 各シナリオは preset + roomDefaults を持ち、admin が選択すると
// config/server.json (preset) + 新規 room の default authPolicy が一括設定される．
//
// custom (F) は user が手動で authMethods/requirementGroups を指定．

/** R4 AUTH_SCENARIOS:
 *  各シナリオは:
 *    id            : シナリオ識別子 (URL-safe)
 *    label         : 表示名
 *    description   : 説明 (1 行)
 *    preset        : 公開方式 (cfg.exposure.preset)
 *    roomDefaults  : 新規作成 room の default authPolicy
 *      authMethods    : on/off/inherit per provider
 *      requirementGroups : グループ間 AND / グループ内 OR
 */
export const AUTH_SCENARIOS = {
  'A_personal_local': {
    id: 'A_personal_local',
    label: 'A. 個人検証 (自分の PC のみ)',
    description: '同 PC からの接続のみ自動信頼．他人は入れない．',
    preset: 'local',
    roomDefaults: {
      authMethods: {
        localhostAuto: 'on',
        inviteToken: 'on',
        roomPassword: 'off',
        emailLegacy: 'off',
        tailscale: 'off',
        ipCidr: 'off',
        noneOpen: 'off',
        trustedProxy: 'off',
      },
      requirementGroups: [['localhostAuto']],
    },
  },
  'B_lab_lan_password': {
    id: 'B_lab_lan_password',
    label: 'B. 研究室 LAN (パスワード)',
    description: 'LAN 内の人とパスワードで共有．シンプル．',
    preset: 'lan',
    roomDefaults: {
      authMethods: {
        roomPassword: 'on',
        ipCidr: 'on',
        localhostAuto: 'off',
        inviteToken: 'on',
        emailLegacy: 'off',
        tailscale: 'off',
        noneOpen: 'off',
        trustedProxy: 'off',
      },
      requirementGroups: [['roomPassword']],
    },
  },
  'C_tailscale_only': {
    id: 'C_tailscale_only',
    label: 'C. Tailscale 内だけ',
    description: 'Tailscale tailnet 内のメンバーのみ．Tailscale が認証．',
    preset: 'tailscale-serve',
    roomDefaults: {
      authMethods: {
        tailscale: 'on',
        localhostAuto: 'off',
        inviteToken: 'on',
        roomPassword: 'off',
        emailLegacy: 'off',
        ipCidr: 'off',
        noneOpen: 'off',
        trustedProxy: 'off',
      },
      requirementGroups: [],
    },
  },
  'D_cloudflare_demo_token': {
    id: 'D_cloudflare_demo_token',
    label: 'D. Cloudflare デモ (個別 token)',
    description: 'Cloudflare Quick Tunnel で公開．各招待者に固有 token．',
    preset: 'cloudflare-quick',
    roomDefaults: {
      authMethods: {
        inviteToken: 'on',
        roomPassword: 'off',
        emailLegacy: 'off',
        tailscale: 'off',
        ipCidr: 'off',
        noneOpen: 'off',
        localhostAuto: 'off',
        trustedProxy: 'off',
      },
      requirementGroups: [['inviteToken']],
    },
  },
  'E_fixed_url_proxy_auth': {
    id: 'E_fixed_url_proxy_auth',
    label: 'E. 固定 URL + 前段認証',
    description: 'reverse-proxy で TLS 終端と認証．前段の X-Authenticated-User を信頼．',
    preset: 'reverse-proxy',
    roomDefaults: {
      authMethods: {
        trustedProxy: 'on',
        inviteToken: 'on',
        roomPassword: 'off',
        emailLegacy: 'off',
        tailscale: 'off',
        ipCidr: 'off',
        noneOpen: 'off',
        localhostAuto: 'off',
      },
      requirementGroups: [['trustedProxy', 'inviteToken']],
    },
  },
  'F_custom': {
    id: 'F_custom',
    label: 'F. 上級者カスタム',
    description: 'env / config / per-room を手動で組み立てる．',
    preset: 'custom',
    roomDefaults: null,
  },
};

export function listScenarios() {
  return Object.values(AUTH_SCENARIOS).map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    preset: s.preset,
  }));
}

export function getScenario(id) {
  return AUTH_SCENARIOS[id] ?? null;
}
