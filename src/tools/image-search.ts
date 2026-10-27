/**
 * image_search 工具 — 多引擎图片搜索
 *
 * 缩略图内联（includeThumbnails）的安全加固：
 * - 旧实现直接 fetch 引擎返回的任意 thumbnailUrl —— 恶意或被污染的结果可借此访问内网（SSRF）
 * - 现在走 http-client：SsrfGuard 调度器在建连时校验 IP，重定向逐跳校验
 * - 流式读取，超过上限立即中止（旧实现先完整下载再判断大小）
 * - 只接受 image/* 且排除 SVG（可内嵌脚本）
 */

import type { ImageSearchRequest, ImageSearchResponse, ImageSearchResult } from '../engines/engine-interface.js';
import type { EngineRegistry } from '../engines/engine-registry.js';
import type { EngineSelector } from '../engines/engine-selector.js';
import type { CacheProvider } from '../cache/cache-interface.js';
import type { SsrfGuard } from '../security/ssrf-guard.js';
import { normalizeUrl } from '../utils/dedup.js';
import { ToolInputError } from './tool-errors.js';
import { getLogger, redactQuery, redactUrl } from '../utils/logger.js';
import { httpRequest } from '../utils/http-client.js';
import { fallbackWarning, runWithFallback, type EngineRateLimiters } from './search-runner.js';
import {
  buildEngineAffinityKey,
  buildSearchCacheKey,
  overfetchCount,
  overfetchHasMore,
  raceSignal,
  readAffinity,
  shouldCacheResponse,
  SingleFlight,
  writeAffinity,
} from './web-search.js';

export interface ImageSearchToolDeps {
  cache: CacheProvider;
  engineRegistry: EngineRegistry;
  engineSelector: EngineSelector;
  ssrfGuard: SsrfGuard;
  limiters?: EngineRateLimiters;
  /** 整个降级循环的总时长上限（毫秒） */
  deadlineMs?: number;
}

const THUMBNAIL_CONCURRENCY = 5;
const THUMBNAIL_TIMEOUT_MS = 5000;
const THUMBNAIL_MAX_BYTES = 50_000;
const THUMBNAIL_MAX_COUNT = 20;

