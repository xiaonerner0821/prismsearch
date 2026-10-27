import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteCache } from '../../src/cache/sqlite-cache.js';

// 使用临时目录，避免在仓库里留下 test-cache.db（旧测试写 ./data/，污染工作树）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismsearch-cache-'));
const TEST_DB_PATH = path.join(tmpDir, 'test-cache.db');

/** 可注入时钟：让 TTL / 过期逻辑不依赖真实等待 */
function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('SqliteCache', () => {
  let cache: SqliteCache;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock();
    cache = new SqliteCache({ path: TEST_DB_PATH, ttl: 60, maxSize: 100, now: clock.now });
  });

  afterEach(async () => {
    await cache.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(TEST_DB_PATH + suffix);
      } catch {
        // 文件不存在时忽略
      }
    }
  });

  it('set和get基本操作', async () => {
    await cache.set('key1', { data: 'hello' });
    expect(await cache.get<{ data: string }>('key1')).toEqual({ data: 'hello' });
  });

  it('get不存在的key返回null', async () => {
    expect(await cache.get('nonexistent')).toBeNull();
  });

  it('过期数据返回null', async () => {
    await cache.set('expiring', 'value', { ttl: 1 });
    expect(await cache.get('expiring')).toBe('value');
    clock.advance(1_100);
    expect(await cache.get('expiring')).toBeNull();
  });

  it('ttl<=0 表示不写入缓存', async () => {
    await cache.set('skipped', 'value', { ttl: 0 });
    expect(await cache.get('skipped')).toBeNull();
    expect((await cache.stats()).size).toBe(0);
  });

  it('delete删除缓存', async () => {
    await cache.set('key1', 'value1');
    expect(await cache.delete('key1')).toBe(true);
    expect(await cache.get('key1')).toBeNull();
  });

  it('delete不存在的key返回false', async () => {
    expect(await cache.delete('nonexistent')).toBe(false);
  });

  it('has检查存在性', async () => {
    await cache.set('key1', 'value1');
    expect(await cache.has('key1')).toBe(true);
    expect(await cache.has('nonexistent')).toBe(false);
  });

  it('has 对已过期条目返回 false', async () => {
    await cache.set('key1', 'v', { ttl: 1 });
    clock.advance(1_100);
    expect(await cache.has('key1')).toBe(false);
  });

  it('clear清空所有缓存', async () => {
    await cache.set('key1', 'v1');
    await cache.set('key2', 'v2');
    await cache.clear();
    expect(await cache.get('key1')).toBeNull();
    expect(await cache.get('key2')).toBeNull();
    expect((await cache.stats()).size).toBe(0);
  });

  it('stats返回统计信息', async () => {
    await cache.set('key1', 'v1');
    await cache.get('key1'); // hit
    await cache.get('nonexistent'); // miss

    const stats = await cache.stats();
    expect(stats.backend).toBe('sqlite');
    expect(stats.size).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it('cleanup清理过期数据', async () => {
    await cache.set('old', 'value', { ttl: 1 });
    await cache.set('fresh', 'value', { ttl: 3600 });
    clock.advance(1_100);
    expect(await cache.cleanup()).toBe(1);
    expect(await cache.has('fresh')).toBe(true);
  });

  it('maxSize超限时按访问顺序淘汰最久未使用的条目（LRU）', async () => {
    const small = new SqliteCache({ path: TEST_DB_PATH, ttl: 3600, maxSize: 3, now: clock.now });
    await small.set('a', 1);
    await small.set('b', 2);
    await small.set('c', 3);
    // 访问 a，使其成为最近使用
    clock.advance(10);
    expect(await small.get('a')).toBe(1);
    clock.advance(10);
    await small.set('d', 4); // 触发淘汰：应淘汰 b（最久未访问），而不是 a

    expect(await small.get('a')).toBe(1);
    expect(await small.get('b')).toBeNull();
    expect((await small.stats()).size).toBeLessThanOrEqual(3);
    await small.close();
  });

  it(':memory: 模式可直接使用', async () => {
    const mem = new SqliteCache({ path: ':memory:', ttl: 60, maxSize: 10 });
    await mem.set('k', 'v');
    expect(await mem.get('k')).toBe('v');
    await mem.close();
  });

  it('多个进程共用库文件：淘汰前用 COUNT(*) 校准，不会多删', async () => {
    const a = new SqliteCache({ path: TEST_DB_PATH, ttl: 3600, maxSize: 3, now: clock.now });
    const b = new SqliteCache({ path: TEST_DB_PATH, ttl: 3600, maxSize: 3, now: clock.now });
    await a.set('a1', 1);
    await a.set('a2', 2);
    await a.set('a3', 3);
    // b 删掉了两条，a 的内存计数仍以为有 3 条
    await b.delete('a1');
    await b.delete('a2');
    clock.advance(10);
    await a.set('a4', 4); // a 计数到 4 > 3，但真实只有 2 条：不该淘汰任何条目
    expect(await a.get('a3')).toBe(3);
    expect(await a.get('a4')).toBe(4);
    expect((await a.stats()).size).toBe(2);
    await a.close();
    await b.close();
  });

  it('cleanup 与 stats 用真实行数校准计数', async () => {
    const a = new SqliteCache({ path: TEST_DB_PATH, ttl: 3600, maxSize: 100, now: clock.now });
    const b = new SqliteCache({ path: TEST_DB_PATH, ttl: 3600, maxSize: 100, now: clock.now });
    await b.set('x', 1);
    await b.set('y', 2);
    expect(await a.cleanup()).toBe(0);
    expect((await a.stats()).size).toBe(2);
    await a.close();
    await b.close();
  });
});
