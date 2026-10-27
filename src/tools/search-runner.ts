/**
 * 搜索执行器 — web_search / image_search 共用的降级循环
 *
 * - 按 EngineSelector 给出的候选顺序依次尝试
 * - 熔断器：真正发请求前申请执行名额（half-open 只放行一个探测），熔断中的引擎直接跳过
 * - 引擎级限流（engines[].rateLimit）：被限流的引擎直接跳过，降级到下一个
 * - 上游 429：该引擎进入冷却期（优先用 Retry-After），冷却期内不再打它
 * - 调用方输入错误（ToolInputError / fallback=false）直接抛出，不再降级
 * - 所有候选都被跳过 / 失败时汇总原因
 * - 整体截止时间 + 客户端取消：任何一个触发都会中止当前请求并停止继续尝试
 */

import type { SearchProvider } from '../engines/engine-interface.js';
import { isImageAvailable } from '../engines/engine-registry.js';
import type { EngineConfig } from '../config/config-schema.js';
import { RateLimiter } from '../security/rate-limiter.js';
import { getLogger, redactQuery } from '../utils/logger.js';

/** 上游 429 没给 Retry-After 时的默认冷却时长 */
const DEFAULT_429_COOLDOWN_MS = 60_000;
/** Retry-After 上限，防止对端给出离谱的值让引擎长时间不可用 */
const MAX_429_COOLDOWN_MS = 10 * 60_000;

/** 每个引擎一个滑动窗口限流器，外加上游 429 触发的冷却期 */
export class EngineRateLimiters {
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly cooldowns = new Map<string, number>();

  constructor(
    configs: readonly Pick<EngineConfig, 'name' | 'rateLimit'>[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.update(configs);
  }

  update(configs: readonly Pick<EngineConfig, 'name' | 'rateLimit'>[]): void {
    this.destroy();
    for (const c of configs) {
      this.limiters.set(c.name, new RateLimiter({
        maxRequests: c.rateLimit.maxRequests,
        windowMs: c.rateLimit.windowMs,
      }));
    }
  }

  /** 尝试为引擎消耗一次配额；未配置的引擎恒放行（冷却期除外） */
  tryConsume(engine: string): { allowed: boolean; retryAfter?: number } {
    const until = this.cooldowns.get(engine);
    if (until !== undefined) {
      const remaining = until - this.now();
      if (remaining > 0) return { allowed: false, retryAfter: remaining };
      this.cooldowns.delete(engine);
    }
    const limiter = this.limiters.get(engine);
    if (!limiter) return { allowed: true };
    const r = limiter.consume(engine);
    return { allowed: r.allowed, retryAfter: r.retryAfter };
  }

  /** 上游返回 429 后让该引擎冷却一段时间 */
  coolDown(engine: string, ms: number): void {
    const until = this.now() + Math.min(Math.max(ms, 0), MAX_429_COOLDOWN_MS);
    this.cooldowns.set(engine, Math.max(until, this.cooldowns.get(engine) ?? 0));
  }

  destroy(): void {
    for (const l of this.limiters.values()) l.destroy();
    this.limiters.clear();
    this.cooldowns.clear();
  }
}

export class NoEngineAvailableError extends Error {
  constructor(readonly attempts: Array<{ engine: string; reason: string }>) {
    super(
      attempts.length === 0
        ? '没有可用的搜索引擎'
        : `所有搜索引擎均失败: ${attempts.map(a => `${a.engine}(${a.reason})`).join('; ')}`,
    );
    this.name = 'NoEngineAvailableError';
  }
}

export interface RunSearchOptions<T> {
  candidates: SearchProvider[];
  limiters?: EngineRateLimiters;
  query: string;
  kind: 'web' | 'image';
  signal?: AbortSignal;
  /** 整个降级循环的总时长上限（毫秒）；不设则只受各引擎自身超时约束 */
  deadlineMs?: number;
  /** signal 已合并客户端取消与整体截止时间，引擎应把它传给底层请求 */
  invoke: (engine: SearchProvider, signal?: AbortSignal) => Promise<T>;
  /**
   * 判断结果是否为空。给出时，空结果会再换一个引擎试一次（最多 EMPTY_RESULT_RETRIES 次）：
   * 爬虫引擎的「伪空结果」已由引擎自己抛 EngineParseError，这里兜底的是真无结果页 /
   * API 引擎返回 0 条——换个引擎常常能搜到。都为空时返回第一份空结果，而不是报错。
   */
  isEmpty?: (value: T) => boolean;
  /**
   * 每次真正向某个引擎发起请求前回调（attempt 从 1 开始，跳过的引擎不计）。
   * 用于向客户端报告进度；回调抛错不影响搜索。
   */
  onAttempt?: (engine: string, attempt: number) => void;
}

/** 空结果最多额外换几个引擎重试：真无结果的查询不该把整条降级链打一遍 */
const EMPTY_RESULT_RETRIES = 1;

/** 从错误里取 HTTP 状态码（HttpError.status / *ApiError.statusCode） */
function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const s = (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  return typeof s === 'number' ? s : undefined;
}

/** 从错误里取 Retry-After（毫秒），支持秒数与 HTTP 日期两种写法 */
function retryAfterOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const raw = (error as { retryAfter?: unknown }).retryAfter;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw * 1000;
  if (typeof raw === 'string') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

/**
 * 是否为「与引擎无关的调用方输入错误」：这类错误换引擎也不会成功，降级只会白白消耗配额。
 *
 * 注意上游返回的 HTTP 4xx 不算：爬虫引擎的 403 多半是反爬拦截，API 引擎的 400 常是
 * 该引擎自身的限制（如 CSE 只能取前 100 条），换一个引擎往往就能成功。
 * 上游 4xx 已经不计入熔断（见 EngineStats），这里只拦截明确标注为输入错误的情况。
 */
export function isCallerInputError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { name?: unknown }).name === 'ToolInputError') return true;
  return (error as { fallback?: unknown }).fallback === false;
}