function deduplicateImageResults(results: ImageSearchResult[]): ImageSearchResult[] {
  const seen = new Set<string>();
  return results.filter(r => {
    const key = normalizeUrl(r.imageUrl);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 抓取单张缩略图为 data URI；失败返回 undefined */
export async function fetchThumbnailDataUri(url: string, ssrfGuard: SsrfGuard): Promise<string | undefined> {
  const check = await ssrfGuard.validateUrl(url);
  if (!check.safe) return undefined;

  const response = await httpRequest(url, {
    timeoutMs: THUMBNAIL_TIMEOUT_MS,
    maxBytes: THUMBNAIL_MAX_BYTES,
    dispatcher: ssrfGuard.getDispatcher(),
    redirect: 'manual-checked',
    validateUrl: async target => {
      const r = await ssrfGuard.validateUrl(target);
      if (!r.safe) throw new Error(r.reason ?? 'blocked');
    },
    throwOnHttpError: false,
    headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' },
  });
  if (!response.ok) return undefined;

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/') || contentType.includes('svg')) return undefined;

  return `data:${contentType};base64,${Buffer.from(response.body).toString('base64')}`;
}

async function attachThumbnails(results: ImageSearchResult[], maxCount: number, ssrfGuard: SsrfGuard): Promise<void> {
  const logger = getLogger();
  const queue = results.slice(0, Math.min(maxCount, THUMBNAIL_MAX_COUNT)).filter(r => r.thumbnailUrl);
  let index = 0;

  const worker = async (): Promise<void> => {
    while (index < queue.length) {
      const item = queue[index++];
      try {
        const dataUri = await fetchThumbnailDataUri(item.thumbnailUrl, ssrfGuard);
        if (dataUri) item.thumbnailBase64 = dataUri;
      } catch (error) {
        logger.debug('缩略图抓取失败', {
          url: redactUrl(item.thumbnailUrl),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(THUMBNAIL_CONCURRENCY, queue.length) }, worker));
}

export async function handleImageSearch(
  request: ImageSearchRequest,
  deps: ImageSearchToolDeps,
  signal?: AbortSignal,
): Promise<ImageSearchResponse> {
  const logger = getLogger();
  const req: ImageSearchRequest = {
    ...request,
    query: request.query.trim(),
    count: request.count ?? 10,
    page: request.page ?? 1,
    safeSearch: request.safeSearch ?? false,
    includeThumbnails: request.includeThumbnails ?? false,
  };
  delete req.signal;
  if (!req.query) throw new ToolInputError('query 不能为空');

  const cacheKey = buildSearchCacheKey('image', req as ImageSearchRequest & Record<string, unknown>, [
    req.imageSize ?? '',
    req.imageType ?? '',
    req.includeThumbnails,
  ]);
  try {
    const cached = await deps.cache.get<ImageSearchResponse>(cacheKey);
    if (cached) {
      logger.debug('图片搜索缓存命中', { query: redactQuery(req.query), engine: cached.engine });
      const hit: ImageSearchResponse = { ...cached, cached: true, results: cached.results.map(r => ({ ...r })) };
      // 缓存里不存 base64，命中时按需补抓
      if (req.includeThumbnails) await attachThumbnails(hit.results, req.count ?? 10, deps.ssrfGuard);
      return hit;
    }
  } catch (error) {
    logger.warn('读取图片搜索缓存失败', { error });
  }

  // 合并并发：共享请求不绑定单个调用方的 signal，调用方取消只是停止等待
  const shared = imageFlights.run(cacheKey, () => searchImagesUncached(req, cacheKey, deps));
  const response = await raceSignal(shared, signal);
  return { ...response, results: response.results.map(r => ({ ...r })) };
}

const imageFlights = new SingleFlight<ImageSearchResponse>();

async function searchImagesUncached(
  req: ImageSearchRequest,
  cacheKey: string,
  deps: ImageSearchToolDeps,
): Promise<ImageSearchResponse> {
  const logger = getLogger();
  const count = req.count ?? 10;
  const page = req.page ?? 1;

  // 自动选引擎的翻页：优先沿用第 1 页的引擎
  const affinityExtra = [req.imageSize ?? '', req.imageType ?? ''];
  const affinityKey = buildEngineAffinityKey('image', req, affinityExtra);
  const rankReq: ImageSearchRequest = { ...req };
  if (!req.engine && page > 1) {
    const sticky = await readAffinity(deps.cache, affinityKey);
    if (sticky) rankReq.engine = sticky;
  }

  const candidates = deps.engineSelector.rankForImage(rankReq, deps.engineRegistry);
  if (candidates.length === 0 && req.engine) {
    throw new ToolInputError(`引擎 "${req.engine}" 不支持图片搜索或当前不可用`);
  }

  const fetchCount = overfetchCount(count, page);
  const { engine, value: response, attempts } = await runWithFallback({
    candidates,
    limiters: deps.limiters,
    query: req.query,
    kind: 'image',
    isEmpty: !req.engine && page === 1 ? (r: ImageSearchResponse) => r.results.length === 0 : undefined,
    deadlineMs: deps.deadlineMs,
    invoke: (e, sig) => {
      if (typeof e.imageSearch !== 'function') throw new Error('不支持图片搜索');
      return e.imageSearch({ ...req, count: fetchCount, signal: sig });
    },
  });

  const deduped = deduplicateImageResults(response.results);
  response.results = deduped.slice(0, count).map((r, i) => ({ ...r, position: (page - 1) * count + i + 1 }));
  response.hasMore = overfetchHasMore(response.hasMore, deduped.length, count, fetchCount);
  response.engine = engine;
  response.page = page;
  response.cached = false;
  const fallback = fallbackWarning(req.engine, engine, attempts);
  if (fallback) response.warnings = [fallback];
  else delete response.warnings;

  if (!req.engine && page === 1) await writeAffinity(deps.cache, affinityKey, engine);

  if (req.includeThumbnails) {
    await attachThumbnails(response.results, count, deps.ssrfGuard);
  }

  // 指定引擎却降级到别的引擎时不缓存（缓存 key 是按请求的引擎算的）
  if (shouldCacheResponse(req.engine, engine, response.results.length)) {
    try {
      // base64 缩略图体积大且是派生数据：缓存里只存 URL，命中时再按需补抓
      const toCache: ImageSearchResponse = {
        ...response,
        results: response.results.map(({ thumbnailBase64: _omit, ...rest }) => rest),
      };
      await deps.cache.set(cacheKey, toCache);
    } catch (error) {
      logger.warn('写入图片搜索缓存失败', { error });
    }
  }

  return response;
}
