/**
 * web_search 新增能力：参数能力声明与 warning、timeRange、聚合模式（RRF）、进度通知、
 * 可配置的引擎亲和
 */

import { describe, it, expect, vi } from 'vitest';
import { EngineSelector } from '../../src/engines/engine-selector.js';
import type { EngineRegistry } from '../../src/engines/engine-registry.js';
import type { EngineConfig } from '../../src/config/config-schema.js';
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult } from '../../src/engines/engine-interface.js';
import { capabilitiesOf, unsupportedParams, unsupportedParamsWarning } from '../../src/engines/engine-capabilities.js';
import { runConcurrent, runWithFallback, NoEngineAvailableError } from '../../src/tools/search-runner.js';
import { handleWebSearch, fuseResults, type SearchProgress } from '../../src/tools/web-search.js';
import { progressNotifier } from '../../src/server/mcp-server.js';
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

function item(url: string, position = 1, snippet = ''): SearchResult {
  return { title: url, url, snippet, position };
}

function resp(engine: string, results: SearchResult[], hasMore = false): SearchResponse {
  return { results, engine, searchTime: 1, cached: false, page: 1, hasMore };
}

function engine(name: string, search: (req: SearchRequest) => Promise<SearchResponse>, available = true): SearchProvider {
  return {
    name,
    search,
    getStatus: () => ({ name, available, latency: 100, successRate: 1 }),
    isAvailable: () => available,
  };
}

function registryOf(engines: SearchProvider[]): EngineRegistry {
  return {
    get: (n: string) => engines.find(e => e.name === n),
    getAvailable: () => engines.filter(e => e.isAvailable()),
    getImageSearchAvailable: () => [],
  } as unknown as EngineRegistry;
}

describe('引擎参数能力', () => {
  it('中文引擎只支持 timeRange；未登记引擎全部不支持', () => {
    expect(capabilitiesOf('baidu')).toEqual({ safeSearch: false, region: false, language: false, timeRange: true });
    expect(capabilitiesOf('google').safeSearch).toBe(true);
    expect(capabilitiesOf('nope').timeRange).toBe(false);
    expect(unsupportedParams('sogou', { safeSearch: true, region: 'cn', language: 'zh', timeRange: 'day' }))
      .toEqual(['safeSearch', 'region', 'language']);
    expect(unsupportedParamsWarning('google', { safeSearch: true, region: 'us' })).toBeUndefined();
    expect(unsupportedParamsWarning('yandex', { timeRange: 'week' })).toMatch(/yandex.*timeRange/);
  });

  it('web_search 结果附带被忽略参数的 warning', async () => {
    const baidu = engine('baidu', async () => resp('baidu', [item('https://b.test/1')]));
    const r = await handleWebSearch({ query: 'q', engine: 'baidu', safeSearch: true, region: 'us' }, {
      cache: memCache(), engineRegistry: registryOf([baidu]), engineSelector: new EngineSelector(),
    });
    expect(r.warnings).toEqual(['引擎 baidu 不支持参数 safeSearch, region，已忽略']);
  });

  it('参数都支持时不带 warnings 字段', async () => {
    const google = engine('google', async () => resp('google', [item('https://g.test/1')]));
    const r = await handleWebSearch({ query: 'q', engine: 'google', safeSearch: true }, {
      cache: memCache(), engineRegistry: registryOf([google]), engineSelector: new EngineSelector(),
    });
    expect(r.warnings).toBeUndefined();
  });
});

