/**
 * web_search 工具 — 网页搜索
 *
 * 参数 schema 只在 tool-schemas.ts 中以 zod 定义一次（旧实现在这里另有一份
 * 手写 JSON Schema，与 mcp-server 中的 zod 定义不一致且从未被使用）。
 *
 * - 同一查询的并发请求合并为一次上游调用（singleflight）
 * - 自动选引擎时记住第 1 页实际用的引擎，后续翻页优先沿用，避免各页来自不同引擎导致重复/断档
 * - 第 1 页适当多取一些再去重切片，减少去重后不足 count 条的情况
 * - 去重后重新编号 position
 * - mode=aggregate：并发查询多个引擎，按倒数排名融合（RRF）合并
 * - 实际使用的引擎不支持调用方给出的参数（safeSearch / region / language / timeRange）时附加 warning
 */

import type { SearchProvider, SearchRequest, SearchResponse, SearchResult } from '../engines/engine-interface.js';
import type { EngineRegistry } from '../engines/engine-registry.js';
import type { EngineSelector } from '../engines/engine-selector.js';
import type { CacheProvider } from '../cache/cache-interface.js';
import { capabilitiesOf, unsupportedParamsWarning } from '../engines/engine-capabilities.js';
import { deduplicateResults, normalizeUrl } from '../utils/dedup.js';
import { isAdUrl } from '../engines/ad-filter.js';
import { ToolInputError } from './tool-errors.js';
import { getLogger, redactQuery } from '../utils/logger.js';
import { fallbackWarning, runConcurrent, runWithFallback, type EngineRateLimiters } from './search-runner.js';

export type SearchMode = 'fallback' | 'aggregate';

/** 进度事件：progress 递增，total 为计划尝试的引擎数（降级链可能提前结束） */
export interface SearchProgress {
  progress: number;
  total?: number;
  message: string;
}

export interface WebSearchToolDeps {
  cache: CacheProvider;
  engineRegistry: EngineRegistry;
  engineSelector: EngineSelector;
  limiters?: EngineRateLimiters;
  /** 整个降级循环的总时长上限（毫秒） */
  deadlineMs?: number;
  /** 每次向一个引擎发起请求前回调（MCP 层据此发 notifications/progress） */
  onProgress?: (event: SearchProgress) => void;
  /** 按落地链接再过滤一遍广告（默认开启；引擎解析层的广告过滤不受影响） */
  adFilter?: boolean;
}

/** 去掉落地链接带广告特征的结果（引擎解析层漏掉的广告） */
export function stripAds(results: SearchResult[], enabled = true): SearchResult[] {
  return enabled ? results.filter(r => !isAdUrl(r.url)) : results;
}

/** 聚合模式同时查询的引擎数 */
export const AGGREGATE_FANOUT = 3;
/** RRF 平滑常数（文献常用值） */
const RRF_K = 60;

/** 第 1 页多取的比例（去重会吃掉一部分结果） */
const OVERFETCH_RATIO = 0.2;
/** 多取后的请求条数上限，与 schema 的 count 上限一致 */
const OVERFETCH_MAX = 50;
/** 「第 1 页用了哪个引擎」的记忆时长 */
const ENGINE_AFFINITY_TTL_SECONDS = 30 * 60;

/** 规范化查询词（去首尾空白、合并空白、小写），避免同义请求重复抓取 */
function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 缓存 key：查询词规范化后与各参数拼接 */
export function buildSearchCacheKey(kind: string, req: SearchRequest & Record<string, unknown>, extra: unknown[] = []): string {
  return JSON.stringify([
    kind,
    normalizeQuery(req.query),
    req.engine ?? 'auto',
    req.region ?? '',
    req.language ?? '',
    req.count ?? 10,
    req.page ?? 1,
    req.safeSearch ?? false,
    ...extra,
  ]);
}

/** 引擎亲和 key：与页码、条数无关，只要是同一个查询就沿用同一引擎 */
export function buildEngineAffinityKey(kind: string, req: SearchRequest, extra: unknown[] = []): string {
  return JSON.stringify([
    `${kind}:engine`,
    normalizeQuery(req.query),
    req.region ?? '',
    req.language ?? '',
    req.safeSearch ?? false,
    ...extra,
  ]);
}

