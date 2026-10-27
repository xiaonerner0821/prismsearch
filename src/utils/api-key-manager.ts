/**
 * API Key 管理器 — 多 Key 轮换、失败退避、配额跟踪
 *
 * 相比旧实现：
 * - 只有**鉴权 / 配额类**错误（401、403、429 及对应错误码）才计入失败。
 *   旧实现对任何异常都累计失败，网络抖动或 5xx 也会把 Key 永久禁用
 * - 禁用改为带冷却的退避：冷却到期自动恢复（指数退避，上限 10 分钟），
 *   不再需要人工或定时任务调用 restoreAll()
 * - 新增 hasUsableKey()：旧实现在所有 Key 都被禁用后仍返回 true，导致引擎被选中后立刻因无 Key 失败
 * - 全部 Key 处于冷却时，getKey() 返回冷却最早结束的那个（宁可试一次也不直接失败），
 *   并给出下次可用的最早时间供上层决定是否跳过该引擎
 * - Key 只以哈希前缀出现在统计中
 */

import { createHash } from 'node:crypto';

const DEFAULT_QUOTA_WINDOW_MS = 60_000;
/** 连续失败多少次后进入冷却 */
const FAILURE_THRESHOLD = 3;
const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 600_000;

/** 判定为「Key 自身有问题」的状态码；其他错误不应影响 Key 可用性 */
const KEY_RELATED_STATUS = new Set([401, 403, 429]);
/** 判定为「Key 自身有问题」的错误码（undici / node 常见形式） */
const KEY_RELATED_CODES = new Set([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'INVALID_API_KEY',
]);

interface ApiKeyEntry {
  key: string;
  /** 累计成功使用次数（用于负载均衡） */
  usage: number;
  lastUsed: number;
  /** 连续鉴权/配额类失败次数（冷却到期后清零） */
  failures: number;
  /** 累计进入冷却的次数（只有成功使用才清零），用于指数退避升级 */
  strikes: number;
  /** 冷却结束时间戳；0 表示可用 */
  cooldownUntil: number;
  /** 配额窗口内已用次数 */
  quotaUsed: number;
  quotaResetAt: number;
  quotaLimit?: number;
}

export interface ApiKeyManagerOptions {
  quotaWindowMs?: number;
  now?: () => number;
}

/** 判断一个错误是否属于「换 Key 可能解决」的类型 */
export function isKeyRelatedError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error === 'object') {
    const status = (error as { status?: unknown; statusCode?: unknown }).status
      ?? (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && KEY_RELATED_STATUS.has(status)) return true;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && KEY_RELATED_CODES.has(code)) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|403|429)\b|unauthori[sz]ed|forbidden|rate.?limit|quota|invalid.?(api.?)?key/i.test(message);
}

export class ApiKeyManager {
  private readonly engineName: string;
  private readonly quotaWindowMs: number;
  private readonly now: () => number;
  private readonly keys = new Map<string, ApiKeyEntry>();

