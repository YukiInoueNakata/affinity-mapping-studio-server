// R2 (2026-06-09): X-Forwarded-For trust 境界の確立．
//
// 現状 src/index.js が XFF を無条件採用していたため、非ブラウザクライアントが
// `X-Forwarded-For: 100.64.1.1` を付けて Tailscale CIDR を偽装可能だった．
//
// 修正方針:
//   - 既定で `req.socket.remoteAddress` のみ使用
//   - `trustedProxyCidrs` に該当する remoteAddress からのみ XFF を採用
//   - 用途別に使い分け:
//     * judgeIp (Tailscale / ipCidr / localhost-auto): 最左 (元 client)
//     * rateLimitKey (DoS 上限): 最右 (最近 hop)
//     * directIp (localhost-auto 専用): socket 由来のみ (XFF 無視)
//   - audit log に ip (resolved) + rawXff (原文) を両方保存

/** IPv4 を 32-bit 整数に．`192.168.1.1` → 0xC0A80101． */
export function ipv4ToInt(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const m = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n < 0 || n > 255 || Number.isNaN(n))) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

/** CIDR `192.168.1.0/24` を { base, mask } に．IPv4 のみ． */
export function parseCidr(cidr) {
  if (!cidr || typeof cidr !== 'string') return null;
  const [ipStr, bitsStr] = cidr.split('/');
  if (!ipStr || !bitsStr) return null;
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const base = ipv4ToInt(ipStr);
  if (base === null) return null;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

/** ip が cidrs のいずれかに該当するか．IPv4 only．IPv6 ループバック (::1) は特別扱い． */
export function isIpInCidrs(ip, cidrs) {
  if (!ip || !cidrs || cidrs.length === 0) return false;
  // IPv6 ループバック (::1) は CIDR ::1/128 として扱う
  if (ip === '::1') {
    return cidrs.some((c) => c === '::1/128');
  }
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const cidrStr of cidrs) {
    const parsed = parseCidr(cidrStr);
    if (!parsed) continue;
    if (((n & parsed.mask) >>> 0) === parsed.base) return true;
  }
  return false;
}

/** R2: WebSocket upgrade の req から trusted な client IP を解決．
 *
 *  @param {object} req - http req (req.socket.remoteAddress / req.headers['x-forwarded-for'])
 *  @param {string[]} trustedProxyCidrs - 信頼する前段 proxy の CIDR 配列 (e.g. ['127.0.0.1/32'])
 *  @returns {{
 *    directIp: string,        // req.socket.remoteAddress (常時)
 *    xffRaw: string,          // 生 XFF (audit 用)
 *    xffChain: string[],      // ['100.64.1.1', 'hop1', 'hop2'] 配列
 *    judgeIp: string,         // 認証判定用 (auth / CIDR / Tailscale)
 *    rateLimitKey: string,    // DoS 上限用 (最近 hop の前)
 *    directIsTrusted: boolean // directIp が trusted proxy か
 *  }}
 */
export function resolveClientIp(req, trustedProxyCidrs) {
  const directIp = req?.socket?.remoteAddress ?? '';
  const xffRaw = (req?.headers?.['x-forwarded-for'] || '').toString();
  const xffChain = xffRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // trustedProxyCidrs が空なら XFF は信用しない (directIp のみ)
  const directIsTrusted =
    trustedProxyCidrs && trustedProxyCidrs.length > 0 && isIpInCidrs(directIp, trustedProxyCidrs);

  // 判定用 IP (Tailscale / ipCidr / etc):
  //   - directIp が trusted proxy 経由 → 最左 (元 client) を採用
  //   - そうでなければ directIp (XFF 無視 = spoof 防御)
  const judgeIp = directIsTrusted && xffChain.length > 0 ? xffChain[0] : directIp;

  // DoS 上限用 IP:
  //   - directIp が trusted proxy 経由 → 最右 (最近の hop の前) を採用 — proxy 自身でなく
  //     その手前を一意キーとして DoS カウント
  //   - そうでなければ directIp
  const rateLimitKey =
    directIsTrusted && xffChain.length > 1
      ? xffChain[xffChain.length - 1]
      : directIp;

  return {
    directIp,
    xffRaw,
    xffChain,
    judgeIp,
    rateLimitKey,
    directIsTrusted,
  };
}

/** R3: localhost-auto 判定．directIp が 127.0.0.1 / ::1 かつ proxy 経由でないとき true．
 *  judgeIp ではなく directIp を見るのが重要 (XFF spoof 防御)． */
export function isTrueLocalhostDirect(directIp) {
  if (!directIp) return false;
  // IPv4
  if (directIp === '127.0.0.1') return true;
  // IPv4-mapped IPv6
  if (directIp === '::ffff:127.0.0.1') return true;
  // IPv6 loopback
  if (directIp === '::1') return true;
  return false;
}

/** Sec-111: Tailscale CGNAT range 判定 (100.64.0.0/10 = 100.64.0.0 〜 100.127.255.255)．
 *  judgeIp で判定する (R2)． */
export function isTailscaleIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const m = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a !== 100) return false;
  return b >= 64 && b <= 127;
}
