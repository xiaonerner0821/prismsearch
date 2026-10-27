/**
 * EngineSelector 排序与评分单元测试
 */

import { describe, it, expect } from 'vitest';
import { EngineSelector } from '../../src/engines/engine-selector.js';
import type { EngineConfig } from '../../src/config/config-schema.js';
import type { EngineRegistry } from '../../src/engines/engine-registry.js';
import type { SearchProvider, EngineStatus } from '../../src/engines/engine-interface.js';

interface FakeEngine extends SearchProvider {
  imageSearch?: (req: unknown) => Promise<unknown>;
}

function makeEngine(
  name: string,
  status: Partial<EngineStatus> = {},
  opts: { image?: boolean } = {},
): FakeEngine {
  const engine: FakeEngine = {
    name,
    search: async () => ({ results: [], engine: name, searchTime: 0, cached: false, page: 1, hasMore: false }),
    getStatus: () => ({
      name,
      available: true,
      latency: 100,
      successRate: 1,
      ...status,
    }),
    isAvailable: () => true,
  };
  if (opts.image) {
    engine.imageSearch = async () => ({ results: [], engine: name, searchTime: 0, cached: false, page: 1, hasMore: false });
  }
  return engine;
}

function makeRegistry(engines: FakeEngine[], imageEngines: FakeEngine[] = []): EngineRegistry {
  return {
    getAvailable: () => engines,
    getImageSearchAvailable: () => imageEngines,
    get: (name: string) => engines.find(e => e.name === name),
  } as unknown as EngineRegistry;
}

function makeConfig(name: string, overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    name,
    displayName: name,
    enabled: true,
    type: 'scraper',
    baseUrl: `https://${name}.example.com/`,
    timeout: 10000,
    priority: 2,
    rateLimit: { maxRequests: 10, windowMs: 60000 },
    ...overrides,
  } as EngineConfig;
}

const REQ = { query: 'hello world' };

describe('EngineSelector 基础排序', () => {
  it('成功率高的引擎排在前面', () => {
    const good = makeEngine('google', { successRate: 0.99, latency: 100 });
    const bad = makeEngine('bing', { successRate: 0.2, latency: 4000 });
    const selector = new EngineSelector();
    const ranked = selector.rank(REQ, makeRegistry([bad, good]));
    expect(ranked.map(e => e.name)).toEqual(['google', 'bing']);
  });

  it('延迟低的引擎得分更高（其他条件相同时）', () => {
    const fast = makeEngine('bing', { latency: 100 });
    const slow = makeEngine('brave', { latency: 4800 });
    const selector = new EngineSelector();
    const ranked = selector.rank(REQ, makeRegistry([slow, fast]));
    expect(ranked[0].name).toBe(fast.name);
  });

  it('引擎配置里的 priority 会影响评分', () => {
    const a = makeEngine('custom-a');
    const b = makeEngine('custom-b');
    const selector = new EngineSelector();
    // 只有 a 有高优先级配置
    selector.setEngineConfigs([makeConfig('custom-a', { priority: 1 })]);
    const ranked = selector.rank(REQ, makeRegistry([b, a]));
    expect(ranked[0].name).toBe('custom-a');
  });

  it('没有可用引擎时返回空列表', () => {
    const selector = new EngineSelector();
    expect(selector.rank(REQ, makeRegistry([]))).toEqual([]);
    expect(selector.select(REQ, makeRegistry([]))).toBeNull();
  });

  it('只有一个引擎时直接返回它', () => {
    const only = makeEngine('google');
    const selector = new EngineSelector();
    expect(selector.rank(REQ, makeRegistry([only]))).toEqual([only]);
  });
});

