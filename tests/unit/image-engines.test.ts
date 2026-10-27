/**
 * 图片引擎单元测试：请求 URL 构造、各级解析策略与失败统计。
 * fetchSearchPage 被替换为桩，不访问真实网络。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchSearchPage = vi.fn();
vi.mock('../../src/engines/scraper-http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engines/scraper-http.js')>()),
  fetchSearchPage: (...args: unknown[]) => fetchSearchPage(...args),
}));

const { buildConfig } = await import('../../src/config/config-loader.js');
const { GoogleImageEngine } = await import('../../src/engines/google/google-image.js');
const { BingImageEngine } = await import('../../src/engines/bing/bing-image.js');
const { BaiduImageEngine } = await import('../../src/engines/baidu/baidu-image.js');
const { EngineBlockedError, EngineParseError } = await import('../../src/engines/engine-interface.js');

function engineConfig(name: string, overrides: Record<string, unknown> = {}) {
  const { config } = buildConfig({ engines: [{ name, ...overrides }] }, {});
  return config.engines.find(e => e.name === name)!;
}

function lastUrl(): URL {
  return new URL(fetchSearchPage.mock.calls.at(-1)![0] as string);
}

/** 统一的抓取桩返回值：默认给一个正常的最终 URL */
function pageResult(body: string, url = 'https://example.com/search') {
  return { body, url, status: 200, headers: {} };
}

beforeEach(() => {
  fetchSearchPage.mockReset();
});

describe('GoogleImageEngine', () => {
  it('沿用配置的 baseUrl，并带上分页、语言与过滤参数', async () => {
    fetchSearchPage.mockResolvedValue(pageResult(
      '<a href="/imgres?imgurl=https%3A%2F%2Fimg.example%2Ffull.jpg&imgrefurl=x"><img src="https://t.example/thumb" alt="图"></a>',
    ));
    const engine = new GoogleImageEngine(engineConfig('google', { baseUrl: 'https://www.google.com.hk/search' }));
    await engine.search({
      query: '猫',
      count: 20,
      page: 3,
      language: 'zh-CN',
      region: 'hk',
      safeSearch: true,
      imageSize: 'large',
      imageType: 'gif',
    });
    const url = lastUrl();
    expect(url.host).toBe('www.google.com.hk');
    expect(url.searchParams.get('tbm')).toBe('isch');
    expect(url.searchParams.get('start')).toBe('40');
    expect(url.searchParams.get('hl')).toBe('zh-CN');
    expect(url.searchParams.get('gl')).toBe('hk');
    expect(url.searchParams.get('safe')).toBe('active');
    expect(url.searchParams.get('tbs')).toBe('isz:l,itp:animated');
  });

  it('优先从脚本数据里提取原图，排除 Google 自身资源并去重', async () => {
    const html = `<script>AF_initDataCallback({data:[
      ["https://example.com/a.jpg",300,200],
      ["https://example.com/a.jpg",300,200],
      ["https://encrypted-tbn0.gstatic.com/x.png",1,1],
      ["https://cdn.example.org/b.png?x=1",10,10]
    ]})</script>`;
    fetchSearchPage.mockResolvedValue(pageResult(html));
    const engine = new GoogleImageEngine(engineConfig('google'));
    const res = await engine.search({ query: 'q', count: 10 });
    expect(res.results.map(r => r.imageUrl)).toEqual([
      'https://example.com/a.jpg',
      'https://cdn.example.org/b.png?x=1',
    ]);
    expect(res.results.map(r => r.position)).toEqual([1, 2]);
    expect(res.hasMore).toBe(false);
  });

  it('脚本里没有数据时退回 DOM 解析（data-ri 结构）', async () => {
    const html = `
      <div data-ri="0"><a href="https://site.example/page"><img data-src="https://t.example/1.jpg" alt="第一张"></a></div>
      <div data-ri="1"><img src="https://t.example/2.jpg"></div>`;
    fetchSearchPage.mockResolvedValue(pageResult(html));
    const res = await new GoogleImageEngine(engineConfig('google')).search({ query: 'q' });
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toMatchObject({ title: '第一张', sourceUrl: 'https://site.example/page' });
    expect(res.results[1].title).toBe('无标题');
  });

  it('最后退回 /imgres 链接，并从中解析出原图地址', async () => {
    const html = `<a href="/imgres?imgurl=https%3A%2F%2Fimg.example%2Ffull.jpg&imgrefurl=x"><img src="https://t.example/thumb" alt="图"></a>`;
    fetchSearchPage.mockResolvedValue(pageResult(html));
    const res = await new GoogleImageEngine(engineConfig('google')).search({ query: 'q' });
    expect(res.results[0]).toMatchObject({
      imageUrl: 'https://img.example/full.jpg',
      thumbnailUrl: 'https://t.example/thumb',
      title: '图',
    });
  });

  it('请求失败时抛出原错误并记录失败统计', async () => {
    fetchSearchPage.mockRejectedValue(new Error('boom'));
    const engine = new GoogleImageEngine(engineConfig('google'));
    await expect(engine.search({ query: 'q' })).rejects.toThrow('boom');
    expect(engine.getLastError()).toBe('boom');
  });
});

