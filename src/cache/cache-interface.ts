/**
 * 缓存抽象接口
 *
 * 实现：SqliteCache（文件持久化）、MemoryCache（进程内 LRU）、RedisCache（分布式共享）。
 * 由 createCache() 按 cache.backend 配置选择。
 */

// 缓存选项
export interface CacheOptions {
  /** 缓存时间（秒），覆盖默认 TTL；<= 0 表示不缓存 */
  ttl?: number;
}

export interface CacheStats {
  backend: string;
  size: number;
  hits: number;
  misses: number;
}

// 缓存提供者接口
export interface CacheProvider {
  /** 后端名称：sqlite / memory / redis */
  readonly backend: string;

  /** 获取缓存，不存在或过期返回 null */
  get<T = unknown>(key: string): Promise<T | null>;

  /** 设置缓存 */
  set<T = unknown>(key: string, value: T, options?: CacheOptions): Promise<void>;

  /** 删除指定缓存 */
  delete(key: string): Promise<boolean>;

  /** 清空所有缓存 */
  clear(): Promise<void>;

  /** 检查缓存是否存在且未过期 */
  has(key: string): Promise<boolean>;

  /** 统计信息 */
  stats(): Promise<CacheStats>;

  /** 清理过期缓存，返回清理数量 */
  cleanup(): Promise<number>;

  /** 关闭连接 / 释放资源 */
  close(): Promise<void>;
}
