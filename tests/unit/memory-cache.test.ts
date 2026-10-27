/**
 * MemoryCache 单元测试（注入时钟）
 */

import { describe, it, expect } from 'vitest';
import { MemoryCache } from '../../src/cache/memory-cache.js';

function makeCache(overrides: { ttl?: number; maxSize?: number } = {}) {
  let now = 0;
  const cache = new MemoryCache({
    ttl: overrides.ttl ?? 60,
    maxSize: overrides.maxSize ?? 3,
    now: () => now,
  });
  return { cache, advance: (ms: number) => { now += ms; } };
}

describe('MemoryCache 基本读写', () => {
  it('set 后 get 能取回值，并记录命中/未命中', async () => {
    const { cache } = makeCache();
    await cache.set('a', { v: 1 });
    expect(await cache.get('a')).toEqual({ v: 1 });
    expect(await cache.get('missing')).toBeNull();

    const stats = await cache.stats();
    expect(stats).toMatchObject({ backend: 'memory', size: 1, hits: 1, misses: 1 });
  });

  it('has 反映键存在与否', async () => {
    const { cache } = makeCache();
    await cache.set('a', 1);
    expect(await cache.has('a')).toBe(true);
    expect(await cache.has('b')).toBe(false);
  });

  it('delete 返回是否真的删除了', async () => {
    const { cache } = makeCache();
    await cache.set('a', 1);
    expect(await cache.delete('a')).toBe(true);
    expect(await cache.delete('a')).toBe(false);
  });

  it('clear 清空条目与统计', async () => {
    const { cache } = makeCache();
    await cache.set('a', 1);
    await cache.get('a');
    await cache.clear();
    expect(await cache.get('a')).toBeNull();
    expect((await cache.stats()).hits).toBe(0);
  });
});

describe('MemoryCache 过期', () => {
  it('到达 TTL 后 get 返回 null 并从 map 中移除', async () => {
    const { cache, advance } = makeCache({ ttl: 1 });
    await cache.set('a', 1);
    advance(999);
    expect(await cache.get('a')).toBe(1);
    advance(1);
    expect(await cache.get('a')).toBeNull();
    expect((await cache.stats()).size).toBe(0);
  });

  it('过期键的 has 返回 false', async () => {
    const { cache, advance } = makeCache({ ttl: 1 });
    await cache.set('a', 1);
    advance(1000);
    expect(await cache.has('a')).toBe(false);
  });

  it('ttl <= 0 表示不缓存', async () => {
    const { cache } = makeCache({ ttl: 0 });
    await cache.set('a', 1);
    expect(await cache.get('a')).toBeNull();
  });

  it('单次 set 的 ttl 覆盖默认值', async () => {
    const { cache, advance } = makeCache({ ttl: 60 });
    await cache.set('short', 1, { ttl: 1 });
    await cache.set('long', 2);
    advance(2000);
    expect(await cache.get('short')).toBeNull();
    expect(await cache.get('long')).toBe(2);
  });

  it('cleanup 只清理过期条目并返回数量', async () => {
    const { cache, advance } = makeCache({ ttl: 60 });
    await cache.set('old', 1, { ttl: 1 });
    await cache.set('keep', 2);
    advance(2000);
    expect(await cache.cleanup()).toBe(1);
    expect((await cache.stats()).size).toBe(1);
  });
});

describe('MemoryCache LRU 淘汰', () => {
  it('超过 maxSize 时淘汰最久未使用的条目', async () => {
    const { cache } = makeCache({ maxSize: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    // 访问 a 刷新其位置，b 成为最久未使用
    await cache.get('a');
    await cache.set('c', 3);

    expect(await cache.get('a')).toBe(1);
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('c')).toBe(3);
  });

  it('重复 set 同一键不会导致自我淘汰', async () => {
    const { cache } = makeCache({ maxSize: 1 });
    await cache.set('a', 1);
    await cache.set('a', 2);
    expect(await cache.get('a')).toBe(2);
    expect((await cache.stats()).size).toBe(1);
  });
});

describe('MemoryCache 关闭', () => {
  it('close 清空所有条目', async () => {
    const { cache } = makeCache();
    await cache.set('a', 1);
    await cache.close();
    expect((await cache.stats()).size).toBe(0);
  });
});
