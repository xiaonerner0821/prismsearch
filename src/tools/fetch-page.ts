/**
 * fetch_page 工具 — 抓取指定 URL 的网页内容
 *
 * 安全链路：
 * 1. 预检：协议 / 黑白名单 / DNS 解析结果（SsrfGuard.validateUrl）
 * 2. 建连时：HTTP 抓取经 SsrfGuard 的 undici 调度器，按实际连接 IP 再校验（防 DNS 重绑定）
 * 3. 重定向：逐跳校验（manual-checked）
 * 4. 浏览器：page.route 拦截每个请求逐一校验
 * 5. 内容过滤：off / warn / block
 *
 * 抓取路由：
 * - workers.enabled 且（useFor=always 或 method=browser）→ 交给 Worker；
 *   Worker 全部不可用且 fallbackToLocal 时回退到本地抓取器
 * - 否则用本地 http / browser 抓取器
 * - method=browser 而浏览器不可用时退回 http（附 warning）；未指定 method 且 http 结果为
 *   骨架页 / 反爬挑战页 / 403、503 空白拦截页时自动改用 browser 重抓，浏览器不可用则只附 warning。
 *   全部尝试共用一个总 deadline。
 * - SSRF 拦截、内容类型不支持、响应体超限属确定性结论，不换抓取器重试
 *
 * 只缓存 2xx 响应，避免把错误页、反爬页缓存一小时。
 * 缓存内容按「格式化后的正文」存储（不含 rawHtml），命中后再跑一次内容过滤，
 * 避免 block 模式被缓存绕过、也避免缓存里塞整页 HTML。
 *
 * 返回长度：缓存与内容过滤都针对完整正文；返回前按 startIndex / maxLength 切段，
 * 附 totalLength 与 nextStartIndex 供调用方续读。format=html 时只在 content 里返回一份 HTML。
 */

import type { Fetcher, FetchResult } from '../fetcher/fetcher-interface.js';
import type { CacheProvider } from '../cache/cache-interface.js';
import type { SsrfGuard } from '../security/ssrf-guard.js';
import type { ContentFilter } from '../security/content-filter.js';
import { getLogger, redactUrl } from '../utils/logger.js';
import { detectJsRequiredPage } from '../fetcher/render-detector.js';

export type FetchFormat = 'html' | 'text' | 'markdown';
export type FetchMethod = 'http' | 'browser';

/** 进程外 Worker 抓取器（由 workers/worker-client 实现） */
export interface RemoteFetcher extends Fetcher {
  /** 至少有一个健康的 Worker */
  hasHealthyWorker(): boolean;
  /** 是否有 Worker 声明支持该方法 */
  supports(method: FetchMethod): boolean;
}

export interface FetchPageToolDeps {
  cache: CacheProvider;
  ssrfGuard: SsrfGuard;
  fetchers: {
    http: Fetcher;
    browser?: Fetcher;
  };
  defaultMethod: FetchMethod;
  defaultTimeoutMs: number;
  maxBytes: number;
  contentFilter?: ContentFilter;
  contentFilterMode: 'off' | 'warn' | 'block';
  remote?: {
    fetcher: RemoteFetcher;
    useFor: 'browser' | 'always';
    fallbackToLocal: boolean;
  };
  /** 缓存 TTL（秒），0 不缓存 */
  cacheTtl?: number;
  /**
   * 未显式指定 method 且走 http 时检测骨架页 / 反爬挑战页 / 空白拦截页：浏览器可用则自动改用 browser 重抓，
   * 不可用则附 warning。默认 true；false 时既不检测也不升级。
   */
  autoBrowserUpgrade?: boolean;
  /** 未传 maxLength 时的默认值 */
  defaultMaxLength?: number;
}