/** 等待 promise，但 signal 触发时立刻放弃（引擎没有正确响应 signal 时也不会卡住整个循环） */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** 合并客户端取消与整体截止时间 */
function combinedSignal(opts: Pick<RunSearchOptions<unknown>, 'signal' | 'deadlineMs'>): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (opts.signal) signals.push(opts.signal);
  if (opts.deadlineMs !== undefined && opts.deadlineMs > 0) signals.push(AbortSignal.timeout(opts.deadlineMs));
  return signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/**
 * 发请求前的准入检查：熔断 → 限流 → 申请执行名额。
 * 不通过时把原因记进 attempts 并返回 false。
 */
function admit(
  engine: SearchProvider,
  opts: Pick<RunSearchOptions<unknown>, 'kind' | 'limiters'>,
  attempts: Array<{ engine: string; reason: string }>,
): boolean {
  // 熔断检查（只读）放在消耗配额之前：熔断中的引擎不应白白占用限流名额
  const available = opts.kind === 'image' ? isImageAvailable(engine) : engine.isAvailable();
  if (!available) {
    attempts.push({ engine: engine.name, reason: 'circuit open' });
    return false;
  }

  const quota = opts.limiters?.tryConsume(engine.name) ?? { allowed: true };
  if (!quota.allowed) {
    attempts.push({ engine: engine.name, reason: `rate limited, retry in ${Math.ceil((quota.retryAfter ?? 0) / 1000)}s` });
    getLogger().debug('引擎被限流，跳过', { engine: engine.name });
    return false;
  }

  // 真正申请执行名额：half-open 只放行一个探测，并发请求到这里会被拒
  if (engine.tryAcquire && !engine.tryAcquire(opts.kind)) {
    attempts.push({ engine: engine.name, reason: 'circuit half-open, probe in flight' });
    return false;
  }
  return true;
}

/** 记录一次引擎失败；上游 429 时让该引擎冷却 */
function recordFailure(
  engine: string,
  error: unknown,
  opts: Pick<RunSearchOptions<unknown>, 'kind' | 'limiters'>,
  attempts: Array<{ engine: string; reason: string }>,
): void {
  const logger = getLogger();
  const reason = error instanceof Error ? error.message : String(error);
  attempts.push({ engine, reason });
  if (statusOf(error) === 429) {
    const cooldown = retryAfterOf(error) ?? DEFAULT_429_COOLDOWN_MS;
    opts.limiters?.coolDown(engine, cooldown);
    logger.warn('引擎返回 429，进入冷却', { engine, cooldownMs: cooldown });
  }
  logger.warn('引擎搜索失败', { kind: opts.kind, engine, error: reason });
}

export interface RunConcurrentOptions<T> extends RunSearchOptions<T> {
  /** 同时查询的引擎数 */
  fanout: number;
}

