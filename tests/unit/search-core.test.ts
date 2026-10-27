/**
 * 搜索核心链路单元测试：熔断错误分类、选择器、降级执行器、web_search 缓存/翻页/并发合并、
 * URL 去重、API Key 退避
 */

import { describe, it, expect, vi } from 'vitest';
import { EngineStats } from '../../src/engines/engine-stats.js';
import { EngineSelector } from '../../src/engines/engine-selector.js';
import type { EngineRegistry } from '../../src/engines/engine-registry.js';
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult } from '../../src/engines/engine-interface.js';
import { runWithFallback, EngineRateLimiters, NoEngineAvailableError, isCallerInputError, fallbackWarning } from '../../src/tools/search-runner.js';
import { handleWebSearch, overfetchCount, overfetchHasMore, SingleFlight, shouldCacheResponse } from '../../src/tools/web-search.js';
import type { CacheProvider } from '../../src/cache/cache-interface.js';
import { normalizeUrl, deduplicateResults } from '../../src/utils/dedup.js';
import { ApiKeyManager } from '../../src/utils/api-key-manager.js';
import { handleListEngines } from '../../src/tools/list-engines.js';

const OPTS = { failureThreshold: 2, baseCooldownMs: 1000, maxCooldownMs: 8000 };

function clockStats() {
  let now = 0;
  const stats = new EngineStats(OPTS, () => now);
  return { stats, advance: (ms: number) => { now += ms; } };
}

describe('EngineStats 错误分类', () => {
  it('4xx（非 429）与取消不推进熔断', () => {
    const { stats } = clockStats();
    for (let i = 0; i < 5; i++) stats.record(false, 10, Object.assign(new Error('nf'), { status: 404 }));
    stats.record(false, 10, Object.assign(new Error('abort'), { name: 'AbortError' }));
    stats.record(false, 10, Object.assign(new Error('abort'), { code: 'ABORTED' }));
    expect(stats.getState()).toBe('closed');
    expect(stats.getLastError()).toBe('abort');
  });

  it('429 与 5xx 推进熔断，getRetryAfterMs 随时间递减', () => {
    const { stats, advance } = clockStats();
    stats.record(false, 10, Object.assign(new Error('rl'), { status: 429 }));
    stats.record(false, 10, Object.assign(new Error('5xx'), { statusCode: 503 }));
    expect(stats.getState()).toBe('open');
    expect(stats.getRetryAfterMs()).toBe(1000);
    advance(400);
    expect(stats.getRetryAfterMs()).toBe(600);
    advance(600);
    expect(stats.getRetryAfterMs()).toBe(0);
    expect(stats.getState()).toBe('half-open');
  });

  it('half-open 探测被取消时归还探测名额', () => {
    const { stats, advance } = clockStats();
    stats.record(false, 10, new Error('a'));
    stats.record(false, 10, new Error('b'));
    advance(1000);
    expect(stats.tryAcquire()).toBe(true);
    expect(stats.tryAcquire()).toBe(false);
    stats.record(false, 10, Object.assign(new Error('x'), { name: 'AbortError' }));
    expect(stats.getState()).toBe('half-open');
    expect(stats.tryAcquire()).toBe(true);
  });
});

function fakeEngine(name: string, opts: {
  available?: boolean;
  imageAvailable?: boolean;
  image?: boolean;
  acquire?: boolean;
  search?: (req: SearchRequest) => Promise<SearchResponse>;
} = {}): SearchProvider {
  const engine: SearchProvider = {
    name,
    search: opts.search ?? (async () => resp(name, [])),
    getStatus: () => ({ name, available: true, latency: 100, successRate: 1 }),
    isAvailable: () => opts.available ?? true,
  };
  if (opts.image) {
    engine.imageSearch = async () => ({ results: [], engine: name, searchTime: 0, cached: false, page: 1, hasMore: false });
    engine.isImageAvailable = () => opts.imageAvailable ?? true;
  }
  if (opts.acquire !== undefined) engine.tryAcquire = () => opts.acquire!;
  return engine;
}

function resp(engine: string, results: SearchResult[], hasMore = false): SearchResponse {
  return { results, engine, searchTime: 1, cached: false, page: 1, hasMore };
}