export interface FetchPageParams {
  url: string;
  format?: FetchFormat;
  timeout?: number;
  method?: FetchMethod;
  waitForSelector?: string;
  /** 本次最多返回的正文字符数（默认 DEFAULT_MAX_LENGTH） */
  maxLength?: number;
  /** 从正文第几个字符开始返回（分段续读，默认 0） */
  startIndex?: number;
}

/** 默认单次返回的正文字符数：约 5k~10k token，足够覆盖绝大多数文章，又不会一次塞爆上下文 */
export const DEFAULT_MAX_LENGTH = 20_000;

export type FetchPageResult = Omit<FetchResult, 'truncated' | 'rawHtml'> & {
  cached?: boolean;
  warnings?: string[];
  /** content 被 maxLength 截断，后面还有内容 */
  truncated?: boolean;
  /** 完整正文字符数 */
  totalLength: number;
  /** 续读用的 startIndex；没有更多内容时不出现 */
  nextStartIndex?: number;
  /** 响应体超过 maxBytes，只抓到开头部分 */
  bodyTruncated?: boolean;
};

export type FetchPageErrorCode =
  | 'SSRF_BLOCKED'
  | 'CONTENT_BLOCKED'
  | 'NO_FETCHER'
  | 'FETCH_FAILED'
  | 'CANCELLED'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'TOO_LARGE';

export class FetchPageError extends Error {
  constructor(
    message: string,
    readonly code: FetchPageErrorCode,
  ) {
    super(message);
    this.name = 'FetchPageError';
  }
}

/** SSRF 校验拦截：属于终止性错误，不能降级到下一个抓取器重试 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/** 沿 cause 链判断是否为 SSRF 拦截（各抓取器会包装原始错误） */
export function isSsrfBlockedError(error: unknown): boolean {
  if (error instanceof SsrfBlockedError) return true;
  const code = findErrorCode(error, ['BLOCKED', 'SSRF_BLOCKED']);
  return code !== undefined;
}

/** 沿 cause 链查找第一个命中的错误码 */
function findErrorCode<T extends string>(error: unknown, codes: readonly T[]): T | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (current instanceof SsrfBlockedError && (codes as readonly string[]).includes('SSRF_BLOCKED')) {
      return 'SSRF_BLOCKED' as T;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && (codes as readonly string[]).includes(code)) return code as T;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * 确定性错误：换抓取器重抓结果相同（内容类型不支持、响应体超限），不再降级重试。
 * 返回对应的 FetchPageError 错误码，非确定性错误返回 undefined。
 */
export function deterministicFetchErrorCode(error: unknown): 'UNSUPPORTED_CONTENT_TYPE' | 'TOO_LARGE' | undefined {
  return findErrorCode(error, ['UNSUPPORTED_CONTENT_TYPE', 'TOO_LARGE'] as const);
}

/** 浏览器不可用（未安装 Playwright 等） */
function isBrowserUnavailableError(error: unknown): boolean {
  return findErrorCode(error, ['BROWSER_NOT_INSTALLED']) !== undefined;
}

/** 浏览器不可用时给调用方的启用方法（warnings 会原样转给 agent / 用户） */
export const BROWSER_SETUP_HINT =
  '如需浏览器渲染：安装 playwright 并执行 npx playwright install chromium，再设置 fetcher.browser.enabled=true；或配置支持 browser 的 Worker';

/** 剩余预算低于该值时不再启动新的抓取尝试（降级 / 重抓），直接放弃 */
export const MIN_ATTEMPT_BUDGET_MS = 1000;

