/**
 * 抓取类引擎的公共 HTTP 工具
 *
 * 统一处理：
 * - User-Agent：从 UA 池按查询词稳定挑选（同一查询多次请求 UA 一致，降低风控）
 * - Referer / Origin：由引擎的 baseUrl 推导，配置了镜像或备用地址时自动跟随，不再写死官方域名
 * - 超时、响应体大小上限、代理池：全部委托给 http-client
 * - 非 2xx 统一抛出带状态码的 ScraperHttpError
 */

import { httpRequest, pickUserAgent, USER_AGENT_POOL } from '../utils/http-client.js';
import { EngineParseError } from './engine-interface.js';

export class ScraperHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ScraperHttpError';
  }
}

export interface ScraperFetchOptions {
  /** 引擎 baseUrl，用于推导 Referer */
  baseUrl: string;
  timeoutMs: number;
  /** 用于稳定挑选 UA */
  query?: string;
  acceptLanguage?: string;
  accept?: string;
  /** 额外请求头（会覆盖默认值） */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 默认 GET；DuckDuckGo HTML 版等需要 POST 表单 */
  method?: 'GET' | 'POST';
  /** POST 时的表单体（自动设置 application/x-www-form-urlencoded） */
  form?: URLSearchParams;
}

export interface ScraperFetchResult {
  status: number;
  /** 跟随重定向后的最终 URL（用于识别验证码跳转） */
  url: string;
  body: string;
  headers: Headers | Record<string, string | string[] | undefined>;
}

const DEFAULT_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

/** 由 baseUrl 推导 Referer（取 origin + "/"） */
export function refererFor(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).origin}/`;
  } catch {
    return '';
  }
}

/**
 * 按查询词稳定挑选 UA：同一查询多次分页请求保持同一 UA，
 * 不同查询之间分散到 UA 池的不同项（降低固定 UA 被识别的概率）。
 */
export function pickStableUserAgent(seed?: string): string {
  if (!seed) return pickUserAgent();
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return USER_AGENT_POOL[hash % USER_AGENT_POOL.length];
}

function buildHeaders(options: ScraperFetchOptions): Record<string, string> {
  const referer = refererFor(options.baseUrl);
  return {
    'User-Agent': pickStableUserAgent(options.query),
    Accept: options.accept ?? DEFAULT_ACCEPT,
    'Accept-Language': options.acceptLanguage ?? 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(referer ? { Referer: referer } : {}),
    ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    ...options.headers,
  };
}

export async function fetchSearchPage(url: string, options: ScraperFetchOptions): Promise<ScraperFetchResult> {
  const response = await httpRequest(url, {
    method: options.method ?? (options.form ? 'POST' : 'GET'),
    headers: buildHeaders(options),
    body: options.form?.toString(),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    throwOnHttpError: false,
  });

  if (!response.ok) {
    throw new ScraperHttpError(`HTTP ${response.status}: ${response.statusText}`, response.status);
  }

  return {
    status: response.status,
    url: response.url,
    body: response.text(),
    headers: response.headers as ScraperFetchResult['headers'],
  };
}

export interface ScraperRedirectOptions extends Omit<ScraperFetchOptions, 'method' | 'form'> {
  /** 响应体字节上限（跳转页通常很小） */
  maxBytes?: number;
}

export interface ScraperRedirectResult {
  /** 3xx 响应的 Location（已解析为绝对地址）；有值时不再请求目标地址 */
  location?: string;
  /** 非 3xx 时的状态码与响应体（供调用方从 JS / meta refresh 中提取跳转目标） */
  status?: number;
  body?: string;
}

/**
 * 请求跳转链接但不跟随重定向（GET，与搜索请求相同的请求头 / 代理 / 超时）。
 * http-client 只有「自动跟随」与「逐跳校验」两种模式：这里用逐跳校验模式，
 * 在第二跳的校验钩子里记下目标地址并中止，从而只发出一次请求、不访问目标站点。
 */
export async function fetchRedirectTarget(url: string, options: ScraperRedirectOptions): Promise<ScraperRedirectResult> {
  let hops = 0;
  let location: string | undefined;
  try {
    const response = await httpRequest(url, {
      method: 'GET',
      headers: buildHeaders(options),
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      signal: options.signal,
      throwOnHttpError: false,
      redirect: 'manual-checked',
      maxRedirects: 1,
      validateUrl: (next) => {
        if (hops++ === 0) return;
        location = next;
        throw new Error('已取得跳转目标，不再跟随');
      },
    });
    return { status: response.status, body: response.text() };
  } catch (error) {
    if (location !== undefined) return { location };
    throw error;
  }
}

// ===== 结果为空 / 反爬页的判定 =====

/**
 * 各引擎的「确实没有结果」文案。
 * 用于把「真的没有结果」与「页面被换成反爬页 / 改版解析失败」区分开：
 * 前者是合法响应，后者必须抛错交给降级链，否则会被当成 0 条结果缓存下来。
 */
const NO_RESULTS_HINTS = [
  '没有找到相关结果', '没有找到与', '未找到相关结果', '抱歉，没有找到', '找不到和您查询的',
  'no results', 'did not match any documents', 'ничего не найдено',
  'there are no results for', 'no results found',
];

export function looksLikeEmptyResultsPage(html: string): boolean {
  if (!html) return false;
  const lower = html.toLowerCase();
  return NO_RESULTS_HINTS.some(h => lower.includes(h.toLowerCase()));
}

/**
 * 校验解析结果：0 条且页面不像「无结果页」时抛 EngineParseError。
 * 返回原数组，便于调用方链式书写。
 */
export function assertParsed<T>(results: T[], html: string, engineName: string): T[] {
  if (results.length > 0) return results;
  if (looksLikeEmptyResultsPage(html)) return results;
  throw new EngineParseError(
    `${engineName} 未解析到结果，且页面不像「无结果」页（疑似反爬或页面改版）`,
  );
}