  constructor(engineName: string, options: ApiKeyManagerOptions = {}) {
    this.engineName = engineName;
    this.quotaWindowMs = options.quotaWindowMs ?? DEFAULT_QUOTA_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  addKey(key: string, quotaLimit?: number): void {
    const trimmed = key.trim();
    if (!trimmed || this.keys.has(trimmed)) return;
    this.keys.set(trimmed, {
      key: trimmed,
      usage: 0,
      lastUsed: 0,
      failures: 0,
      strikes: 0,
      cooldownUntil: 0,
      quotaUsed: 0,
      quotaResetAt: this.now() + this.quotaWindowMs,
      quotaLimit,
    });
  }

  addKeys(keys: string[], quotaLimit?: number): void {
    for (const key of keys) this.addKey(key, quotaLimit);
  }

  /** 从逗号分隔字符串批量添加 */
  addKeysFromString(value: string | undefined, quotaLimit?: number): void {
    if (!value) return;
    this.addKeys(value.split(',').map(k => k.trim()).filter(Boolean), quotaLimit);
  }

  removeKey(key: string): void {
    this.keys.delete(key);
  }

  private refreshEntry(entry: ApiKeyEntry): void {
    const now = this.now();
    if (entry.quotaResetAt <= now) {
      entry.quotaUsed = 0;
      entry.quotaResetAt = now + this.quotaWindowMs;
    }
    // 冷却到期自动恢复
    if (entry.cooldownUntil !== 0 && entry.cooldownUntil <= now) {
      entry.cooldownUntil = 0;
      entry.failures = 0;
    }
  }

  private isUsable(entry: ApiKeyEntry): boolean {
    this.refreshEntry(entry);
    if (entry.cooldownUntil !== 0) return false;
    if (entry.quotaLimit !== undefined && entry.quotaUsed >= entry.quotaLimit) return false;
    return true;
  }

  /** 是否至少有一个当前可用的 Key */
  hasUsableKey(): boolean {
    for (const entry of this.keys.values()) {
      if (this.isUsable(entry)) return true;
    }
    return false;
  }

  /**
   * 取得下一个可用 Key（成功次数最少者优先，均衡使用）。
   * 全部处于冷却 / 配额耗尽时返回 undefined —— 此时应跳过该引擎而不是换 Key 硬试。
   */
  getKey(): string | undefined {
    this.refreshAll();
    let best: ApiKeyEntry | undefined;
    for (const entry of this.keys.values()) {
      if (!this.isUsable(entry)) continue;
      if (!best || entry.usage < best.usage) best = entry;
    }
    if (!best) return undefined;
    best.usage++;
    best.quotaUsed++;
    best.lastUsed = this.now();
    return best.key;
  }

  /** 最早恢复可用的时间戳；全部可用时返回 0 */
  nextAvailableAt(): number {
    let earliest = 0;
    for (const entry of this.keys.values()) {
      this.refreshEntry(entry);
      if (this.isUsable(entry)) return 0;
      const candidate = entry.cooldownUntil || this.now() + this.quotaWindowMs;
      if (earliest === 0 || candidate < earliest) earliest = candidate;
    }
    return earliest;
  }

  reportSuccess(key: string): void {
    const entry = this.keys.get(key);
    if (!entry) return;
    entry.failures = 0;
    entry.strikes = 0;
    entry.cooldownUntil = 0;
  }

  /**
   * 上报失败。只有鉴权 / 配额类错误才累计；
   * 达到阈值后进入指数退避冷却（1min → 2min → … 上限 10min）。
   */
  reportFailure(key: string, error?: unknown): void {
    const entry = this.keys.get(key);
    if (!entry) return;
    if (error !== undefined && !isKeyRelatedError(error)) {
      // 网络、5xx、解析错误与 Key 无关，不惩罚
      return;
    }
    entry.failures++;
    if (entry.failures >= FAILURE_THRESHOLD) {
      // 用累计 strikes 升级退避：failures 会随冷却到期清零，只看它会让退避永远停在第一档
      const exponent = Math.min(entry.strikes, 4);
      const cooldown = Math.min(BASE_COOLDOWN_MS * 2 ** exponent, MAX_COOLDOWN_MS);
      entry.cooldownUntil = this.now() + cooldown;
      entry.strikes++;
      entry.failures = 0;
    }
  }

  /** 立即恢复所有 Key（管理接口 / 配置热重载用） */
  restoreAll(): void {
    for (const entry of this.keys.values()) {
      entry.cooldownUntil = 0;
      entry.failures = 0;
      entry.strikes = 0;
    }
  }

  /** 统计信息（Key 脱敏） */
  getStats(): Array<{
    key: string;
    usage: number;
    failures: number;
    available: boolean;
    cooldownUntil: number;
    quotaUsed: number;
    quotaLimit?: number;
  }> {
    return Array.from(this.keys.values()).map(entry => ({
      key: `${createHash('sha256').update(entry.key).digest('hex').slice(0, 4)}****`,
      usage: entry.usage,
      failures: entry.failures,
      available: this.isUsable(entry),
      cooldownUntil: entry.cooldownUntil,
      quotaUsed: entry.quotaUsed,
      quotaLimit: entry.quotaLimit,
    }));
  }

  /** 热更新 Key 列表：新增缺失的，移除不在列表中的，保留既有状态 */
  refreshKeys(keys: string[], quotaLimit?: number): void {
    const wanted = new Set(keys.map(k => k.trim()).filter(Boolean));
    for (const existing of this.keys.keys()) {
      if (!wanted.has(existing)) this.keys.delete(existing);
    }
    for (const key of wanted) this.addKey(key, quotaLimit);
  }

  get size(): number {
    return this.keys.size;
  }

  get name(): string {
    return this.engineName;
  }

  private refreshAll(): void {
    for (const entry of this.keys.values()) this.refreshEntry(entry);
  }
}

// 全局注册表 — 按引擎名管理
const managers = new Map<string, ApiKeyManager>();

export function getApiKeyManager(engineName: string): ApiKeyManager {
  let manager = managers.get(engineName);
  if (!manager) {
    manager = new ApiKeyManager(engineName);
    managers.set(engineName, manager);
  }
  return manager;
}

/** 重置注册表（配置热重载 / 测试用） */
export function resetApiKeyManagers(): void {
  managers.clear();
}
