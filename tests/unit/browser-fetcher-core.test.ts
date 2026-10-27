import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { PlaywrightPage } from '../../src/fetcher/browser-pool.js';
const { pool, extract } = vi.hoisted(() => ({ pool: { acquire: vi.fn(), release: vi.fn(), close: vi.fn() }, extract: vi.fn() }));
vi.mock('../../src/fetcher/browser-pool.js', () => ({ BrowserPool: class { acquire = pool.acquire; release = pool.release; close = pool.close; } }));
vi.mock('../../src/fetcher/content-extractor.js', () => ({ ContentExtractor: { extractReadable: extract } }));
import { BrowserFetcher, sanitizeUrl } from '../../src/fetcher/browser-fetcher.js';

function pageMock() {
  return { route: vi.fn(), setExtraHTTPHeaders: vi.fn(), goto: vi.fn(), content: vi.fn().mockResolvedValue('<html>ok</html>'), url: vi.fn().mockReturnValue('https://final.test/'), close: vi.fn(), waitForSelector: vi.fn(), waitForTimeout: vi.fn() } as unknown as PlaywrightPage;
}
beforeEach(() => { vi.clearAllMocks(); pool.release.mockResolvedValue(undefined); extract.mockResolvedValue({ content: 'ok', title: 'Title' }); });
afterEach(() => vi.restoreAllMocks());
describe('BrowserFetcher', () => {
  it('抓取页面、等待 selector、透传 headers，并在 HTML 格式返回 rawHtml', async () => {
    const page = pageMock();
    (page.goto as any).mockResolvedValue({ status: () => 201, headers: () => ({ 'content-type': 'text/html' }) });
    (page.waitForSelector as any).mockResolvedValue(undefined);
    pool.acquire.mockResolvedValue({ page });
    const f = new BrowserFetcher({ browserType: 'chromium', executablePath: undefined, headless: true, pageTimeout: 1000, waitUntil: 'domcontentloaded', maxConcurrency: 1 } as any);
    const result = await f.fetch({ url: 'https://test/', format: 'html', headers: { X: 'y' }, userAgent: 'Agent', waitForSelector: '#ready', waitForTimeout: 20 });
    expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith({ X: 'y', 'User-Agent': 'Agent' });
    expect(page.goto).toHaveBeenCalledWith('https://test/', expect.objectContaining({ waitUntil: 'domcontentloaded' }));
    expect(page.waitForSelector).toHaveBeenCalled();
    expect(result).toMatchObject({ url: 'https://final.test/', statusCode: 201, rawHtml: '<html>ok</html>', fetchedBy: 'browser' });
    expect(pool.release).toHaveBeenCalled();
  });
  it('selector 超时继续，waitForTimeout 分支可用', async () => {
    const page = pageMock(); (page.goto as any).mockResolvedValue(null); (page.waitForSelector as any).mockRejectedValue(new Error('timeout')); pool.acquire.mockResolvedValue({ page });
    await expect(new BrowserFetcher({ pageTimeout: 100 } as any).fetch({ url: 'https://test/', waitForSelector: '#x', waitForTimeout: 5 })).resolves.toMatchObject({ statusCode: 200 });
    const page2 = pageMock(); (page2.goto as any).mockResolvedValue(null); pool.acquire.mockResolvedValue({ page: page2 });
    await new BrowserFetcher({ pageTimeout: 100 } as any).fetch({ url: 'https://test/', waitForTimeout: 5 });
    expect(page2.waitForTimeout).toHaveBeenCalled();
  });
  it('取消、内容类型错误和普通异常分别处理，并释放页面', async () => {
    const controller = new AbortController(); controller.abort();
    pool.acquire.mockResolvedValue({ page: pageMock() });
    await expect(new BrowserFetcher({ pageTimeout: 100 } as any).fetch({ url: 'https://test/', signal: controller.signal })).rejects.toThrow('浏览器抓取已取消');
    const page = pageMock(); (page.goto as any).mockRejectedValue(new Error('boom')); pool.acquire.mockResolvedValue({ page });
    await expect(new BrowserFetcher({ pageTimeout: 100 } as any).fetch({ url: 'https://test/' })).rejects.toThrow('浏览器抓取失败');
    expect(pool.release).toHaveBeenCalled();
  });
  it('SSRF 路由只校验网络类型和 http(s)，拦截时 abort', async () => {
    const page = pageMock(); (page.goto as any).mockResolvedValue(null); pool.acquire.mockResolvedValue({ page });
    const validate = vi.fn().mockRejectedValue(new Error('blocked'));
    await new BrowserFetcher({ pageTimeout: 100 } as any).fetch({ url: 'https://test/', validateUrl: validate });
    const routeHandler = (page.route as any).mock.calls[0][1];
    const route = { continue: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
    await routeHandler(route, { url: () => 'https://private/', resourceType: () => 'document' });
    expect(validate).toHaveBeenCalledWith('https://private/'); expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    await routeHandler(route, { url: () => 'data:text/html,x', resourceType: () => 'image' });
    await routeHandler(route, { url: () => 'https://x/', resourceType: () => 'websocket' });
    expect(route.continue).toHaveBeenCalled();
  });
  it('在途取消关闭页面并移除 abort 监听，选择器取消错误不吞掉', async () => {
    const controller = new AbortController();
    const page = pageMock();
    (page.close as any).mockRejectedValue(new Error('already closed'));
    (page.goto as any).mockImplementation(async () => { controller.abort(); throw new Error('navigation aborted'); });
    pool.acquire.mockResolvedValue({ page });
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(new BrowserFetcher({ pageTimeout: 100 } as any).fetch({ url: 'https://test/', signal: controller.signal })).rejects.toThrow('浏览器抓取已取消');
    expect(page.close).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('网络路由放行与非网络资源的 continue 异常不传播', async () => {
    const page = pageMock(); (page.goto as any).mockResolvedValue(null); pool.acquire.mockResolvedValue({ page });
    const validate = vi.fn().mockResolvedValue(undefined);
    await new BrowserFetcher({ pageTimeout: 100 } as any).fetch({ url: 'https://test/', validateUrl: validate });
    const handler = (page.route as any).mock.calls[0][1];
    const route = { continue: vi.fn().mockRejectedValue(new Error('closed')), abort: vi.fn().mockRejectedValue(new Error('closed')) };
    await handler(route, { url: () => 'https://public/', resourceType: () => 'document' });
    await handler(route, { url: () => 'https://public/', resourceType: () => 'unknown' });
    await handler(route, { url: () => 'blob:x', resourceType: () => 'image' });
    validate.mockRejectedValueOnce('blocked');
    await handler(route, { url: () => 'https://private/', resourceType: () => 'document' });
    expect(route.continue).toHaveBeenCalledTimes(3); expect(route.abort).toHaveBeenCalledOnce();
  });
  it('未知类型时读取 body，读取失败容错；非文本类型原样拒绝', async () => {
    const page = pageMock();
    (page.goto as any).mockResolvedValue({ headers: () => ({}), status: () => 200, body: vi.fn().mockRejectedValue(new Error('body missing')) });
    pool.acquire.mockResolvedValue({ page });
    await expect(new BrowserFetcher({ pageTimeout: 100 } as any).fetch({ url: 'https://test/' })).resolves.toMatchObject({ content: 'ok' });
    (page.goto as any).mockResolvedValue({ headers: () => ({ 'content-type': 'image/png' }), status: () => 200 });
    await expect(new BrowserFetcher({ pageTimeout: 100 } as any).fetch({ url: 'https://test/' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE' });
  });
  it('关闭浏览器池并脱敏 URL', async () => {
    const f = new BrowserFetcher({} as any); await f.close(); expect(pool.close).toHaveBeenCalled();
    expect(sanitizeUrl('https://user:pass@example.com/a?q=secret')).toBe('https://example.com/a');
    expect(sanitizeUrl('bad')).toBe('<invalid-url>');
  });
});
