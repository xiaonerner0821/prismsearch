/**
 * 基于 better-sqlite3 的缓存实现
 *
 * 相比旧实现：
 * - 真正的 LRU：新增 accessed_at 列，get 命中时刷新，淘汰按 accessed_at 升序
 *   （旧实现按 created_at 淘汰，实为 FIFO，与文档宣称的 LRU 不符）
 * - 预编译语句复用；条目数在内存中维护，不再每次 set 都 COUNT(*)
 * - 旧库自动迁移（补列 + 建索引）
 * - 目录创建失败时给出明确错误（常见于 MCP 客户端以 / 或 System32 为 cwd 启动）
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { CacheProvider, CacheOptions, CacheStats } from './cache-interface.js';

export interface SqliteCacheOptions {
  path: string;
  /** 默认 TTL（秒） */
  ttl: number;
  /** 最大条目数 */
  maxSize: number;
  /** 可注入时钟，便于测试 */
  now?: () => number;
}

export class SqliteCache implements CacheProvider {
  readonly backend = 'sqlite';
  private readonly db: Database.Database;
  private readonly defaultTtl: number;
  private readonly maxSize: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private size: number;
  private closed = false;

  private readonly stmt: {
    get: Database.Statement<[string], { value: string; expires_at: number }>;
    touch: Database.Statement<[number, string]>;
    upsert: Database.Statement<[string, string, number, number, number]>;
    exists: Database.Statement<[string], { expires_at: number }>;
    del: Database.Statement<[string]>;
    count: Database.Statement<[], { count: number }>;
    evict: Database.Statement<[number]>;
    cleanup: Database.Statement<[number]>;
    clear: Database.Statement<[]>;
  };

  constructor(options: SqliteCacheOptions) {
    this.defaultTtl = options.ttl;
    this.maxSize = options.maxSize;
    this.now = options.now ?? Date.now;

    if (options.path !== ':memory:') {
      const dir = path.dirname(options.path);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(
          `无法创建缓存目录 ${dir}：${msg}。请通过 cache.sqlite.path 或 PRISMSEARCH_HOME 指定可写位置，或改用 cache.backend: memory`,
          { cause: error },
        );
      }
    }

    this.db = new Database(options.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    // 迁移：旧库没有 accessed_at 列
    const columns = this.db.prepare('PRAGMA table_info(cache)').all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === 'accessed_at')) {
      this.db.exec('ALTER TABLE cache ADD COLUMN accessed_at INTEGER NOT NULL DEFAULT 0');
      this.db.exec('UPDATE cache SET accessed_at = created_at');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_cache_expires_at ON cache(expires_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_cache_accessed_at ON cache(accessed_at)');

    this.stmt = {
      get: this.db.prepare('SELECT value, expires_at FROM cache WHERE key = ?'),
      touch: this.db.prepare('UPDATE cache SET accessed_at = ? WHERE key = ?'),
      upsert: this.db.prepare(
        `INSERT INTO cache (key, value, created_at, expires_at, accessed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at,
           expires_at = excluded.expires_at, accessed_at = excluded.accessed_at`,
      ),
      exists: this.db.prepare('SELECT expires_at FROM cache WHERE key = ?'),
      del: this.db.prepare('DELETE FROM cache WHERE key = ?'),
      count: this.db.prepare('SELECT COUNT(*) AS count FROM cache'),
      evict: this.db.prepare(
        'DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY accessed_at ASC LIMIT ?)',
      ),
      cleanup: this.db.prepare('DELETE FROM cache WHERE expires_at <= ?'),
      clear: this.db.prepare('DELETE FROM cache'),
    };

    this.size = this.stmt.count.get()?.count ?? 0;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const now = this.now();
    const row = this.stmt.get.get(key);
    if (!row) {
      this.misses++;
      return null;
    }
    if (row.expires_at <= now) {
      if (this.stmt.del.run(key).changes > 0) this.size = Math.max(0, this.size - 1);
      this.misses++;
      return null;
    }
    try {
      const value = JSON.parse(row.value) as T;
      this.stmt.touch.run(now, key);
      this.hits++;
      return value;
    } catch {
      // 损坏的条目直接删除
      if (this.stmt.del.run(key).changes > 0) this.size = Math.max(0, this.size - 1);
      this.misses++;
      return null;
    }
  }

  async set<T = unknown>(key: string, value: T, options?: CacheOptions): Promise<void> {
    const ttlSeconds = options?.ttl ?? this.defaultTtl;
    if (ttlSeconds <= 0) return;
    const now = this.now();
    const existed = this.stmt.exists.get(key) !== undefined;
    this.stmt.upsert.run(key, JSON.stringify(value), now, now + ttlSeconds * 1000, now);
    if (!existed) this.size++;

    if (this.size > this.maxSize) {
      // 内存计数只反映本进程的写入：多个进程共用同一个库文件时会漂移，
      // 淘汰前先用 COUNT(*) 校准，避免多删（别的进程已经删过）或少删（别的进程写入了）
      this.recount();
      if (this.size <= this.maxSize) return;
      // 先清过期，再按 LRU 淘汰
      this.stmt.cleanup.run(now);
      this.recount();
      if (this.size > this.maxSize) {
        this.stmt.evict.run(this.size - this.maxSize);
        this.recount();
      }
    }
  }

  /** 用库里的真实行数校准内存计数 */
  private recount(): void {
    this.size = this.stmt.count.get()?.count ?? 0;
  }

  async delete(key: string): Promise<boolean> {
    const changed = this.stmt.del.run(key).changes > 0;
    if (changed) this.size = Math.max(0, this.size - 1);
    return changed;
  }

  async clear(): Promise<void> {
    this.stmt.clear.run();
    this.size = 0;
    this.hits = 0;
    this.misses = 0;
  }

  async has(key: string): Promise<boolean> {
    const row = this.stmt.exists.get(key);
    return !!row && row.expires_at > this.now();
  }

  async stats(): Promise<CacheStats> {
    if (!this.closed) this.recount();
    return { backend: this.backend, size: this.size, hits: this.hits, misses: this.misses };
  }

  async cleanup(): Promise<number> {
    if (this.closed) return 0;
    const removed = this.stmt.cleanup.run(this.now()).changes;
    // 定期清理顺带校准计数（其它进程的写入 / 删除也会反映进来）
    this.recount();
    return removed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