function registryOf(engines: SearchProvider[]): EngineRegistry {
  return {
    get: (n: string) => engines.find(e => e.name === n),
    getAvailable: () => engines.filter(e => e.isAvailable()),
    getImageSearchAvailable: () => engines.filter(e => e.imageSearch && (e.isImageAvailable?.() ?? e.isAvailable())),
  } as unknown as EngineRegistry;
}

describe('EngineSelector', () => {
  it('指定引擎熔断中时不排第一，走降级链', () => {
    const reg = registryOf([fakeEngine('google', { available: false }), fakeEngine('bing'), fakeEngine('baidu')]);
    const ranked = new EngineSelector().rank({ query: 'x', engine: 'google' }, reg);
    expect(ranked.map(e => e.name)).not.toContain('google');
    expect(ranked.length).toBe(2);
  });

  it('图片：指定引擎不支持图片返回空；图片熔断时排除', () => {
    const sel = new EngineSelector();
    const reg = registryOf([
      fakeEngine('so'),
      fakeEngine('bing', { image: true, imageAvailable: false }),
      fakeEngine('baidu', { image: true }),
    ]);
    expect(sel.rankForImage({ query: 'x', engine: 'so' }, reg)).toEqual([]);
    expect(sel.rankForImage({ query: 'x', engine: 'bing' }, reg).map(e => e.name)).toEqual(['baidu']);
  });

  it('语言匹配大小写不敏感、区域匹配加分', () => {
    const sel = new EngineSelector();
    const reg = registryOf([fakeEngine('google'), fakeEngine('baidu')]);
    expect(sel.rank({ query: 'hello', language: 'ZH-CN' }, reg)[0].name).toBe('baidu');
    expect(sel.rank({ query: 'hello', region: 'CN', language: 'zh' }, reg)[0].name).toBe('baidu');
  });

  it('图片排序用图片统计而不是网页统计', () => {
    const withImageStatus = (name: string, imageSuccess: number) => {
      const e = fakeEngine(name, { image: true });
      e.getImageStatus = () => ({ name, available: true, latency: 100, successRate: imageSuccess });
      return e;
    };
    // 网页统计完全相同；google 默认优先级更高，但图片成功率为 0
    const reg = registryOf([withImageStatus('google', 0), withImageStatus('bing', 1)]);
    expect(new EngineSelector().rankForImage({ query: 'cat' }, reg)[0].name).toBe('bing');
  });

  it('图片排序也遵守 crossOrigin 降级顺序', () => {
    const sel = new EngineSelector();
    sel.setEngineConfigs([{ name: 'google', priority: 1, fallback: { crossOrigin: ['baidu'] } } as never]);
    const reg = registryOf([
      fakeEngine('google', { image: true, imageAvailable: false }),
      fakeEngine('bing', { image: true }),
      fakeEngine('baidu', { image: true }),
    ]);
    expect(sel.rankForImage({ query: 'cat', engine: 'google' }, reg)[0].name).toBe('baidu');
  });
});

