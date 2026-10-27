/**
 * GoogleWebEngine 多策略编排单元测试
 * 覆盖：enablejs 墙检测、API/浏览器/HTTP 策略优先级、失败降级、成功策略粘性
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GoogleWebEngine } from '../../src/engines/google/google-web.js';
import type { EngineConfig } from '../../src/config/config-schema.js';
import type { Fetcher } from '../../src/fetcher/fetcher-interface.js';

// Google 强制 JS 渲染时返回的提示页（HTTP 200 但无任何搜索结果）
const ENABLEJS_HTML = '<!DOCTYPE html><html><head><title>Google Search</title></head><body>'
  + '<noscript><meta content="0;url=/httpservice/retry/enablejs?sei=abc" http-equiv="refresh"></noscript>'
  + '<script>window.google={};</script></body></html>';

// 模拟浏览器渲染后的正常 SERP
const SERP_HTML = '<!DOCTYPE html><html><body><div id="search">'
  + '<div class="g"><div><a href="https://openai.com"><h3>OpenAI</h3></a>'
  + '<div class="VwiC3b">AI research company</div></div></div>'
  + '<div class="g"><div><a href="https://example.com"><h3>Example</h3></a>'
  + '<div class="VwiC3b">Example snippet</div></div></div>'
  + '</div></body></html>';

// 模拟 2025 年后浏览器渲染版 SERP（无 div.g，结果在 div.tF2Cxc，
// 链接为 /goto?url=<不透明令牌>，真实 URL 在 cite 面包屑中）
const RENDERED_SERP_HTML = '<!DOCTYPE html><html><body><div id="search">'
  + '<div class="tF2Cxc"><div class="yuRUbf"><a class="zReHs" href="/goto?url=TOKEN1">'
  + '<h3>OpenAI | Research &amp; Deployment</h3></a>'
  + '<cite>https://openai.com</cite></div>'
  + '<div class="VwiC3b">AI research company</div></div>'
  + '<div class="tF2Cxc"><div class="yuRUbf"><a class="zReHs" href="/goto?url=TOKEN2">'
  + '<h3>TypeScript Handbook</h3></a>'
  + '<cite>https://www.typescriptlang.org › docs › handbook</cite></div>'
  + '<div class="VwiC3b">TypeScript documentation</div></div>'
  + '</div></body></html>';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    name: 'google',
    displayName: 'Google',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://www.google.com/search',
    timeout: 2000,
    priority: 1,
    rateLimit: { maxRequests: 10, windowMs: 60000 },
    ...overrides,
  };
}

function mockHttpHtml(html: string, status = 200) {
  return vi.fn().mockImplementation(async () =>
    new Response(html, { status, statusText: 'OK', headers: { 'content-type': 'text/html; charset=utf-8' } }),
  );
}

function mockApiJson(body: unknown, status = 200) {
  // 标准 Response：Custom Search API 客户端经 http-client 读取 headers 与 body 流
  return vi.fn().mockImplementation(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function makeBrowserFetcher(html: string | Error): Fetcher & { fetch: ReturnType<typeof vi.fn> } {
  const fetchFn = html instanceof Error
    ? vi.fn().mockRejectedValue(html)
    : vi.fn().mockResolvedValue({
        url: 'https://www.google.com/search?q=x',
        content: html,
        rawHtml: html,
        title: 'Google Search',
        statusCode: 200,
        contentLength: html.length,
        fetchTime: 100,
      });
  return { name: 'browser', fetch: fetchFn };
}

describe('GoogleWebEngine 策略编排', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('纯 HTTP 拿到 enablejs 墙时抛出带诊断信息的错误', async () => {
    globalThis.fetch = mockHttpHtml(ENABLEJS_HTML);
    const engine = new GoogleWebEngine(makeConfig());
    await expect(engine.search({ query: 'openai' })).rejects.toThrow(/enablejs|JavaScript/);
  });

  it('注入浏览器抓取器后优先用浏览器渲染并解析结果', async () => {
    globalThis.fetch = mockHttpHtml(ENABLEJS_HTML);
    const engine = new GoogleWebEngine(makeConfig());
    const browser = makeBrowserFetcher(SERP_HTML);
    engine.setBrowserFetcher(browser);

    const resp = await engine.search({ query: 'openai' });

    expect(resp.results).toHaveLength(2);
    expect(resp.results[0]).toMatchObject({ title: 'OpenAI', url: 'https://openai.com' });
    // 浏览器优先级高于 http，http 不应被调用
    expect(browser.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('timeRange 映射为 tbs=qdr:d/w/m/y', async () => {
    globalThis.fetch = mockHttpHtml(SERP_HTML);
    await new GoogleWebEngine(makeConfig()).search({ query: 'openai', timeRange: 'week' });
    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('tbs')).toBe('qdr:w');
  });

  it('浏览器渲染结果为空时降级到 http 策略', async () => {
    globalThis.fetch = mockHttpHtml(SERP_HTML);
    const engine = new GoogleWebEngine(makeConfig());
    // 浏览器渲染成功但页面无结果（如被重定向到 consent 页）
    engine.setBrowserFetcher(makeBrowserFetcher('<html><body>consent</body></html>'));

    const resp = await engine.search({ query: 'openai' });

    expect(resp.results).toHaveLength(2);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('成功策略具有粘性：http 成功后不再优先尝试失败的浏览器', async () => {
    globalThis.fetch = mockHttpHtml(SERP_HTML);
    const engine = new GoogleWebEngine(makeConfig());
    const browser = makeBrowserFetcher(new Error('browser broken'));
    engine.setBrowserFetcher(browser);

    // 第一次：browser 失败 → http 成功，preferred 变为 http
    const first = await engine.search({ query: 'openai' });
    expect(first.results).toHaveLength(2);
    expect(browser.fetch).toHaveBeenCalledTimes(1);

    // 第二次：http 是首选策略且成功，不应再调用 browser
    const second = await engine.search({ query: 'openai again' });
    expect(second.results).toHaveLength(2);
    expect(browser.fetch).toHaveBeenCalledTimes(1);
  });

  it('配置 API 凭据后优先使用 Custom Search API', async () => {
    globalThis.fetch = mockApiJson({
      items: [{ title: 'OpenAI', link: 'https://openai.com', snippet: 'via API' }],
      searchInformation: { totalResults: '100' },
    });
    const engine = new GoogleWebEngine(makeConfig({ apiKey: 'k1', searchEngineId: 'cx1' }));
    engine.setBrowserFetcher(makeBrowserFetcher(SERP_HTML));

    const resp = await engine.search({ query: 'openai' });

    expect(resp.results).toHaveLength(1);
    expect(resp.results[0].snippet).toBe('via API');
    expect(resp.totalResults).toBe(100);
    const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('googleapis.com/customsearch/v1');
  });

  it('API 失败（配额耗尽）时降级到浏览器策略', async () => {
    globalThis.fetch = mockApiJson(
      { error: { code: 429, message: 'Quota exceeded' } },
      429,
    );
    const engine = new GoogleWebEngine(makeConfig({ apiKey: 'k1', searchEngineId: 'cx1' }));
    engine.setBrowserFetcher(makeBrowserFetcher(SERP_HTML));

    const resp = await engine.search({ query: 'openai' });

    expect(resp.results).toHaveLength(2);
    expect(resp.results[0].url).toBe('https://openai.com');
  });

  it('API 返回空结果视为正常响应，不再降级', async () => {
    globalThis.fetch = mockApiJson({ searchInformation: { totalResults: '0' } });
    const engine = new GoogleWebEngine(makeConfig({ apiKey: 'k1', searchEngineId: 'cx1' }));
    const browser = makeBrowserFetcher(SERP_HTML);
    engine.setBrowserFetcher(browser);

    const resp = await engine.search({ query: 'asdfqwer-no-match' });

    expect(resp.results).toEqual([]);
    expect(browser.fetch).not.toHaveBeenCalled();
  });

  it('解析渲染版 DOM：tF2Cxc + goto 令牌链接从 cite 还原真实 URL', async () => {
    globalThis.fetch = mockHttpHtml(ENABLEJS_HTML);
    const engine = new GoogleWebEngine(makeConfig());
    engine.setBrowserFetcher(makeBrowserFetcher(RENDERED_SERP_HTML));

    const resp = await engine.search({ query: 'openai' });

    expect(resp.results).toHaveLength(2);
    expect(resp.results[0]).toMatchObject({
      title: 'OpenAI | Research & Deployment',
      url: 'https://openai.com',
      snippet: 'AI research company',
    });
    // cite 面包屑 "https://www.typescriptlang.org › docs › handbook" 还原为真实路径
    expect(resp.results[1].url).toBe('https://www.typescriptlang.org/docs/handbook');
  });

  it('goto 令牌链接向 Google 请求 302 还原真实地址，失败的才用 cite 兜底', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (input: unknown) => {
      const u = String(input);
      calls.push(u);
      if (u.endsWith('/goto?url=TOKEN1')) {
        return new Response(null, { status: 302, headers: { location: 'https://openai.com/research/#:~:text=hi' } });
      }
      // TOKEN2 跳回 Google 自己（地区跳转），不能当作目标页
      return new Response(null, { status: 302, headers: { location: 'https://www.google.com.hk/url?q=x' } });
    });
    const engine = new GoogleWebEngine(makeConfig());
    engine.setBrowserFetcher(makeBrowserFetcher(RENDERED_SERP_HTML));

    const resp = await engine.search({ query: 'openai' });

    expect(calls.every(c => c.startsWith('https://www.google.com/goto?url='))).toBe(true);
    expect(resp.results[0].url).toBe('https://openai.com/research/');
    expect(resp.results[1].url).toBe('https://www.typescriptlang.org/docs/handbook');
  });

  it('只向 Google 域名还原 goto 链接（结果页地址异常时不发请求）', async () => {
    globalThis.fetch = vi.fn();
    const item = { title: 't', url: 'https://cite.example', snippet: '', source: 'google', position: 1 };
    await GoogleWebEngine.resolveGotoLinks(new Map([[item, '/goto?url=T']]), 'https://evil.example/search');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(item.url).toBe('https://cite.example');
  });

  it('所有策略都失败时抛出最后一个错误', async () => {
    globalThis.fetch = mockHttpHtml(ENABLEJS_HTML);
    const engine = new GoogleWebEngine(makeConfig({ apiKey: 'k1', searchEngineId: 'cx1' }));
    engine.setBrowserFetcher(makeBrowserFetcher(new Error('no chromium')));

    // api 会因 429 以外的 http 200 + enablejs 内容而 json 解析失败，browser 抛错，http 被墙
    await expect(engine.search({ query: 'openai' })).rejects.toThrow();
  });
});
