/**
 * 搜狗搜索引擎单元测试（基于 HTML fixture，离线）
 * 覆盖：div.vrwrap/div.rb 解析、相对 URL 补全、验证码页检测、备用选择器
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SogouWebEngine } from '../../src/engines/sogou/sogou-web.js';
import { EngineBlockedError, EngineParseError } from '../../src/engines/engine-interface.js';
import type { EngineConfig } from '../../src/config/config-schema.js';
import { makeResponse } from './helpers/mock-response.js';

// 正常 SERP：vrwrap 与 rb 两种容器；第二条为相对链接（站内跳转）
const SERP_HTML = '<!DOCTYPE html><html><body><div class="results">'
  + '<div class="vrwrap">'
  + '<h3><a href="https://openai.com">OpenAI</a></h3>'
  + '<div class="str_info">OpenAI 是一家人工智能研究公司。</div>'
  + '</div>'
  + '<div class="rb">'
  + '<h3><a href="/link?url=sogouToken1">搜狗站内跳转结果</a></h3>'
  + '<p class="space-txt">该结果的链接是相对路径，应补全为搜狗域名。</p>'
  + '</div>'
  + '</div></body></html>';

// 备用结构：div.results 下的 div.result；第二条为相对链接
const FALLBACK_HTML = '<!DOCTYPE html><html><body><div class="results">'
  + '<div class="result">'
  + '<h3>旧版结果标题</h3>'
  + '<a href="https://old.example.com/page">旧版链接</a>'
  + '<p class="ft">旧版结构的摘要内容。</p>'
  + '</div>'
  + '<div class="result">'
  + '<a href="/web/searchList.jsp?keyword=x">相对链接标题</a>'
  + '<p>相对链接的摘要内容。</p>'
  + '</div>'
  + '</div></body></html>';

// 验证码页特征
const ANTISPAM_HTML = '<html><body><div>用户您好，我们的系统检测到您网络中存在异常访问请求</div></body></html>';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    name: 'sogou',
    displayName: '搜狗搜索',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://www.sogou.com/web',
    timeout: 5000,
    priority: 5,
    rateLimit: { maxRequests: 10, windowMs: 60000 },
    ...overrides,
  };
}

/** n 条直链结果的 SERP（无需解包跳转） */
function serpWithLinksDirect(n: number): string {
  let items = '';
  for (let i = 0; i < n; i++) {
    items += `<div class="vrwrap"><h3><a href="https://r${i}.example.com/">结果${i}</a></h3><div class="str_info">摘要${i}</div></div>`;
  }
  return `<!DOCTYPE html><html><body><div class="results">${items}</div></body></html>`;
}

function mockFetchHtml(html: string, opts: { status?: number; url?: string } = {}) {
  return vi.fn().mockImplementation(async () =>
    makeResponse(html, { status: opts.status ?? 200, url: opts.url ?? 'https://www.sogou.com/web?query=x' }),
  );
}

