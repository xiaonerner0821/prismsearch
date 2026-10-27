/**
 * wechat_search 工具 — 微信公众号文章搜索（基于搜狗微信）
 *
 * 与 web_search 的区别：
 * - 只搜微信公众号文章，结果带公众号名称与发布日期
 * - 返回的文章链接是带签名的临时链接（有效期有限），需要正文时尽快用 fetch_page 抓取
 * - 独立的短 TTL 缓存（10 分钟），避免缓存过期的签名链接
 *
 * 引擎实例由服务端按 config.wechat 构造并注入（旧实现在模块内写死一份配置，
 * 用户无法关闭或调整，list_engines 也看不到它）。
 */

import type { SearchProvider, SearchResponse } from '../engines/engine-interface.js';
import type { CacheProvider } from '../cache/cache-interface.js';
import type { RateLimiter } from '../security/rate-limiter.js';
import { deduplicateResults } from '../utils/dedup.js';
import { ToolInputError } from './tool-errors.js';
import { getLogger, redactQuery } from '../utils/logger.js';

/** 签名链接时效有限，缓存 10 分钟即可 */
export const WECHAT_CACHE_TTL_SECONDS = 600;

export interface WechatSearchToolDeps {
  cache: CacheProvider;
  /** 未启用时为 undefined */
  engine?: SearchProvider;
  limiter?: RateLimiter;
}

export interface WechatSearchParams {
  query: string;
  count?: number;
  page?: number;
}

export async function handleWechatSearch(
  params: WechatSearchParams,
  deps: WechatSearchToolDeps,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const logger = getLogger();
  if (!deps.engine) {
    throw new ToolInputError('微信公众号搜索未启用（config.wechat.enabled=false）');
  }

  const query = params.query.trim();
  if (!query) throw new ToolInputError('query 不能为空');
  const count = params.count ?? 10;
  const page = params.page ?? 1;

  const cacheKey = JSON.stringify(['wechat_search', query.replace(/\s+/g, ' ').toLowerCase(), count, page]);
  try {
    const cached = await deps.cache.get<SearchResponse>(cacheKey);
    if (cached) {
      logger.debug('微信搜索缓存命中', { query: redactQuery(query) });
      return { ...cached, cached: true };
    }
  } catch (error) {
    logger.warn('读取微信搜索缓存失败', { error });
  }

  if (deps.limiter) {
    const quota = deps.limiter.consume('wechat');
    if (!quota.allowed) {
      throw new ToolInputError(`微信搜索请求过于频繁，请 ${Math.ceil((quota.retryAfter ?? 0) / 1000)} 秒后重试`);
    }
  }

  logger.info('执行微信公众号搜索', { query: redactQuery(query), page });
  const response = await deps.engine.search({ query, engine: 'wechat', count, page, signal });

  response.results = deduplicateResults(response.results)
    .slice(0, count)
    .map((r, i) => ({ ...r, position: (page - 1) * count + i + 1 }));
  response.cached = false;

  if (response.results.length > 0) {
    try {
      await deps.cache.set(cacheKey, response, { ttl: WECHAT_CACHE_TTL_SECONDS });
    } catch (error) {
      logger.warn('写入微信搜索缓存失败', { error });
    }
  }

  return response;
}
