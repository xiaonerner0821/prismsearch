import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisCache } from '../../src/cache/redis-cache.js';

function fakeClient() {
  return {
    get: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    set: vi.fn(), del: vi.fn().mockResolvedValue(1), exists: vi.fn().mockResolvedValue(1),
    dbSize: vi.fn().mockResolvedValue(2), quit: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined), on: vi.fn(),
    scanIterator: vi.fn(async function* () { yield ['p:a', 'p:b']; yield []; yield ['p:c']; }),
  };
}
const state = vi.hoisted(() => ({ client: undefined as unknown as ReturnType<typeof fakeClient>, create: vi.fn() }));
vi.mock('redis', () => ({ createClient: (opts: unknown) => { state.create(opts); return state.client; } }));
const options = { url: 'redis://host', keyPrefix: 'p:', ttl: 4 };

describe('RedisCache', () => {
  beforeEach(() => { state.client = fakeClient(); state.create.mockClear(); });
  it('通过正式参数覆盖 URL 旧口令，并保留 ACL 用户名', async () => {
    await RedisCache.create({ ...options, url: 'redis://user:old@host:6379/2', password: 'secret' });
    expect(state.create).toHaveBeenCalledWith({ url: 'redis://user@host:6379/2', password: 'secret' });
    expect(state.client.connect).toHaveBeenCalledOnce();
  });
  it('未指定独立密码时保留 URL 认证，并允许显式空密码', async () => {
    await RedisCache.create({ ...options, url: 'redis://user:old@host' });
    expect(state.create).toHaveBeenLastCalledWith({ url: 'redis://user:old@host' });
    await RedisCache.create({ ...options, password: '' });
    expect(state.create).toHaveBeenLastCalledWith({ url: 'redis://host', password: '' });
  });
  it('正确统计命中、不存在与损坏 JSON，不将解析失败计为命中', async () => {
    const cache = await RedisCache.create(options);
    state.client.get.mockResolvedValueOnce(null).mockResolvedValueOnce('{bad').mockResolvedValueOnce('{"ok":true}');
    expect(await cache.get('missing')).toBeNull();
    expect(await cache.get('bad')).toBeNull();
    expect(await cache.get('ok')).toEqual({ ok: true });
    expect(state.client.get).toHaveBeenLastCalledWith('p:ok');
    expect(await cache.stats()).toEqual({ backend: 'redis', size: 2, hits: 1, misses: 2 });
  });
  it('序列化并向上取整 TTL，零/负 TTL 不缓存', async () => {
    const cache = await RedisCache.create(options);
    await cache.set('a', { a: 1 });
    expect(state.client.set).toHaveBeenLastCalledWith('p:a', '{"a":1}', { EX: 4 });
    await cache.set('b', false, { ttl: 0.2 });
    expect(state.client.set).toHaveBeenLastCalledWith('p:b', 'false', { EX: 1 });
    await cache.set('c', 1, { ttl: 0 });
    await cache.set('d', 1, { ttl: -2 });
    expect(state.client.set).toHaveBeenCalledTimes(2);
  });
  it('delete/has 使用前缀并转换返回值，cleanup 无操作', async () => {
    const cache = await RedisCache.create(options);
    expect(await cache.delete('a')).toBe(true);
    state.client.del.mockResolvedValueOnce(0);
    expect(await cache.delete('a')).toBe(false);
    expect(state.client.del).toHaveBeenCalledWith('p:a');
    expect(await cache.has('b')).toBe(true);
    state.client.exists.mockResolvedValueOnce(0);
    expect(await cache.has('b')).toBe(false);
    expect(state.client.exists).toHaveBeenCalledWith('p:b');
    expect(await cache.cleanup()).toBe(0);
  });
  it('clear 使用 Redis 5 批次 SCAN，忽略空批次并重置统计', async () => {
    const cache = await RedisCache.create(options);
    await cache.get('missing');
    await cache.clear();
    expect(state.client.scanIterator).toHaveBeenCalledWith({ MATCH: 'p:*', COUNT: 100 });
    expect(state.client.del.mock.calls).toEqual([[['p:a', 'p:b']], [['p:c']]]);
    expect(await cache.stats()).toMatchObject({ hits: 0, misses: 0 });
  });
  it('错误事件兼容 Error 和非 Error；关闭错误忽略', async () => {
    const cache = await RedisCache.create(options);
    const listener = state.client.on.mock.calls[0][1] as (error: unknown) => void;
    listener(new Error('offline')); listener('offline');
    await cache.close();
    state.client.quit.mockRejectedValueOnce(new Error('closed'));
    await expect(cache.close()).resolves.toBeUndefined();
  });
  it('连接失败向工厂传播', async () => {
    state.client.connect.mockRejectedValueOnce(new Error('offline'));
    await expect(RedisCache.create(options)).rejects.toThrow('offline');
  });
});