describe('EngineSelector 语言匹配', () => {
  it('显式语言与引擎亲和性一致时得分更高', () => {
    const baidu = makeEngine('baidu');
    const google = makeEngine('google');
    const selector = new EngineSelector();
    // 两者其余条件相同，中文请求下百度应有语言优势
    const ranked = selector.rank({ query: '中文查询', language: 'zh-CN' }, makeRegistry([google, baidu]));
    expect(ranked[0].name).toBe('baidu');
  });

  it('未指定语言时按查询是否含 CJK 判断偏好', () => {
    const baidu = makeEngine('baidu');
    const google = makeEngine('google');
    const selector = new EngineSelector();

    const cjk = selector.rank({ query: '测试中文' }, makeRegistry([google, baidu]));
    expect(cjk[0].name).toBe('baidu');

    const en = selector.rank({ query: 'test english' }, makeRegistry([baidu, google]));
    expect(en[0].name).toBe('google');
  });
});

describe('EngineSelector 指定引擎与降级顺序', () => {
  it('指定引擎排在首位', () => {
    const google = makeEngine('google');
    const bing = makeEngine('bing');
    const selector = new EngineSelector();
    const ranked = selector.rank({ query: 'x', engine: 'bing' }, makeRegistry([google, bing]));
    expect(ranked[0].name).toBe('bing');
    expect(ranked.map(e => e.name).sort()).toEqual(['bing', 'google']);
  });

  it('crossOrigin 配置的引擎在降级时获得加分，可翻转原本的评分顺序', () => {
    // 三个引擎成功率/延迟完全相同，得分差异只来自 priority 与语言亲和性：
    // bing（priority 2，英文亲和）略高于 duckduckgo（priority 6）
    const makeSet = () => [
      makeEngine('google', { successRate: 0.9 }),
      makeEngine('bing', { successRate: 0.9 }),
      makeEngine('duckduckgo', { successRate: 0.9 }),
    ];
    const req = { query: 'test english' };

    // 对照组：没有 crossOrigin 配置时 bing 排在 duckduckgo 前面
    const plain = new EngineSelector();
    const baseline = plain.rank({ ...req, engine: 'google' }, makeRegistry(makeSet()));
    expect(baseline.map(e => e.name).slice(1, 3)).toEqual(['bing', 'duckduckgo']);

    // 配置 google 失败后优先降级到 duckduckgo，顺序应被翻转
    const configured = new EngineSelector();
    configured.setEngineConfigs([
      makeConfig('google', { fallback: { crossOrigin: ['duckduckgo'] } } as Partial<EngineConfig>),
    ]);
    const ranked = configured.rank({ ...req, engine: 'google' }, makeRegistry(makeSet()));
    expect(ranked[0].name).toBe('google');
    expect(ranked[1].name).toBe('duckduckgo');
  });

  it('指定了不存在的引擎时返回其余候选', () => {
    const google = makeEngine('google');
    const selector = new EngineSelector();
    const ranked = selector.rank({ query: 'x', engine: 'nope' }, makeRegistry([google]));
    expect(ranked.map(e => e.name)).toEqual(['google']);
  });
});

describe('EngineSelector 图片搜索', () => {
  it('只返回支持图片搜索的引擎', () => {
    const web = makeEngine('google');
    const img = makeEngine('bing', {}, { image: true });
    const selector = new EngineSelector();
    const ranked = selector.rankForImage({ query: 'cat' }, makeRegistry([web], [img]));
    expect(ranked.map(e => e.name)).toEqual(['bing']);
  });

  it('指定了不支持图片搜索的引擎时返回空', () => {
    const web = makeEngine('google');
    const selector = new EngineSelector();
    expect(selector.rankForImage({ query: 'cat', engine: 'google' }, makeRegistry([web], []))).toEqual([]);
  });

  it('指定了支持图片搜索的引擎时排在首位', () => {
    const a = makeEngine('google', {}, { image: true });
    const b = makeEngine('bing', {}, { image: true });
    const selector = new EngineSelector();
    const ranked = selector.rankForImage({ query: 'cat', engine: 'bing' }, makeRegistry([a, b], [a, b]));
    expect(ranked[0].name).toBe('bing');
  });
});