/** 一组候选抓取器全部失败（非终止性错误）或预算耗尽 */
class FetchChainError extends Error {
  constructor(
    readonly lastError: unknown,
    readonly browserUnavailable: boolean,
    readonly budgetExhausted: boolean,
  ) {
    super(lastError instanceof Error ? lastError.message : String(lastError ?? '未知错误'));
    this.name = 'FetchChainError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildCacheKey(url: string, format: string, method: string, selector?: string): string {
  return `fetch:${method}:${format}:${selector ?? ''}:${url}`;
}

/** 选择抓取器；返回候选列表（首选在前，其后为降级选项） */
function chooseFetchers(method: FetchMethod, deps: FetchPageToolDeps): Fetcher[] {
  const local = method === 'browser' ? deps.fetchers.browser : deps.fetchers.http;
  const remote = deps.remote;
  const wantsRemote = !!remote && (remote.useFor === 'always' || method === 'browser');

  const list: Fetcher[] = [];
  if (wantsRemote && remote.fetcher.supports(method) && remote.fetcher.hasHealthyWorker()) {
    list.push(remote.fetcher);
    if (remote.fallbackToLocal && local) list.push(local);
  } else if (local) {
    list.push(local);
  } else if (wantsRemote && remote.fetcher.supports(method)) {
    // 本地没有（如未装 Playwright），即便健康检查暂未通过也尝试一次远端
    list.push(remote.fetcher);
  }
  return list;
}

/**
 * fetch_page 主流程。
 *
 * 超时：整次调用共用一个总 deadline（params.timeout / defaultTimeoutMs），每个抓取尝试只拿剩余预算；
 * 首次尝试之外，剩余预算低于 MIN_ATTEMPT_BUDGET_MS 时直接放弃，不再降级 / 重抓。
 *
 * 降级：
 * - 同一 method 内：远端 Worker ↔ 本地抓取器（非确定性错误才换下一个）
 * - method=browser 而浏览器不可用（未装 Playwright 等）：退回 http，并在 warnings 中说明
 * - 未显式指定 method 且走 http：结果为骨架页 / 反爬挑战页 / 空白拦截页时，浏览器可用则自动改用
 *   browser 重抓，不可用则附 warning；显式 method=http 时不检测也不升级
 */
export async function handleFetchPage(
  params: FetchPageParams,
  deps: FetchPageToolDeps,
  signal?: AbortSignal,
): Promise<FetchPageResult> {
  const logger = getLogger();
  const { url } = params;
  const format = params.format ?? 'markdown';
  const timeout = params.timeout ?? deps.defaultTimeoutMs;
  const method = params.method ?? deps.defaultMethod;
  const deadline = Date.now() + timeout;
  const remainingBudget = () => deadline - Date.now();

  if (signal?.aborted) throw new FetchPageError('抓取已取消', 'CANCELLED');

  const warnings: string[] = [];
  let primaryMethod: FetchMethod = method;
  let fetchers = chooseFetchers(method, deps);
  if (fetchers.length === 0 && method === 'browser') {
    const httpFetchers = chooseFetchers('http', deps);
    if (httpFetchers.length > 0) {
      fetchers = httpFetchers;
      primaryMethod = 'http';
      warnings.push(`浏览器抓取不可用（未启用或未安装 Playwright，且无支持浏览器渲染的 Worker），已退回 http 抓取，JS 渲染内容可能缺失。${BROWSER_SETUP_HINT}`);
    }
  }
  if (fetchers.length === 0) {
    throw new FetchPageError(
      method === 'browser'
        ? '浏览器抓取不可用：请安装 playwright 并设置 fetcher.browser.enabled=true，或配置支持浏览器渲染的 Worker'
        : '没有可用的 HTTP 抓取器',
      'NO_FETCHER',
    );
  }

  // 1. SSRF 预检
  const validation = await deps.ssrfGuard.validateUrl(url);
  if (!validation.safe) {
    throw new FetchPageError(`URL 安全检查未通过: ${validation.reason ?? '目标地址被禁止'}`, 'SSRF_BLOCKED');
  }

  // 内容过滤 — URL
  if (deps.contentFilter && deps.contentFilterMode !== 'off') {
    const urlCheck = deps.contentFilter.checkUrl(url);
    if (!urlCheck.safe) {
      if (deps.contentFilterMode === 'block') {
        throw new FetchPageError(`URL 安全过滤未通过: ${urlCheck.threats.join('; ')}`, 'CONTENT_BLOCKED');
      }
      warnings.push(...urlCheck.threats);
    }
  }

  /** 内容过滤 — 正文；block 模式直接抛错 */
  const checkContent = (text: string): string[] => {
    if (!deps.contentFilter || deps.contentFilterMode === 'off' || !text) return [];
    const r = deps.contentFilter.checkContent(text);
    if (r.safe) return [];
    if (deps.contentFilterMode === 'block') {
      throw new FetchPageError(`内容安全过滤未通过: ${r.threats.join('; ')}`, 'CONTENT_BLOCKED');
    }
    logger.warn('内容安全过滤命中', { url: redactUrl(url), threats: r.threats });
    return r.threats;
  };

  // 查缓存（命中后同样要过内容过滤，否则 block 模式可被缓存绕过）
  const cacheKey = buildCacheKey(url, format, method, params.waitForSelector);
  try {
    const cached = await deps.cache.get<FetchResult>(cacheKey);
    if (cached) {
      logger.debug('抓取缓存命中', { url: redactUrl(url), method });
      const cachedWarnings = [...warnings, ...checkContent(cached.content)];
      return finalize({ ...cached, cached: true }, cachedWarnings, params, deps);
    }
  } catch (error) {
    if (error instanceof FetchPageError) throw error;
    logger.warn('读取抓取缓存失败', { error });
  }

  logger.info('抓取网页', { url: redactUrl(url), format, method });

  const validateUrl = async (target: string): Promise<void> => {
    const r = await deps.ssrfGuard.validateUrl(target);
    if (!r.safe) throw new SsrfBlockedError(`目标被 SSRF 防护拦截: ${r.reason ?? redactUrl(target)}`);
  };

  // 是否检测「需要浏览器渲染」：此时让 http 抓取器顺带返回 rawHtml 供检测（返回前去掉）。
  // 浏览器不可用时同样检测：无法升级，但要在 warnings 里告诉调用方拿到的只是空壳 / 拦截页
  const mayUpgrade = params.method === undefined && primaryMethod === 'http' && (deps.autoBrowserUpgrade ?? true);

  let attempts = 0;
  /** 按候选顺序执行一组抓取器；终止性错误抛 FetchPageError，其余失败汇总为 FetchChainError */
  const runChain = async (list: Fetcher[], attemptMethod: FetchMethod, includeRawHtml: boolean): Promise<FetchResult> => {
    let lastError: unknown;
    let browserUnavailable = false;
    for (const fetcher of list) {
      if (signal?.aborted) throw new FetchPageError('抓取已取消', 'CANCELLED');
      const budget = remainingBudget();
      // 首次尝试总会执行；之后的降级 / 重抓在剩余预算过小时直接放弃
      if (attempts > 0 && budget < MIN_ATTEMPT_BUDGET_MS) {
        throw new FetchChainError(lastError ?? new Error(`总超时 ${timeout}ms 已用尽`), browserUnavailable, true);
      }
      attempts++;
      try {
        return await fetcher.fetch({
          url,
          format,
          timeout: Math.max(1, budget),
          maxBytes: deps.maxBytes,
          validateUrl,
          dispatcher: deps.ssrfGuard.getDispatcher(),
          waitForSelector: params.waitForSelector,
          // 显式传 method：Worker 端默认按 browser 执行，不传会把 http 请求也送去渲染
          method: attemptMethod,
          signal,
          ...(includeRawHtml ? { includeRawHtml: true } : {}),
        });
      } catch (error) {
        lastError = error;
        // SSRF 拦截是安全结论，换抓取器重试没有意义（还可能绕过防护）
        if (isSsrfBlockedError(error)) throw new FetchPageError(errorMessage(error), 'SSRF_BLOCKED');
        if (signal?.aborted) throw new FetchPageError('抓取已取消', 'CANCELLED');
        // 内容类型不支持 / 超限：换抓取器结果相同，直接终止
        const deterministic = deterministicFetchErrorCode(error);
        if (deterministic) throw new FetchPageError(`抓取失败: ${errorMessage(error)}`, deterministic);
        if (isBrowserUnavailableError(error)) browserUnavailable = true;
        logger.warn('抓取失败，尝试下一个抓取器', {
          fetcher: fetcher.name,
          url: redactUrl(url),
          error: errorMessage(error),
        });
      }
    }
    throw new FetchChainError(lastError, browserUnavailable, false);
  };

  const toFetchPageError = (error: unknown): FetchPageError => {
    if (error instanceof FetchPageError) return error;
    if (error instanceof FetchChainError) {
      const suffix = error.budgetExhausted ? `（总超时 ${timeout}ms 预算已用尽，未再尝试其余抓取器）` : '';
      return new FetchPageError(`抓取失败: ${error.message}${suffix}`, 'FETCH_FAILED');
    }
    return new FetchPageError(`抓取失败: ${errorMessage(error)}`, 'FETCH_FAILED');
  };

  // 2. 执行抓取（按候选顺序降级）
  let result: FetchResult;
  /** 降级 / 未成功升级的结果不进缓存，避免把残缺内容缓存一小时 */
  let cacheable = primaryMethod === method;
  try {
    result = await runChain(fetchers, primaryMethod, mayUpgrade);
  } catch (error) {
    // method=browser 但浏览器不可用（未安装 Playwright 等）：退回 http
    const httpFetchers = primaryMethod === 'browser' ? chooseFetchers('http', deps) : [];
    if (!(error instanceof FetchChainError && error.browserUnavailable) || httpFetchers.length === 0) {
      throw toFetchPageError(error);
    }
    if (remainingBudget() < MIN_ATTEMPT_BUDGET_MS) throw toFetchPageError(error);
    logger.warn('浏览器不可用，退回 http 抓取', { url: redactUrl(url), error: error.message });
    warnings.push(`浏览器抓取不可用（${error.message.split('\n')[0]}），已退回 http 抓取，JS 渲染内容可能缺失`);
    cacheable = false;
    try {
      result = await runChain(httpFetchers, 'http', false);
    } catch (fallbackError) {
      throw toFetchPageError(fallbackError);
    }
  }

  // 3. http 结果疑似骨架页 / 需 JS 渲染 / 反爬挑战页：自动改用浏览器重抓（同样受总 deadline 约束）
  if (mayUpgrade) {
    const detection = detectJsRequiredPage({
      html: result.rawHtml,
      text: result.content,
      title: result.title,
      contentType: result.contentType,
      statusCode: result.statusCode,
    });
    if (detection.needsBrowser) {
      const browserFetchers = chooseFetchers('browser', deps);
      if (browserFetchers.length === 0) {
        warnings.push(`${detection.reason}，但浏览器抓取不可用，返回的 http 结果可能缺少正文。${BROWSER_SETUP_HINT}`);
        cacheable = false;
      } else if (remainingBudget() < MIN_ATTEMPT_BUDGET_MS) {
        warnings.push(`${detection.reason}，剩余时间不足，未改用浏览器重抓`);
        cacheable = false;
      } else {
        logger.info('检测到需 JS 渲染的页面，改用浏览器重抓', { url: redactUrl(url), reason: detection.reason });
        try {
          result = await runChain(browserFetchers, 'browser', false);
          warnings.push(`${detection.reason}，已自动改用浏览器重抓`);
        } catch (error) {
          // 安全拦截与取消必须向上抛；其余失败保留 http 结果
          if (error instanceof FetchPageError && (error.code === 'SSRF_BLOCKED' || error.code === 'CANCELLED')) throw error;
          const msg = error instanceof FetchChainError || error instanceof FetchPageError ? error.message : errorMessage(error);
          warnings.push(`${detection.reason}，浏览器重抓失败（${msg.split('\n')[0]}），返回 http 结果`);
          cacheable = false;
        }
      }
    }
  }

  // rawHtml 不再单独返回：format=html 时 content 就是 HTML，两份完全重复只会翻倍占用上下文；
  // 其它格式下 rawHtml 只是检测用，不外泄
  if (result.rawHtml !== undefined) {
    const { rawHtml, ...rest } = result;
    result = format === 'html' && !rest.content ? { ...rest, content: rawHtml } : rest;
  }

  // 4. 内容过滤（对提取后的正文，而不是整页 HTML）
  warnings.push(...checkContent(result.content));

  // 非 2xx：内容为空是正常的（错误页常无正文），但不提示的话看起来就像抓到了空页面
  if (result.statusCode < 200 || result.statusCode >= 300) {
    warnings.push(`目标站点返回 HTTP ${result.statusCode}${result.content ? '' : '，且页面没有可提取的正文'}`);
  }

  // 5. 仅缓存成功响应；缓存完整正文（分段在返回时再切，不同 startIndex 共用一份缓存）
  if (cacheable && result.statusCode >= 200 && result.statusCode < 300 && (deps.cacheTtl ?? 1) > 0) {
    const { rawHtml: _rawHtml, ...cacheableResult } = result;
    try {
      await deps.cache.set(cacheKey, cacheableResult, deps.cacheTtl !== undefined ? { ttl: deps.cacheTtl } : undefined);
    } catch (error) {
      logger.warn('写入抓取缓存失败', { error });
    }
  }

  return finalize({ ...result, cached: false }, warnings, params, deps);
}

/**
 * 按 startIndex / maxLength 切出一段正文，并把抓取器的字节截断标记改名为 bodyTruncated
 * （truncated 对外表示「content 被 maxLength 截断、后面还有」）。
 */
export function sliceContent<T extends FetchResult & { cached?: boolean }>(
  result: T,
  startIndex: number,
  maxLength: number,
): Omit<T, 'truncated'> & { truncated?: boolean; totalLength: number; nextStartIndex?: number; bodyTruncated?: boolean } {
  const { truncated: bodyTruncated, ...rest } = result;
  const full = result.content ?? '';
  const totalLength = full.length;
  const start = Math.min(Math.max(0, startIndex), totalLength);
  let end = Math.min(totalLength, start + maxLength);
  // 不把代理对（emoji 等）切成两半
  if (end < totalLength && end > start) {
    const code = full.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  const out = {
    ...rest,
    content: full.slice(start, end),
    totalLength,
    ...(bodyTruncated ? { bodyTruncated: true } : {}),
  } as Omit<T, 'truncated'> & { truncated?: boolean; totalLength: number; nextStartIndex?: number; bodyTruncated?: boolean };
  if (end < totalLength) {
    out.truncated = true;
    out.nextStartIndex = end;
  }
  return out;
}

function finalize(
  result: FetchResult & { cached?: boolean },
  warnings: string[],
  params: FetchPageParams,
  deps: FetchPageToolDeps,
): FetchPageResult {
  const startIndex = params.startIndex ?? 0;
  const maxLength = params.maxLength ?? deps.defaultMaxLength ?? DEFAULT_MAX_LENGTH;
  const sliced = sliceContent(result, startIndex, maxLength);
  const allWarnings = [...(result.warnings ?? []), ...warnings];
  if (startIndex > 0 && startIndex >= sliced.totalLength) {
    allWarnings.push(`startIndex ${startIndex} 超出正文长度 ${sliced.totalLength}，没有更多内容`);
  }
  if (sliced.bodyTruncated) {
    allWarnings.push('响应体超过大小上限，只抓取了开头部分');
  }
  return allWarnings.length ? { ...sliced, warnings: allWarnings } : sliced;
}
