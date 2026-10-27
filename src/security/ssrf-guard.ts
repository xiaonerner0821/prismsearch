/**
 * SSRF（服务端请求伪造）防护模块
 *
 * 防护分两层：
 * 1. validateUrl()：请求前的快速预检（协议、黑白名单、IP 字面量、解析出的全部地址）
 * 2. createDispatcher()：返回一个 undici Agent，其 connect.lookup 在**真正建连时**
 *    校验目标 IP。这是抵御 DNS 重绑定 / TOCTOU 的关键 —— 预检与建连之间
 *    DNS 结果被替换也无法绕过，因为最终连接的那个 IP 本身会被检查。
 *
 * 配合 http-client 的 'manual-checked' 重定向模式，每一跳都会重新预检 + 建连校验。
 *
 * IP 判断基于 node:net 的 BlockList，原生支持 IPv4 / IPv6 子网；
 * IPv4 映射的 IPv6 地址（::ffff:127.0.0.1）会先还原为 IPv4 再判断。
 */

import dns from 'node:dns';
import net, { BlockList } from 'node:net';
import { Agent, type Dispatcher } from 'undici';

export interface SsrfGuardOptions {
  enabled: boolean;
  allowedProtocols: string[];      // 如 ['http:', 'https:']
  blockedIpRanges: string[];       // CIDR 格式，IPv4 / IPv6 均可
  whitelist: string[];             // 兼容字段：仅域名白名单，不绕过私网保护
  allowedPrivateHosts?: string[];  // 明确允许的私网主机名
  blacklist: string[];             // 黑名单域名（支持 *.example.com）
  dnsRebindingProtection: boolean; // 建连时校验 IP
}

/**
 * 内置始终禁止的地址段（与用户配置取并集）。
 * 覆盖 RFC 6890 中所有非全局可路由的特殊用途地址。
 */
export const BUILTIN_BLOCKED_RANGES: readonly string[] = [
  // IPv4
  '0.0.0.0/8',          // 当前网络
  '10.0.0.0/8',         // 私有网络
  '100.64.0.0/10',      // 运营商级 NAT
  '127.0.0.0/8',        // 回环
  '169.254.0.0/16',     // 链路本地（含云厂商元数据 169.254.169.254）
  '172.16.0.0/12',      // 私有网络
  '192.0.0.0/24',       // IETF 协议分配
  '192.0.2.0/24',       // 文档用 TEST-NET-1
  '192.88.99.0/24',     // 6to4 中继
  '192.168.0.0/16',     // 私有网络
  '198.18.0.0/15',      // 基准测试
  '198.51.100.0/24',    // TEST-NET-2
  '203.0.113.0/24',     // TEST-NET-3
  '224.0.0.0/4',        // 组播
  '240.0.0.0/4',        // 保留（含 255.255.255.255 广播）
  // IPv6
  '::/128',             // 未指定地址
  '::1/128',            // 回环
  '64:ff9b::/96',       // NAT64（可映射到内网 IPv4）
  '64:ff9b:1::/48',     // 本地 NAT64
  '100::/64',           // 丢弃前缀
  '2001:db8::/32',      // 文档用
  'fc00::/7',           // 唯一本地地址
  'fe80::/10',          // 链路本地
  'ff00::/8',           // 组播
];

export interface ValidationResult {
  safe: boolean;
  reason?: string;
}

export class SsrfBlockedError extends Error {
  readonly code = 'SSRF_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

type LookupFn = (
  hostname: string,
  options: dns.LookupOptions,
) => Promise<dns.LookupAddress[]>;

const defaultLookup: LookupFn = (hostname, options) =>
  dns.promises.lookup(hostname, { ...options, all: true, verbatim: true });

/** 去掉 IPv6 字面量的方括号 */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** IPv4 映射的 IPv6（::ffff:a.b.c.d 或 ::ffff:7f00:1）还原为 IPv4 */
export function normalizeIp(ip: string): { address: string; family: 'ipv4' | 'ipv6' } | null {
  const raw = stripBrackets(ip).split('%')[0]; // 去掉 zone id
  const version = net.isIP(raw);
  if (version === 4) return { address: raw, family: 'ipv4' };
  if (version !== 6) return null;

  const lower = raw.toLowerCase();
  const mapped = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped && net.isIPv4(mapped[1])) return { address: mapped[1], family: 'ipv4' };

