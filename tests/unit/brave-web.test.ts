/**
 * Brave Search API 引擎单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BraveWebEngine, BraveApiError } from '../../src/engines/brave/brave-web.js';
import type { EngineConfig } from '../../src/config/config-schema.js';
import { makeResponse } from './helpers/mock-response.js';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    name: 'brave',
    displayName: 'Brave Search',
    enabled: true,
    type: 'api',
    baseUrl: 'https://api.search.brave.com/res/v1/web/search',
    timeout: 5000,
    priority: 2,
    rateLimit: { maxRequests: 10, windowMs: 60000 },
    ...overrides,
  };
}

function mockFetchJson(body: unknown, status = 200) {
  return vi.fn().mockImplementation(async () =>
    makeResponse(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      contentType: 'application/json',
    }),
  );
}

describe('BraveWebEngine', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('未配置 API Key 时不可用', () => {
    const engine = new BraveWebEngine(makeConfig());
    expect(engine.isAvailable()).toBe(false);
  });

  it('支持从环境变量 BRAVE_API_KEY 读取', () => {
    vi.stubEnv('BRAVE_API_KEY', 'env-token');
    const engine = new BraveWebEngine(makeConfig());
    expect(engine.isAvailable()).toBe(true);
  });

  it('search 正确映射结果与请求参数', async () => {
    const engine = new BraveWebEngine(makeConfig({ apiKey: 'BSA-test' }));
    globalThis.fetch = mockFetchJson({
      web: {
        results: [
          { title: 'OpenAI', url: 'https://openai.com', description: 'AI company' },
          { title: 'Example', url: 'https://example.com', description: 'Example site' },
        ],
      },
    });

    const resp = await engine.search({ query: 'openai', region: 'us', language: 'zh-CN', safeSearch: true, timeRange: 'month', count: 10, page: 2 });

    expect(resp.engine).toBe('brave');
    expect(resp.results).toHaveLength(2);
    expect(resp.results[0]).toMatchObject({
      title: 'OpenAI',
      url: 'https://openai.com',
      snippet: 'AI company',
      source: 'brave',
      position: 11, // 第2页: (2-1)*10+1
    });

    const [calledUrl, calledOpts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = new URL(calledUrl as string);
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.searchParams.get('q')).toBe('openai');
    expect(url.searchParams.get('country')).toBe('US');
    expect(url.searchParams.get('search_lang')).toBe('zh-hans');
    expect(url.searchParams.get('safesearch')).toBe('strict');
    // Brave 的 offset 是「从 0 开始的页码」，第 2 页应为 1（旧实现误传条目偏移 10）
    expect(url.searchParams.get('offset')).toBe('1');
    expect(url.searchParams.get('count')).toBe('10');
    expect(url.searchParams.get('text_decorations')).toBe('false');
    expect(url.searchParams.get('freshness')).toBe('pm');
    expect((calledOpts as RequestInit).headers).toMatchObject({ 'X-Subscription-Token': 'BSA-test' });
  });

  it('查询无匹配时返回空数组而非抛错', async () => {
    const engine = new BraveWebEngine(makeConfig({ apiKey: 'BSA-test' }));
    globalThis.fetch = mockFetchJson({ web: { results: [] } });

    const resp = await engine.search({ query: 'asdfqwer-no-match' });
    expect(resp.results).toEqual([]);
  });

  it('HTTP 401/429 抛出 BraveApiError 并携带状态码', async () => {
    const engine = new BraveWebEngine(makeConfig({ apiKey: 'BSA-bad' }));
    globalThis.fetch = mockFetchJson({ error: 'invalid token' }, 401);

    await expect(engine.search({ query: 'x' })).rejects.toThrow(BraveApiError);
    await engine.search({ query: 'x' }).catch((e: BraveApiError) => {
      expect(e.statusCode).toBe(401);
    });
    expect(engine.getStatus().lastError).toContain('401');
  });

  it('第 1 页不发送 offset，超出最大页数时明确报错', async () => {
    const engine = new BraveWebEngine(makeConfig({ apiKey: 'BSA-test' }));
    const fetchMock = mockFetchJson({ web: { results: [] } });
    globalThis.fetch = fetchMock;

    await engine.search({ query: 'x', count: 10, page: 1 });
    const firstUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(firstUrl.searchParams.has('offset')).toBe(false);

    // Brave Web API 的 offset 上限为 9，即最多第 10 页
    await expect(engine.search({ query: 'x', count: 10, page: 11 })).rejects.toThrow(/最多只能取到前 100 条/);
  });

  it('count 超过 20 时按 20 条一页连续请求并切片', async () => {
    const engine = new BraveWebEngine(makeConfig({ apiKey: 'BSA-test' }));
    const pageItems = (p: number) => Array.from({ length: 20 }, (_, i) => ({
      title: `r-${p * 20 + i}`,
      url: `https://example.com/${p * 20 + i}`,
    }));
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => mockFetchJson({ web: { results: pageItems(0) } })())
      .mockImplementationOnce(async () => mockFetchJson({ web: { results: pageItems(1) } })());
    globalThis.fetch = fetchMock;

    const resp = await engine.search({ query: 'x', count: 30, page: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = new URL(fetchMock.mock.calls[1][0] as string);
    expect(second.searchParams.get('count')).toBe('20');
    expect(second.searchParams.get('offset')).toBe('1');
    expect(resp.results).toHaveLength(30);
    expect(resp.results[29]).toMatchObject({ title: 'r-29', position: 30 });
  });

  it('区域 uk 映射为合法国家码 GB', async () => {
    const engine = new BraveWebEngine(makeConfig({ apiKey: 'BSA-test' }));
    const fetchMock = mockFetchJson({ web: { results: [] } });
    globalThis.fetch = fetchMock;

    await engine.search({ query: 'x', region: 'uk' });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('country')).toBe('GB');
  });

  it('imageSearch 翻页通过多取后切片实现（图片接口不支持 offset）', async () => {
    const engine = new BraveWebEngine(makeConfig({ apiKey: 'BSA-test' }));
    const items = Array.from({ length: 20 }, (_, i) => ({
      title: `img-${i}`,
      url: `https://example.com/p${i}`,
      properties: { url: `https://img.example.com/${i}.jpg` },
      thumbnail: { src: `https://img.example.com/${i}-t.jpg` },
    }));
    const fetchMock = mockFetchJson({ results: items });
    globalThis.fetch = fetchMock;

    const resp = await engine.imageSearch({ query: 'cat', count: 10, page: 2 });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.has('offset')).toBe(false);
    // 第 2 页需要前 20 条
    expect(calledUrl.searchParams.get('count')).toBe('20');
    expect(resp.results.map(r => r.title)).toEqual(items.slice(10, 20).map(i => i.title));
    expect(resp.results[0].position).toBe(11);
  });

  it('imageSearch 映射图片字段', async () => {
    const engine = new BraveWebEngine(makeConfig({ apiKey: 'BSA-test' }));
    globalThis.fetch = mockFetchJson({
      results: [
        {
          title: 'Cat',
          url: 'https://example.com/cat-page',
          source: 'example.com',
          properties: { url: 'https://img.example.com/cat.jpg', width: 800, height: 600 },
          thumbnail: { src: 'https://img.example.com/cat-thumb.jpg' },
        },
      ],
    });

    const resp = await engine.imageSearch({ query: 'cat', count: 10, page: 1 });

    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]).toMatchObject({
      title: 'Cat',
      imageUrl: 'https://img.example.com/cat.jpg',
      thumbnailUrl: 'https://img.example.com/cat-thumb.jpg',
      sourceUrl: 'https://example.com/cat-page',
      width: 800,
      height: 600,
      source: 'brave',
    });

    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/res/v1/images/search');
  });
});
