/**
 * 微信公众号文章搜索引擎单元测试（基于 HTML fixture，离线）
 * 覆盖：li[id^=sogou_vr_11002601_box_] 列表解析、timeConvert 时间戳还原、
 *       搜狗跳转页 JS 片段拼接真实 mp.weixin.qq.com 链接、
 *       相对链接补全、公众号名摘要前缀、反爬/空结果处理
 *
 * 说明：该引擎流程为「取 SNUID Cookie → 拉搜索页 → 逐条请求跳转页还原真实链接」，
 * 测试通过按 URL 分发的假 fetch 覆盖三步，不发起真实网络请求。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WechatArticleEngine } from '../../src/engines/wechat/wechat-article.js';
import { EngineBlockedError } from '../../src/engines/engine-interface.js';
import type { EngineConfig } from '../../src/config/config-schema.js';

// 搜狗微信搜索页 fixture：
// 1) 相对 href（需补全为 weixin.sogou.com 域名），公众号名取 span.all-time-y2，带 timeConvert 时间戳
// 2) 绝对 href，公众号名回退到 a[href*=websearch/weixin]
const SERP_HTML = '<!DOCTYPE html><html><body><ul class="news-list">'
  + '<li id="sogou_vr_11002601_box_0">'
  + '<h3><a target="_blank" href="/link?url=dnXjK1abcToken0">深度解析：AI 大模型的最新进展</a></h3>'
  + '<p class="txt-info">本文梳理了近期大模型能力边界的变化与典型应用。</p>'
  + '<div class="s-p">'
  + '<span class="all-time-y2">机器之心</span>'
  + '<span class="s2"><script>document.write(timeConvert(\'1699999999\'))</script></span>'
  + '</div>'
  + '</li>'
  + '<li id="sogou_vr_11002601_box_1">'
  + '<h3><a target="_blank" href="https://weixin.sogou.com/link?url=dnXjK1abcToken1">公众号运营实战技巧</a></h3>'
  + '<p class="txt-info">从选题到排版，拆解高效运营动作。</p>'
  + '<div class="s-p">'
  + '<a href="/websearch/weixin?query=x">运营深度精选</a>'
  + '<span class="s2"><script>document.write(timeConvert(\'1700000000\'))</script></span>'
  + '</div>'
  + '</li>'
  + '</ul></body></html>';

// 跳转页 fixture：真实链接被拆成多段 url += '...'，且混入 @ 与被破坏的 ×tamp 参数名
const REDIRECT_HTML_0 = '<html><body><script>var url=\'\';'
  + 'url+=\'https://mp.weixin.qq.co\';'
  + 'url+=\'m/s?src=11×tamp=1699999999@&ver=1\';'
  + '</script></body></html>';
const REDIRECT_HTML_1 = '<html><body><script>var url=\'\';'
  + 'url+=\'https://mp.weixin.qq.com/s/AbCdEfGhIjKlMnOp\';'
  + '</script></body></html>';

const SOGOU_URL_0 = 'https://weixin.sogou.com/link?url=dnXjK1abcToken0';
const SOGOU_URL_1 = 'https://weixin.sogou.com/link?url=dnXjK1abcToken1';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    name: 'wechat',
    displayName: '微信公众号（搜狗）',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://weixin.sogou.com/weixin',
    timeout: 5000,
    priority: 8,
    rateLimit: { maxRequests: 10, windowMs: 60000 },
    ...overrides,
  };
}

interface WechatMockHandlers {
  snuid?: string;
  searchHtml?: string;
  searchStatus?: number;
  redirects?: Record<string, { status?: number; html?: string }>;
}

// 按 URL 分发的假 fetch：首页/视频页出 SNUID，搜索页出 SERP，其余按跳转页表处理
function makeWechatFetch(handlers: WechatMockHandlers) {
  return vi.fn().mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url === 'https://weixin.sogou.com/' || url.startsWith('https://v.sogou.com/')) {
      const snuid = handlers.snuid ?? 'TESTSNUID0001';
      return {
        status: 302,
        headers: new Headers({ 'set-cookie': `SNUID=${snuid}; expires=Sat, 01-Jan-2028 00:00:00 GMT; path=/` }),
        text: async () => '',
      };
    }
    if (url.startsWith('https://weixin.sogou.com/weixin')) {
      return {
        status: handlers.searchStatus ?? 200,
        text: async () => handlers.searchHtml ?? '',
      };
    }
    const redirect = handlers.redirects?.[url];
    if (redirect) {
      return { status: redirect.status ?? 200, text: async () => redirect.html ?? '' };
    }
    return { status: 404, text: async () => '' };
  });
}

describe('WechatArticleEngine', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('接口形状：name/displayName 与可用性', () => {
    const engine = new WechatArticleEngine(makeConfig());
    expect(engine.name).toBe('wechat');
    expect(engine.displayName).toBe('微信公众号（搜狗）');
    expect(engine.isAvailable()).toBe(true);
    expect(engine.getStatus().name).toBe('wechat');

    const disabled = new WechatArticleEngine(makeConfig({ enabled: false }));
    expect(disabled.isAvailable()).toBe(false);
  });

  it('解析多条文章：还原真实链接、时间戳与公众号前缀摘要', async () => {
    const fetchMock = makeWechatFetch({
      searchHtml: SERP_HTML,
      redirects: {
        [SOGOU_URL_0]: { html: REDIRECT_HTML_0 },
        [SOGOU_URL_1]: { html: REDIRECT_HTML_1 },
      },
    });
    globalThis.fetch = fetchMock;
    const engine = new WechatArticleEngine(makeConfig());

    const resp = await engine.search({ query: 'AI 大模型', count: 10, page: 1 });

    expect(resp.engine).toBe('wechat');
    expect(resp.results).toHaveLength(2);

    // 并发还原链接，完成顺序不稳定，按标题查找断言
    const first = resp.results.find(r => r.title === '深度解析：AI 大模型的最新进展');
    expect(first).toBeDefined();
    // JS 片段拼接 + 去除 @ + 修复 ×tamp → &timestamp
    expect(first).toMatchObject({
      url: 'https://mp.weixin.qq.com/s?src=11&timestamp=1699999999&ver=1',
      snippet: '【机器之心】本文梳理了近期大模型能力边界的变化与典型应用。',
      source: 'wechat',
      timestamp: new Date(1699999999 * 1000).toISOString(),
    });

    const second = resp.results.find(r => r.title === '公众号运营实战技巧');
    expect(second).toBeDefined();
    expect(second).toMatchObject({
      url: 'https://mp.weixin.qq.com/s/AbCdEfGhIjKlMnOp',
      snippet: '【运营深度精选】从选题到排版，拆解高效运营动作。',
      source: 'wechat',
      timestamp: new Date(1700000000 * 1000).toISOString(),
    });

    // position 从 1 开始递增
    expect(resp.results.map(r => r.position)).toEqual([1, 2]);

    // 验证搜索页请求：type=2 搜文章、query、ie=utf8、携带 SNUID Cookie
    const searchCall = fetchMock.mock.calls.find(c =>
      String(c[0]).startsWith('https://weixin.sogou.com/weixin'));
    expect(searchCall).toBeDefined();
    const searchUrl = new URL(String(searchCall![0]));
    expect(searchUrl.searchParams.get('type')).toBe('2');
    expect(searchUrl.searchParams.get('query')).toBe('AI 大模型');
    expect(searchUrl.searchParams.get('ie')).toBe('utf8');
    const headers = (searchCall![1] as { headers: Record<string, string> }).headers;
    expect(headers['Cookie']).toContain('SNUID=TESTSNUID0001');
  });

  it('搜索页正常但无匹配节点时返回空结果，且不重试', { timeout: 20000 }, async () => {
    const fetchMock = makeWechatFetch({ searchHtml: '<html><body><ul class="news-list"></ul></body></html>' });
    globalThis.fetch = fetchMock;
    const engine = new WechatArticleEngine(makeConfig());

    const resp = await engine.search({ query: 'asdfqwer-no-match' });
    expect(resp.results).toEqual([]);
    expect(resp.hasMore).toBe(false);
    // 「页面正常但没结果」不是故障，不应触发重试与退避等待
    const searchCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).startsWith('https://weixin.sogou.com/weixin'));
    expect(searchCalls).toHaveLength(1);
    expect(engine.getStatus().lastError).toBeUndefined();
  });

  it('搜索页返回 5xx 时重试后抛错，并记录 lastError', { timeout: 20000 }, async () => {
    globalThis.fetch = makeWechatFetch({ searchStatus: 503 });
    const engine = new WechatArticleEngine(makeConfig(), { retries: 1 });

    await expect(engine.search({ query: 'x' })).rejects.toThrow(/HTTP 503/);
    expect(engine.getStatus().lastError).toContain('503');
  });

  it('全部跳转页解析失败时返回空数组而非抛错', { timeout: 20000 }, async () => {
    globalThis.fetch = makeWechatFetch({
      searchHtml: SERP_HTML,
      redirects: {
        [SOGOU_URL_0]: { status: 404 },
        [SOGOU_URL_1]: { html: '<html><body><script>var x=1;</script></body></html>' },
      },
    });
    const engine = new WechatArticleEngine(makeConfig());

    const resp = await engine.search({ query: 'AI 大模型' });
    expect(resp.results).toEqual([]);
    expect(resp.hasMore).toBe(false);
  });

  it('部分跳转失败时跳过该条目，保留可还原的结果', { timeout: 20000 }, async () => {
    globalThis.fetch = makeWechatFetch({
      searchHtml: SERP_HTML,
      redirects: {
        [SOGOU_URL_0]: { status: 404 },
        [SOGOU_URL_1]: { html: REDIRECT_HTML_1 },
      },
    });
    const engine = new WechatArticleEngine(makeConfig());

    const resp = await engine.search({ query: 'AI 大模型' });
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]).toMatchObject({
      title: '公众号运营实战技巧',
      url: 'https://mp.weixin.qq.com/s/AbCdEfGhIjKlMnOp',
      position: 1,
    });
  });

  it('搜索页命中反爬特征文案时抛出验证码错误', { timeout: 20000 }, async () => {
    globalThis.fetch = makeWechatFetch({
      searchHtml: '<html><body><div>请输入验证码</div></body></html>',
    });
    const engine = new WechatArticleEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toThrow(/验证码|反爬/);
    expect(engine.getStatus().lastError).toContain('验证码');
  });

  it('搜索页 302 跳到 /antispider/ 时归类为 EngineBlockedError（保留类型，工具层才能展示原因）', { timeout: 20000 }, async () => {
    const base = makeWechatFetch({});
    globalThis.fetch = vi.fn().mockImplementation(async (input: unknown, init?: unknown) => {
      if (String(input).startsWith('https://weixin.sogou.com/weixin')) {
        return { status: 302, headers: new Headers({ location: 'http://weixin.sogou.com/antispider/?antip=wx_sh2' }), text: async () => '' };
      }
      return base(input, init);
    });
    await expect(new WechatArticleEngine(makeConfig()).search({ query: 'x' })).rejects.toBeInstanceOf(EngineBlockedError);
  });

  it('所有来源都不下发 SNUID 时抛 EngineBlockedError 而不是普通 Error', { timeout: 20000 }, async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => ({ status: 200, headers: new Headers(), text: async () => '' }));
    await expect(new WechatArticleEngine(makeConfig()).search({ query: 'x' })).rejects.toBeInstanceOf(EngineBlockedError);
  });
});
