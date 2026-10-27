/**
 * DuckDuckGo 网页搜索引擎单元测试（基于 HTML fixture，离线）
 * 覆盖：div.result 解析、//duckduckgo.com/l/?uddg= 重定向链接还原、
 *       GET 查询参数（q/kl/kp）、人机验证页识别、lite 版表格备用选择器
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { DuckDuckGoWebEngine } from '../../src/engines/duckduckgo/duckduckgo-web.js';
import { EngineParseError } from '../../src/engines/engine-interface.js';
import type { EngineConfig } from '../../src/config/config-schema.js';
import { makeResponse } from './helpers/mock-response.js';

// 正常 SERP：一条直链 + 一条 uddg 重定向链接
const SERP_HTML = '<!DOCTYPE html><html><body><div class="results">'
  + '<div class="result results_links results_links_deep web-result">'
  + '<h2 class="result__title"><a class="result__a" href="https://openai.com">OpenAI</a></h2>'
  + '<a class="result__snippet" href="https://openai.com">OpenAI is an AI research company.</a>'
  + '</div>'
  + '<div class="result results_links web-result">'
  + '<h2 class="result__title"><a class="result__a" '
  + 'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2F&amp;rut=abc123">TypeScript Docs</a></h2>'
  + '<div class="result__snippet">TypeScript documentation and handbook.</div>'
  + '</div>'
  + '</div></body></html>';

// lite 版结构：table.t 中结果链接行与摘要行相邻
const LITE_HTML = '<!DOCTYPE html><html><body><table class="t">'
  + '<tr><td valign="top"><a class="result-link" href="https://lite.example.com/a">Lite 结果一</a></td></tr>'
  + '<tr><td class="result-snippet">Lite 版本摘要文本一。</td></tr>'
  + '<tr><td valign="top"><a class="result-link" href="https://lite.example.com/b">Lite 结果二</a></td></tr>'
  + '<tr><td class="result-snippet">Lite 版本摘要文本二。</td></tr>'
  + '</table></body></html>';

// 反爬挑战页（真实页面的精简版）
const CHALLENGE_HTML = '<html><body><div class="anomaly-modal__title">'
  + 'Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form"></form></body></html>';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    name: 'duckduckgo',
    displayName: 'DuckDuckGo',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://html.duckduckgo.com/html/',
    timeout: 5000,
    priority: 6,
    rateLimit: { maxRequests: 10, windowMs: 60000 },
    ...overrides,
  };
}

function mockFetchHtml(html: string, status = 200) {
  return vi.fn().mockImplementation(async () =>
    makeResponse(html, { status, url: 'https://html.duckduckgo.com/html/' }),
  );
}

function calledUrl(): URL {
  return new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
}

describe('DuckDuckGoWebEngine', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('接口形状：name/displayName 与可用性', () => {
    const engine = new DuckDuckGoWebEngine(makeConfig());
    expect(engine.name).toBe('duckduckgo');
    expect(engine.displayName).toBe('DuckDuckGo');
    expect(engine.isAvailable()).toBe(true);
    expect(engine.getStatus().name).toBe('duckduckgo');

    const disabled = new DuckDuckGoWebEngine(makeConfig({ enabled: false }));
    expect(disabled.isAvailable()).toBe(false);
  });

  it('解析多条结果并还原 uddg 重定向链接', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    const engine = new DuckDuckGoWebEngine(makeConfig());

    const resp = await engine.search({ query: 'openai', region: 'cn', safeSearch: true });

    expect(resp.engine).toBe('duckduckgo');
    expect(resp.results).toHaveLength(2);
    expect(resp.results[0]).toMatchObject({
      title: 'OpenAI',
      url: 'https://openai.com',
      snippet: 'OpenAI is an AI research company.',
      source: 'duckduckgo',
      position: 1,
    });
    // //duckduckgo.com/l/?uddg=<urlencoded> 还原为真实 URL
    expect(resp.results[1]).toMatchObject({
      title: 'TypeScript Docs',
      url: 'https://www.typescriptlang.org/docs/',
      snippet: 'TypeScript documentation and handbook.',
      position: 2,
    });

    // 验证 GET 查询参数：q / kl（cn → cn-zh）/ kp（安全搜索）
    const url = calledUrl();
    expect(url.origin + url.pathname).toBe('https://html.duckduckgo.com/html/');
    expect(url.searchParams.get('q')).toBe('openai');
    expect(url.searchParams.get('kl')).toBe('cn-zh');
    expect(url.searchParams.get('kp')).toBe('1');
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as { method?: string };
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('未知区域代码不再拼出无效的 <region>-en，交给 DDG 默认', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    const engine = new DuckDuckGoWebEngine(makeConfig());

    await engine.search({ query: 'x', region: 'xx' });

    expect(calledUrl().searchParams.get('kl')).toBeNull();
  });

  it('未知区域但有语言时用 <region>-<lang> 兜底', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    const engine = new DuckDuckGoWebEngine(makeConfig());

    await engine.search({ query: 'x', region: 'xx', language: 'ja' });

    expect(calledUrl().searchParams.get('kl')).toBe('xx-jp');
  });

  it('第 2 页先取第 1 页拿 Next 表单的会话参数（vqd 等），再用 s 传偏移量', async () => {
    const PAGE1 = SERP_HTML.replace('</body>', '<div class="nav-link"><form action="/html/" method="post">'
      + '<input type="submit" value="Next"><input type="hidden" name="q" value="x">'
      + '<input type="hidden" name="s" value="10"><input type="hidden" name="dc" value="12">'
      + '<input type="hidden" name="vqd" value="4-123"><input type="hidden" name="kl" value="wt-wt">'
      + '</form></div></body>');
    const fetchMock = vi.fn().mockImplementation(async () =>
      makeResponse(PAGE1, { status: 200, url: 'https://html.duckduckgo.com/html/' }));
    globalThis.fetch = fetchMock;
    const engine = new DuckDuckGoWebEngine(makeConfig());

    await engine.search({ query: 'x', count: 10, page: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = new URL(fetchMock.mock.calls[0][0] as string);
    expect(first.searchParams.get('s')).toBeNull();
    const second = new URL(fetchMock.mock.calls[1][0] as string);
    expect(second.searchParams.get('s')).toBe('10');
    expect(second.searchParams.get('vqd')).toBe('4-123');
    expect(second.searchParams.get('dc')).toBe('11');
    expect(second.searchParams.get('q')).toBe('x');
  });

  it('第 1 页没有 Next 表单时仍只带 s 偏移量', async () => {
    const fetchMock = mockFetchHtml(SERP_HTML);
    globalThis.fetch = fetchMock;
    await new DuckDuckGoWebEngine(makeConfig()).search({ query: 'x', count: 10, page: 3 });
    const last = new URL(fetchMock.mock.calls.at(-1)![0] as string);
    expect(last.searchParams.get('s')).toBe('20');
    expect(last.searchParams.get('vqd')).toBeNull();
  });

  it('timeRange 映射为 df=d/w/m/y', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    await new DuckDuckGoWebEngine(makeConfig()).search({ query: 'x', timeRange: 'year' });
    expect(calledUrl().searchParams.get('df')).toBe('y');
  });

  it('空结果页返回空数组且 hasMore 为 false', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><div class="no-results">No results found for asdfqwer</div></body></html>');
    const engine = new DuckDuckGoWebEngine(makeConfig());

    const resp = await engine.search({ query: 'asdfqwer-no-match' });
    expect(resp.results).toEqual([]);
    expect(resp.hasMore).toBe(false);
  });

  it('解析不到结果且不像无结果页时抛 EngineParseError', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><div class="results"></div></body></html>');
    const engine = new DuckDuckGoWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toBeInstanceOf(EngineParseError);
  });

  it('人机验证页抛错并记录失败，而不是返回 0 条结果', async () => {
    globalThis.fetch = mockFetchHtml(CHALLENGE_HTML);
    const engine = new DuckDuckGoWebEngine(makeConfig());

    await expect(engine.search({ query: 'q' })).rejects.toThrow(/人机验证/);
    expect(engine.getStatus().lastError).toMatch(/人机验证/);
  });

  it('isChallengePage：202 状态或挑战表单都判定为挑战页', () => {
    expect(DuckDuckGoWebEngine.isChallengePage(202, '')).toBe(true);
    expect(DuckDuckGoWebEngine.isChallengePage(200, CHALLENGE_HTML)).toBe(true);
    expect(DuckDuckGoWebEngine.isChallengePage(200, SERP_HTML)).toBe(false);
  });

  it('主选择器无匹配时解析 lite 版表格结构（摘要取自相邻行）', async () => {
    globalThis.fetch = mockFetchHtml(LITE_HTML);
    const engine = new DuckDuckGoWebEngine(makeConfig());

    const resp = await engine.search({ query: 'test' });
    expect(resp.results).toHaveLength(2);
    expect(resp.results[0]).toMatchObject({
      title: 'Lite 结果一',
      url: 'https://lite.example.com/a',
      snippet: 'Lite 版本摘要文本一。',
      source: 'duckduckgo',
      position: 1,
    });
    expect(resp.results[1]).toMatchObject({
      title: 'Lite 结果二',
      url: 'https://lite.example.com/b',
      snippet: 'Lite 版本摘要文本二。',
      position: 2,
    });
  });

  it('lite 版协议相对的 uddg 跳转链接也能解包（真实 lite 页结构）', async () => {
    globalThis.fetch = mockFetchHtml('<!DOCTYPE html><html><body><table>'
      + '<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.com%2Fa&amp;rut=x" class=\'result-link\'>新闻一</a></td></tr>'
      + '<tr><td class=\'result-snippet\'>摘要一</td></tr>'
      + '</table></body></html>');
    const engine = new DuckDuckGoWebEngine(makeConfig({ baseUrl: 'https://lite.duckduckgo.com/lite/' }));

    const resp = await engine.search({ query: 'news' });
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]).toMatchObject({ title: '新闻一', url: 'https://news.example.com/a', snippet: '摘要一' });
  });

  it('unwrapUrl：只解包 DDG 跳转链接，其他原样返回', () => {
    expect(DuckDuckGoWebEngine.unwrapUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fx')).toBe('https://a.com/x');
    expect(DuckDuckGoWebEngine.unwrapUrl('https://a.com/x')).toBe('https://a.com/x');
  });

  it('主域名被验证码拦截、备用域名解析失败时，报告验证码而不是最后一个错误', async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      return call === 1
        ? makeResponse(CHALLENGE_HTML, { status: 202, url: 'https://html.duckduckgo.com/html/' })
        : makeResponse('<html><body><div id="main"></div></body></html>', { url: 'https://lite.duckduckgo.com/lite/' });
    });
    const engine = new DuckDuckGoWebEngine(makeConfig({ alternateUrls: ['https://lite.duckduckgo.com/lite/'] }));

    await expect(engine.search({ query: 'q' })).rejects.toThrow(/人机验证/);
  });
});
