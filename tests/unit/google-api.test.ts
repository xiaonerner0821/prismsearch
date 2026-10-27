/**
 * Google Custom Search API 客户端单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleCustomSearchClient, GoogleApiError, computeCsePaging } from '../../src/engines/google/google-api.js';
import type { EngineConfig } from '../../src/config/config-schema.js';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    name: 'google',
    displayName: 'Google',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://www.google.com/search',
    timeout: 5000,
    priority: 1,
    rateLimit: { maxRequests: 10, windowMs: 60000 },
    ...overrides,
  };
}

function mockFetchJson(body: unknown, status = 200) {
  // 返回标准 Response：http-client 需要读取 headers 并以流的方式读取 body
  return vi.fn().mockImplementation(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'content-type': 'application/json' },
    }),
  );
}

/** 取第 n 次 fetch 调用的请求头 */
function calledHeaders(n = 0): Headers {
  const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[n][1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

describe('GoogleCustomSearchClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('未配置凭据时 create 返回 null', () => {
    expect(GoogleCustomSearchClient.create(makeConfig())).toBeNull();
  });

  it('仅有 apiKey 没有 searchEngineId 时返回 null', () => {
    expect(GoogleCustomSearchClient.create(makeConfig({ apiKey: 'k1' }))).toBeNull();
  });

  it('凭据齐全时创建成功（config 优先）', () => {
    const client = GoogleCustomSearchClient.create(
      makeConfig({ apiKey: 'k1', searchEngineId: 'cx1' }),
    );
    expect(client).not.toBeNull();
  });

  it('支持从环境变量读取凭据', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'env-key');
    vi.stubEnv('GOOGLE_CSE_ID', 'env-cx');
    const client = GoogleCustomSearchClient.create(makeConfig());
    expect(client).not.toBeNull();
  });

  it('search 正确映射 API 响应', async () => {
    const client = GoogleCustomSearchClient.create(
      makeConfig({ apiKey: 'k1', searchEngineId: 'cx1' }),
    )!;

    globalThis.fetch = mockFetchJson({
      items: [
        { title: 'OpenAI', link: 'https://openai.com', snippet: 'AI company' },
        { title: 'Example', link: 'https://example.com', snippet: 'An example' },
      ],
      searchInformation: { totalResults: '12345' },
    });

    const { results, totalResults } = await client.search({ query: 'openai' }, 10, 1);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'OpenAI',
      url: 'https://openai.com',
      snippet: 'AI company',
      source: 'google',
      position: 1,
    });
    expect(totalResults).toBe(12345);

    // 验证请求参数包含 cx/q/safe；API Key 走请求头，不出现在 URL 中
    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.searchParams.has('key')).toBe(false);
    expect(calledHeaders().get('x-goog-api-key')).toBe('k1');
    expect(calledUrl.searchParams.get('cx')).toBe('cx1');
    expect(calledUrl.searchParams.get('q')).toBe('openai');
    expect(calledUrl.searchParams.get('safe')).toBe('off');
  });

  it('search 传递 region/language/safeSearch/分页参数', async () => {
    const client = GoogleCustomSearchClient.create(
      makeConfig({ apiKey: 'k1', searchEngineId: 'cx1' }),
    )!;

    globalThis.fetch = mockFetchJson({ items: [] });

    await client.search(
      { query: 'test', region: 'us', language: 'en', safeSearch: true, timeRange: 'week' },
      10,
      2,
    );

    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.searchParams.get('dateRestrict')).toBe('w1');
    expect(calledUrl.searchParams.get('gl')).toBe('us');
    expect(calledUrl.searchParams.get('hl')).toBe('en');
    expect(calledUrl.searchParams.get('safe')).toBe('active');
    expect(calledUrl.searchParams.get('start')).toBe('11');
  });

  it('count 超过单页上限时按 count 计算翻页偏移，不与上一页重叠', async () => {
    expect(computeCsePaging(30, 1)).toEqual({ num: 10, start: 1 });
    expect(computeCsePaging(30, 2)).toEqual({ num: 10, start: 31 });
    expect(computeCsePaging(5, 3)).toEqual({ num: 5, start: 11 });
    // 第 4 页（91-120）超出 CSE 前 100 条的上限
    expect(() => computeCsePaging(30, 5)).toThrow(/page 最大为 4/);

    const client = GoogleCustomSearchClient.create(
      makeConfig({ apiKey: 'k1', searchEngineId: 'cx1' }),
    )!;
    const items = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, link: `https://a.test/${i}` }));
    globalThis.fetch = mockFetchJson({ items });
    const { results } = await client.search({ query: 'x' }, 30, 2);
    const starts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map(c => new URL(c[0]).searchParams.get('start'));
    expect(starts).toEqual(['31', '41', '51']);
    expect(results[0].position).toBe(31);
    expect(results).toHaveLength(30);
  });

  it('查询无匹配时返回空数组而非抛错', async () => {
    const client = GoogleCustomSearchClient.create(
      makeConfig({ apiKey: 'k1', searchEngineId: 'cx1' }),
    )!;

    globalThis.fetch = mockFetchJson({ searchInformation: { totalResults: '0' } });

    const { results } = await client.search({ query: 'asdfqwer-no-match' }, 10, 1);
    expect(results).toEqual([]);
  });

  it('HTTP 错误抛出 GoogleApiError 并携带状态码', async () => {
    const client = GoogleCustomSearchClient.create(
      makeConfig({ apiKey: 'bad-key', searchEngineId: 'cx1' }),
    )!;

    globalThis.fetch = mockFetchJson(
      { error: { code: 429, message: 'Quota exceeded' } },
      429,
    );

    await expect(client.search({ query: 'x' }, 10, 1)).rejects.toThrow(GoogleApiError);
    await client.search({ query: 'x' }, 10, 1).catch((e: GoogleApiError) => {
      expect(e.statusCode).toBe(429);
    });
  });

  it('imageSearch 映射图片字段并传递 searchType', async () => {
    const client = GoogleCustomSearchClient.create(
      makeConfig({ apiKey: 'k1', searchEngineId: 'cx1' }),
    )!;

    globalThis.fetch = mockFetchJson({
      items: [
        {
          title: 'Cat',
          link: 'https://img.example.com/cat.jpg',
          image: {
            contextLink: 'https://example.com/cat-page',
            thumbnailLink: 'https://img.example.com/cat-thumb.jpg',
            width: 800,
            height: 600,
          },
        },
      ],
    });

    const { results } = await client.imageSearch(
      { query: 'cat', imageSize: 'large', imageType: 'photo' },
      10,
      1,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Cat',
      imageUrl: 'https://img.example.com/cat.jpg',
      thumbnailUrl: 'https://img.example.com/cat-thumb.jpg',
      sourceUrl: 'https://example.com/cat-page',
      width: 800,
      height: 600,
      source: 'google',
    });

    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl.searchParams.get('searchType')).toBe('image');
    expect(calledUrl.searchParams.get('imgSize')).toBe('large');
    expect(calledUrl.searchParams.get('imgType')).toBe('photo');
  });
});
