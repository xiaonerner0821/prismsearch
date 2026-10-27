/**
 * 进程内 LRU 缓存
 *
 * 使用 Map 的插入顺序实现 O(1) LRU：命中即删除再插入到队尾，
 * 淘汰时从队首取最久未使用的条目。适用于单进程、可接受重启丢缓存的场景，
 * 也是 Redis 不可用时的兜底后端。
 */

import type { CacheProvider, CacheOptions, CacheStats } from './cache-interface.js';

interface Entry {
  value: unknown;
  expiresAt: number;
}

export interface MemoryCacheOptions {
  /** 默认 TTL（秒），0 表示不过期 */
  ttl: number;
  /** 最大条目数 */
  maxSize: number;
  now?: () => number;
}

export class MemoryCache implements CacheProvider {
  readonly backend = 'memory';
  private readonly map = new Map<string, Entry>();
  private readonly defaultTtl: number;
  private readonly maxSize: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;

  constructor(options: MemoryCacheOptions) {
    this.defaultTtl = options.ttl;
    this.maxSize = options.maxSize;
    this.now = options.now ?? Date.now;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.expiresAt !== 0 && entry.expiresAt <= this.now()) {
      this.map.delete(key);
      this.misses++;
      return null;
    }
    // 刷新 LRU 位置
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, options?: CacheOptions): Promise<void> {
    const ttl = options?.ttl ?? this.defaultTtl;
    if (ttl <= 0) return;
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttl * 1000 });
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async clear(): Promise<void> {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  async has(key: string): Promise<boolean> {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== 0 && entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  async stats(): Promise<CacheStats> {
    return { backend: this.backend, size: this.map.size, hits: this.hits, misses: this.misses };
  }

  async cleanup(): Promise<number> {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiresAt !== 0 && entry.expiresAt <= now) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async close(): Promise<void> {
    this.map.clear();
  }
}