describe('BingImageEngine', () => {
  it('从 baseUrl 推导源站，固定使用 /images/search 路径', async () => {
    fetchSearchPage.mockResolvedValue(pageResult(
      '<div class="imgpt"><a href="https://page.example/"><img src="https://t.example/x.jpg" alt="备用"></a></div>',
    ));
    const engine = new BingImageEngine(engineConfig('bing', { baseUrl: 'https://cn.bing.com/search' }));
    await engine.search({ query: 'dog', count: 10, page: 2, imageSize: 'small', imageType: 'photo' });
    const url = lastUrl();
    expect(url.origin + url.pathname).toBe('https://cn.bing.com/images/search');
    expect(url.searchParams.get('first')).toBe('11');
    expect(url.searchParams.get('qft')).toBe('+filterui:imagesize-small+filterui:photo-photo');
  });

  it('解析 a.iusc 的 m 元数据，跳过损坏的条目', async () => {
    const meta = JSON.stringify({
      murl: 'https://img.example/full.jpg',
      turl: 'https://t.example/thumb.jpg',
      t: '标题',
      purl: 'https://page.example/',
      w: '800',
      h: '600',
    });
    const html = `<a class="iusc" m='${meta}'></a><a class="iusc" m="{broken"></a><a class="iusc"></a>`;
    fetchSearchPage.mockResolvedValue(pageResult(html));
    const res = await new BingImageEngine(engineConfig('bing')).search({ query: 'q' });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({
      title: '标题',
      imageUrl: 'https://img.example/full.jpg',
      thumbnailUrl: 'https://t.example/thumb.jpg',
      sourceUrl: 'https://page.example/',
      width: 800,
      height: 600,
      source: 'bing',
      position: 1,
    });
  });

  it('a.iusc 缺失时退回 .imgpt 结构', async () => {
    const html = `<div class="imgpt"><a href="https://page.example/"><img src="https://t.example/x.jpg" alt="备用"></a></div>`;
    fetchSearchPage.mockResolvedValue(pageResult(html));
    const res = await new BingImageEngine(engineConfig('bing')).search({ query: 'q' });
    expect(res.results[0]).toMatchObject({ title: '备用', imageUrl: 'https://t.example/x.jpg' });
  });

  it('零结果且不像无结果页时抛 EngineParseError', async () => {
    fetchSearchPage.mockResolvedValue(pageResult('<html><body>改版页面</body></html>'));
    const engine = new BingImageEngine(engineConfig('bing'));
    await expect(engine.search({ query: 'q' })).rejects.toBeInstanceOf(EngineParseError);
  });

  it('验证码页抛 EngineBlockedError', async () => {
    fetchSearchPage.mockResolvedValue(pageResult('<html><div id="b_captcha">请验证</div></html>'));
    const engine = new BingImageEngine(engineConfig('bing'));
    await expect(engine.search({ query: 'q' })).rejects.toBeInstanceOf(EngineBlockedError);
  });
});