describe('timeRange', () => {
  it('透传给引擎，并参与缓存 key（不同 timeRange 不共用缓存）', async () => {
    const seen: Array<string | undefined> = [];
    const google = engine('google', async req => { seen.push(req.timeRange); return resp('google', [item(`https://g.test/${seen.length}`)]); });
    const deps = { cache: memCache(), engineRegistry: registryOf([google]), engineSelector: new EngineSelector() };
    await handleWebSearch({ query: 'q', timeRange: 'week' }, deps);
    const again = await handleWebSearch({ query: 'q', timeRange: 'week' }, deps);
    const other = await handleWebSearch({ query: 'q', timeRange: 'day' }, deps);
    const none = await handleWebSearch({ query: 'q' }, deps);
    expect(again.cached).toBe(true);
    expect(other.cached).toBe(false);
    expect(none.cached).toBe(false);
    expect(seen).toEqual(['week', 'day', undefined]);
  });

  it('自动选引擎时，支持时间过滤的引擎排到前面', async () => {
    const calls: string[] = [];
    const yandex = engine('yandex', async () => { calls.push('yandex'); return resp('yandex', [item('https://y.test')]); });
    const bing = engine('bing', async () => { calls.push('bing'); return resp('bing', [item('https://b.test')]); });
    const selector = new EngineSelector();
    vi.spyOn(selector, 'rank').mockReturnValue([yandex, bing]);
    const r = await handleWebSearch({ query: 'q', timeRange: 'month' }, {
      cache: memCache(), engineRegistry: registryOf([yandex, bing]), engineSelector: selector,
    });
    expect(r.engine).toBe('bing');
    expect(calls).toEqual(['bing']);
  });
});

describe('聚合模式', () => {
  it('fuseResults：多家都靠前的结果排第一，sources 记录来源，摘要互补', () => {
    const fused = fuseResults([
      { engine: 'a', results: [item('https://x.test/1'), item('https://shared.test/', 2, '')] },
      { engine: 'b', results: [item('https://www.shared.test', 1, 'from b'), item('https://y.test/1', 2)] },
    ]);
    expect(fused[0].url).toBe('https://www.shared.test');
    expect(fused[0].sources).toEqual(['a', 'b']);
    expect(fused[0].snippet).toBe('from b');
    expect(fused.map(r => r.url)).toEqual(['https://www.shared.test', 'https://x.test/1', 'https://y.test/1']);
  });

  it('并发查询多个引擎，合并结果并写缓存；engine 为参与引擎拼接', async () => {
    const started: string[] = [];
    const mk = (name: string, urls: string[]) => engine(name, async () => {
      started.push(name);
      await new Promise(r => setTimeout(r, 5));
      return resp(name, urls.map((u, i) => item(u, i + 1)));
    });
    const a = mk('google', ['https://1.test', 'https://2.test']);
    const b = mk('bing', ['https://2.test', 'https://3.test']);
    const c = mk('brave', ['https://2.test']);
    const d = mk('baidu', ['https://4.test']);
    const cache = memCache();
    const selector = new EngineSelector();
    vi.spyOn(selector, 'rank').mockReturnValue([a, b, c, d]);
    const r = await handleWebSearch({ query: 'q', mode: 'aggregate', count: 2 }, { cache, engineRegistry: registryOf([a, b, c, d]), engineSelector: selector });
    expect(started.sort()).toEqual(['bing', 'brave', 'google']);
    expect(r.engine).toBe('google+bing+brave');
    expect(r.engines).toEqual(['google', 'bing', 'brave']);
    expect(r.results.map(x => x.url)).toEqual(['https://2.test', 'https://1.test']);
    expect(r.results.map(x => x.position)).toEqual([1, 2]);
    expect(r.hasMore).toBe(true);
    expect(cache.store.size).toBe(1);
    const again = await handleWebSearch({ query: 'q', mode: 'aggregate', count: 2 }, { cache, engineRegistry: registryOf([a, b, c, d]), engineSelector: selector });
    expect(again.cached).toBe(true);
  });

  it('部分引擎失败：返回其余结果 + warning，且不缓存', async () => {
    const ok = engine('google', async () => resp('google', [item('https://1.test')]));
    const bad = engine('bing', async () => { throw new Error('boom'); });
    const cache = memCache();
    const selector = new EngineSelector();
    vi.spyOn(selector, 'rank').mockReturnValue([ok, bad]);
    const r = await handleWebSearch({ query: 'q', mode: 'aggregate' }, { cache, engineRegistry: registryOf([ok, bad]), engineSelector: selector });
    expect(r.results).toHaveLength(1);
    expect(r.warnings?.join()).toMatch(/实际成功 1 个/);
    expect(cache.store.size).toBe(0);
  });

  it('全部失败时报 NoEngineAvailableError', async () => {
    const bad = engine('google', async () => { throw new Error('boom'); });
    await expect(runConcurrent({
      candidates: [bad], fanout: 3, query: 'q', kind: 'web', invoke: e => e.search({ query: 'q' }),
    })).rejects.toBeInstanceOf(NoEngineAvailableError);
  });

  it('跳过熔断中的引擎，补上后面的候选', async () => {
    const res = await runConcurrent({
      candidates: [engine('a', async () => resp('a', []), false), engine('b', async () => resp('b', [])), engine('c', async () => resp('c', []))],
      fanout: 2, query: 'q', kind: 'web', invoke: e => e.search({ query: 'q' }),
    });
    expect(res.map(r => r.engine)).toEqual(['b', 'c']);
  });

  it('指定了引擎时聚合被忽略并给出 warning', async () => {
    const google = engine('google', async () => resp('google', [item('https://1.test')]));
    const r = await handleWebSearch({ query: 'q', engine: 'google', mode: 'aggregate' }, {
      cache: memCache(), engineRegistry: registryOf([google]), engineSelector: new EngineSelector(),
    });
    expect(r.engine).toBe('google');
    expect(r.warnings?.join()).toMatch(/mode=aggregate 被忽略/);
  });
});