describe('SogouWebEngine', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('接口形状：name/displayName 与可用性', () => {
    const engine = new SogouWebEngine(makeConfig());
    expect(engine.name).toBe('sogou');
    expect(engine.displayName).toBe('搜狗搜索');
    expect(engine.isAvailable()).toBe(true);
    expect(engine.getStatus().name).toBe('sogou');

    const disabled = new SogouWebEngine(makeConfig({ enabled: false }));
    expect(disabled.isAvailable()).toBe(false);
  });

  it('解析多条结果：vrwrap/rb 容器与相对 URL 补全', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    const engine = new SogouWebEngine(makeConfig());

    const resp = await engine.search({ query: 'openai', count: 10, page: 2, language: 'zh-CN' });

    expect(resp.engine).toBe('sogou');
    expect(resp.results).toHaveLength(2);
    expect(resp.results[0]).toMatchObject({
      title: 'OpenAI',
      url: 'https://openai.com',
      snippet: 'OpenAI 是一家人工智能研究公司。',
      source: 'sogou',
      position: 1,
    });
    // 相对链接补全为 https://www.sogou.com 前缀
    expect(resp.results[1]).toMatchObject({
      title: '搜狗站内跳转结果',
      url: 'https://www.sogou.com/link?url=sogouToken1',
      snippet: '该结果的链接是相对路径，应补全为搜狗域名。',
      position: 2,
    });

    // 验证请求参数：page 即页码，ie 固定为 utf8
    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('query')).toBe('openai');
    expect(calledUrl.searchParams.get('page')).toBe('2');
    expect(calledUrl.searchParams.get('ie')).toBe('utf8');
  });

  it('ie 编码参数固定为 utf8，不随 language 变化', async () => {
    const engine = new SogouWebEngine(makeConfig());
    const ieOf = async (language?: string) => {
      const fetchMock = mockFetchHtml(SERP_HTML);
      globalThis.fetch = fetchMock;
      await engine.search({ query: 'openai', language });
      return new URL(fetchMock.mock.calls[0][0] as string).searchParams.get('ie');
    };
    expect(await ieOf()).toBe('utf8');
    expect(await ieOf('en')).toBe('utf8');
    expect(await ieOf('zh-CN')).toBe('utf8');
  });

  it('timeRange 映射为 s_from=inttime_*', async () => {
    const fetchMock = mockFetchHtml(SERP_HTML);
    globalThis.fetch = fetchMock;
    await new SogouWebEngine(makeConfig()).search({ query: 'openai', timeRange: 'month' });
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get('s_from')).toBe('inttime_month');
  });

  it('空结果页返回空数组且 hasMore 为 false', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><div class="results">抱歉，没有找到相关结果。</div></body></html>');
    const engine = new SogouWebEngine(makeConfig());

    const resp = await engine.search({ query: 'asdfqwer-no-match' });
    expect(resp.results).toEqual([]);
    expect(resp.hasMore).toBe(false);
  });

  it('解析不到结果且不像无结果页时抛 EngineParseError', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><div class="results"></div></body></html>');
    const engine = new SogouWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toBeInstanceOf(EngineParseError);
  });

  it('resolveLink：/link 跳转参数是明文 URL 时直接解开，否则保留跳转地址', () => {
    const base = 'https://www.sogou.com/web';
    expect(SogouWebEngine.resolveLink('/link?url=https%3A%2F%2Fexample.com%2Fa', base))
      .toBe('https://example.com/a');
    expect(SogouWebEngine.resolveLink('/link?url=opaqueToken', base))
      .toBe('https://www.sogou.com/link?url=opaqueToken');
    expect(SogouWebEngine.resolveLink('https://example.com/x', base)).toBe('https://example.com/x');
  });

  it('命中反爬特征文案时抛出验证码错误', async () => {
    globalThis.fetch = mockFetchHtml(ANTISPAM_HTML);
    const engine = new SogouWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toThrow(/验证码|反爬/);
    expect(engine.getStatus().lastError).toContain('验证码');
  });

  it('最终 URL 落到 /antispam/ 时识别为验证码页', async () => {
    globalThis.fetch = mockFetchHtml('<html><body>ok</body></html>', {
      url: 'https://www.sogou.com/antispam/thank.php',
    });
    const engine = new SogouWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toThrow(/验证码|反爬/);
  });

  it('主选择器无匹配时使用 div.results div.result 备用选择器并补全相对链接', async () => {
    globalThis.fetch = mockFetchHtml(FALLBACK_HTML);
    const engine = new SogouWebEngine(makeConfig());

    const resp = await engine.search({ query: 'test' });
    expect(resp.results).toHaveLength(2);
    expect(resp.results[0]).toMatchObject({
      title: '旧版结果标题',
      url: 'https://old.example.com/page',
      snippet: '旧版结构的摘要内容。',
      source: 'sogou',
      position: 1,
    });
    // 备用路径同样做相对 URL 补全；h3 为空时取链接文本作标题
    expect(resp.results[1]).toMatchObject({
      title: '相对链接标题',
      url: 'https://www.sogou.com/web/searchList.jsp?keyword=x',
      snippet: '相对链接的摘要内容。',
      position: 2,
    });
  });
});

