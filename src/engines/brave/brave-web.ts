/**
 * Brave Search API 引擎（官方 JSON API）
 *
 * 文档: https://brave.com/search/api/
 * 免费额度：每月 2000 次，每秒 1 次，无需绑定信用卡。
 *
 * 凭据（二选一）：
 * - config.apiKey（支持逗号分隔多个 key 轮换）
 * - 环境变量 BRAVE_API_KEY
 */

import type {
  SearchProvider,
  SearchRequest,
  SearchResponse,
  SearchResult,
  EngineStatus,
  ImageSearchRequest,
  ImageSearchResponse,
  ImageSearchResult,
  TimeRange,
} from '../engine-interface.js';
import type { EngineConfig } from '../../config/config-schema.js';
import { EngineStats } from '../engine-stats.js';
import { getApiKeyManager } from '../../utils/api-key-manager.js';
import { httpRequest } from '../../utils/http-client.js';

const WEB_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const IMAGE_ENDPOINT = 'https://api.search.brave.com/res/v1/images/search';
/** Web 搜索单页上限 */
const BRAVE_WEB_MAX_COUNT = 20;
/** Web 搜索 offset（页码，从 0 开始）上限 */
const BRAVE_WEB_MAX_OFFSET = 9;
/** 图片搜索单次上限；图片接口不支持 offset，翻页通过「多取后切片」实现 */
const BRAVE_IMAGE_MAX_COUNT = 200;
const ENGINE_NAME = 'brave';

/** Brave API 错误（带 HTTP 状态码） */
export class BraveApiError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'BraveApiError';
    this.statusCode = statusCode;
  }
}

// ===== API 响应类型（仅声明用到的字段） =====

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveImageResult {
  title?: string;
  url?: string;               // 来源页面 URL
  source?: string;            // 来源站点
  properties?: { url?: string; width?: number; height?: number }; // 原图
  thumbnail?: { src?: string };
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
  results?: BraveImageResult[];   // 图片搜索在顶层
}

/** 将我们通用的语言代码映射为 Brave search_lang 取值 */
function mapSearchLang(language?: string): string | undefined {
  if (!language) return undefined;
  const lower = language.toLowerCase();
  if (lower === 'zh-cn' || lower === 'zh') return 'zh-hans';
  if (lower === 'zh-tw' || lower === 'zh-hk') return 'zh-hant';
  return lower.split('-')[0];
}

/**
 * 区域码 → Brave country（ISO 3166-1 alpha-2）。
 * 常用的 'uk' 不是合法国家码（英国是 GB），直接大写会被 API 以 422 拒绝
 */
export function mapCountry(region: string): string {
  const upper = region.toUpperCase();
  if (upper === 'UK') return 'GB';
  return upper;
}

export class BraveWebEngine implements SearchProvider {
  readonly name = ENGINE_NAME;
  readonly displayName = 'Brave Search';
  private config: EngineConfig;
  private stats = new EngineStats();
  private imageStats = new EngineStats();
  private lastError?: string;
  private keyManager = getApiKeyManager(ENGINE_NAME);

