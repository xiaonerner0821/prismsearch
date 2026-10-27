/**
 * 基于 Redis 的缓存实现（分布式共享）
 *
 * redis 是可选依赖：未安装或连接失败时不抛错，由 createCache 回退到其他后端。
 * TTL 交由 Redis 原生过期管理；maxSize 由 Redis 的 maxmemory 策略负责，此处不做淘汰。
 */

import type { CacheProvider, CacheOptions, CacheStats } from './cache-interface.js';
import { getLogger } from '../utils/logger.js';

/** redis 客户端的最小结构（避免编译期强依赖） */
interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  flushDb(): Promise<unknown>;
  exists(key: string): Promise<number>;
  dbSize(): Promise<number>;
  scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<string[]>;
  quit(): Promise<unknown>;
  connect(): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  isOpen?: boolean;
}

export interface RedisCacheOptions {
  url: string;
  password?: string;
  keyPrefix: string;
  ttl: number;
}

export class RedisCache implements CacheProvider {
  readonly backend = 'redis';
  private readonly client: RedisClient;
  private readonly keyPrefix: string;
  private readonly defaultTtl: number;
  private hits = 0;
  private misses = 0;

  private constructor(client: RedisClient, options: RedisCacheOptions) {
    this.client = client;
    this.keyPrefix = options.keyPrefix;
    this.defaultTtl = options.ttl;
  }

  /** 创建并连接；失败时抛错，由工厂回退 */
  static async create(options: RedisCacheOptions): Promise<RedisCache> {
    let createClient: ((opts: { url: string; password?: string }) => RedisClient) | undefined;
    try {
      const mod = (await import('redis')) as unknown as {
        createClient?: (opts: { url: string; password?: string }) => RedisClient;
      };
      createClient = mod.createClient;
    } catch {
      throw new Error('未安装 redis 依赖（npm install redis），无法使用 redis 缓存后端');
    }
    if (!createClient) throw new Error('redis 模块未导出 createClient');

    // redis 的 URL 密码优先于独立参数，显式覆盖时只移除旧密码，保留 ACL 用户名。
    const url = new URL(options.url);
    if (options.password !== undefined) url.password = '';
    const client = createClient({
      url: url.toString(),
      ...(options.password !== undefined ? { password: options.password } : {}),
    });
    client.on('error', (err: unknown) => {
      getLogger().warn('Redis 连接错误', { error: err instanceof Error ? err.message : String(err) });
    });
    await client.connect();
    return new RedisCache(client, options);
  }

  private k(key: string): string {
    return this.keyPrefix + key;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.k(key));
    if (raw === null) {
      this.misses++;
      return null;
    }
    try {
      const value = JSON.parse(raw) as T;
      this.hits++;
      return value;
    } catch {
      this.misses++;
      return null;
    }
  }

  async set<T = unknown>(key: string, value: T, options?: CacheOptions): Promise<void> {
    const ttl = options?.ttl ?? this.defaultTtl;
    if (ttl <= 0) return;
    await this.client.set(this.k(key), JSON.stringify(value), { EX: Math.max(1, Math.ceil(ttl)) });
  }

  async delete(key: string): Promise<boolean> {
    return (await this.client.del(this.k(key))) > 0;
  }

  async clear(): Promise<void> {
    for await (const keys of this.client.scanIterator({ MATCH: `${this.keyPrefix}*`, COUNT: 100 })) {
      if (keys.length > 0) await this.client.del(keys);
    }
    this.hits = 0;
    this.misses = 0;
  }

  async has(key: string): Promise<boolean> {
    return (await this.client.exists(this.k(key))) > 0;
  }

  async stats(): Promise<CacheStats> {
    return { backend: this.backend, size: await this.client.dbSize(), hits: this.hits, misses: this.misses };
  }

  /** TTL 由 Redis 自动管理，无需主动清理 */
  async cleanup(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // 忽略关闭错误
    }
  }
}
