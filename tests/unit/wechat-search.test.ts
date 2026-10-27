import { describe, it, expect, vi } from 'vitest';
import { handleWechatSearch } from '../../src/tools/wechat-search.js';
import { ToolInputError } from '../../src/tools/tool-errors.js';
import type { CacheProvider } from '../../src/cache/cache-interface.js';
import type { SearchProvider } from '../../src/engines/engine-interface.js';

const response = (results: any[]) => ({ results, engine: 'wechat', searchTime: 1, cached: false, page: 1, hasMore: true });
function deps(overrides: Partial<{ cache: any; engine: any; limiter: any }> = {}) {
  const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn(), clear: vi.fn(), has: vi.fn(), stats: vi.fn(), cleanup: vi.fn(), close: vi.fn(), backend: 'memory' } as unknown as CacheProvider;
  const engine = { search: vi.fn().mockResolvedValue(response([{ title: 'A', url: 'u', snippet: 's', source: 'wechat', position: 99 }, { title: 'A', url: 'u', snippet: 'dup', source: 'wechat', position: 100 }, { title: 'B', url: 'v', snippet: 'b', source: 'wechat', position: 2 }])), name: 'wechat', displayName: '微信', getStatus: vi.fn(), isAvailable: () => true } as unknown as SearchProvider;
  return { cache: overrides.cache ?? cache, engine: overrides.engine ?? engine, limiter: overrides.limiter };
}

describe('handleWechatSearch', () => {
  it('校验未启用和空 query', async () => {
    await expect(handleWechatSearch({ query: 'x' }, { cache: deps().cache })).rejects.toBeInstanceOf(ToolInputError);
    await expect(handleWechatSearch({ query: ' ' }, deps())).rejects.toThrow('query 不能为空');
  });
  it('去重、截断、重排并缓存结果', async () => {
    const d = deps();
    const result = await handleWechatSearch({ query: '  Hello   World ', count: 2, page: 2 }, d);
    expect(result.results).toHaveLength(2);
    expect(result.results.map(x => x.position)).toEqual([3, 4]);
    expect(d.engine!.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'Hello   World', count: 2, page: 2 }));
    expect(d.cache.set).toHaveBeenCalledWith(expect.any(String), result, { ttl: 600 });
  });
  it('缓存命中时跳过限流和引擎', async () => {
    const cached = response([{ title: 'cached', url: 'u', snippet: 's', source: 'wechat', position: 1 }]);
    const limiter = { consume: vi.fn() };
    const d = deps({ cache: { ...deps().cache, get: vi.fn().mockResolvedValue(cached), set: vi.fn() }, limiter });
    const result = await handleWechatSearch({ query: 'q' }, d);
    expect(result.cached).toBe(true);
    expect(d.engine!.search).not.toHaveBeenCalled();
    expect(limiter.consume).not.toHaveBeenCalled();
  });
  it('缓存读写失败不影响搜索，取消信号原样透传', async () => {
    const d = deps();
    vi.mocked(d.cache.get).mockRejectedValueOnce(new Error('read'));
    vi.mocked(d.cache.set).mockRejectedValueOnce(new Error('write'));
    const signal = new AbortController().signal;
    const result = await handleWechatSearch({ query: 'q' }, d, signal);
    expect(result.cached).toBe(false);
    expect(d.engine!.search).toHaveBeenCalledWith({ query: 'q', count: 10, page: 1, engine: 'wechat', signal });
  });
  it('空结果不缓存，上游异常原样传播', async () => {
    const d = deps();
    vi.mocked(d.engine!.search).mockResolvedValueOnce(response([]));
    expect((await handleWechatSearch({ query: 'q' }, d)).results).toEqual([]);
    expect(d.cache.set).not.toHaveBeenCalled();
    const error = new Error('upstream');
    vi.mocked(d.engine!.search).mockRejectedValueOnce(error);
    await expect(handleWechatSearch({ query: 'q' }, d)).rejects.toBe(error);
  });
  it('缓存 key 规范化空白和大小写，区分页码和数量', async () => {
    const d = deps();
    await handleWechatSearch({ query: ' Hello   World ' }, d);
    expect(d.cache.get).toHaveBeenLastCalledWith(JSON.stringify(['wechat_search', 'hello world', 10, 1]));
    await handleWechatSearch({ query: 'hello world', count: 3, page: 2 }, d);
    expect(d.cache.get).toHaveBeenLastCalledWith(JSON.stringify(['wechat_search', 'hello world', 3, 2]));
  });
  it('限流时拒绝请求', async () => {
    const d = deps({ limiter: { consume: vi.fn().mockReturnValue({ allowed: false, retryAfter: 1500 }) } });
    await expect(handleWechatSearch({ query: 'q' }, d)).rejects.toThrow('2 秒');
  });
});