describe('SogouWebEngine 跳转链接解包', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  /** 生成 n 条加密跳转结果的 SERP */
  function serpWithLinks(tokens: string[], extra = ''): string {
    return '<html><body><div class="results">'
      + tokens.map(t => `<div class="vrwrap"><h3><a href="/link?url=${t}">结果 ${t}</a></h3><p>摘要 ${t}</p></div>`).join('')
      + extra
      + '</div></body></html>';
  }

  type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

  /** 按请求 URL 路由的 fetch mock：搜索页返回 serp，/link 跳转按 token 分派 */
  function routedFetch(serp: string, links: Record<string, Handler>, searchHeaders: Record<string, string> = {}) {
    return vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/link') {
        const handler = links[url.searchParams.get('url') ?? ''];
        return handler ? handler(init) : makeResponse('not found', { status: 404, url: String(input) });
      }
      return makeResponse(serp, { url: String(input), headers: searchHeaders });
    });
  }

  const redirect = (location: string) => () =>
    makeResponse('', { status: 302, headers: { location } });
  const page = (html: string) => () => makeResponse(html, { status: 200 });

  it('从 302 Location 头解出真实地址，且不跟随到目标站点', async () => {
    const fetchMock = routedFetch(serpWithLinks(['tokA']), { tokA: redirect('https://real.example.com/a?x=1') });
    globalThis.fetch = fetchMock;

    const resp = await new SogouWebEngine(makeConfig()).search({ query: 'q' });
    expect(resp.results[0].url).toBe('https://real.example.com/a?x=1');
    const hosts = fetchMock.mock.calls.map(c => new URL(String(c[0])).hostname);
    expect(hosts).not.toContain('real.example.com');
    // 跳转请求为 GET 且不自动跟随
    const linkCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/link?'));
    expect(linkCall?.[1]).toMatchObject({ method: 'GET', redirect: 'manual' });
  });

  it('从跳转页正文的 location.replace / URL= / meta refresh 中解出真实地址', async () => {
    globalThis.fetch = routedFetch(serpWithLinks(['t1', 't2', 't3']), {
      t1: page('<script>window.location.replace("https://one.example.com/p?a=1&amp;b=2")</script>'),
      t2: page("<meta content=\"0;URL='https://two.example.com/'\"><script>var URL='https://two.example.com/'</script>"),
      t3: page('<html><head><meta http-equiv="refresh" content="0; url=https://three.example.com/x"></head></html>'),
    });

    const resp = await new SogouWebEngine(makeConfig()).search({ query: 'q' });
    expect(resp.results.map(r => r.url)).toEqual([
      'https://one.example.com/p?a=1&b=2',
      'https://two.example.com/',
      'https://three.example.com/x',
    ]);
  });

  it('解包失败、非 http(s) 目标或仍指向搜狗跳转时保留原链接', async () => {
    globalThis.fetch = routedFetch(serpWithLinks(['bad404', 'js', 'loop', 'empty', 'neterr']), {
      js: redirect('javascript:alert(1)'),
      loop: redirect('https://www.sogou.com/link?url=again'),
      empty: page('<html><body>nothing here</body></html>'),
      neterr: () => { throw new TypeError('fetch failed'); },
    });

    const resp = await new SogouWebEngine(makeConfig()).search({ query: 'q' });
    expect(resp.results.map(r => r.url)).toEqual([
      'https://www.sogou.com/link?url=bad404',
      'https://www.sogou.com/link?url=js',
      'https://www.sogou.com/link?url=loop',
      'https://www.sogou.com/link?url=empty',
      'https://www.sogou.com/link?url=neterr',
    ]);
  });

  it('结果节点自带 data-url 时直接使用，不发跳转请求', async () => {
    const serp = '<html><body><div class="results">'
      + '<div class="vrwrap"><h3><a href="/link?url=enc1" data-url="https://direct.example.com/1">A</a></h3></div>'
      + '<div class="vrwrap" data-url="https://direct.example.com/2"><h3><a href="/link?url=enc2">B</a></h3></div>'
      + '<div class="rb"><h3><a href="/link?url=enc3">C</a></h3><div class="fb" data-url="https://direct.example.com/3"></div></div>'
      + '</div></body></html>';
    const fetchMock = routedFetch(serp, {});
    globalThis.fetch = fetchMock;

    const resp = await new SogouWebEngine(makeConfig()).search({ query: 'q' });
    expect(resp.results.map(r => r.url)).toEqual([
      'https://direct.example.com/1',
      'https://direct.example.com/2',
      'https://direct.example.com/3',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('跳转请求带上搜索响应下发的 Cookie', async () => {
    let cookieSeen: string | undefined;
    globalThis.fetch = routedFetch(serpWithLinks(['ck']), {
      ck: (init) => {
        cookieSeen = (init?.headers as Record<string, string> | undefined)?.Cookie;
        return makeResponse('', { status: 302, headers: { location: 'https://ck.example.com/' } });
      },
    }, { 'set-cookie': 'SNUID=abc123; path=/; domain=.sogou.com' });

    const resp = await new SogouWebEngine(makeConfig()).search({ query: 'q' });
    expect(resp.results[0].url).toBe('https://ck.example.com/');
    expect(cookieSeen).toContain('SNUID=abc123');
  });

  it('并发不超过 5', async () => {
    const tokens = Array.from({ length: 10 }, (_, i) => `c${i}`);
    let inFlight = 0;
    let peak = 0;
    const slow: Handler = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight--;
      return makeResponse('', { status: 302, headers: { location: 'https://c.example.com/' } });
    };
    globalThis.fetch = routedFetch(serpWithLinks(tokens), Object.fromEntries(tokens.map(t => [t, slow])));

    const resp = await new SogouWebEngine(makeConfig()).search({ query: 'q' });
    expect(resp.results.every(r => r.url === 'https://c.example.com/')).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('单条跳转超时后保留原链接，不拖慢整体', async () => {
    const hang: Handler = (init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    globalThis.fetch = routedFetch(serpWithLinks(['hang', 'ok']), {
      hang,
      ok: redirect('https://ok.example.com/'),
    });

    const started = Date.now();
    const resp = await new SogouWebEngine(makeConfig({ timeout: 200 })).search({ query: 'q' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(resp.results.map(r => r.url)).toEqual([
      'https://www.sogou.com/link?url=hang',
      'https://ok.example.com/',
    ]);
  });

  it('request.signal 取消后不再发起解包请求', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/link?')) return makeResponse('', { status: 302, headers: { location: 'https://x.example.com/' } });
      // 搜索页返回后立即取消
      controller.abort();
      return makeResponse(serpWithLinks(['s1', 's2']), { url });
    });
    globalThis.fetch = fetchMock;

    const resp = await new SogouWebEngine(makeConfig()).search({ query: 'q', signal: controller.signal });
    expect(resp.results.map(r => r.url)).toEqual([
      'https://www.sogou.com/link?url=s1',
      'https://www.sogou.com/link?url=s2',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('风控状态码 HTTP 399 归类为 EngineBlockedError', async () => {
    globalThis.fetch = mockFetchHtml('', { status: 399 });
    await expect(new SogouWebEngine(makeConfig()).search({ query: 'q' })).rejects.toBeInstanceOf(EngineBlockedError);
  });

  it('每页不足 count 条（搜狗常见 9 条）仍判定 hasMore', async () => {
    globalThis.fetch = mockFetchHtml(serpWithLinksDirect(9));
    const resp = await new SogouWebEngine(makeConfig()).search({ query: 'q', count: 10 });
    expect(resp.results).toHaveLength(9);
    expect(resp.hasMore).toBe(true);
  });

  it('extractRedirectTarget / isSogouRedirect 静态工具', () => {
    expect(SogouWebEngine.extractRedirectTarget('<script>location.replace(\'https://a.example.com/\')</script>'))
      .toBe('https://a.example.com/');
    expect(SogouWebEngine.extractRedirectTarget('<p>no redirect</p>')).toBeUndefined();
    expect(SogouWebEngine.isSogouRedirect('https://www.sogou.com/link?url=x')).toBe(true);
    expect(SogouWebEngine.isSogouRedirect('https://m.sogou.com/link?url=x')).toBe(true);
    expect(SogouWebEngine.isSogouRedirect('https://example.com/link?url=x')).toBe(false);
    expect(SogouWebEngine.isSogouRedirect('https://www.sogou.com/web?query=x')).toBe(false);
  });
});