describe('runWithFallback', () => {
  it('熔断中 / 探测名额被占用的引擎跳过且不消耗限流配额', async () => {
    const limiters = new EngineRateLimiters([
      { name: 'a', rateLimit: { maxRequests: 1, windowMs: 60_000 } },
    ]);
    const a = fakeEngine('a', { available: false });
    const b = fakeEngine('b', { acquire: false });
    const c = fakeEngine('c');
    const r = await runWithFallback({
      candidates: [a, b, c], limiters, query: 'q', kind: 'web',
      invoke: e => e.search({ query: 'q' }),
    });
    expect(r.engine).toBe('c');
    // a 没占用配额
    expect(limiters.tryConsume('a').allowed).toBe(true);
    limiters.destroy();
  });

  it('上游 429 进入冷却，Retry-After 生效', async () => {
    let now = 0;
    const limiters = new EngineRateLimiters([], () => now);
    const err = Object.assign(new Error('429'), { status: 429, retryAfter: '5' });
    await expect(runWithFallback({
      candidates: [fakeEngine('a')], limiters, query: 'q', kind: 'web',
      invoke: async () => { throw err; },
    })).rejects.toBeInstanceOf(NoEngineAvailableError);
    expect(limiters.tryConsume('a').allowed).toBe(false);
    now = 5001;
    expect(limiters.tryConsume('a').allowed).toBe(true);
  });

  it('整体截止时间到期后中止当前引擎并停止降级', async () => {
    const second = vi.fn(async () => 'ok');
    const slow = (_e: SearchProvider, sig?: AbortSignal) => new Promise<string>((_, rej) => {
      sig?.addEventListener('abort', () => rej(new Error('aborted')));
    });
    let calls = 0;
    const err = await runWithFallback({
      candidates: [fakeEngine('a'), fakeEngine('b')], query: 'q', kind: 'web', deadlineMs: 30,
      invoke: (e, sig) => (calls++ === 0 ? slow(e, sig) : second()),
    }).catch(e => e);
    expect(err).toBeInstanceOf(NoEngineAvailableError);
    expect(second).not.toHaveBeenCalled();
    expect((err as NoEngineAvailableError).attempts.at(-1)?.reason).toMatch(/deadline/);
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

function item(url: string, position: number): SearchResult {
  return { title: url, url, snippet: '', position };
}

describe('handleWebSearch', () => {
  it('多取 + 去重后重新编号 position，并给出 hasMore', async () => {
    const seen: SearchRequest[] = [];
    const engine = fakeEngine('a', {
      search: async req => {
        seen.push(req);
        return resp('a', [
          item('https://x.com/1', 1), item('https://x.com/1/', 2),
          item('https://x.com/2', 3), item('https://x.com/3', 4),
        ]);
      },
    });
    const reg = registryOf([engine]);
    const r = await handleWebSearch({ query: 'q', count: 2 }, {
      cache: memCache(), engineRegistry: reg, engineSelector: new EngineSelector(), deadlineMs: 5000,
    });
    expect(seen[0].count).toBe(overfetchCount(2, 1));
    expect(seen[0].signal).toBeDefined();
    expect(r.results.map(x => [x.url, x.position])).toEqual([['https://x.com/1', 1], ['https://x.com/2', 2]]);
    expect(r.hasMore).toBe(true);
  });

  it('自动选引擎时第 2 页沿用第 1 页的引擎', async () => {
    const calls: string[] = [];
    const mk = (name: string) => fakeEngine(name, {
      search: async () => { calls.push(name); return resp(name, [item(`https://${name}.com/${calls.length}`, 1)]); },
    });
    const a = mk('google');
    const b = mk('bing');
    const cache = memCache();
    const sel = new EngineSelector();
    const r1 = await handleWebSearch({ query: 'hello' }, { cache, engineRegistry: registryOf([a, b]), engineSelector: sel });
    // 第 2 页时把引擎顺序反过来，亲和仍应选回第 1 页的引擎
    const r2 = await handleWebSearch({ query: 'hello', page: 2 }, { cache, engineRegistry: registryOf([b, a]), engineSelector: sel });
    expect(r2.engine).toBe(r1.engine);
    expect(r2.results[0].position).toBe(11);
  });

  it('并发相同请求只打一次上游；缓存命中返回 cached', async () => {
    let n = 0;
    const engine = fakeEngine('a', {
      search: async () => { n++; await new Promise(r => setTimeout(r, 10)); return resp('a', [item('https://x.com', 1)]); },
    });
    const deps = { cache: memCache(), engineRegistry: registryOf([engine]), engineSelector: new EngineSelector() };
    const [r1, r2] = await Promise.all([handleWebSearch({ query: 'q' }, deps), handleWebSearch({ query: ' Q ' }, deps)]);
    expect(n).toBe(1);
    expect(r1.results).not.toBe(r2.results);
    const r3 = await handleWebSearch({ query: 'q' }, deps);
    expect(r3.cached).toBe(true);
    expect(n).toBe(1);
  });

  it('SingleFlight 完成后释放 key', async () => {
    const sf = new SingleFlight<number>();
    await sf.run('k', async () => 1);
    expect(sf.size).toBe(0);
  });

  it('指定引擎失败降级到别的引擎时不写缓存，下次仍先试指定引擎', async () => {
    let googleCalls = 0;
    const google = fakeEngine('google', { search: async () => { googleCalls++; throw new Error('boom'); } });
    const bing = fakeEngine('bing', { search: async () => resp('bing', [item('https://bing.test/1', 1)]) });
    const cache = memCache();
    const deps = { cache, engineRegistry: registryOf([google, bing]), engineSelector: new EngineSelector() };
    const r1 = await handleWebSearch({ query: 'q', engine: 'google' }, deps);
    expect(r1.engine).toBe('bing');
    expect(cache.store.size).toBe(0);
    const r2 = await handleWebSearch({ query: 'q', engine: 'google' }, deps);
    expect(r2.cached).toBe(false);
    expect(googleCalls).toBe(2);
  });

  it('shouldCacheResponse：空结果与引擎不符时不缓存', () => {
    expect(shouldCacheResponse(undefined, 'bing', 1)).toBe(true);
    expect(shouldCacheResponse('bing', 'bing', 1)).toBe(true);
    expect(shouldCacheResponse('google', 'bing', 1)).toBe(false);
    expect(shouldCacheResponse(undefined, 'bing', 0)).toBe(false);
  });
});

describe('runWithFallback 空结果', () => {
  const run = (results: Record<string, number>) => {
    const called: string[] = [];
    const p = runWithFallback({
      candidates: Object.keys(results).map(n => fakeEngine(n)), query: 'q', kind: 'web',
      isEmpty: (v: number) => v === 0,
      invoke: async e => { called.push(e.name); return results[e.name]; },
    });
    return { p, called };
  };

  it('空结果换下一个引擎再试一次，拿到非空就返回', async () => {
    const { p, called } = run({ a: 0, b: 5, c: 9 });
    expect(await p).toMatchObject({ engine: 'b', value: 5, attempts: [{ engine: 'a', reason: 'empty result' }] });
    expect(called).toEqual(['a', 'b']);
  });

  it('最多额外重试一次；都为空时返回第一份空结果而不是报错', async () => {
    const { p, called } = run({ a: 0, b: 0, c: 9 });
    expect(await p).toMatchObject({ engine: 'a', value: 0 });
    expect(called).toEqual(['a', 'b']);
  });
});

describe('fallbackWarning / overfetchHasMore', () => {
  it('指定引擎降级到别的引擎时给出原因；未指定或命中时不提示', () => {
    const attempts = [{ engine: 'bing', reason: 'Bing 忽略了翻页参数\n详细堆栈' }];
    expect(fallbackWarning('bing', 'baidu', attempts)).toBe('指定的引擎 bing 不可用（Bing 忽略了翻页参数），已降级到 baidu');
    expect(fallbackWarning(undefined, 'baidu', attempts)).toBeUndefined();
    expect(fallbackWarning('baidu', 'baidu', [])).toBeUndefined();
  });

  it('第 1 页多取后上游只给满一页，也判定还有下一页', () => {
    expect(overfetchHasMore(false, 10, 10, 13)).toBe(true);
    expect(overfetchHasMore(false, 9, 10, 13)).toBe(false);
    expect(overfetchHasMore(false, 10, 10, 10)).toBe(false);
    expect(overfetchHasMore(false, 11, 10, 10)).toBe(true);
    expect(overfetchHasMore(true, 3, 10, 10)).toBe(true);
  });
});

describe('runWithFallback 调用方输入错误', () => {
  it('ToolInputError / fallback=false 直接抛出，不再降级', async () => {
    const second = vi.fn(async () => 'ok');
    const inputErr = Object.assign(new Error('bad'), { name: 'ToolInputError' });
    await expect(runWithFallback({
      candidates: [fakeEngine('a'), fakeEngine('b')], query: 'q', kind: 'web',
      invoke: async e => { if (e.name === 'a') throw inputErr; return second(); },
    })).rejects.toBe(inputErr);
    expect(second).not.toHaveBeenCalled();
    expect(isCallerInputError(Object.assign(new Error('x'), { fallback: false }))).toBe(true);
    // 上游 4xx 仍允许降级（爬虫 403 多半是反爬）
    expect(isCallerInputError(Object.assign(new Error('x'), { status: 403 }))).toBe(false);
  });
});

describe('list_engines 图片统计', () => {
  it('支持图片搜索的引擎带 imageStats，与网页统计分开', () => {
    const bing = fakeEngine('bing', { image: true, imageAvailable: false });
    bing.getImageStatus = () => ({ name: 'bing', available: false, latency: 321.4, successRate: 0.25, lastError: 'img boom' });
    const so = fakeEngine('so');
    const base = { type: 'scraper', enabled: true, priority: 1, regions: [] };
    const res = handleListEngines({
      engineRegistry: registryOf([bing, so]),
      config: { engines: [{ ...base, name: 'bing' }, { ...base, name: 'so' }] } as never,
    });
    const b = res.engines.find(e => e.name === 'bing')!;
    expect(b.stats.successRate).toBe(1);
    expect(b.imageStats).toEqual({ available: false, avgLatency: 321, successRate: 0.25, lastUsed: undefined, lastError: 'img boom' });
    expect(res.engines.find(e => e.name === 'so')!.imageStats).toBeUndefined();
  });

  it('每个引擎带 capabilities 参数能力声明', () => {
    const base = { type: 'scraper', enabled: true, priority: 1, regions: [] };
    const res = handleListEngines({
      engineRegistry: registryOf([fakeEngine('baidu'), fakeEngine('google')]),
      config: { engines: [{ ...base, name: 'baidu' }, { ...base, name: 'google' }] } as never,
    });
    expect(res.engines.find(e => e.name === 'baidu')!.capabilities).toEqual({ safeSearch: false, region: false, language: false, timeRange: true });
    expect(res.engines.find(e => e.name === 'google')!.capabilities.timeRange).toBe(true);
  });
});

describe('normalizeUrl', () => {
  it('保留 ref / source 等业务参数与参数顺序，只去跟踪参数', () => {
    expect(normalizeUrl('https://a.com/p?ref=1')).not.toBe(normalizeUrl('https://a.com/p?ref=2'));
    expect(normalizeUrl('https://a.com/p?b=1&a=2&utm_medium=x&UTM_Source=y')).toBe('https://a.com/p?b=1&a=2');
  });

  it('路径尾斜杠与默认端口合并，查询串不受影响', () => {
    expect(normalizeUrl('http://A.com:80/x/?q=1')).toBe(normalizeUrl('https://a.com/x?q=1'));
    expect(deduplicateResults([item('https://a.com/x/', 1), item('https://a.com/x', 2)]).length).toBe(1);
  });

  it('www. 与裸域视为同一站点，其他子域不合并', () => {
    expect(normalizeUrl('https://www.a.com/p')).toBe(normalizeUrl('https://a.com/p'));
    expect(normalizeUrl('https://m.a.com/p')).not.toBe(normalizeUrl('https://a.com/p'));
  });
});

describe('ApiKeyManager 退避', () => {
  it('冷却到期后再次失败，退避时长翻倍；成功后重置', () => {
    let now = 0;
    const m = new ApiKeyManager('t', { now: () => now });
    m.addKey('k1');
    const err = Object.assign(new Error('x'), { status: 401 });
    for (let i = 0; i < 3; i++) m.reportFailure('k1', err);
    expect(m.nextAvailableAt()).toBe(60_000);
    now = 60_000;
    expect(m.hasUsableKey()).toBe(true);
    for (let i = 0; i < 3; i++) m.reportFailure('k1', err);
    expect(m.nextAvailableAt()).toBe(60_000 + 120_000);
    now = 180_000;
    m.reportSuccess('k1');
    for (let i = 0; i < 3; i++) m.reportFailure('k1', err);
    expect(m.nextAvailableAt()).toBe(180_000 + 60_000);
  });

  it('网络错误不计入失败', () => {
    const m = new ApiKeyManager('t');
    m.addKey('k1');
    for (let i = 0; i < 10; i++) m.reportFailure('k1', Object.assign(new Error('x'), { status: 503 }));
    expect(m.hasUsableKey()).toBe(true);
  });
});
