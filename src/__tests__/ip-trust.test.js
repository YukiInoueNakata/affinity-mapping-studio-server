// R2 test: X-Forwarded-For trust / IP utility / spoof 防御
//
// Security 観点:
//   - XFF spoof で tailscale / ipCidr / localhostAuto を突破できないこと
//   - trusted proxy 経由なら XFF を採用すること
//   - directIp (socket 由来) は常に保護される

import { describe, it, expect } from 'vitest';
import {
  ipv4ToInt,
  parseCidr,
  isIpInCidrs,
  resolveClientIp,
  isTrueLocalhostDirect,
  isTailscaleIp,
} from '../ip-trust.js';

function mockReq({ remoteAddress, xff }) {
  return {
    socket: { remoteAddress },
    headers: { 'x-forwarded-for': xff },
  };
}

describe('ipv4ToInt', () => {
  it('192.168.1.1 → 0xC0A80101', () => {
    expect(ipv4ToInt('192.168.1.1')).toBe(0xC0A80101);
  });
  it('::ffff:127.0.0.1 (IPv4-mapped IPv6) も parse', () => {
    expect(ipv4ToInt('::ffff:127.0.0.1')).toBe(0x7F000001);
  });
  it('invalid IP → null', () => {
    expect(ipv4ToInt('not-an-ip')).toBe(null);
    expect(ipv4ToInt('300.0.0.1')).toBe(null);
  });
});

describe('parseCidr', () => {
  it('192.168.1.0/24', () => {
    const r = parseCidr('192.168.1.0/24');
    expect(r).not.toBe(null);
    expect(r.mask).toBe(0xFFFFFF00);
  });
  it('127.0.0.1/32 (single host)', () => {
    const r = parseCidr('127.0.0.1/32');
    expect(r.mask).toBe(0xFFFFFFFF);
    expect(r.base).toBe(0x7F000001);
  });
  it('0.0.0.0/0 (everything)', () => {
    const r = parseCidr('0.0.0.0/0');
    expect(r.mask).toBe(0);
    expect(r.base).toBe(0);
  });
  it('invalid CIDR → null', () => {
    expect(parseCidr('not-a-cidr')).toBe(null);
    expect(parseCidr('192.168.1.0/33')).toBe(null);
  });
});

describe('isIpInCidrs', () => {
  it('192.168.1.5 in 192.168.1.0/24', () => {
    expect(isIpInCidrs('192.168.1.5', ['192.168.1.0/24'])).toBe(true);
  });
  it('10.0.0.1 not in 192.168.1.0/24', () => {
    expect(isIpInCidrs('10.0.0.1', ['192.168.1.0/24'])).toBe(false);
  });
  it('::1 (IPv6 loopback) in ::1/128', () => {
    expect(isIpInCidrs('::1', ['::1/128'])).toBe(true);
  });
  it('複数 CIDR の OR', () => {
    expect(isIpInCidrs('10.0.0.5', ['192.168.0.0/16', '10.0.0.0/8'])).toBe(true);
  });
  it('空 cidrs → false', () => {
    expect(isIpInCidrs('1.2.3.4', [])).toBe(false);
  });
});

describe('resolveClientIp - Security (XFF spoof 防御)', () => {
  it('trustedProxyCidrs 空 → XFF 完全無視', () => {
    const req = mockReq({ remoteAddress: '203.0.113.5', xff: '100.64.1.1' });
    const r = resolveClientIp(req, []);
    expect(r.directIp).toBe('203.0.113.5');
    expect(r.judgeIp).toBe('203.0.113.5');         // XFF 無視
    expect(r.rateLimitKey).toBe('203.0.113.5');
    expect(r.directIsTrusted).toBe(false);
    expect(r.xffRaw).toBe('100.64.1.1');           // audit には残す
    expect(r.xffChain).toEqual(['100.64.1.1']);
  });

  it('XFF spoof で Tailscale CIDR 突破できない', () => {
    const req = mockReq({ remoteAddress: '1.2.3.4', xff: '100.64.1.1' });
    const r = resolveClientIp(req, []);
    expect(isTailscaleIp(r.judgeIp)).toBe(false);   // spoof 失敗
    expect(isTailscaleIp(r.directIp)).toBe(false);
  });

  it('XFF spoof で localhost CIDR 突破できない', () => {
    const req = mockReq({ remoteAddress: '1.2.3.4', xff: '127.0.0.1' });
    const r = resolveClientIp(req, []);
    expect(isTrueLocalhostDirect(r.directIp)).toBe(false);
    expect(r.judgeIp).toBe('1.2.3.4');
  });

  it('XFF spoof で ip-cidr allowlist 突破できない', () => {
    const req = mockReq({ remoteAddress: '1.2.3.4', xff: '192.168.1.10' });
    const r = resolveClientIp(req, []);
    expect(isIpInCidrs(r.judgeIp, ['192.168.1.0/24'])).toBe(false);
  });
});

