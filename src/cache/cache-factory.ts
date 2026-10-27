/**
 * 缓存工厂：按 cache.backend 创建缓存后端，并管理定时过期清理。
 *
 * - sqlite：文件持久化（默认，路径默认 ~/.prismsearch/cache.db）
 * - memory：进程内 LRU
 * - redis：分布式共享；redis 依赖缺失或连接失败时回退到 memory 并记录警告，
 *   不会因为缓存不可用导致整个服务起不来
 *
 * 旧实现的 cleanup() 从未被调用，过期数据只在读取时惰性删除；
 * 这里用 unref 的定时器周期清理，不阻止进程退出。
 */

import type { CacheConfig } from '../config/config-schema.js';
import type { CacheProvider } from './cache-interface.js';
import { MemoryCache } from './memory-cache.js';
import { SqliteCache } from './sqlite-cache.js';
import { RedisCache } from './redis-cache.js';
import { getLogger } from '../utils/logger.js';

export interface ManagedCache {
  cache: CacheProvider;
  /** 停止定时清理并关闭后端 */
  close(): Promise<void>;
}

async function createBackend(config: CacheConfig): Promise<CacheProvider> {
  const logger = getLogger();
  switch (config.backend) {
    case 'memory':
      return new MemoryCache({ ttl: config.ttl, maxSize: config.maxSize });

    case 'redis':
      try {
        return await RedisCache.create({
          url: config.redis.url,
          password: config.redis.password,
          keyPrefix: config.redis.keyPrefix,
          ttl: config.ttl,
        });
      } catch (error) {
        logger.warn('Redis 缓存不可用，回退到内存缓存', {
          error: error instanceof Error ? error.message : String(error),
        });
        return new MemoryCache({ ttl: config.ttl, maxSize: config.maxSize });
      }

    case 'sqlite':
    default: {
      const path = config.sqlite.path;
      if (!path) throw new Error('cache.sqlite.path 未解析（应由配置加载器填充默认值）');
      return new SqliteCache({ path, ttl: config.ttl, maxSize: config.maxSize });
    }
  }
}

/** 创建缓存并启动定时清理 */
export async function createCache(config: CacheConfig): Promise<ManagedCache> {
  const cache = await createBackend(config);
  const logger = getLogger();

  const timer = setInterval(() => {
    cache
      .cleanup()
      .then(removed => {
        if (removed > 0) logger.debug('已清理过期缓存', { removed, backend: cache.backend });
      })
      .catch(error => {
        logger.warn('清理过期缓存失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, config.cleanupInterval * 1000);
  timer.unref?.();

  let closed = false;
  return {
    cache,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await cache.close();
    },
  };
}