/** 同 key 的并发调用共享一个 Promise；完成后立即移除 */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  get size(): number {
    return this.inflight.size;
  }
}

const webFlights = new SingleFlight<SearchResponse>();

/** 第 1 页多取的条数；翻页时偏移量按 count 计算，不能多取，否则页与页之间会错位 */
export function overfetchCount(count: number, page: number): number {
  if (page !== 1) return count;
  return Math.min(OVERFETCH_MAX, Math.max(count, Math.ceil(count * (1 + OVERFETCH_RATIO))));
}

/**
 * 多取之后的 hasMore 修正。引擎按「拿到的条数 >= 请求条数」判断 hasMore，而第 1 页请求的是
 * 多取后的条数：上游只给了满满一页（如百度给 10 条、我们要 13 条）时引擎会报告没有下一页，
 * 实测导致 10 条结果的第 1 页 hasMore=false。只要多取过、且凑够了调用方要的一整页，就认为还有更多。
 */
export function overfetchHasMore(engineHasMore: boolean, available: number, count: number, fetchCount: number): boolean {
  if (engineHasMore || available > count) return true;
  return fetchCount > count && available >= count;
}

/** 是否写入搜索缓存：非空，且（未指定引擎或实际用的就是指定引擎） */
export function shouldCacheResponse(requested: string | undefined, actual: string, resultCount: number): boolean {
  if (resultCount === 0) return false;
  return !requested || requested === actual;
}