describe('resolveClientIp - Trusted proxy (XFF 採用)', () => {
  it('trusted proxy 経由なら XFF 最左 (元 client) を judgeIp に', () => {
    const req = mockReq({ remoteAddress: '127.0.0.1', xff: '203.0.113.5, hop1, hop2' });
    const r = resolveClientIp(req, ['127.0.0.1/32']);
    expect(r.directIsTrusted).toBe(true);
    expect(r.judgeIp).toBe('203.0.113.5');           // 最左 = 元 client
    expect(r.rateLimitKey).toBe('hop2');             // 最右 = 最近 hop
  });

  it('trusted proxy 経由 + XFF 1 個だけ → rateLimitKey は directIp', () => {
    const req = mockReq({ remoteAddress: '127.0.0.1', xff: '203.0.113.5' });
    const r = resolveClientIp(req, ['127.0.0.1/32']);
    expect(r.judgeIp).toBe('203.0.113.5');
    expect(r.rateLimitKey).toBe('127.0.0.1');        // XFF 1 個なら directIp
  });

  it('trusted proxy 経由だが XFF 無し → directIp のまま', () => {
    const req = mockReq({ remoteAddress: '127.0.0.1', xff: undefined });
    const r = resolveClientIp(req, ['127.0.0.1/32']);
    expect(r.judgeIp).toBe('127.0.0.1');
    expect(r.directIp).toBe('127.0.0.1');
  });

  it('XFF chain 解釈: "client, hop1, hop2"', () => {
    const req = mockReq({ remoteAddress: '127.0.0.1', xff: '203.0.113.5, 100.64.1.1, 1.2.3.4' });
    const r = resolveClientIp(req, ['127.0.0.1/32']);
    expect(r.xffChain).toEqual(['203.0.113.5', '100.64.1.1', '1.2.3.4']);
    expect(r.judgeIp).toBe('203.0.113.5');
  });
});

describe('resolveClientIp - audit data', () => {
  it('rawXff を audit 用に保存', () => {
    const req = mockReq({ remoteAddress: '1.2.3.4', xff: '100.64.1.1, hop1' });
    const r = resolveClientIp(req, []);
    expect(r.xffRaw).toBe('100.64.1.1, hop1');
    expect(r.xffChain).toEqual(['100.64.1.1', 'hop1']);
  });

  it('XFF なしでも xffRaw は空文字列で安全', () => {
    const req = mockReq({ remoteAddress: '1.2.3.4', xff: undefined });
    const r = resolveClientIp(req, []);
    expect(r.xffRaw).toBe('');
    expect(r.xffChain).toEqual([]);
  });
});

describe('isTrueLocalhostDirect', () => {
  it('127.0.0.1 → true', () => {
    expect(isTrueLocalhostDirect('127.0.0.1')).toBe(true);
  });
  it('::ffff:127.0.0.1 (IPv4-mapped IPv6) → true', () => {
    expect(isTrueLocalhostDirect('::ffff:127.0.0.1')).toBe(true);
  });
  it('::1 (IPv6 loopback) → true', () => {
    expect(isTrueLocalhostDirect('::1')).toBe(true);
  });
  it('1.2.3.4 → false', () => {
    expect(isTrueLocalhostDirect('1.2.3.4')).toBe(false);
  });
});

describe('isTailscaleIp', () => {
  it('100.64.1.1 → true (CGNAT)', () => {
    expect(isTailscaleIp('100.64.1.1')).toBe(true);
  });
  it('100.127.255.255 → true (range boundary)', () => {
    expect(isTailscaleIp('100.127.255.255')).toBe(true);
  });
  it('100.128.0.1 → false (out of CGNAT)', () => {
    expect(isTailscaleIp('100.128.0.1')).toBe(false);
  });
  it('192.168.1.1 → false', () => {
    expect(isTailscaleIp('192.168.1.1')).toBe(false);
  });
});
