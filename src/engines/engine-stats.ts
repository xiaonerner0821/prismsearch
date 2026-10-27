/**
 * 引擎统计跟踪 + 熔断器
 *
 * 记录搜索历史用于自动选择策略，并内置三态熔断器：
 * - closed（关闭）：正常放行
 * - open（打开）：连续失败达到阈值后熔断，冷却期内拒绝请求
 * - half-open（半开）：冷却期结束后放行一次探测请求；
 *   探测成功 → closed，探测失败 → 重新 open 且冷却时间指数退避（有上限）
 *
 * 旧实现没有半开状态：熔断后选择器再也不会调用该引擎，也就永远无法记录成功，
 * 一次网络抖动即可让引擎在进程生命周期内永久不可用。
 */

import { isPenalizingError, type EngineStatus } from './engine-interface.js';

export type CircuitState = 'closed' | 'open' | 'half-open';
export interface CircuitBreakerOptions {
  /** 连续失败多少次后熔断 */
  failureThreshold: number;
  /** 首次熔断的冷却时间（毫秒） */
  baseCooldownMs: number;
  /** 冷却时间上限（毫秒） */
  maxCooldownMs: number;
}

export const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  baseCooldownMs: 30_000,
  maxCooldownMs: 10 * 60_000,
};

interface HistoryEntry {
  success: boolean;
  latency: number;
  timestamp: number;
}

export class EngineStats {
  private history: HistoryEntry[] = [];
  private readonly maxHistory = 100; // 保留最近100次记录

  private state: CircuitState = 'closed';
  private openedAt = 0;
  private tripCount = 0; // 连续熔断次数，用于冷却时间指数退避
  private probeInFlight = false;
  private lastErrorMessage?: string;

  /** 可注入时钟，便于测试 */
  constructor(
    private readonly options: CircuitBreakerOptions = DEFAULT_CIRCUIT_OPTIONS,
    private readonly now: () => number = Date.now,
  ) {}

  // 记录一次搜索结果
  record(success: boolean, latency: number, error?: unknown): void {
    this.history.push({ success, latency, timestamp: this.now() });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    if (success) {
      this.state = 'closed';
      this.tripCount = 0;
      this.probeInFlight = false;
      return;
    }

    if (error !== undefined) {
      this.lastErrorMessage = error instanceof Error ? error.message : String(error);
    }

    // 4xx（429 除外）/ 主动取消等与引擎健康无关的失败：只记统计，不推进熔断
    if (error !== undefined && !isPenalizingError(error)) {
      // 半开探测名额必须归还，否则探测被取消后引擎会永远卡在 half-open
      this.probeInFlight = false;
      return;
    }

    if (this.state === 'half-open') {
      // 探测失败：重新熔断并延长冷却
      this.trip();
      return;
    }

    if (this.state === 'closed' && this.getConsecutiveFailures() >= this.options.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.tripCount++;
    this.probeInFlight = false;
  }

  /** 当前冷却时长（指数退避，有上限） */
  getCooldownMs(): number {
    const exp = Math.max(0, this.tripCount - 1);
    return Math.min(this.options.baseCooldownMs * 2 ** exp, this.options.maxCooldownMs);
  }

  /** 当前熔断状态（会根据时间推进 open → half-open） */
  getState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.getCooldownMs()) {
      this.state = 'half-open';
      this.probeInFlight = false;
    }
    return this.state;
  }

  /**
   * 是否可用（只读判断，不占用探测名额）。
   * 半开状态下若探测请求尚未发出，视为可用，让选择器有机会选中它。
   */
  isAvailable(): boolean {
    const state = this.getState();
    if (state === 'closed') return true;
    if (state === 'half-open') return !this.probeInFlight;
    return false;
  }

  /**
   * 申请执行一次请求。closed 状态总是允许；half-open 状态只允许一个并发探测。
   * 引擎在真正发请求前调用，返回 false 时应直接视为不可用。
   */
  tryAcquire(): boolean {
    const state = this.getState();
    if (state === 'closed') return true;
    if (state === 'half-open' && !this.probeInFlight) {
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  /** 手动重置（如配置热重载后） */
  reset(): void {
    this.state = 'closed';
    this.tripCount = 0;
    this.probeInFlight = false;
    this.history = [];
    this.lastErrorMessage = undefined;
  }

  // 获取成功率（最近100次）
  getSuccessRate(): number {
    if (this.history.length === 0) return 1; // 无历史记录默认为100%
    const successes = this.history.filter(h => h.success).length;
    return successes / this.history.length;
  }

  // 获取平均延迟（最近100次成功请求）
  getAvgLatency(): number {
    const successful = this.history.filter(h => h.success);
    if (successful.length === 0) return 0;
    const total = successful.reduce((sum, h) => sum + h.latency, 0);
    return total / successful.length;
  }

  // 获取最近使用时间
  getLastUsed(): number | undefined {
    if (this.history.length === 0) return undefined;
    return this.history[this.history.length - 1].timestamp;
  }

  getLastError(): string | undefined {
    return this.lastErrorMessage;
  }

  // 获取最近的连续失败次数
  getConsecutiveFailures(): number {
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (!this.history[i].success) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /** 距离下一次半开探测还有多久（ms）；非 open 状态返回 0 */
  getRetryAfterMs(): number {
    if (this.getState() !== 'open') return 0;
    return Math.max(0, this.getCooldownMs() - (this.now() - this.openedAt));
  }

  /** 按本统计生成 EngineStatus（图片统计与网页统计共用同一套字段） */
  toStatus(name: string, available: boolean, lastError?: string): EngineStatus {
    return {
      name,
      available,
      latency: this.getAvgLatency(),
      successRate: this.getSuccessRate(),
      lastUsed: this.getLastUsed(),
      lastError: lastError ?? this.getLastError(),
    };
  }
}
