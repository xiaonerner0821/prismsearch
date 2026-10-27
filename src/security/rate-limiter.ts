/**
 * 速率限制器（滑动窗口算法）
 *
 * - enabled=false 或 maxRequests=0 时恒放行（security.rateLimit.enabled 与引擎级 maxRequests: 0 均据此生效）
 * - 按 key 分桶：全局限流用固定 key，按客户端限流用「凭证指纹 / 客户端地址」作 key
 * - 桶数量设上限（maxKeys），超出时淘汰最久未活动的桶，防止按客户端分桶时被刷爆内存
 * - 可注入时钟，便于测试
 */

export interface RateLimiterOptions {
  maxRequests: number;  // 窗口内最大请求数；0 表示不限制
  windowMs: number;     // 时间窗口(毫秒)
  enabled?: boolean;    // 默认 true
  maxKeys?: number;     // 最多保留的分桶数，默认 10000
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;     // 是否允许
  remaining: number;    // 剩余次数
  resetAt: number;      // 窗口重置时间戳
  retryAfter?: number;  // 需要等待的毫秒数（被限制时）
}

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly enabled: boolean;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, number[]>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: RateLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.enabled = (options.enabled ?? true) && options.maxRequests > 0;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;

    // 定期清理不活跃的 key；unref 允许进程正常退出
    this.cleanupTimer = setInterval(() => this.cleanupInactive(), Math.max(this.windowMs, 60_000));
    this.cleanupTimer.unref?.();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private unlimited(now: number): RateLimitResult {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetAt: now };
  }

  // 检查是否允许（不消耗配额）
  check(key: string): RateLimitResult {
    const now = this.now();
    if (!this.enabled) return this.unlimited(now);
    const timestamps = this.getActiveTimestamps(key, now, false);
    const resetAt = timestamps.length > 0 ? timestamps[0] + this.windowMs : now + this.windowMs;
    if (timestamps.length >= this.maxRequests) {
      return { allowed: false, remaining: 0, resetAt, retryAfter: Math.max(0, resetAt - now) };
    }
    return { allowed: true, remaining: this.maxRequests - timestamps.length, resetAt };
  }

  // 消耗一次配额
  consume(key: string): RateLimitResult {
    const now = this.now();
    if (!this.enabled) return this.unlimited(now);
    const timestamps = this.getActiveTimestamps(key, now, true);

    if (timestamps.length >= this.maxRequests) {
      const resetAt = timestamps[0] + this.windowMs;
      return { allowed: false, remaining: 0, resetAt, retryAfter: Math.max(0, resetAt - now) };
    }

    timestamps.push(now);
    // 重新插入以刷新「最近活动」顺序
    this.windows.delete(key);
    this.windows.set(key, timestamps);
    this.enforceKeyLimit();

    return {
      allowed: true,
      remaining: this.maxRequests - timestamps.length,
      resetAt: timestamps[0] + this.windowMs,
    };
  }

  // 重置指定 key
  reset(key: string): void {
    this.windows.delete(key);
  }

  // 重置所有
  resetAll(): void {
    this.windows.clear();
  }

  // 销毁定时器
  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.windows.clear();
  }

  /** 当前分桶数（测试 / 监控用） */
  keyCount(): number {
    return this.windows.size;
  }

  // 获取窗口内有效的时间戳列表
  private getActiveTimestamps(key: string, now: number, store: boolean): number[] {
    const timestamps = this.windows.get(key);
    if (!timestamps) return [];
    const windowStart = now - this.windowMs;
    const active = timestamps.filter(t => t > windowStart);
    if (active.length === 0) {
      this.windows.delete(key);
    } else if (store) {
      this.windows.set(key, active);
    }
    return active;
  }

  // 超过上限时淘汰最久未活动的分桶（Map 按插入顺序，队首即最旧）
  private enforceKeyLimit(): void {
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }

  // 清理长期不活跃的 key
  private cleanupInactive(): void {
    const windowStart = this.now() - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      if (timestamps.every(t => t <= windowStart)) this.windows.delete(key);
    }
  }
}
