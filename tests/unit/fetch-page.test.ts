/**
 * fetch_page：总 deadline、确定性错误不降级、http ↔ browser 互相降级
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleFetchPage, sliceContent, DEFAULT_MAX_LENGTH, FetchPageError, MIN_ATTEMPT_BUDGET_MS, type FetchPageToolDeps } from '../../src/tools/fetch-page.js';
import { UnsupportedContentTypeError } from '../../src/fetcher/content-type.js';
import { BrowserNotInstalledError } from '../../src/fetcher/browser-errors.js';
import { HttpError } from '../../src/utils/http-client.js';
import type { Fetcher, FetchOptions, FetchResult } from '../../src/fetcher/fetcher-interface.js';
import type { CacheProvider } from '../../src/cache/cache-interface.js';

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

const SKELETON = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/main.js"></script></body></html>';
const ARTICLE = `<!doctype html><html><head><title>A</title></head><body><p>${'readable text '.repeat(40)}</p></body></html>`;

function page(overrides: Partial<FetchResult> = {}): FetchResult {
  return { url: 'https://a.test/', content: 'hello', statusCode: 200, fetchTime: 1, contentType: 'text/html', ...overrides };
}

/** http 抓取器：仅在 includeRawHtml / format=html 时回传 rawHtml（与真实实现一致） */
function httpFetcher(html: string, extra: Partial<FetchResult> = {}): Fetcher & { fetch: ReturnType<typeof vi.fn> } {
  return {
    name: 'http',
    fetch: vi.fn(async (o: FetchOptions) => page({
      fetchedBy: 'http',
      content: 'App',
      rawHtml: o.includeRawHtml || o.format === 'html' ? html : undefined,
      ...extra,
    })),
  };
}

function browserFetcher(impl?: (o: FetchOptions) => Promise<FetchResult>): Fetcher & { fetch: ReturnType<typeof vi.fn> } {
  return { name: 'browser', fetch: vi.fn(impl ?? (async () => page({ fetchedBy: 'browser', content: 'rendered body' }))) };
}

function deps(fetchers: FetchPageToolDeps['fetchers'], extra: Partial<FetchPageToolDeps> = {}) {
  return {
    cache: memCache(),
    ssrfGuard: { validateUrl: async () => ({ safe: true }), getDispatcher: () => undefined } as unknown as FetchPageToolDeps['ssrfGuard'],
    fetchers,
    defaultMethod: 'http' as const,
    defaultTimeoutMs: 10_000,
    maxBytes: 1024,
    contentFilterMode: 'off' as const,
    ...extra,
  } satisfies FetchPageToolDeps;
}

