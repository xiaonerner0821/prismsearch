import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ tools: new Map<string, (...args: any[]) => any>(), web: vi.fn(), image: vi.fn(), fetch: vi.fn(), wechat: vi.fn(), list: vi.fn() }));
vi.mock('@modelcontextprotocol/server', () => ({ McpServer: class { registerTool(name: string, _config: unknown, handler: (...args: any[]) => any) { mocks.tools.set(name, handler); } } }));
vi.mock('../../src/tools/web-search.js', () => ({ handleWebSearch: mocks.web }));
vi.mock('../../src/tools/image-search.js', () => ({ handleImageSearch: mocks.image }));
vi.mock('../../src/tools/wechat-search.js', () => ({ handleWechatSearch: mocks.wechat }));
vi.mock('../../src/tools/list-engines.js', () => ({ handleListEngines: mocks.list }));
vi.mock('../../src/tools/fetch-page.js', async original => ({ ...(await original<typeof import('../../src/tools/fetch-page.js')>()), handleFetchPage: mocks.fetch }));
import { PrismSearchRuntime, RuntimeHolder, createMcpServer, RateLimitError, progressNotifier } from '../../src/server/mcp-server.js';
import { buildConfig } from '../../src/config/config-loader.js';
import { FetchPageError } from '../../src/tools/fetch-page.js';

function config(extra = {}) { return buildConfig({ engines: [], cache: { backend: 'memory' }, wechat: { enabled: false }, fetcher: { browser: { enabled: false } }, ...extra }, {}).config; }
const runtimes: PrismSearchRuntime[] = [];
async function runtime(extra = {}, options: any = { toolLevelRateLimit: false }) { const rt = await PrismSearchRuntime.create(config(extra), options); runtimes.push(rt); return rt; }
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); for (const rt of runtimes.splice(0)) await rt.close(); });
const ctx = () => ({ mcpReq: { signal: new AbortController().signal, notify: vi.fn().mockResolvedValue(undefined) } });

describe('MCP 核心工具', () => {
  it.each([['web_search', 'web'], ['image_search', 'image'], ['fetch_page', 'fetch'], ['wechat_search', 'wechat'], ['list_engines', 'list']] as const)('%s 封装成功结果并脱敏未知异常', async (name, key) => {
    const rt = await runtime(); createMcpServer(new RuntimeHolder(rt));
    mocks[key].mockReturnValue({ results: [], test: true });
    const result = await mocks.tools.get(name)!({ query: 'q', url: 'https://example.test/' }, ctx());
    expect(result.structuredContent).toEqual({ results: [], test: true });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    mocks[key].mockImplementationOnce(() => { throw new Error('secret internal path/token'); });
    const failure = await mocks.tools.get(name)!({}, ctx());
    expect(failure.isError).toBe(true);
    expect(failure.content[0].text).not.toContain('secret');
    expect(JSON.parse(failure.content[0].text).error).toBe('内部错误，请查看服务端日志');
  });
  it('已知错误保留 code/retryAfter，工具层全局限流', async () => {
    const rt = await runtime({ security: { rateLimit: { enabled: true, maxRequests: 1, windowMs: 1000 } } }, { toolLevelRateLimit: true });
    createMcpServer(new RuntimeHolder(rt));
    mocks.fetch.mockRejectedValueOnce(new FetchPageError('safe error', 'FETCH_FAILED'));
    const first = await mocks.tools.get('fetch_page')!({}, ctx());
    expect(first.isError).toBe(true);
    expect(JSON.parse(first.content[0].text)).toEqual({ error: 'safe error', code: 'FETCH_FAILED' });
    const second = await mocks.tools.get('fetch_page')!({}, ctx());
    expect(JSON.parse(second.content[0].text)).toMatchObject({ retryAfterMs: expect.any(Number) });
    expect(new RateLimitError(1001).message).toContain('2 秒');
  });
  it('注入远端 Worker 与浏览器/微信开启配置', async () => {
    const remote = { fetch: vi.fn(), status: vi.fn().mockReturnValue([]) };
    const rt = await runtime({ wechat: { enabled: true }, fetcher: { browser: { enabled: true } } }, { toolLevelRateLimit: true, remoteFetcher: remote });
    expect(rt.wechatEngine).toBeDefined(); expect(rt.wechatLimiter).toBeDefined(); expect(rt.fetchers.browser).toBeDefined();
    createMcpServer(new RuntimeHolder(rt)); mocks.fetch.mockResolvedValue({}); mocks.list.mockReturnValue({});
    await mocks.tools.get('fetch_page')!({}, ctx());
    expect(mocks.fetch.mock.lastCall![1].remote.fetcher).toBe(remote);
    await mocks.tools.get('list_engines')!();
    expect(mocks.list.mock.lastCall![0].workers()).toEqual([]);
  });
  it('运行时关闭一个组件失败不影响其他组件', async () => {
    const rt = await runtime(); vi.spyOn(rt.cache, 'close').mockRejectedValueOnce(new Error('cache'));
    const guard = vi.spyOn(rt.ssrfGuard, 'close'); await rt.close(); expect(guard).toHaveBeenCalled();
  });
  it('RuntimeHolder 重建后原子替换，宽限期关闭旧实例；重建失败保留原实例', async () => {
    const old = await runtime(); const next = await runtime(); const holder = new RuntimeHolder(old);
    const close = vi.spyOn(old, 'close'); vi.spyOn(PrismSearchRuntime, 'create').mockResolvedValueOnce(next).mockRejectedValueOnce(new Error('bad config'));
    vi.useFakeTimers(); await holder.reload(config(), { toolLevelRateLimit: false }, 20);
    expect(holder.get()).toBe(next); expect(close).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(20); expect(close).toHaveBeenCalledOnce();
    await expect(holder.reload(config(), { toolLevelRateLimit: false })).rejects.toThrow('bad config'); expect(holder.get()).toBe(next);
    const nextClose = vi.spyOn(next, 'close'); await holder.close(); expect(nextClose).toHaveBeenCalled();
  });
  it('进度通知可选、保留零 token 且失败不影响调用', async () => {
    const notify = vi.fn().mockRejectedValue(new Error('client disconnected'));
    expect(progressNotifier({ notify })).toBeUndefined();
    const report = progressNotifier({ notify, _meta: { progressToken: 0 } })!;
    report({ progress: 1, total: 2, message: 'test' }); report({ progress: 2, message: 'done' });
    expect(notify).toHaveBeenCalledWith({ method: 'notifications/progress', params: { progressToken: 0, progress: 1, total: 2, message: 'test' } });
    await Promise.resolve();
  });
});