/**
 * 聚合模式：按候选顺序选出前 fanout 个通过准入检查的引擎并发查询，返回全部成功结果（保持候选顺序）。
 * 某个引擎失败不影响其它引擎；一个都没成功时抛 NoEngineAvailableError。
 * 空结果也算成功（由调用方合并时自然忽略）。
 */
export async function runConcurrent<T>(opts: RunConcurrentOptions<T>): Promise<Array<{ engine: string; value: T }>> {
  const attempts: Array<{ engine: string; reason: string }> = [];
  const signal = combinedSignal(opts);

  const chosen: SearchProvider[] = [];
  for (const engine of opts.candidates) {
    if (chosen.length >= opts.fanout) break;
    if (signal?.aborted) break;
    if (admit(engine, opts, attempts)) chosen.push(engine);
  }

  const settled = await Promise.all(chosen.map(async (engine, i): Promise<{ engine: string; value: T } | undefined> => {
    try {
      opts.onAttempt?.(engine.name, i + 1);
    } catch {
      // 进度通知只是附加信息
    }
    try {
      getLogger().info('执行搜索（聚合）', { kind: opts.kind, engine: engine.name, query: redactQuery(opts.query) });
      const value = await raceAbort(opts.invoke(engine, signal), signal);
      return { engine: engine.name, value };
    } catch (error) {
      if (isCallerInputError(error)) throw error;
      recordFailure(engine.name, error, opts, attempts);
      return undefined;
    }
  }));

  const ok = settled.filter((s): s is { engine: string; value: T } => s !== undefined);
  if (ok.length === 0) throw new NoEngineAvailableError(attempts);
  return ok;
}

export async function runWithFallback<T>(opts: RunSearchOptions<T>): Promise<{
  engine: string;
  value: T;
  /** 成功之前被跳过 / 失败的引擎及原因（用于向调用方说明为什么换了引擎） */
  attempts: Array<{ engine: string; reason: string }>;
}> {
  const logger = getLogger();
  const attempts: Array<{ engine: string; reason: string }> = [];
  const signal = combinedSignal(opts);

  // 第一份空结果：后续引擎都失败 / 也为空时返回它
  let firstEmpty: { engine: string; value: T } | undefined;
  let emptyRetriesLeft = EMPTY_RESULT_RETRIES;
  let attemptNo = 0;

  for (const engine of opts.candidates) {
    if (firstEmpty && emptyRetriesLeft <= 0) break;
    if (signal?.aborted) {
      const timedOut = !opts.signal?.aborted;
      attempts.push({ engine: engine.name, reason: timedOut ? `deadline exceeded (${opts.deadlineMs}ms)` : 'cancelled' });
      break;
    }

    if (!admit(engine, opts, attempts)) continue;

    if (firstEmpty) emptyRetriesLeft--;
    attemptNo++;
    try {
      opts.onAttempt?.(engine.name, attemptNo);
    } catch {
      // 进度通知只是附加信息
    }
    try {
      logger.info('执行搜索', { kind: opts.kind, engine: engine.name, query: redactQuery(opts.query) });
      const value = await raceAbort(opts.invoke(engine, signal), signal);
      if (opts.isEmpty?.(value)) {
        attempts.push({ engine: engine.name, reason: 'empty result' });
        logger.info('引擎返回空结果，换一个引擎再试', { kind: opts.kind, engine: engine.name });
        firstEmpty ??= { engine: engine.name, value };
        continue;
      }
      return { engine: engine.name, value, attempts };
    } catch (error) {
      // 调用方参数本身有问题：换哪个引擎都一样，直接返回，不再降级
      if (isCallerInputError(error)) throw error;
      recordFailure(engine.name, error, opts, attempts);
    }
  }

  if (firstEmpty) return { ...firstEmpty, attempts };
  throw new NoEngineAvailableError(attempts);
}

/**
 * 用户指定了引擎、实际却由别的引擎返回时的提示：降级是为了可用性，
 * 但不说明的话调用方会以为拿到的是指定引擎的结果
 */
export function fallbackWarning(
  requested: string | undefined,
  actual: string,
  attempts: ReadonlyArray<{ engine: string; reason: string }>,
): string | undefined {
  if (!requested || requested === actual) return undefined;
  const reason = attempts.find(a => a.engine === requested)?.reason;
  const brief = reason ? `（${reason.split('\n')[0].slice(0, 160)}）` : '';
  return `指定的引擎 ${requested} 不可用${brief}，已降级到 ${actual}`;
}
