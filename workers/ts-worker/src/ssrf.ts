/**
 * Worker 端 SSRF 防护
 *
 * Worker 部署在内网，是本项目里攻击面最大的组件：只要能让它去请求某个地址，
 * 就等于拿到了内网的一个 SSRF 跳板。因此这里在「连接建立时」校验解析后的 IP，
 * 而不是只校验 URL 字符串——后者挡不住 DNS 重绑定。
 *
 * 拒绝：回环、私网、链路本地（含云元数据 169.254.169.254）、组播、保留段、
 *      以及 IPv4 映射/内嵌的 IPv6 形式。
 */

import net, { BlockList } from 'node:net';
import dns from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { Agent } from 'undici';

/** 目标地址不安全的统一标记，对应协议里的 SSRF_BLOCKED */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私网
  ['100.64.0.0', 10], // 运营商级 NAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地 / 云元数据
  ['172.16.0.0', 12], // 私网
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // 文档示例
  ['192.168.0.0', 16], // 私网
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // 文档示例
  ['203.0.113.0', 24], // 文档示例
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留
] as const;

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function isBlockedV4(ip: string): boolean {
  const value = v4ToInt(ip);
  if (value === null) return true; // 解析不了的一律拒绝
  for (const [base, bits] of BLOCKED_V4) {
    const baseValue = v4ToInt(base);
    if (baseValue === null) continue;
    const mask = (~0 >>> 0) << (32 - bits);
    if ((value & mask) === (baseValue & mask)) return true;
  }
  return false;
}

const BLOCKED_V6 = new BlockList();
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['::', 96],
  ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['2001::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) BLOCKED_V6.addSubnet(address, prefix, 'ipv6');

function isBlockedV6(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%')[0];
  if (BLOCKED_V6.check(normalized, 'ipv6')) return true;

  // ::1 回环、:: 未指定
  if (normalized === '::1' || normalized === '::') return true;
  // 唯一本地地址 fc00::/7
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  // 链路本地 fe80::/10
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  // 组播 ff00::/8
  if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;

  // IPv4 映射 / 内嵌：::ffff:127.0.0.1、::ffff:7f00:1、64:ff9b::/96 (NAT64)
  const mapped = /^(?:::ffff:|64:ff9b::)(.+)$/.exec(normalized);
  if (mapped) {
    const tail = mapped[1];
    if (net.isIPv4(tail)) return isBlockedV4(tail);
    // 十六进制形式的映射地址，如 7f00:1
    const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hexPair) {
      const hi = parseInt(hexPair[1], 16);
      const lo = parseInt(hexPair[2], 16);
      const v4 = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
      return isBlockedV4(v4);
    }
    return true;
  }

  return false;
}

/** IP 字面量是否被禁止 */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true;
}

export interface SsrfOptions {
  /** 允许访问内网（默认 false）。仅用于明确的自建内网抓取场景 */
  allowPrivateNetwork?: boolean;
}

/** 进程级默认值：由 server 启动时根据环境变量设置一次 */
let ssrfDefaults: SsrfOptions = {};

export function configureSsrf(options: SsrfOptions): void {
  if (options.allowPrivateNetwork) throw new Error('全局 allowPrivateNetwork 已禁用');
  ssrfDefaults = { ...options };
}

/** 校验单个 URL：协议、主机名与解析结果 */
export async function assertUrlAllowed(rawUrl: string, options: SsrfOptions = ssrfDefaults): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`无效的 URL：${rawUrl.slice(0, 200)}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`只允许 http/https 协议，收到 ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError('URL 中不允许携带用户名或密码');
  }
  if (options.allowPrivateNetwork) throw new SsrfBlockedError('全局 allowPrivateNetwork 已禁用');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfBlockedError(`目标地址指向内网或保留地址：${host}`);
    return url;
  }

  // 域名：解析后逐个校验（防止 DNS 重绑定到内网）
  let records: Array<{ address: string }>;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    // DNS 失败不算安全问题，交由后续抓取阶段报 FETCH_FAILED
    return url;
  }
  if (records.length === 0) return url;

  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new SsrfBlockedError(`${host} 解析到内网或保留地址：${record.address}`);
    }
  }
  return url;
}

/**
 * 返回一个在连接阶段再校验一次 IP 的 undici Agent。
 * 这是真正的防线：DNS 重绑定会让「校验时」和「连接时」解析出不同的 IP。
 */
export function createGuardedAgent(): Agent {
  return new Agent({
    connect: {
      // 签名对齐 Node 的 LookupFunction：options.family 允许 "IPv4"/"IPv6" 字符串
      lookup(hostname, options, callback) {
        const { all, family } = options as { all?: boolean; family?: number | string };
        const lookupOptions: LookupOptions & { all: true } = { all: true };
        if (typeof family === 'number') lookupOptions.family = family;

        dns
          .lookup(hostname, lookupOptions)
          .then(records => {
            const list = records as unknown as LookupAddress[];
            const blocked = list.find(r => isBlockedIp(r.address));
            if (blocked) {
              const err = new Error(`目标地址指向内网或保留地址：${blocked.address}`) as NodeJS.ErrnoException;
              err.code = 'ESSRFBLOCKED';
              callback(err, '', 4);
              return;
            }
            if (all) {
              (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
            } else {
              callback(null, list[0].address, list[0].family);
            }
          })
          .catch((err: unknown) => callback(err as NodeJS.ErrnoException, '', 4));
      },
    },
  });
}
