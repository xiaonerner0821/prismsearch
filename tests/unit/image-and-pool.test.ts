/**
 * 图片搜索缓存与浏览器池排队的基础行为
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleImageSearch } from '../../src/tools/image-search.js';
import { BrowserPool } from '../../src/fetcher/browser-pool.js';
import type { EngineRegistry } from '../../src/engines/engine-registry.js';
import type { EngineSelector } from '../../src/engines/engine-selector.js';
import type { SsrfGuard } from '../../src/security/ssrf-guard.js';
import type { CacheProvider } from '../../src/cache/cache-interface.js';
import type { ImageSearchResponse, ImageSearchResult, SearchProvider } from '../../src/engines/engine-interface.js';
import type { BrowserFetcherConfig } from '../../src/config/config-schema.js';

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

function imageEngine(results: ImageSearchResult[]): SearchProvider {
  const engine: SearchProvider = {
    name: 'bing',
    search: async () => ({ results: [], engine: 'bing', searchTime: 0, cached: false, page: 1, hasMore: false }),
    getStatus: () => ({ name: 'bing', available: true, latency: 1, successRate: 1 }),
    isAvailable: () => true,
    imageSearch: async () => ({ results, engine: 'bing', searchTime: 0, cached: false, page: 1, hasMore: false }),
    isImageAvailable: () => true,
  };
  return engine;
}

const ssrfGuard = {
  validateUrl: async () => ({ safe: true }),
  getDispatcher: () => undefined,
} as unknown as SsrfGuard;

afterEach(() => { vi.unstubAllGlobals(); });

describe('handleImageSearch', () => {
  it('缩略图 base64 不进缓存，命中缓存时按需补抓', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png, { headers: { 'content-type': 'image/png' } })));

    const cache = memCache();
    const results: ImageSearchResult[] = [
      { title: 'a', imageUrl: 'https://img.test/a.png', thumbnailUrl: 'https://img.test/a-thumb.png', position: 1 },
    ];
    const deps = {
      cache,
      engineRegistry: { get: () => imageEngine(results), getImageSearchAvailable: () => [imageEngine(results)] } as unknown as EngineRegistry,
      engineSelector: { rankForImage: () => [imageEngine(results)] } as unknown as EngineSelector,
      ssrfGuard,
      deadlineMs: 5000,
    };

    const first = await handleImageSearch({ query: 'cat', includeThumbnails: true }, deps);
    expect(first.results[0].thumbnailBase64).toMatch(/^data:image\/png;base64,/);

    // 缓存里还有翻页亲和记录，按结构找出搜索结果那一条
    const stored = [...cache.store.values()].find(
      v => typeof v === 'object' && v !== null && 'results' in v,
    ) as ImageSearchResponse;
    expect(stored.results[0].thumbnailBase64).toBeUndefined();

    const second = await handleImageSearch({ query: 'cat', includeThumbnails: true }, deps);
    expect(second.cached).toBe(true);
    expect(second.results[0].thumbnailBase64).toMatch(/^data:image\/png;base64,/);

    // 不要求缩略图时命中缓存不该再去抓图
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    const third = await handleImageSearch({ query: 'cat' }, deps);
    expect(third.results[0].thumbnailBase64).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('去重后按页码重新编号 position', async () => {
    const results: ImageSearchResult[] = Array.from({ length: 6 }, (_, i) => ({
      title: `t${i}`,
      imageUrl: i === 1 ? 'https://img.test/0.png' : `https://img.test/${i}.png`,
      thumbnailUrl: `https://img.test/${i}-thumb.png`,
      position: i + 1,
    }));
    const deps = {
      cache: memCache(),
      engineRegistry: {} as unknown as EngineRegistry,
      engineSelector: { rankForImage: () => [imageEngine(results)] } as unknown as EngineSelector,
      ssrfGuard,
    };
    const r = await handleImageSearch({ query: 'q', count: 2, page: 3 }, deps);
    expect(r.results.map(x => x.position)).toEqual([5, 6]);
    expect(r.results.every(x => x.thumbnailBase64 === undefined)).toBe(true);
  });
});

describe('BrowserPool 排队', () => {
  const config = { maxPages: 0, headless: true, timeout: 1000, browserType: 'chromium' } as BrowserFetcherConfig;

  it('并发满时排队超时报错，而不是无限挂起', async () => {
    const pool = new BrowserPool(config);
    await expect(pool.acquire({ timeoutMs: 20 })).rejects.toThrow(/排队超时/);
  });

  it('关闭后拒绝获取', async () => {
    const pool = new BrowserPool(config);
    await pool.close();
    await expect(pool.acquire()).rejects.toThrow(/已关闭/);
  });
});
