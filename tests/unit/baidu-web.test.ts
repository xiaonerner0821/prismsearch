/**
 * 百度网页搜索引擎单元测试（基于 HTML fixture，离线）
 * 覆盖：div.result/div.c-container 解析、mu/data-landurl 真实 URL 还原、
 *       摘要多级 fallback、推广节点过滤、验证码页检测
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BaiduWebEngine } from '../../src/engines/baidu/baidu-web.js';
import { EngineParseError } from '../../src/engines/engine-interface.js';
import type { EngineConfig } from '../../src/config/config-schema.js';
import { makeResponse } from './helpers/mock-response.js';

// 正常 SERP：
// 1) mu 属性提供真实 URL（覆盖百度跳转 href）
// 2) data-landurl 提供真实 URL，摘要走「h3 兄弟节点」第二级 fallback
// 3) 无摘要标签，走「容器全文减标题」第三级 fallback
// 4) mu 为相对路径时回退到标题链接 href
const SERP_HTML = '<!DOCTYPE html><html><body><div id="content_left">'
  + '<div class="result c-container" mu="https://openai.com/">'
  + '<h3 class="t"><a href="https://www.baidu.com/link?url=token1">OpenAI 官方网站</a></h3>'
  + '<div class="c-abstract">OpenAI 是一家人工智能研究公司，致力于发展安全有益的通用人工智能。</div>'
  + '</div>'
  + '<div class="result c-container">'
  + '<h3 class="t"><a href="https://www.baidu.com/link?url=token2">TypeScript 手册</a></h3>'
  + '<div class="c-row" data-landurl="https://www.typescriptlang.org/docs/"></div>'
  + '<div class="c-color-text">TypeScript 官方文档，详细介绍类型系统与工程实践。</div>'
  + '</div>'
  + '<div class="result c-container" mu="https://example.com/page">'
  + '<h3 class="t"><a href="https://www.baidu.com/link?url=token3">示例站点标题</a></h3>这是直接写在容器里的摘要文字，没有专门的标签。'
  + '</div>'
  + '<div class="result c-container" mu="/relative/path">'
  + '<h3 class="t"><a href="https://www.baidu.com/link?url=token4">相对 mu 回退</a></h3>'
  + '<div class="c-abstract">当 mu 不是 http 链接时，应回退到标题链接的 href。</div>'
  + '</div>'
  + '</div></body></html>';

// 推广节点：data-tuiguang / ec_tuiguang_ppim class / data-click 含 tuiguang，仅最后一条为自然结果
const AD_HTML = '<!DOCTYPE html><html><body><div id="content_left">'
  + '<div class="result c-container" data-tuiguang="1">'
  + '<h3 class="t"><a href="https://ad1.example.com">推广结果一</a></h3>'
  + '</div>'
  + '<div class="result c-container ec_tuiguang_ppim">'
  + '<h3 class="t"><a href="https://ad2.example.com">推广结果二</a></h3>'
  + '</div>'
  + '<div class="result c-container" data-click="{\'rsv_tuiguang\':\'0\'}">'
  + '<h3 class="t"><a href="https://ad3.example.com">推广结果三</a></h3>'
  + '</div>'
  + '<div class="result c-container" mu="https://organic.example.com/">'
  + '<h3 class="t"><a href="https://www.baidu.com/link?url=token9">自然结果</a></h3>'
  + '<div class="c-abstract">这是唯一的自然搜索结果摘要内容。</div>'
  + '</div>'
  + '</div></body></html>';

// 验证码页特征
const CAPTCHA_HTML = '<html><head><title>百度安全验证</title></head><body><div>百度安全验证</div></body></html>';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    name: 'baidu',
    displayName: '百度',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://www.baidu.com/s',
    timeout: 5000,
    priority: 3,
    rateLimit: { maxRequests: 10, windowMs: 60000 },
    ...overrides,
  };
}

function mockFetchHtml(html: string, opts: { status?: number; url?: string } = {}) {
  // 每次调用返回新的标准 Response（body 流只能读一次）
  return vi.fn().mockImplementation(async () =>
    makeResponse(html, { status: opts.status ?? 200, url: opts.url ?? 'https://www.baidu.com/s?wd=x' }),
  );
}

describe('BaiduWebEngine', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('接口形状：name/displayName 与可用性', () => {
    const engine = new BaiduWebEngine(makeConfig());
    expect(engine.name).toBe('baidu');
    expect(engine.displayName).toBe('百度');
    expect(engine.isAvailable()).toBe(true);
    expect(engine.getStatus().name).toBe('baidu');

    const disabled = new BaiduWebEngine(makeConfig({ enabled: false }));
    expect(disabled.isAvailable()).toBe(false);
  });

  it('解析多条结果：mu 优先、data-landurl 次之、摘要多级 fallback', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    const engine = new BaiduWebEngine(makeConfig());

    const resp = await engine.search({ query: 'openai', count: 10, page: 2, language: 'zh-CN' });

    expect(resp.engine).toBe('baidu');
    expect(resp.results).toHaveLength(4);

    // mu 属性优先于跳转 href
    expect(resp.results[0]).toMatchObject({
      title: 'OpenAI 官方网站',
      url: 'https://openai.com/',
      snippet: 'OpenAI 是一家人工智能研究公司，致力于发展安全有益的通用人工智能。',
      source: 'baidu',
      position: 1,
    });
    // data-landurl 次之；摘要取 h3 之后第一个足够长的兄弟节点
    expect(resp.results[1]).toMatchObject({
      title: 'TypeScript 手册',
      url: 'https://www.typescriptlang.org/docs/',
      snippet: 'TypeScript 官方文档，详细介绍类型系统与工程实践。',
      position: 2,
    });
    // 无摘要标签时取容器全文（去掉标题）
    expect(resp.results[2]).toMatchObject({
      title: '示例站点标题',
      url: 'https://example.com/page',
      snippet: '这是直接写在容器里的摘要文字，没有专门的标签。',
      position: 3,
    });
    // mu 非 http 时回退到标题链接 href
    expect(resp.results[3]).toMatchObject({
      title: '相对 mu 回退',
      url: 'https://www.baidu.com/link?url=token4',
      position: 4,
    });

    // 验证请求参数：第 2 页 pn=(2-1)*10=10
    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('wd')).toBe('openai');
    expect(calledUrl.searchParams.get('rn')).toBe('10');
    expect(calledUrl.searchParams.get('pn')).toBe('10');
    expect(calledUrl.searchParams.get('ie')).toBe('utf-8');
  });

  it('ie 编码参数固定为 utf-8，不随 language 变化', async () => {
    const engine = new BaiduWebEngine(makeConfig());
    const ieOf = async (language?: string) => {
      const fetchMock = mockFetchHtml(SERP_HTML);
      globalThis.fetch = fetchMock;
      await engine.search({ query: 'openai', language });
      return new URL(fetchMock.mock.calls[0][0] as string).searchParams.get('ie');
    };
    expect(await ieOf()).toBe('utf-8');
    expect(await ieOf('en')).toBe('utf-8');
    expect(await ieOf('zh-CN')).toBe('utf-8');
  });

  it('timeRange 映射为 gpc 的 Unix 秒区间，不传时没有 gpc', async () => {
    const engine = new BaiduWebEngine(makeConfig());
    const gpcOf = async (timeRange?: 'day' | 'week') => {
      const fetchMock = mockFetchHtml(SERP_HTML);
      globalThis.fetch = fetchMock;
      await engine.search({ query: 'openai', timeRange });
      return new URL(fetchMock.mock.calls[0][0] as string).searchParams.get('gpc');
    };
    expect(await gpcOf()).toBeNull();
    const m = /^stf=(\d+),(\d+)\|stftype=1$/.exec((await gpcOf('week')) ?? '');
    expect(m).not.toBeNull();
    expect(Number(m![2]) - Number(m![1])).toBe(7 * 86_400);
  });

  it('过滤 data-tuiguang / ec_tuiguang_ppim / data-click 含 tuiguang 的推广节点', async () => {
    globalThis.fetch = mockFetchHtml(AD_HTML);
    const engine = new BaiduWebEngine(makeConfig());

    const resp = await engine.search({ query: 'test' });
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]).toMatchObject({
      title: '自然结果',
      url: 'https://organic.example.com/',
      snippet: '这是唯一的自然搜索结果摘要内容。',
      position: 1,
    });
  });

  it('空结果页返回空数组且 hasMore 为 false', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><div id="content_left">抱歉，没有找到与 asdfqwer 相关的网页。</div></body></html>');
    const engine = new BaiduWebEngine(makeConfig());

    const resp = await engine.search({ query: 'asdfqwer-no-match' });
    expect(resp.results).toEqual([]);
    expect(resp.hasMore).toBe(false);
  });

  it('解析不到结果且不像无结果页时抛 EngineParseError', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><div id="content_left"></div></body></html>');
    const engine = new BaiduWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toBeInstanceOf(EngineParseError);
  });

  it('页面内容含「百度安全验证」时抛出反爬错误', async () => {
    globalThis.fetch = mockFetchHtml(CAPTCHA_HTML);
    const engine = new BaiduWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toThrow(/验证码|反爬/);
    expect(engine.getStatus().lastError).toContain('验证码');
  });

  it('最终 URL 跳转到 wappass.baidu.com 时识别为验证码页', async () => {
    globalThis.fetch = mockFetchHtml('<html><body>ok</body></html>', {
      url: 'https://wappass.baidu.com/static/captcha.html',
    });
    const engine = new BaiduWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toThrow(/验证码|反爬/);
  });
});