describe('BaiduImageEngine', () => {
  const item = (i: number) => ({
    objURL: `https://img.example/${i}.jpg`,
    thumbURL: `https://t.example/${i}.jpg`,
    fromURL: `https://page.example/${i}`,
    fromPageTitle: `标题${i}`,
    width: 100,
    height: 50,
  });

  it('请求 JSON 接口并按页换算 pn', async () => {
    fetchSearchPage.mockResolvedValue(pageResult(JSON.stringify({ data: [item(1)] })));
    await new BaiduImageEngine(engineConfig('baidu')).search({ query: '狗', count: 30, page: 2, imageSize: 'medium', imageType: 'gif' });
    const url = lastUrl();
    expect(url.host).toBe('image.baidu.com');
    expect(url.searchParams.get('word')).toBe('狗');
    expect(url.searchParams.get('pn')).toBe('30');
    expect(url.searchParams.get('z')).toBe('2');
    expect(url.searchParams.get('ic')).toBe('4');
  });

  it('解析普通 JSON 与 JSONP，跳过空条目并按 count 截断', async () => {
    const body = `cb(${JSON.stringify({ data: [item(1), {}, null, item(2), item(3)] })})`;
    fetchSearchPage.mockResolvedValue(pageResult(body));
    const res = await new BaiduImageEngine(engineConfig('baidu')).search({ query: 'q', count: 2 });
    expect(res.results.map(r => r.imageUrl)).toEqual(['https://img.example/1.jpg', 'https://img.example/2.jpg']);
    expect(res.results[0]).toMatchObject({ sourceTitle: '标题1', width: 100, height: 50 });
    expect(res.hasMore).toBe(true);
  });

  it('objURL / fromURL 为加密串时改用 replaceUrl 中的明文地址，缺失时退回 CDN 图', async () => {
    const encrypted = {
      objURL: 'ippr_z2C$qAzdH3FAzdH3Frtvfd_z&e3B',
      fromURL: 'ippr_z2C$qAzdH3FAzdH3Fooo_z&e3B',
      thumbURL: 'https://img1.baidu.com/it/u=1&fm=253',
      middleURL: 'https://img1.baidu.com/it/u=1&fm=253&w=500',
      fromPageTitle: '加密条目',
    };
    const withReplace = {
      ...encrypted,
      replaceUrl: [{ ObjURL: 'https://pics2.baidu.com/feed/a.jpeg', FromURL: 'http://baijiahao.baidu.com/s?id=1' }],
    };
    fetchSearchPage.mockResolvedValue(pageResult(JSON.stringify({ data: [withReplace, encrypted] })));
    const res = await new BaiduImageEngine(engineConfig('baidu')).search({ query: 'q', count: 5 });
    expect(res.results[0]).toMatchObject({
      imageUrl: 'https://pics2.baidu.com/feed/a.jpeg',
      sourceUrl: 'http://baijiahao.baidu.com/s?id=1',
    });
    expect(res.results[1]).toMatchObject({ imageUrl: 'https://img1.baidu.com/it/u=1&fm=253&w=500', sourceUrl: '' });
    for (const r of res.results) expect(r.imageUrl).toMatch(/^https?:\/\//);
  });

  it('验证码页与无法解析的响应给出不同的错误', async () => {
    const engine = new BaiduImageEngine(engineConfig('baidu'));
    fetchSearchPage.mockResolvedValueOnce(pageResult('<html>百度安全验证</html>'));
    await expect(engine.search({ query: 'q' })).rejects.toThrow(/验证码/);
    fetchSearchPage.mockResolvedValueOnce(pageResult('not json'));
    await expect(engine.search({ query: 'q' })).rejects.toThrow(/解析失败/);
    // JSON 正常但没有任何可用条目：不能当成「0 条结果」成功返回
    fetchSearchPage.mockResolvedValueOnce(pageResult(JSON.stringify({ data: [] })));
    await expect(engine.search({ query: 'q' })).rejects.toBeInstanceOf(EngineParseError);
  });
});
