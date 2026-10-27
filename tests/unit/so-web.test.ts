/**
 * 360 搜索引擎单元测试（基于 HTML fixture，离线）
 * 覆盖：li.res-list 解析、data-url 真实链接优先、广告节点过滤、备用选择器
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SoWebEngine } from '../../src/engines/so/so-web.js';
import { EngineBlockedError, EngineParseError } from '../../src/engines/engine-interface.js';
import type { EngineConfig } from '../../src/config/config-schema.js';
import { makeResponse } from './helpers/mock-response.js';

// 正常 SERP：
// 1) 链接上的 data-url 提供真实 URL（覆盖 360 跳转 href）
// 2) 容器 li 上的 data-url 提供真实 URL
// 3) 无 data-url 时直接使用 href
const SERP_HTML = '<!DOCTYPE html><html><body><ul class="res-list-wrap">'
  + '<li class="res-list">'
  + '<h3><a href="https://www.so.com/link?m=token1" data-url="https://openai.com">OpenAI</a></h3>'
  + '<p class="res-desc">OpenAI 是一家人工智能研究公司。</p>'
  + '</li>'
  + '<li class="res-list" data-url="https://www.typescriptlang.org/docs/">'
  + '<h3><a href="https://www.so.com/link?m=token2">TypeScript 文档</a></h3>'
  + '<div class="res-comm-con">TypeScript 官方中文文档与教程。</div>'
  + '</li>'
  + '<li class="res-list">'
  + '<h3><a href="https://example.com">Example 站点</a></h3>'
  + '<p class="res-desc">示例摘要内容。</p>'
  + '</li>'
  + '</ul></body></html>';

// 广告节点：res-mediav class 与 data-mediav 属性，仅最后一条为自然结果
const AD_HTML = '<!DOCTYPE html><html><body><ul class="res-list-wrap">'
  + '<li class="res-list res-mediav">'
  + '<h3><a href="https://ad1.example.com">视频推广</a></h3>'
  + '</li>'
  + '<li class="res-list" data-mediav="1">'
  + '<h3><a href="https://ad2.example.com">媒体推广</a></h3>'
  + '</li>'
  + '<li class="res-list">'
  + '<h3><a href="https://organic.example.com">自然结果</a></h3>'
  + '<p class="res-desc">唯一保留的自然结果摘要。</p>'
  + '</li>'
  + '</ul></body></html>';

// 备用结构：无 li.res-list，使用 div.result
const FALLBACK_HTML = '<!DOCTYPE html><html><body>'
  + '<div class="result">'
  + '<h3>备用结构标题</h3>'
  + '<a href="https://backup.example.com/a">备用链接文字</a>'
  + '<p>备用选择器解析出的摘要内容。</p>'
  + '</div>'
  + '</body></html>';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    name: 'so',
    displayName: '360搜索',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://www.so.com/s',
    timeout: 5000,
    priority: 4,
    rateLimit: { maxRequests: 10, windowMs: 60000 },
    ...overrides,
  };
}

function mockFetchHtml(html: string, status = 200) {
  return vi.fn().mockImplementation(async () =>
    makeResponse(html, { status, url: 'https://www.so.com/s?q=x' }),
  );
}

describe('SoWebEngine', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('接口形状：name/displayName 与可用性', () => {
    const engine = new SoWebEngine(makeConfig());
    expect(engine.name).toBe('so');
    expect(engine.displayName).toBe('360搜索');
    expect(engine.isAvailable()).toBe(true);
    expect(engine.getStatus().name).toBe('so');

    const disabled = new SoWebEngine(makeConfig({ enabled: false }));
    expect(disabled.isAvailable()).toBe(false);
  });

  it('解析多条结果：data-url 优先于跳转 href', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    const engine = new SoWebEngine(makeConfig());

    const resp = await engine.search({ query: 'openai', count: 10, page: 2 });

    expect(resp.engine).toBe('so');
    expect(resp.results).toHaveLength(3);
    // 链接上的 data-url 覆盖跳转 href
    expect(resp.results[0]).toMatchObject({
      title: 'OpenAI',
      url: 'https://openai.com',
      snippet: 'OpenAI 是一家人工智能研究公司。',
      source: 'so',
      position: 1,
    });
    // 容器上的 data-url 覆盖跳转 href
    expect(resp.results[1]).toMatchObject({
      title: 'TypeScript 文档',
      url: 'https://www.typescriptlang.org/docs/',
      snippet: 'TypeScript 官方中文文档与教程。',
      position: 2,
    });
    // 无 data-url 时保留原 href
    expect(resp.results[2]).toMatchObject({
      title: 'Example 站点',
      url: 'https://example.com',
      snippet: '示例摘要内容。',
      position: 3,
    });

    // 验证请求参数：360 分页 pn 即页码
    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('q')).toBe('openai');
    expect(calledUrl.searchParams.get('pn')).toBe('2');
  });

  it('过滤 res-mediav / data-mediav 广告节点', async () => {
    globalThis.fetch = mockFetchHtml(AD_HTML);
    const engine = new SoWebEngine(makeConfig());

    const resp = await engine.search({ query: 'test' });
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]).toMatchObject({
      title: '自然结果',
      url: 'https://organic.example.com',
      snippet: '唯一保留的自然结果摘要。',
      position: 1,
    });
  });

  it('空结果页返回空数组且 hasMore 为 false', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><div id="main">没有找到相关结果，请更换关键词。</div></body></html>');
    const engine = new SoWebEngine(makeConfig());

    const resp = await engine.search({ query: 'asdfqwer-no-match' });
    expect(resp.results).toEqual([]);
    expect(resp.hasMore).toBe(false);
  });

  it('解析不到结果且不像无结果页时抛 EngineParseError', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><div id="main"></div></body></html>');
    const engine = new SoWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toBeInstanceOf(EngineParseError);
  });

  it('验证码页抛 EngineBlockedError', async () => {
    globalThis.fetch = mockFetchHtml('<html><body>请输入验证码</body></html>');
    const engine = new SoWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toBeInstanceOf(EngineBlockedError);
  });

  it('timeRange 映射为 adv_t=d/w/m/y', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    await new SoWebEngine(makeConfig()).search({ query: 'x', timeRange: 'day' });
    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('adv_t')).toBe('d');
  });

  it('百科 / 问答 / 资讯等卡片从各自的摘要容器取摘要', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><ul>'
      + '<li class="res-list"><h3><a href="https://wenku.so.com/a">文库卡片</a></h3>'
      + '<div class="mh-desc js-mh-desc">文库卡片的摘要。</div><div class="mh-desc">第二段不取</div></li>'
      + '<li class="res-list"><h3><a href="https://wenda.so.com/q">问答卡片</a></h3>'
      + '<div class="res-list-summary">问答卡片的摘要。</div></li>'
      + '</ul></body></html>');
    const resp = await new SoWebEngine(makeConfig()).search({ query: 'x' });
    expect(resp.results.map(r => r.snippet)).toEqual(['文库卡片的摘要。', '问答卡片的摘要。']);
  });

  it('每页不足 count 条但分页器有「下一页」时 hasMore 为 true', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><ul>'
      + '<li class="res-list"><h3><a href="https://a.example.com/">结果一</a></h3><p class="res-desc">摘要</p></li>'
      + '</ul><div id="page"><a id="snext" href="/s?q=x&pn=2">下一页</a></div></body></html>');
    const resp = await new SoWebEngine(makeConfig()).search({ query: 'x', count: 10 });
    expect(resp.results).toHaveLength(1);
    expect(resp.hasMore).toBe(true);
    expect(SoWebEngine.hasNextPage('<div id="page"></div>')).toBe(false);
  });

  it('主选择器无匹配时使用 div.result 备用选择器', async () => {
    globalThis.fetch = mockFetchHtml(FALLBACK_HTML);
    const engine = new SoWebEngine(makeConfig());

    const resp = await engine.search({ query: 'test' });
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]).toMatchObject({
      title: '备用结构标题',
      url: 'https://backup.example.com/a',
      snippet: '备用选择器解析出的摘要内容。',
      source: 'so',
      position: 1,
    });
  });
});
