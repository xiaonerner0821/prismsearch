/**
 * 抓取链路单元测试：字符集嗅探、二进制判定、非 HTML 文本识别、解析结果校验、
 * SSRF 预检 DNS 缓存、CSE 多页、fetch_page 的 SSRF 终止与缓存策略
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { sniffCharset } from '../../src/utils/http-client.js';
import { looksBinary } from '../../src/fetcher/http-fetcher.js';
import { isNonHtmlText } from '../../src/fetcher/content-extractor.js';
import { assertParsed, looksLikeEmptyResultsPage } from '../../src/engines/scraper-http.js';
import { EngineParseError } from '../../src/engines/engine-interface.js';
import { SsrfGuard } from '../../src/security/ssrf-guard.js';
import { GoogleCustomSearchClient } from '../../src/engines/google/google-api.js';
import { handleFetchPage, FetchPageError, SsrfBlockedError, type FetchPageToolDeps } from '../../src/tools/fetch-page.js';
import type { Fetcher, FetchResult } from '../../src/fetcher/fetcher-interface.js';
import type { CacheProvider } from '../../src/cache/cache-interface.js';
import type { EngineConfig } from '../../src/config/config-schema.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('sniffCharset', () => {
  it('BOM 优先于 Content-Type', () => {
    expect(sniffCharset(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), 'text/html; charset=gbk')).toBe('utf-8');
  });

  it('GBK / GB2312 统一为 gb18030', () => {
    expect(sniffCharset(enc('a'), 'text/html; charset=GB2312')).toBe('gb18030');
    expect(sniffCharset(enc('<meta charset="gbk">'), undefined)).toBe('gb18030');
  });

  it('无声明时合法 UTF-8 用 utf-8，否则兜底 gb18030', () => {
    expect(sniffCharset(enc('中文'), undefined)).toBe('utf-8');
    expect(sniffCharset(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), undefined)).toBe('gb18030');
  });
});

describe('looksBinary / isNonHtmlText', () => {
  it('识别魔数与 NUL 字节，UTF-16 BOM 不算二进制', () => {
    expect(looksBinary(enc('%PDF-1.7'))).toBe(true);
    expect(looksBinary(new Uint8Array([0x41, 0x00, 0x42]))).toBe(true);
    expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe(false);
    expect(looksBinary(enc('<html></html>'))).toBe(false);
  });

  it('JSON / 纯文本原样返回，HTML 走转换', () => {
    expect(isNonHtmlText('application/json; charset=utf-8', '{}')).toBe(true);
    expect(isNonHtmlText('text/plain', 'x')).toBe(true);
    expect(isNonHtmlText('text/html', 'x')).toBe(false);
    expect(isNonHtmlText(undefined, '<!doctype html><p>x')).toBe(false);
    expect(isNonHtmlText(undefined, 'plain words')).toBe(true);
  });
});

describe('assertParsed', () => {
  it('有结果直接返回；无结果页返回空；其他情况抛 EngineParseError', () => {
    expect(assertParsed([1], '', 'x')).toEqual([1]);
    expect(looksLikeEmptyResultsPage('<p>抱歉，没有找到与“x”相关的网页</p>')).toBe(true);
    expect(assertParsed([], '<p>No results found for x</p>', 'x')).toEqual([]);
    expect(() => assertParsed([], '<html><body>captcha</body></html>', 'x')).toThrow(EngineParseError);
  });
});

describe('SsrfGuard 预检 DNS 缓存', () => {
  const opts = {
    enabled: true, allowedProtocols: ['http:', 'https:'], blockedIpRanges: [],
    whitelist: [], blacklist: [], dnsRebindingProtection: true,
  };

  it('TTL 内同域名只解析一次，过期后重新解析；失败不缓存', async () => {
    let now = 0;
    let fail = true;
    const lookup = vi.fn(async (host: string) => {
      if (host === 'flaky.test' && fail) throw new Error('ENOTFOUND');
      return [{ address: '93.184.216.34', family: 4 }];
    });
    const guard = new SsrfGuard(opts, { lookup, now: () => now });

    await guard.validateUrl('https://a.test/1');
    await Promise.all([guard.validateUrl('https://A.test/2'), guard.validateUrl('https://a.test/3')]);
    expect(lookup).toHaveBeenCalledTimes(1);
    now = 31_000;
    await guard.validateUrl('https://a.test/4');
    expect(lookup).toHaveBeenCalledTimes(2);

    expect((await guard.validateUrl('https://flaky.test/')).safe).toBe(false);
    fail = false;
    expect((await guard.validateUrl('https://flaky.test/')).safe).toBe(true);
  });
});

describe('Google CSE 多页', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('count > 10 时连续请求多页并按 count 切片', async () => {
    const items = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ title: `t${from + i}`, link: `https://x.com/${from + i}`, snippet: '' }));
    const starts: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const start = new URL(String(input)).searchParams.get('start') ?? '1';
      starts.push(start);
      const body = { items: start === '1' ? items(1, 10) : items(11, 10), searchInformation: { totalResults: '100' } };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const client = GoogleCustomSearchClient.create({
      name: 'google', displayName: 'Google', enabled: true, type: 'scraper',
      baseUrl: 'https://www.google.com/search', timeout: 5000, priority: 1,
      rateLimit: { maxRequests: 10, windowMs: 60000 }, apiKey: 'k', searchEngineId: 'cx',
    } as EngineConfig)!;
    const { results, totalResults } = await client.search({ query: 'q' }, 15, 1);
    expect(starts).toEqual(['1', '11']);
    expect(results.length).toBe(15);
    expect(results.at(-1)?.position).toBe(15);
    expect(totalResults).toBe(100);
  });
});

function memCache(): CacheProvider & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    backend: 'memory',
    store,
    get: async <T>(k: string) => (store.has(k) ? structuredClone(store.get(k)) as T : null),
    set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); },
    delete: async (k: string) => store.delete(k),
    clear: async () => store.clear(),
    has: async (k: string) => store.has(k),
    stats: async () => ({ backend: 'memory', size: store.size, hits: 0, misses: 0 }),
    cleanup: async () => 0,
    close: async () => undefined,
  };
}

function page(overrides: Partial<FetchResult> = {}): FetchResult {
  return { url: 'https://a.test/', content: 'hello', rawHtml: '<p>hello</p>', statusCode: 200, fetchTime: 1, ...overrides };
}

function deps(http: Fetcher, browser?: Fetcher, cache = memCache()): FetchPageToolDeps & { cache: ReturnType<typeof memCache> } {
  return {
    cache,
    ssrfGuard: { validateUrl: async () => ({ safe: true }), getDispatcher: () => undefined } as unknown as FetchPageToolDeps['ssrfGuard'],
    fetchers: { http, browser },
    defaultMethod: 'http',
    defaultTimeoutMs: 5000,
    maxBytes: 1024,
    contentFilterMode: 'off',
    remote: browser
      ? { fetcher: Object.assign(browser, { hasHealthyWorker: () => true, supports: () => true }), useFor: 'always', fallbackToLocal: true }
      : undefined,
  };
}

describe('handleFetchPage', () => {
  it('rawHtml 不返回也不进缓存，非 2xx 不缓存', async () => {
    const http: Fetcher = { name: 'http', fetch: async o => page({ url: o.url, statusCode: o.url.endsWith('404') ? 404 : 200 }) };
    const d = deps(http);
    const r = await handleFetchPage({ url: 'https://a.test/', format: 'html' }, d);
    expect((r as Record<string, unknown>).rawHtml).toBeUndefined();
    expect(r.content).toBe('hello');
    const [stored] = [...d.cache.store.values()] as FetchResult[];
    expect(stored.rawHtml).toBeUndefined();
    await handleFetchPage({ url: 'https://a.test/404' }, d);
    expect(d.cache.store.size).toBe(1);
    expect((await handleFetchPage({ url: 'https://a.test/', format: 'html' }, d)).cached).toBe(true);
  });

  it('SSRF 拦截是终止性错误，不降级到下一个抓取器', async () => {
    const local = vi.fn(async () => page());
    const remote: Fetcher = { name: 'worker', fetch: async () => { throw new Error('wrap', { cause: new SsrfBlockedError('blocked') }); } };
    const d = deps({ name: 'http', fetch: local }, remote);
    const err = await handleFetchPage({ url: 'https://a.test/' }, d).catch(e => e);
    expect(err).toBeInstanceOf(FetchPageError);
    expect((err as FetchPageError).code).toBe('SSRF_BLOCKED');
    expect(local).not.toHaveBeenCalled();
  });

  it('普通失败降级到本地抓取器；已取消直接报 CANCELLED', async () => {
    const remote: Fetcher = { name: 'worker', fetch: async () => { throw new Error('502'); } };
    const d = deps({ name: 'http', fetch: async () => page({ fetchedBy: 'http' }) }, remote);
    expect((await handleFetchPage({ url: 'https://a.test/' }, d)).fetchedBy).toBe('http');
    const ac = new AbortController();
    ac.abort();
    const err = await handleFetchPage({ url: 'https://a.test/x' }, d, ac.signal).catch(e => e);
    expect((err as FetchPageError).code).toBe('CANCELLED');
  });
});