/** 读取亲和引擎；读失败不影响搜索 */
export async function readAffinity(cache: CacheProvider, key: string): Promise<string | undefined> {
  try {
    return (await cache.get<string>(key)) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function writeAffinity(cache: CacheProvider, key: string, engine: string): Promise<void> {
  try {
    await cache.set(key, engine, { ttl: ENGINE_AFFINITY_TTL_SECONDS });
  } catch {
    // 亲和只是优化，写失败忽略
  }
}

/** web_search 的调用参数：搜索请求外加执行模式 */
export interface WebSearchParams extends SearchRequest {
  /** fallback（默认）：单引擎、失败降级；aggregate：多引擎并发后融合排序 */
  mode?: SearchMode;
}

export async function handleWebSearch(
  request: WebSearchParams,
  deps: WebSearchToolDeps,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const logger = getLogger();
  const { mode: requestedMode, ...rest } = request;
  const req: SearchRequest = {
    ...rest,
    query: request.query.trim(),
    count: request.count ?? 10,
    page: request.page ?? 1,
    safeSearch: request.safeSearch ?? false,
  };
  delete req.signal;
  if (!req.timeRange) delete req.timeRange;
  if (!req.query) throw new ToolInputError('query 不能为空');

  // 指定了引擎时聚合没有意义：按指定引擎单独搜索
  const preWarnings: string[] = [];
  let mode: SearchMode = requestedMode ?? 'fallback';
  if (mode === 'aggregate' && req.engine) {
    mode = 'fallback';
    preWarnings.push(`已指定引擎 ${req.engine}，mode=aggregate 被忽略`);
  }

  const cacheKey = buildSearchCacheKey('search', req as SearchRequest & Record<string, unknown>, [req.timeRange ?? '', mode]);
  try {
    const cached = await deps.cache.get<SearchResponse>(cacheKey);
    if (cached) {
      logger.debug('搜索缓存命中', { query: redactQuery(req.query), engine: cached.engine });
      return withWarnings({ ...cached, cached: true }, preWarnings);
    }
  } catch (error) {
    logger.warn('读取搜索缓存失败', { error });
  }

  // 合并并发：共享的上游请求只受整体截止时间约束，不绑定任何单个调用方的取消信号，
  // 否则第一个调用方一取消，其余等待者都会跟着失败；调用方取消只是停止等待。
  // 进度通知只发给发起这次共享请求的调用方
  const shared = webFlights.run(cacheKey, () =>
    mode === 'aggregate' ? searchAggregate(req, cacheKey, deps) : searchUncached(req, cacheKey, deps));
  const response = await raceSignal(shared, signal);
  // 返回副本，避免多个调用方共享同一个对象被各自修改
  return withWarnings({ ...response, results: response.results.map(r => ({ ...r })) }, preWarnings);
}

function withWarnings(response: SearchResponse, extra: string[]): SearchResponse {
  const warnings = [...extra, ...(response.warnings ?? [])];
  if (warnings.length === 0) {
    const { warnings: _none, ...rest } = response;
    return rest;
  }
  return { ...response, warnings };
}

/**
 * 候选排序：指定了 timeRange 时，把支持时间过滤的引擎稳定地排到前面，
 * 否则选中的引擎会静默忽略这个过滤条件
 */
function rankCandidates(req: SearchRequest, deps: WebSearchToolDeps): SearchProvider[] {
  const candidates = deps.engineSelector.rank(req, deps.engineRegistry);
  if (!req.timeRange || req.engine) return candidates;
  return [
    ...candidates.filter(e => capabilitiesOf(e.name).timeRange),
    ...candidates.filter(e => !capabilitiesOf(e.name).timeRange),
  ];
}

/** 进度回调：引擎切换时通知客户端 */
function progressReporter(deps: WebSearchToolDeps, total: number, verb: string) {
  if (!deps.onProgress) return undefined;
  return (engine: string, attempt: number) => {
    deps.onProgress?.({ progress: attempt, total, message: `${verb} ${engine}` });
  };
}

async function searchUncached(
  req: SearchRequest,
  cacheKey: string,
  deps: WebSearchToolDeps,
): Promise<SearchResponse> {
  const logger = getLogger();
  const count = req.count ?? 10;
  const page = req.page ?? 1;

  // 自动选引擎的翻页：优先沿用第 1 页的引擎（仍保留降级链）
  const affinityKey = buildEngineAffinityKey('search', req, [req.timeRange ?? '']);
  const rankReq: SearchRequest = { ...req };
  if (!req.engine && page > 1) {
    const sticky = await readAffinity(deps.cache, affinityKey);
    if (sticky) rankReq.engine = sticky;
  }

  const fetchCount = overfetchCount(count, page);
  const candidates = rankCandidates(rankReq, deps);
  const { engine, value: response, attempts } = await runWithFallback({
    candidates,
    limiters: deps.limiters,
    query: req.query,
    kind: 'web',
    // 空结果换引擎重试只在「自动选引擎的第 1 页」做：指定了引擎要尊重用户选择，
    // 翻页时换引擎会让页与页之间的结果对不上
    isEmpty: !req.engine && page === 1 ? (r: SearchResponse) => r.results.length === 0 : undefined,
    deadlineMs: deps.deadlineMs,
    invoke: (e, sig) => e.search({ ...req, count: fetchCount, signal: sig }),
    onAttempt: progressReporter(deps, candidates.length, '正在使用引擎'),
  });

  const deduped = deduplicateResults(stripAds(response.results, deps.adFilter));
  response.results = deduped.slice(0, count).map((r, i) => ({ ...r, position: (page - 1) * count + i + 1 }));
  // 多取的部分被截掉了：说明后面一定还有
  response.hasMore = overfetchHasMore(response.hasMore, deduped.length, count, fetchCount);
  response.engine = engine;
  response.page = page;
  response.cached = false;
  const warnings = [fallbackWarning(req.engine, engine, attempts), unsupportedParamsWarning(engine, req)]
    .filter((w): w is string => !!w);
  if (warnings.length) response.warnings = warnings;
  else delete response.warnings;

  if (!req.engine && page === 1) await writeAffinity(deps.cache, affinityKey, engine);

  // 空结果不缓存：真无结果的情况很少，缓存会让偶发问题持续一整个 TTL。
  // 指定了引擎却降级到别的引擎时也不缓存：缓存 key 里是请求的引擎，
  // 写进去会让之后一个 TTL 内指定该引擎的请求都拿到别家的结果
  if (shouldCacheResponse(req.engine, engine, response.results.length)) {
    try {
      await deps.cache.set(cacheKey, response);
    } catch (error) {
      logger.warn('写入搜索缓存失败', { error });
    }
  }

  return response;
}

/**
 * 倒数排名融合（Reciprocal Rank Fusion）：每个引擎给第 r 名（从 1 开始）的结果贡献 1/(k+r) 分，
 * 同一页面（按规范化 URL 判定）的分数累加；多家引擎都排得靠前的结果自然排到最前。
 * 同分按首次出现的先后（即候选引擎顺序）排列。保留得分最高那家引擎给出的标题 / 摘要，
 * 摘要为空时用其它引擎的补上；sources 记录所有返回了该结果的引擎。
 */
export function fuseResults(lists: Array<{ engine: string; results: SearchResult[] }>, k = RRF_K): SearchResult[] {
  const merged = new Map<string, { result: SearchResult; score: number; best: number; order: number; sources: string[] }>();
  let order = 0;
  for (const { engine, results } of lists) {
    deduplicateResults(results).forEach((r, i) => {
      const key = normalizeUrl(r.url);
      const contribution = 1 / (k + i + 1);
      const entry = merged.get(key);
      if (!entry) {
        merged.set(key, { result: { ...r }, score: contribution, best: contribution, order: order++, sources: [engine] });
        return;
      }
      entry.score += contribution;
      if (!entry.sources.includes(engine)) entry.sources.push(engine);
      if (contribution > entry.best) {
        entry.best = contribution;
        entry.result = { ...r, snippet: r.snippet || entry.result.snippet };
      } else if (!entry.result.snippet && r.snippet) {
        entry.result.snippet = r.snippet;
      }
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(e => ({ ...e.result, source: e.sources[0], sources: e.sources }));
}

/**
 * 聚合模式：并发查询前 AGGREGATE_FANOUT 个可用引擎，RRF 融合后去重切片。
 * 单个引擎失败只记入 warnings；全部失败才报错。不写引擎亲和（每页都重新聚合）。
 */
async function searchAggregate(
  req: SearchRequest,
  cacheKey: string,
  deps: WebSearchToolDeps,
): Promise<SearchResponse> {
  const logger = getLogger();
  const started = Date.now();
  const count = req.count ?? 10;
  const page = req.page ?? 1;
  const fetchCount = overfetchCount(count, page);
  const candidates = rankCandidates(req, deps);
  const fanout = Math.min(AGGREGATE_FANOUT, candidates.length);

  const ok = await runConcurrent({
    candidates,
    fanout,
    limiters: deps.limiters,
    query: req.query,
    kind: 'web',
    deadlineMs: deps.deadlineMs,
    invoke: (e, sig) => e.search({ ...req, count: fetchCount, signal: sig }),
    onAttempt: progressReporter(deps, fanout, '并发查询引擎'),
  });

  const lists = ok.map(({ engine, value }) => ({ engine, results: stripAds(value.results, deps.adFilter) }));
  const fused = fuseResults(lists);
  const engines = ok.filter(o => o.value.results.length > 0).map(o => o.engine);
  const warnings = ok.map(o => unsupportedParamsWarning(o.engine, req)).filter((w): w is string => !!w);
  if (ok.length < fanout) warnings.push(`聚合模式计划查询 ${fanout} 个引擎，实际成功 ${ok.length} 个`);

  const response: SearchResponse = {
    results: fused.slice(0, count).map((r, i) => ({ ...r, position: (page - 1) * count + i + 1 })),
    engine: engines.length > 0 ? engines.join('+') : ok[0].engine,
    engines,
    searchTime: Date.now() - started,
    cached: false,
    page,
    hasMore: overfetchHasMore(ok.some(o => o.value.hasMore), fused.length, count, fetchCount),
  };
  if (warnings.length) response.warnings = warnings;

  // 只有部分引擎成功时不缓存：否则一个 TTL 内都拿不到完整的聚合结果
  if (response.results.length > 0 && ok.length === fanout) {
    try {
      await deps.cache.set(cacheKey, response);
    } catch (error) {
      logger.warn('写入搜索缓存失败', { error });
    }
  }
  return response;
}

/** 等待共享结果，但当前调用方取消时立即放弃（不影响其它等待者） */
export function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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
