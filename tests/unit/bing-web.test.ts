/**
 * Bing 网页搜索引擎单元测试（基于 HTML fixture，离线）
 * 覆盖：li.b_algo 解析、脏节点过滤（无标题/非 http 链接）、空结果页、同源降级
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BingWebEngine, BingPaginationIgnoredError, bingTimeFilter } from '../../src/engines/bing/bing-web.js';
import { EngineBlockedError, EngineParseError } from '../../src/engines/engine-interface.js';
import type { EngineConfig } from '../../src/config/config-schema.js';
import { makeResponse } from './helpers/mock-response.js';

// 正常 SERP：两条自然结果，分别使用 .b_caption p 与 .b_lineclamp2 摘要容器
const SERP_HTML = '<!DOCTYPE html><html><body><ol id="b_results">'
  + '<li class="b_algo">'
  + '<h2><a href="https://openai.com">OpenAI</a></h2>'
  + '<div class="b_caption"><p>OpenAI is an AI research company.</p></div>'
  + '</li>'
  + '<li class="b_algo">'
  + '<h2><a href="https://www.typescriptlang.org/docs/">TypeScript Docs</a></h2>'
  + '<p class="b_lineclamp2">TypeScript extends JavaScript with types.</p>'
  + '</li>'
  + '</ol></body></html>';

// 脏节点：无标题容器 + 相对链接（非 http），仅最后一条有效
const DIRTY_HTML = '<!DOCTYPE html><html><body><ol id="b_results">'
  + '<li class="b_algo"><div class="b_ad">广告占位</div></li>'
  + '<li class="b_algo"><h2><a href="/ck/a?u=token">站内跳转链接</a></h2></li>'
  + '<li class="b_algo">'
  + '<h2><a href="https://valid.example.com/article">有效结果</a></h2>'
  + '<div class="b_caption"><p>这是唯一应被保留的搜索结果。</p></div>'
  + '</li>'
  + '</ol></body></html>';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    name: 'bing',
    displayName: 'Bing',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://www.bing.com/search',
    timeout: 5000,
    priority: 2,
    rateLimit: { maxRequests: 10, windowMs: 60000 },
    ...overrides,
  };
}

function mockFetchHtml(html: string, status = 200) {
  return vi.fn().mockImplementation(async () =>
    makeResponse(html, { status, url: 'https://www.bing.com/search?q=x' }),
  );
}

describe('BingWebEngine', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('接口形状：name/displayName 与可用性', () => {
    const engine = new BingWebEngine(makeConfig());
    expect(engine.name).toBe('bing');
    expect(engine.displayName).toBe('Bing');
    expect(engine.isAvailable()).toBe(true);
    expect(engine.getStatus().name).toBe('bing');

    const disabled = new BingWebEngine(makeConfig({ enabled: false }));
    expect(disabled.isAvailable()).toBe(false);
  });

  it('解析多条结果并携带分页/语言/安全搜索参数', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    const engine = new BingWebEngine(makeConfig());

    const resp = await engine.search({ query: 'openai', count: 10, page: 2, language: 'zh-CN', safeSearch: true });

    expect(resp.engine).toBe('bing');
    expect(resp.results).toHaveLength(2);
    // 第 2 页的 position 从 11 开始
    expect(resp.results[0]).toMatchObject({
      title: 'OpenAI',
      url: 'https://openai.com',
      snippet: 'OpenAI is an AI research company.',
      source: 'bing',
      position: 11,
    });
    expect(resp.results[1]).toMatchObject({
      title: 'TypeScript Docs',
      url: 'https://www.typescriptlang.org/docs/',
      snippet: 'TypeScript extends JavaScript with types.',
      source: 'bing',
      position: 12,
    });

    // 验证请求参数：第 2 页 first=(2-1)*10+1=11
    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('q')).toBe('openai');
    expect(calledUrl.searchParams.get('count')).toBe('10');
    expect(calledUrl.searchParams.get('first')).toBe('11');
    expect(calledUrl.searchParams.get('setlang')).toBe('zh-CN');
    expect(calledUrl.searchParams.get('adlt')).toBe('strict');
  });

  it('区域映射为 cc + mkt 参数', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    const engine = new BingWebEngine(makeConfig());

    await engine.search({ query: 'openai', region: 'uk' });
    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('cc')).toBe('GB');
    expect(calledUrl.searchParams.get('mkt')).toBe('en-GB');
  });

  it('空结果页返回空数组且 hasMore 为 false', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><ol id="b_results"><li class="b_no">There are no results for asdfqwer</li></ol></body></html>');
    const engine = new BingWebEngine(makeConfig());

    const resp = await engine.search({ query: 'asdfqwer-no-match' });
    expect(resp.results).toEqual([]);
    expect(resp.hasMore).toBe(false);
  });

  it('解析不到结果且不像无结果页时抛 EngineParseError（不当作 0 条成功）', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><div>改版后的页面</div></body></html>');
    const engine = new BingWebEngine(makeConfig());

    await expect(engine.search({ query: 'openai' })).rejects.toBeInstanceOf(EngineParseError);
  });

  it('验证码页抛 EngineBlockedError', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><div id="b_captcha">verify</div></body></html>');
    const engine = new BingWebEngine(makeConfig());

    await expect(engine.search({ query: 'openai' })).rejects.toBeInstanceOf(EngineBlockedError);
  });

  it('过滤无标题容器与非 http 链接等脏节点', async () => {
    globalThis.fetch = mockFetchHtml(DIRTY_HTML);
    const engine = new BingWebEngine(makeConfig());

    const resp = await engine.search({ query: 'test' });
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]).toMatchObject({
      title: '有效结果',
      url: 'https://valid.example.com/article',
      snippet: '这是唯一应被保留的搜索结果。',
      position: 1,
    });
  });

  it('结果数达到 count 时截断且 hasMore 为 true', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    const engine = new BingWebEngine(makeConfig());

    const resp = await engine.search({ query: 'openai', count: 1 });
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0].title).toBe('OpenAI');
    expect(resp.hasMore).toBe(true);
  });

  it('主 URL 失败时降级到备用 URL', async () => {
    const fetchMock = mockFetchHtml(SERP_HTML);
    fetchMock.mockRejectedValueOnce(new Error('connect timeout'));
    globalThis.fetch = fetchMock;
    const engine = new BingWebEngine(makeConfig({ alternateUrls: ['https://cn.bing.com/search'] }));

    const resp = await engine.search({ query: 'openai' });
    expect(resp.results).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(secondUrl.origin).toBe('https://cn.bing.com');
  });

  describe('分页拼接', () => {
    /** 生成第 offset+1 起的 n 条结果页 */
    function serp(offset: number, n: number): string {
      const items = Array.from({ length: n }, (_, i) =>
        `<li class="b_algo"><h2><a href="https://r${offset + i + 1}.test/">R${offset + i + 1}</a></h2><p class="b_lineclamp2">s</p></li>`).join('');
      return `<html><body><ol id="b_results">${items}</ol></body></html>`;
    }
    /** 模拟 Bing：每页实际只给 perPage 条，按 first 参数偏移，总共 total 条 */
    function bingMock(perPage: number, total: number) {
      return vi.fn().mockImplementation(async (u: string) => {
        const first = Number(new URL(u).searchParams.get('first') ?? '1');
        const offset = first - 1;
        return makeResponse(serp(offset, Math.max(0, Math.min(perPage, total - offset))), { url: u });
      });
    }

    it('count>10 时按实际返回条数推进偏移，多次请求拼到 count 条', async () => {
      const fetchMock = bingMock(8, 100);
      globalThis.fetch = fetchMock;
      const resp = await new BingWebEngine(makeConfig()).search({ query: 'q', count: 20 });
      expect(resp.results).toHaveLength(20);
      expect(resp.results.map(r => r.title).slice(0, 3)).toEqual(['R1', 'R2', 'R3']);
      expect(resp.results[19]).toMatchObject({ title: 'R20', position: 20 });
      const firsts = fetchMock.mock.calls.map(c => new URL(c[0] as string).searchParams.get('first'));
      expect(firsts).toEqual([null, '9', '17']);
      expect(resp.hasMore).toBe(true);
    });

    it('翻页从 (page-1)*count 开始，不跳过结果', async () => {
      globalThis.fetch = bingMock(10, 100);
      const resp = await new BingWebEngine(makeConfig()).search({ query: 'q', count: 5, page: 3 });
      expect(resp.results.map(r => r.title)).toEqual(['R11', 'R12', 'R13', 'R14', 'R15']);
      expect(resp.results[0].position).toBe(11);
    });

    it('结果耗尽时 hasMore=false', async () => {
      globalThis.fetch = bingMock(10, 13);
      const resp = await new BingWebEngine(makeConfig()).search({ query: 'q', count: 20 });
      expect(resp.results).toHaveLength(13);
      expect(resp.hasMore).toBe(false);
    });

    it('后续子请求失败时返回已拿到的部分', async () => {
      const fetchMock = bingMock(10, 100);
      fetchMock.mockImplementationOnce(async (u: string) => makeResponse(serp(0, 10), { url: u }));
      fetchMock.mockRejectedValueOnce(new Error('boom'));
      globalThis.fetch = fetchMock;
      const resp = await new BingWebEngine(makeConfig()).search({ query: 'q', count: 20 });
      expect(resp.results).toHaveLength(10);
    });
  });

  it('还原 /ck/a 点击跟踪链接为真实地址', async () => {
    const real = 'https://baike.baidu.com/item/x';
    const ck = `https://www.bing.com/ck/a?!&&p=abc&ptn=3&u=a1${Buffer.from(real).toString('base64url')}&ntb=1`;
    globalThis.fetch = mockFetchHtml(`<html><body><ol id="b_results"><li class="b_algo"><h2><a href="${ck}">百科</a></h2></li></ol></body></html>`);
    const resp = await new BingWebEngine(makeConfig()).search({ query: 'x' });
    expect(resp.results[0].url).toBe(real);
    expect(BingWebEngine.unwrapClickUrl('https://www.bing.com/ck/a?u=a1bm90LWEtdXJs')).toBe('https://www.bing.com/ck/a?u=a1bm90LWEtdXJs');
    expect(BingWebEngine.unwrapClickUrl('https://example.com/a')).toBe('https://example.com/a');
  });

  it('请求非首页却拿回第 1 页（分页器当前页为 1）时抛错，不把第 1 页当作后续页返回', async () => {
    const page1 = SERP_HTML.replace('</ol>', '</ol><nav><ul class="b_pag"><li><a class="sb_pagS" aria-label="第 1 页">1</a></li></ul></nav>');
    globalThis.fetch = mockFetchHtml(page1);
    await expect(new BingWebEngine(makeConfig()).search({ query: 'x', page: 2 })).rejects.toBeInstanceOf(BingPaginationIgnoredError);
    // 首页请求不受影响
    globalThis.fetch = mockFetchHtml(page1);
    const resp = await new BingWebEngine(makeConfig()).search({ query: 'x' });
    expect(resp.results).toHaveLength(2);
    expect(BingWebEngine.currentPage(page1.replace('第 1 页">1', '第 2 页">2'))).toBe(2);
  });

  it('拼接中途 Bing 不再翻页时返回已拿到的部分，hasMore=false', async () => {
    const full = Array.from({ length: 10 }, (_, i) =>
      `<li class="b_algo"><h2><a href="https://r${i}.test/">R${i}</a></h2></li>`).join('');
    const page1 = `<html><body><ol id="b_results">${full}</ol><a class="sb_pagS" aria-label="第 1 页">1</a></body></html>`;
    globalThis.fetch = mockFetchHtml(page1);
    const resp = await new BingWebEngine(makeConfig()).search({ query: 'x', count: 20 });
    expect(resp.results).toHaveLength(10);
    expect(resp.hasMore).toBe(false);
  });

  it('timeRange 映射为 filters 参数', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    await new BingWebEngine(makeConfig()).search({ query: 'openai', timeRange: 'week' });
    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('filters')).toBe('ex1:"ez2"');
    expect(bingTimeFilter('day')).toBe('ex1:"ez1"');
    expect(bingTimeFilter('month')).toBe('ex1:"ez3"');
    expect(bingTimeFilter('year', 86_400_000 * 20_000)).toBe('ex1:"ez5_19635_20000"');
  });
});
