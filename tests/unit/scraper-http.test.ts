/**
 * scraper-http 公共抓取工具单元测试
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  fetchSearchPage,
  pickStableUserAgent,
  refererFor,
  ScraperHttpError,
} from '../../src/engines/scraper-http.js';
import { USER_AGENT_POOL } from '../../src/utils/http-client.js';
import { makeResponse } from './helpers/mock-response.js';

function headersOf(call: unknown[]): Headers {
  const init = (call[1] ?? {}) as RequestInit;
  return new Headers(init.headers as HeadersInit);
}

describe('refererFor', () => {
  it('取 baseUrl 的 origin 加斜杠', () => {
    expect(refererFor('https://www.bing.com/search?q=x')).toBe('https://www.bing.com/');
    expect(refererFor('https://mirror.example.com:8443/path/')).toBe('https://mirror.example.com:8443/');
  });

  it('非法 baseUrl 返回空字符串', () => {
    expect(refererFor('not a url')).toBe('');
  });
});

describe('pickStableUserAgent', () => {
  it('同一查询词总是得到同一个 UA，且来自 UA 池', () => {
    const a = pickStableUserAgent('openai');
    expect(pickStableUserAgent('openai')).toBe(a);
    expect(USER_AGENT_POOL).toContain(a);
  });

  it('不同查询词会分散到池中的多个 UA', () => {
    const picked = new Set(Array.from({ length: 50 }, (_, i) => pickStableUserAgent(`q-${i}`)));
    expect(picked.size).toBeGreaterThan(1);
  });

  it('无种子时也返回池中的 UA', () => {
    expect(USER_AGENT_POOL).toContain(pickStableUserAgent());
  });
});

describe('fetchSearchPage', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('GET 请求带上 Referer、稳定 UA 与语言头，返回正文与最终 URL', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      makeResponse('<html>ok</html>', { url: 'https://www.bing.com/search?q=final' }),
    );
    globalThis.fetch = fetchMock;

    const result = await fetchSearchPage('https://www.bing.com/search?q=x', {
      baseUrl: 'https://www.bing.com/search',
      timeoutMs: 5000,
      query: 'x',
      acceptLanguage: 'en-US',
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe('<html>ok</html>');
    expect(result.url).toBe('https://www.bing.com/search?q=final');

    const call = fetchMock.mock.calls[0];
    expect((call[1] as RequestInit).method ?? 'GET').toBe('GET');
    const headers = headersOf(call);
    expect(headers.get('referer')).toBe('https://www.bing.com/');
    expect(headers.get('user-agent')).toBe(pickStableUserAgent('x'));
    expect(headers.get('accept-language')).toBe('en-US');
  });

  it('传入 form 时自动改为 POST 表单', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => makeResponse('<html></html>'));
    globalThis.fetch = fetchMock;

    await fetchSearchPage('https://html.duckduckgo.com/html/', {
      baseUrl: 'https://html.duckduckgo.com/html/',
      timeoutMs: 5000,
      form: new URLSearchParams({ q: 'hello world' }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('q=hello+world');
    expect(headersOf(fetchMock.mock.calls[0]).get('content-type')).toBe('application/x-www-form-urlencoded');
  });

  it('自定义 headers 覆盖默认值', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => makeResponse('{}'));
    globalThis.fetch = fetchMock;

    await fetchSearchPage('https://image.baidu.com/search/acjson', {
      baseUrl: 'https://image.baidu.com/',
      timeoutMs: 5000,
      accept: 'application/json',
      headers: { Referer: 'https://custom.example/' },
    });

    const headers = headersOf(fetchMock.mock.calls[0]);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('referer')).toBe('https://custom.example/');
  });

  it('非 2xx 抛出带状态码的 ScraperHttpError', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      makeResponse('blocked', { status: 429, statusText: 'Too Many Requests' }),
    );

    const error = await fetchSearchPage('https://www.so.com/s?q=x', {
      baseUrl: 'https://www.so.com/',
      timeoutMs: 5000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScraperHttpError);
    expect((error as ScraperHttpError).status).toBe(429);
    expect((error as ScraperHttpError).message).toContain('429');
  });
});