function remote(fetcher: Fetcher): NonNullable<FetchPageToolDeps['remote']> {
  return {
    fetcher: Object.assign(fetcher, { hasHealthyWorker: () => true, supports: () => true }),
    useFor: 'always',
    fallbackToLocal: true,
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('fetch_page 总 deadline', () => {
  it('下一个抓取器只拿剩余预算', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const worker: Fetcher = { name: 'worker', fetch: vi.fn(async () => { now += 4000; throw new Error('502'); }) };
    const http = httpFetcher(ARTICLE);
    const d = deps({ http }, { remote: remote(worker) });
    const r = await handleFetchPage({ url: 'https://a.test/', timeout: 10_000, method: 'http' }, d);
    expect(r.fetchedBy).toBe('http');
    expect((worker.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].timeout).toBe(10_000);
    expect(http.fetch.mock.calls[0][0].timeout).toBe(6000);
  });

  it('剩余预算过小直接放弃，不再降级', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const worker: Fetcher = { name: 'worker', fetch: async () => { now += 10_000 - MIN_ATTEMPT_BUDGET_MS + 1; throw new Error('超时'); } };
    const http = httpFetcher(ARTICLE);
    const err = await handleFetchPage({ url: 'https://a.test/', timeout: 10_000 }, deps({ http }, { remote: remote(worker) })).catch(e => e);
    expect(err).toBeInstanceOf(FetchPageError);
    expect((err as FetchPageError).code).toBe('FETCH_FAILED');
    expect((err as Error).message).toMatch(/预算已用尽/);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('浏览器重抓同样受总 deadline 约束', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const http: Fetcher = { name: 'http', fetch: async () => { now += 9500; return page({ fetchedBy: 'http', rawHtml: SKELETON }); } };
    const browser = browserFetcher();
    const r = await handleFetchPage({ url: 'https://a.test/', timeout: 10_000 }, deps({ http, browser }));
    expect(browser.fetch).not.toHaveBeenCalled();
    expect(r.fetchedBy).toBe('http');
    expect(r.warnings?.join()).toMatch(/剩余时间不足/);
  });
});

describe('fetch_page 确定性错误不换抓取器', () => {
  it.each([
    ['UNSUPPORTED_CONTENT_TYPE', () => new Error('wrap', { cause: new UnsupportedContentTypeError('application/pdf') })],
    ['TOO_LARGE', () => new Error('wrap', { cause: new HttpError('响应体过大', 200, 'TOO_LARGE') })],
  ])('%s', async (code, make) => {
    const worker: Fetcher = { name: 'worker', fetch: async () => { throw make(); } };
    const http = httpFetcher(ARTICLE);
    const err = await handleFetchPage({ url: 'https://a.test/' }, deps({ http }, { remote: remote(worker) })).catch(e => e);
    expect((err as FetchPageError).code).toBe(code);
    expect(http.fetch).not.toHaveBeenCalled();
  });
});

describe('fetch_page http → browser 自动升级', () => {
  it('未指定 method 时骨架页改用浏览器重抓，rawHtml 不外泄', async () => {
    const http = httpFetcher(SKELETON);
    const browser = browserFetcher();
    const d = deps({ http, browser });
    const r = await handleFetchPage({ url: 'https://a.test/' }, d);
    expect(http.fetch.mock.calls[0][0].includeRawHtml).toBe(true);
    expect(browser.fetch.mock.calls[0][0].method).toBe('browser');
    expect(r.fetchedBy).toBe('browser');
    expect(r.rawHtml).toBeUndefined();
    expect(r.warnings?.join()).toMatch(/已自动改用浏览器重抓/);
    expect(d.cache.store.size).toBe(1);
  });

  it('反爬挑战页（Just a moment...）同样升级', async () => {
    const http = httpFetcher('<html><head><title>Just a moment...</title></head><body></body></html>', { statusCode: 503, title: 'Just a moment...' });
    const browser = browserFetcher();
    const r = await handleFetchPage({ url: 'https://a.test/' }, deps({ http, browser }));
    expect(r.fetchedBy).toBe('browser');
  });

  it('显式 method=http 不升级；正常页面不升级', async () => {
    const browser = browserFetcher();
    const r1 = await handleFetchPage({ url: 'https://a.test/', method: 'http' }, deps({ http: httpFetcher(SKELETON), browser }));
    expect(r1.fetchedBy).toBe('http');
    const r2 = await handleFetchPage({ url: 'https://a.test/b' }, deps({ http: httpFetcher(ARTICLE), browser }));
    expect(r2.fetchedBy).toBe('http');
    expect(r2.warnings).toBeUndefined();
    expect(browser.fetch).not.toHaveBeenCalled();
  });

  it('浏览器重抓失败时返回 http 结果并给出 warning，且不缓存', async () => {
    const browser = browserFetcher(async () => { throw new Error('crash'); });
    const d = deps({ http: httpFetcher(SKELETON), browser });
    const r = await handleFetchPage({ url: 'https://a.test/' }, d);
    expect(r.fetchedBy).toBe('http');
    expect(r.warnings?.join()).toMatch(/浏览器重抓失败/);
    expect(d.cache.store.size).toBe(0);
  });

  it('403 空白拦截页同样升级', async () => {
    const http = httpFetcher('<html><body><h1>Forbidden</h1></body></html>', { statusCode: 403, content: 'Forbidden' });
    const browser = browserFetcher();
    const r = await handleFetchPage({ url: 'https://a.test/' }, deps({ http, browser }));
    expect(r.fetchedBy).toBe('browser');
    expect(r.warnings?.join()).toMatch(/疑似拦截非浏览器请求，已自动改用浏览器重抓/);
  });

  it('浏览器不可用时仍检测骨架页，给出启用提示且不缓存', async () => {
    const http = httpFetcher(SKELETON);
    const d = deps({ http });
    const r = await handleFetchPage({ url: 'https://a.test/' }, d);
    expect(http.fetch.mock.calls[0][0].includeRawHtml).toBe(true);
    expect(r.fetchedBy).toBe('http');
    expect(r.rawHtml).toBeUndefined();
    expect(r.warnings?.join()).toMatch(/骨架页.*浏览器抓取不可用.*playwright install chromium/);
    expect(d.cache.store.size).toBe(0);
  });

  it('浏览器不可用、页面正常时不附 warning', async () => {
    const r = await handleFetchPage({ url: 'https://a.test/' }, deps({ http: httpFetcher(ARTICLE) }));
    expect(r.warnings).toBeUndefined();
  });

  it('autoBrowserUpgrade=false 时既不检测也不升级', async () => {
    const http = httpFetcher(SKELETON);
    const browser = browserFetcher();
    const r = await handleFetchPage({ url: 'https://a.test/' }, deps({ http, browser }, { autoBrowserUpgrade: false }));
    expect(http.fetch.mock.calls[0][0].includeRawHtml).toBeUndefined();
    expect(browser.fetch).not.toHaveBeenCalled();
    expect(r.warnings).toBeUndefined();
  });

  it('format=html 时只在 content 里返回一份 HTML（不再重复 rawHtml）', async () => {
    const r = await handleFetchPage({ url: 'https://a.test/', format: 'html', method: 'http' }, deps({ http: httpFetcher(ARTICLE, { content: ARTICLE }) }));
    expect(r.content).toBe(ARTICLE);
    expect((r as Record<string, unknown>).rawHtml).toBeUndefined();
  });

  it('format=html 而抓取器 content 为空时用 rawHtml 补上', async () => {
    const r = await handleFetchPage({ url: 'https://a.test/', format: 'html', method: 'http' }, deps({ http: httpFetcher(ARTICLE, { content: '' }) }));
    expect(r.content).toBe(ARTICLE);
  });
});

describe('fetch_page 长度控制（maxLength / startIndex）', () => {
  const LONG = 'x'.repeat(250);

  it('默认上限 DEFAULT_MAX_LENGTH，超出时 truncated + nextStartIndex', async () => {
    const big = 'a'.repeat(DEFAULT_MAX_LENGTH + 10);
    const r = await handleFetchPage({ url: 'https://a.test/', method: 'http' }, deps({ http: httpFetcher(ARTICLE, { content: big }) }));
    expect(r.content).toHaveLength(DEFAULT_MAX_LENGTH);
    expect(r.truncated).toBe(true);
    expect(r.totalLength).toBe(DEFAULT_MAX_LENGTH + 10);
    expect(r.nextStartIndex).toBe(DEFAULT_MAX_LENGTH);
  });

  it('分段续读命中同一份缓存，最后一段不带 nextStartIndex', async () => {
    const http = httpFetcher(ARTICLE, { content: LONG });
    const d = deps({ http });
    const r1 = await handleFetchPage({ url: 'https://a.test/', method: 'http', maxLength: 100 }, d);
    expect(r1.content).toBe('x'.repeat(100));
    expect(r1.nextStartIndex).toBe(100);
    const r2 = await handleFetchPage({ url: 'https://a.test/', method: 'http', maxLength: 100, startIndex: 200 }, d);
    expect(r2.cached).toBe(true);
    expect(r2.content).toHaveLength(50);
    expect(r2.truncated).toBeUndefined();
    expect(r2.nextStartIndex).toBeUndefined();
    expect(http.fetch).toHaveBeenCalledTimes(1);
    // 缓存里存的是完整正文
    const [stored] = [...d.cache.store.values()] as FetchResult[];
    expect(stored.content).toBe(LONG);
  });

  it('startIndex 超出长度时返回空内容并给出 warning', async () => {
    const r = await handleFetchPage({ url: 'https://a.test/', method: 'http', startIndex: 999 }, deps({ http: httpFetcher(ARTICLE, { content: LONG }) }));
    expect(r.content).toBe('');
    expect(r.warnings?.join()).toMatch(/超出正文长度/);
  });

  it('响应体字节截断改名为 bodyTruncated，并带 warning', async () => {
    const r = await handleFetchPage({ url: 'https://a.test/', method: 'http' }, deps({ http: httpFetcher(ARTICLE, { content: 'short', truncated: true }) }));
    expect(r.truncated).toBeUndefined();
    expect(r.bodyTruncated).toBe(true);
    expect(r.warnings?.join()).toMatch(/大小上限/);
  });

  it('不把代理对切成两半', () => {
    const s = sliceContent(page({ content: 'ab😀cd' }), 0, 3);
    expect(s.content).toBe('ab');
    expect(s.nextStartIndex).toBe(2);
  });

  it('抓取器自身的 warnings 并入结果', async () => {
    const r = await handleFetchPage({ url: 'https://a.test/', method: 'http' }, deps({ http: httpFetcher(ARTICLE, { content: 'pdf text', warnings: ['PDF 共 80 页，只提取了前 50 页'] }) }));
    expect(r.warnings).toContain('PDF 共 80 页，只提取了前 50 页');
  });
});

describe('fetch_page 路由与缓存', () => {
  it('worker useFor=always：优先走 Worker，失败回退本地', async () => {
    const worker: Fetcher = { name: 'worker', fetch: vi.fn(async () => { throw new Error('502'); }) };
    const http = httpFetcher(ARTICLE, { content: 'local' });
    const r = await handleFetchPage({ url: 'https://a.test/', method: 'http' }, deps({ http }, { remote: remote(worker) }));
    expect(worker.fetch).toHaveBeenCalledTimes(1);
    expect(r.content).toBe('local');
  });

  it('不同 format 使用不同缓存 key；cacheTtl=0 不缓存', async () => {
    const http = httpFetcher(ARTICLE, { content: 'body' });
    const d = deps({ http });
    await handleFetchPage({ url: 'https://a.test/', method: 'http', format: 'text' }, d);
    await handleFetchPage({ url: 'https://a.test/', method: 'http', format: 'markdown' }, d);
    expect(d.cache.store.size).toBe(2);
    const d0 = deps({ http: httpFetcher(ARTICLE) }, { cacheTtl: 0 });
    await handleFetchPage({ url: 'https://a.test/', method: 'http' }, d0);
    expect(d0.cache.store.size).toBe(0);
  });

  it('自动升级到浏览器的结果会被缓存，再次请求不再抓取', async () => {
    const http = httpFetcher(SKELETON);
    const browser = browserFetcher();
    const d = deps({ http, browser });
    await handleFetchPage({ url: 'https://a.test/' }, d);
    const r = await handleFetchPage({ url: 'https://a.test/' }, d);
    expect(r.cached).toBe(true);
    expect(r.content).toBe('rendered body');
    expect(browser.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('fetch_page browser → http 降级', () => {
  it('显式 method=browser 而 Playwright 未安装：退回 http 并给出 warning，不缓存', async () => {
    const http = httpFetcher(ARTICLE);
    const browser = browserFetcher(async () => { throw new BrowserNotInstalledError(); });
    const d = deps({ http, browser });
    const r = await handleFetchPage({ url: 'https://a.test/', method: 'browser' }, d);
    expect(r.fetchedBy).toBe('http');
    expect(http.fetch.mock.calls[0][0].method).toBe('http');
    expect(r.warnings?.join()).toMatch(/已退回 http/);
    expect(d.cache.store.size).toBe(0);
  });

  it('未配置浏览器抓取器时 method=browser 也退回 http', async () => {
    const r = await handleFetchPage({ url: 'https://a.test/', method: 'browser' }, deps({ http: httpFetcher(ARTICLE) }));
    expect(r.fetchedBy).toBe('http');
    expect(r.warnings?.join()).toMatch(/浏览器抓取不可用/);
  });

  it('浏览器普通失败（非未安装）不退回 http', async () => {
    const http = httpFetcher(ARTICLE);
    const browser = browserFetcher(async () => { throw new Error('navigation failed'); });
    const err = await handleFetchPage({ url: 'https://a.test/', method: 'browser' }, deps({ http, browser })).catch(e => e);
    expect((err as FetchPageError).code).toBe('FETCH_FAILED');
    expect(http.fetch).not.toHaveBeenCalled();
  });
});