  const hexMapped = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return { address: `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`, family: 'ipv4' };
  }
  return { address: raw, family: 'ipv6' };
}

/** 域名匹配（支持 *.example.com 通配子域名，大小写不敏感，忽略末尾的点） */
export function matchDomain(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const pat = pattern.toLowerCase().trim().replace(/\.$/, '');
  if (!pat) return false;
  if (host === pat) return true;
  if (pat.startsWith('*.')) {
    const base = pat.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return false;
}

/** 预检用 DNS 结果的缓存时长：浏览器渲染一页会对同一域名的几十个子资源逐一预检 */
const PRECHECK_DNS_TTL_MS = 30_000;
const PRECHECK_DNS_MAX_ENTRIES = 512;

export class SsrfGuard {
  private readonly options: SsrfGuardOptions;
  private readonly blockList: BlockList;
  private readonly lookup: LookupFn;
  private readonly now: () => number;
  private dispatcher?: Agent;
  /**
   * 预检阶段的 DNS 缓存（含进行中的解析，相同域名并发预检只解析一次）。
   * 只服务 validateUrl；建连时的 createSafeLookup 始终实时解析，防重绑定的那一层不受影响。
   */
  private readonly precheckDns = new Map<string, { expires: number; addresses: Promise<dns.LookupAddress[]> }>();

  constructor(options: SsrfGuardOptions, deps: { lookup?: LookupFn; now?: () => number } = {}) {
    this.options = options;
    this.lookup = deps.lookup ?? defaultLookup;
    this.now = deps.now ?? Date.now;
    this.blockList = new BlockList();
    for (const cidr of new Set([...BUILTIN_BLOCKED_RANGES, ...options.blockedIpRanges])) {
      this.addCidr(cidr);
    }
  }

  private addCidr(cidr: string): void {
    const [ip, prefixStr] = cidr.trim().split('/');
    const normalized = normalizeIp(ip);
    if (!normalized) {
      throw new Error(`无效的 CIDR 配置: ${cidr}`);
    }
    const maxPrefix = normalized.family === 'ipv4' ? 32 : 128;
    const prefix = prefixStr === undefined ? maxPrefix : Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new Error(`无效的 CIDR 前缀: ${cidr}`);
    }
    this.blockList.addSubnet(normalized.address, prefix, normalized.family);
  }

  isEnabled(): boolean {
    return this.options.enabled;
  }

  /** 判断单个 IP 是否被禁止（无法识别的格式一律视为禁止） */
  isBlockedAddress(ip: string): boolean {
    const normalized = normalizeIp(ip);
    if (!normalized) return true;
    return this.blockList.check(normalized.address, normalized.family);
  }

  private isAllowedPrivateHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    if (net.isIP(host)) return false;
    return this.options.allowedPrivateHosts?.some(d => d.toLowerCase().replace(/\.$/, '') === host) ?? false;
  }

  /** 私网例外只允许 RFC1918/ULA，不得扩大到回环、链路本地或云元数据。 */
  private isPermittedAddress(hostname: string, ip: string): boolean {
    if (!this.isBlockedAddress(ip)) return true;
    if (!this.isAllowedPrivateHost(hostname)) return false;
    const normalized = normalizeIp(ip);
    if (!normalized) return false;
    const privateRanges = new BlockList();
    privateRanges.addSubnet('10.0.0.0', 8, 'ipv4');
    privateRanges.addSubnet('172.16.0.0', 12, 'ipv4');
    privateRanges.addSubnet('192.168.0.0', 16, 'ipv4');
    privateRanges.addSubnet('fc00::', 7, 'ipv6');
    return privateRanges.check(normalized.address, normalized.family);
  }

  private isBlacklisted(hostname: string): boolean {
    return this.options.blacklist.some(d => matchDomain(hostname, d));
  }

  /** 请求前预检 */
  async validateUrl(url: string): Promise<ValidationResult> {
    if (!this.options.enabled) return { safe: true };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { safe: false, reason: 'URL格式无效' };
    }

    if (!this.options.allowedProtocols.includes(parsed.protocol)) {
      return { safe: false, reason: `不允许的协议: ${parsed.protocol}` };
    }
    if (parsed.username || parsed.password) {
      return { safe: false, reason: '不允许在 URL 中携带认证信息' };
    }

    // WHATWG URL 已将十进制 / 八进制 / 十六进制 IPv4 写法规范化为点分十进制
    const hostname = stripBrackets(parsed.hostname);

    if (this.isBlacklisted(hostname)) {
      return { safe: false, reason: `域名在黑名单中: ${hostname}` };
    }
    if (net.isIP(hostname)) {
      return this.isPermittedAddress(hostname, hostname)
        ? { safe: true }
        : { safe: false, reason: `IP地址被禁止: ${hostname}` };
    }

    let addresses: dns.LookupAddress[];
    try {
      addresses = await this.cachedPrecheckLookup(hostname);
    } catch {
      return { safe: false, reason: `DNS解析失败: ${hostname}` };
    }
    if (addresses.length === 0) {
      return { safe: false, reason: `DNS解析无结果: ${hostname}` };
    }
    // 任何一个解析结果命中禁止段都拒绝（防止 A 记录混入内网地址）
    const blocked = addresses.find(a => !this.isPermittedAddress(hostname, a.address));
    if (blocked) {
      return { safe: false, reason: `解析后的IP被禁止: ${blocked.address} (${hostname})` };
    }
    return { safe: true };
  }

  private cachedPrecheckLookup(hostname: string): Promise<dns.LookupAddress[]> {
    const key = hostname.toLowerCase();
    const now = this.now();
    const hit = this.precheckDns.get(key);
    if (hit && hit.expires > now) return hit.addresses;

    const addresses = this.lookup(hostname, {});
    // 解析失败不缓存，下一次重新解析
    addresses.catch(() => this.precheckDns.delete(key));
    if (this.precheckDns.size >= PRECHECK_DNS_MAX_ENTRIES) {
      for (const [k, v] of this.precheckDns) {
        if (v.expires <= now) this.precheckDns.delete(k);
      }
      if (this.precheckDns.size >= PRECHECK_DNS_MAX_ENTRIES) {
        const oldest = this.precheckDns.keys().next().value;
        if (oldest !== undefined) this.precheckDns.delete(oldest);
      }
    }
    this.precheckDns.set(key, { expires: now + PRECHECK_DNS_TTL_MS, addresses });
    return addresses;
  }

  /** 预检失败时抛出 SsrfBlockedError，供 http-client 的 validateUrl 钩子使用 */
  async assertSafe(url: string): Promise<void> {
    const result = await this.validateUrl(url);
    if (!result.safe) throw new SsrfBlockedError(result.reason ?? 'URL 被 SSRF 防护拦截');
  }

  /**
   * 建连时使用的 lookup：解析后过滤掉禁止地址，全部被禁止则报错。
   * 兼容 net.connect 的两种回调形式（单地址 / all:true 地址数组）。
   */
  createSafeLookup(): net.LookupFunction {
    return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
      const host = stripBrackets(hostname);
      this.lookup(host, { family: options.family, hints: options.hints })
        .then(addresses => {
          const allowed = addresses.filter(a => this.isPermittedAddress(host, a.address));
          if (allowed.length === 0) {
            const err = new SsrfBlockedError(`建连被拦截：${host} 解析到禁止访问的地址`);
            callback(err);
            return;
          }
          if (options.all) {
            callback(null, allowed);
          } else {
            callback(null, allowed[0].address, allowed[0].family);
          }
        })
        .catch(err => callback(err));
    }) as net.LookupFunction;
  }

  /**
   * 返回带建连校验的 undici dispatcher（惰性创建并复用）。
   * 关闭 SSRF 或关闭 dnsRebindingProtection 时返回 undefined，使用默认 dispatcher。
   */
  getDispatcher(): Dispatcher | undefined {
    if (!this.options.enabled || !this.options.dnsRebindingProtection) return undefined;
    this.dispatcher ??= new Agent({ connect: { lookup: this.createSafeLookup() } });
    return this.dispatcher;
  }

  async close(): Promise<void> {
    const d = this.dispatcher;
    this.dispatcher = undefined;
    await d?.close().catch(() => undefined);
  }
}