describe('进度通知', () => {
  it('降级链每切换一个引擎回调一次', async () => {
    const events: SearchProgress[] = [];
    const bad = engine('google', async () => { throw new Error('boom'); });
    const ok = engine('bing', async () => resp('bing', [item('https://1.test')]));
    const selector = new EngineSelector();
    vi.spyOn(selector, 'rank').mockReturnValue([bad, ok]);
    await handleWebSearch({ query: 'q' }, {
      cache: memCache(), engineRegistry: registryOf([bad, ok]), engineSelector: selector, onProgress: e => events.push(e),
    });
    expect(events).toEqual([
      { progress: 1, total: 2, message: '正在使用引擎 google' },
      { progress: 2, total: 2, message: '正在使用引擎 bing' },
    ]);
  });

  it('onAttempt 抛错不影响搜索', async () => {
    const r = await runWithFallback({
      candidates: [engine('a', async () => resp('a', []))], query: 'q', kind: 'web',
      invoke: async () => 1, onAttempt: () => { throw new Error('x'); },
    });
    expect(r.value).toBe(1);
  });

  it('progressNotifier：有 progressToken 才发 notifications/progress', async () => {
    expect(progressNotifier({ notify: async () => undefined })).toBeUndefined();
    const notify = vi.fn(async () => undefined);
    const cb = progressNotifier({ _meta: { progressToken: 'tok' }, notify })!;
    cb({ progress: 1, total: 3, message: 'm' });
    expect(notify).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 'tok', progress: 1, total: 3, message: 'm' },
    });
    // 发送失败被吞掉
    const failing = progressNotifier({ _meta: { progressToken: 1 }, notify: async () => { throw new Error('closed'); } })!;
    expect(() => failing({ progress: 1, message: 'm' })).not.toThrow();
  });
});

describe('可配置的引擎亲和', () => {
  function cfg(name: string, extra: Partial<EngineConfig> = {}): EngineConfig {
    return { name, enabled: true, type: 'scraper', baseUrl: `https://${name}.test/`, timeout: 1000, priority: 5, regions: [], languages: [], ...extra } as EngineConfig;
  }
  const plain = (name: string) => engine(name, async () => resp(name, []));

  it('配置的 languages 参与语言匹配评分', () => {
    const foo = plain('foo');
    const bar = plain('bar');
    const sel = new EngineSelector();
    sel.setEngineConfigs([cfg('foo'), cfg('bar', { languages: ['ja'] })]);
    expect(sel.rank({ query: 'q', language: 'ja' }, registryOf([foo, bar]))[0].name).toBe('bar');
  });

  it('配置的 regions 参与区域匹配评分', () => {
    const foo = plain('foo');
    const bar = plain('bar');
    const sel = new EngineSelector();
    sel.setEngineConfigs([cfg('foo'), cfg('bar', { regions: ['br'] })]);
    expect(sel.rank({ query: 'q', region: 'BR' }, registryOf([foo, bar]))[0].name).toBe('bar');
  });

  it('未配置时回落到内置默认（百度擅长中文）', () => {
    const sel = new EngineSelector();
    sel.setEngineConfigs([cfg('baidu'), cfg('yandex')]);
    expect(sel.rank({ query: 'q', language: 'zh-CN' }, registryOf([plain('yandex'), plain('baidu')]))[0].name).toBe('baidu');
  });
});