  constructor(config: EngineConfig) {
    this.config = config;
    const rawKeys = config.apiKey ?? process.env.BRAVE_API_KEY ?? '';
    const keys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
    this.keyManager.refreshKeys(keys);
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const startTime = Date.now();
    const count = request.count ?? 10;
    const page = request.page ?? 1;

    try {
      // Brave Web API：count 上限 20；offset 是「以 count 为单位的页码」（从 0 开始，上限 9）。
      // count ≤ 20 时一次请求即可；超过 20 时按 20 条一页连续取多页再按条目切片，
      // 旧实现直接把 count 截到 20，用户要 30 条只拿到 20 条
      const sliceStart = (page - 1) * count;
      const sliceEnd = sliceStart + count;
      const perPage = count <= BRAVE_WEB_MAX_COUNT ? Math.max(count, 1) : BRAVE_WEB_MAX_COUNT;
      const firstPage = Math.floor(sliceStart / perPage);
      const lastPage = Math.floor((sliceEnd - 1) / perPage);
      if (firstPage > BRAVE_WEB_MAX_OFFSET) {
        throw new BraveApiError(
          `Brave Search API 最多只能取到前 ${(BRAVE_WEB_MAX_OFFSET + 1) * perPage} 条结果`,
          400,
        );
      }

      const collected: BraveWebResult[] = [];
      for (let p = firstPage; p <= Math.min(lastPage, BRAVE_WEB_MAX_OFFSET); p++) {
        const params = this.buildBaseParams(request.query, request);
        params.set('count', String(perPage));
        if (p > 0) params.set('offset', String(p));
        params.set('text_decorations', 'false');
        const data = await this.callApi(WEB_ENDPOINT, params, request.signal);
        const items = data.web?.results ?? [];
        collected.push(...items);
        if (items.length < perPage) break; // 没有更多了
      }

      const skip = sliceStart - firstPage * perPage;
      const items = collected.slice(skip, skip + count);
      const results: SearchResult[] = items.map((item, i) => ({
        title: item.title ?? '',
        url: item.url ?? '',
        snippet: item.description ?? '',
        source: this.name,
        position: sliceStart + i + 1,
      }));

      this.stats.record(true, Date.now() - startTime);
      this.lastError = undefined;
      return {
        results,
        engine: this.name,
        searchTime: Date.now() - startTime,
        cached: false,
        page,
        hasMore: results.length >= count,
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.stats.record(false, Date.now() - startTime, error);
      throw error;
    }
  }

  async imageSearch(request: ImageSearchRequest): Promise<ImageSearchResponse> {
    const startTime = Date.now();
    const count = request.count ?? 10;
    const page = request.page ?? 1;

    try {
      const params = this.buildBaseParams(request.query, request);
      // Brave 图片接口不接受 offset：要取第 N 页只能一次多取前 N*count 条，再切片
      const perPage = Math.min(Math.max(count, 1), BRAVE_WEB_MAX_COUNT);
      const take = Math.min(page * perPage, BRAVE_IMAGE_MAX_COUNT);
      params.set('count', String(take));

      const data = await this.callApi(IMAGE_ENDPOINT, params, request.signal);
      const items = (data.results ?? []).slice((page - 1) * perPage, page * perPage);

      const results: ImageSearchResult[] = items.map((item, i) => ({
        title: item.title ?? '',
        imageUrl: item.properties?.url ?? '',
        thumbnailUrl: item.thumbnail?.src ?? '',
        sourceUrl: item.url ?? '',
        sourceTitle: item.source,
        width: item.properties?.width,
        height: item.properties?.height,
        source: this.name,
        position: (page - 1) * perPage + i + 1,
      }));

      this.imageStats.record(true, Date.now() - startTime);
      return {
        results,
        engine: this.name,
        searchTime: Date.now() - startTime,
        cached: false,
        page,
        hasMore: results.length >= perPage && take < BRAVE_IMAGE_MAX_COUNT,
      };
    } catch (error) {
      this.imageStats.record(false, Date.now() - startTime, error);
      throw error;
    }
  }

  // ===== 内部方法 =====

  /** 构建公共查询参数（token 之外的部分） */
  private buildBaseParams(
    query: string,
    request: { region?: string; language?: string; safeSearch?: boolean; timeRange?: TimeRange },
  ): URLSearchParams {
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('safesearch', request.safeSearch ? 'strict' : 'moderate');
    if (request.timeRange) {
      // freshness：pd / pw / pm / py（过去一天 / 周 / 月 / 年）
      params.set('freshness', `p${request.timeRange[0]}`);
    }
    if (request.region) {
      params.set('country', mapCountry(request.region));
    }
    const lang = mapSearchLang(request.language);
    if (lang) {
      params.set('search_lang', lang);
    }
    return params;
  }

  /** 调用 API，处理 token 轮换与失败上报 */
  private async callApi(endpoint: string, params: URLSearchParams, signal?: AbortSignal): Promise<BraveSearchResponse> {
    const key = this.keyManager.getKey();
    if (!key) {
      throw new BraveApiError(
        'Brave Search API 没有可用的 API Key（请配置 apiKey 或环境变量 BRAVE_API_KEY；免费注册: https://brave.com/search/api/）',
      );
    }

    const url = new URL(endpoint);
    url.search = params.toString();

    let response;
    try {
      response = await httpRequest(url.toString(), {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': key,
        },
        timeoutMs: this.config.timeout,
        signal,
        throwOnHttpError: false,
      });
    } catch (error) {
      // 网络错误与 Key 无关，不上报
      throw new BraveApiError(
        `Brave Search API 请求失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const body = response.text().slice(0, 200);
      const error = new BraveApiError(
        `Brave Search API 请求失败: HTTP ${response.status} ${response.statusText} - ${body}`,
        response.status,
      );
      this.keyManager.reportFailure(key, error);
      throw error;
    }

    let data: BraveSearchResponse;
    try {
      data = response.json<BraveSearchResponse>();
    } catch (error) {
      throw new BraveApiError(
        `Brave Search API 返回了无法解析的响应: ${error instanceof Error ? error.message : String(error)}`,
        response.status,
      );
    }
    this.keyManager.reportSuccess(key);
    return data;
  }

  getStatus(): EngineStatus {
    return {
      name: this.name,
      available: this.isAvailable(),
      latency: this.stats.getAvgLatency(),
      successRate: this.stats.getSuccessRate(),
      lastUsed: this.stats.getLastUsed(),
      lastError: this.lastError,
    };
  }

  isAvailable(): boolean {
    if (!this.config.enabled) return false;
    // 未配置 API Key（或全部 key 处于配额耗尽冷却中）不可用
    if (!this.keyManager.hasUsableKey()) return false;
    // 连续失败超过5次视为不可用
    return this.stats.isAvailable();
  }

  isImageAvailable(): boolean {
    if (!this.config.enabled) return false;
    if (!this.keyManager.hasUsableKey()) return false;
    return this.imageStats.isAvailable();
  }

  getImageStatus(): EngineStatus {
    return this.imageStats.toStatus(this.name, this.isImageAvailable());
  }

  tryAcquire(kind: 'web' | 'image'): boolean {
    return kind === 'image' ? this.imageStats.tryAcquire() : this.stats.tryAcquire();
  }
}
