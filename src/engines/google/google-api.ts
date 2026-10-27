/**
 * Google Custom Search API 客户端（官方 JSON API）
 *
 * 文档: https://developers.google.com/custom-search/v1/overview
 *
 * 需要两个凭据（配置文件或环境变量二选一）：
 * - API Key:   config.apiKey        或环境变量 GOOGLE_API_KEY（支持逗号分隔多个 key 轮换）
 * - 搜索引擎ID: config.searchEngineId 或环境变量 GOOGLE_CSE_ID（即 cx）
 *
 * 免费额度：每个 API Key 每天 100 次查询，超出返回 429/403。
 */

import type {
  SearchRequest,
  SearchResult,
  ImageSearchRequest,
  ImageSearchResult,
  TimeRange,
} from '../engine-interface.js';
import type { EngineConfig } from '../../config/config-schema.js';
import { getApiKeyManager } from '../../utils/api-key-manager.js';
import { httpRequest, HttpError } from '../../utils/http-client.js';

const API_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
const ENGINE_NAME = 'google';

/** CSE 单次最多返回条数 */
const CSE_MAX_PER_PAGE = 10;
/** CSE 最多可访问到第 100 条（start + num - 1 <= 100） */
const CSE_MAX_RESULTS = 100;

/**
 * 计算 CSE 分页参数。
 * - num：单次 API 调用取多少条（CSE 上限 10）；count > 10 时调用方连续取多次
 * - start：本页第一条的全局序号，按「每页 count 条」计算 —— 偏移必须用 count 而不是 num，
 *   否则 count=30、page=2 时 start=11，和第 1 页重叠
 * 超过 CSE 能访问的前 100 条时提前拦截（Google 会直接返回 400）。
 */
export function computeCsePaging(count: number, page: number): { num: number; start: number } {
  const perPage = Math.max(count, 1);
  const num = Math.min(perPage, CSE_MAX_PER_PAGE);
  const start = (page - 1) * perPage + 1;
  if (start + num - 1 > CSE_MAX_RESULTS) {
    const maxPage = Math.floor((CSE_MAX_RESULTS - num) / perPage) + 1;
    throw new GoogleApiError(
      `Google Custom Search API 最多只能取到前 ${CSE_MAX_RESULTS} 条结果；` +
      `当前每页 ${num} 条，page 最大为 ${maxPage}`,
      400,
    );
  }
  return { num, start };
}

/** Custom Search API 错误（带 HTTP 状态码，便于上层识别配额/鉴权问题） */
export class GoogleApiError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'GoogleApiError';
    this.statusCode = statusCode;
  }
}

// ===== API 响应类型（仅声明用到的字段） =====

interface CseItem {
  title?: string;
  link?: string;
  snippet?: string;
  image?: {
    contextLink?: string;
    height?: number;
    width?: number;
    thumbnailLink?: string;
  };
}

interface CseResponse {
  items?: CseItem[];
  searchInformation?: { totalResults?: string };
  error?: { code?: number; message?: string };
}

export class GoogleCustomSearchClient {
  private config: EngineConfig;
  private cx: string;
  private keyManager = getApiKeyManager(ENGINE_NAME);

  private constructor(config: EngineConfig, cx: string, apiKeys: string[]) {
    this.config = config;
    this.cx = cx;
    this.keyManager.refreshKeys(apiKeys);
  }

  /**
   * 工厂方法：凭据齐全时返回客户端，否则返回 null（调用方跳过 API 策略）。
   * 凭据来源优先级：config.apiKey / config.searchEngineId > 环境变量。
   */
  static create(config: EngineConfig): GoogleCustomSearchClient | null {
    const rawKeys = config.apiKey ?? process.env.GOOGLE_API_KEY ?? '';
    const apiKeys = rawKeys
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
    const cx = config.searchEngineId ?? process.env.GOOGLE_CSE_ID ?? '';

    if (apiKeys.length === 0 || !cx) {
      return null;
    }
    return new GoogleCustomSearchClient(config, cx, apiKeys);
  }

  /** 网页搜索，返回结果列表与估计总数 */
  async search(
    request: SearchRequest,
    count: number,
    page: number,
  ): Promise<{ results: SearchResult[]; totalResults?: number }> {
    const params = this.buildBaseParams(request.query, request);
    const { num, start } = computeCsePaging(count, page);
    params.set('num', String(num));
    // CSE 单页最多 10 条：count > 10 时连续取多页再按条目切片，旧实现会把 count 静默截到 10
    const collected: CseItem[] = [];
    let total: string | undefined;
    let cursor = start;
    while (collected.length < count && cursor + num - 1 <= CSE_MAX_RESULTS) {
      const pageParams = new URLSearchParams(params);
      pageParams.set('start', String(cursor));
      const data = await this.callApi(pageParams, request.signal);
      total ??= data.searchInformation?.totalResults;
      const items = data.items ?? [];
      collected.push(...items);
      if (items.length < num) break; // 没有更多了
      cursor += num;
    }
    const items = collected.slice(0, count);

    const results: SearchResult[] = items.map((item, i) => ({
      title: item.title ?? '',
      url: item.link ?? '',
      snippet: item.snippet ?? '',
      source: ENGINE_NAME,
      position: start + i,
    }));

    return {
      results,
      totalResults: total !== undefined ? Number(total) : undefined,
    };
  }

  /** 图片搜索（searchType=image） */
  async imageSearch(
    request: ImageSearchRequest,
    count: number,
    page: number,
  ): Promise<{ results: ImageSearchResult[] }> {
    const params = this.buildBaseParams(request.query, request);
    params.set('searchType', 'image');

    // 尺寸过滤：API 接受 huge/icon/large/medium/small/xlarge/xxlarge
    if (request.imageSize) {
      const sizeMap: Record<string, string> = {
        small: 'small',
        medium: 'medium',
        large: 'large',
      };
      const mapped = sizeMap[request.imageSize];
      if (mapped) params.set('imgSize', mapped);
    }

    // 类型过滤：photo/clipart 用 imgType；gif 用 fileType；transparent 用 imgColorType
    if (request.imageType === 'gif') {
      params.set('fileType', 'gif');
    } else if (request.imageType === 'transparent') {
      params.set('imgColorType', 'trans');
    } else if (request.imageType) {
      params.set('imgType', request.imageType);
    }

    const { num, start } = computeCsePaging(count, page);
    // CSE 单页最多 10 条：count > 10 时连续取多页再按条目切片，旧实现会把 count 静默截到 10
    const collected: CseItem[] = [];
    let cursor = start;
    while (collected.length < count && cursor + num - 1 <= CSE_MAX_RESULTS) {
      const pageParams = new URLSearchParams(params);
      pageParams.set('num', String(num));
      pageParams.set('start', String(cursor));
      const data = await this.callApi(pageParams, request.signal);
      const items = data.items ?? [];
      collected.push(...items);
      if (items.length < num) break; // 没有更多了
      cursor += num;
    }
    const items = collected.slice(0, count);

    const results: ImageSearchResult[] = items.map((item, i) => ({
      title: item.title ?? '',
      imageUrl: item.link ?? '',
      thumbnailUrl: item.image?.thumbnailLink ?? item.link ?? '',
      sourceUrl: item.image?.contextLink ?? '',
      width: item.image?.width,
      height: item.image?.height,
      source: ENGINE_NAME,
      position: start + i,
    }));

    return { results };
  }

  /** 是否有可用的 API Key（全部 key 冷却中 / 配额耗尽时为 false） */
  hasUsableKey(): boolean {
    return this.keyManager.hasUsableKey();
  }

  // ===== 内部方法 =====

  /** 构建公共查询参数（key/cx 之外的部分） */
  private buildBaseParams(
    query: string,
    request: { region?: string; language?: string; safeSearch?: boolean; timeRange?: TimeRange },
  ): URLSearchParams {
    const params = new URLSearchParams();
    params.set('cx', this.cx);
    params.set('q', query);
    if (request.region) {
      params.set('gl', request.region);
    }
    if (request.language) {
      params.set('hl', request.language);
    }
    params.set('safe', request.safeSearch ? 'active' : 'off');
    if (request.timeRange) {
      // dateRestrict：d1 / w1 / m1 / y1
      params.set('dateRestrict', `${request.timeRange[0]}1`);
    }
    return params;
  }

  /**
   * 调用 API，处理 key 轮换与失败上报。
   * API Key 通过 X-goog-api-key 请求头传递（Google 官方支持），
   * 不再拼在 URL 查询串里 —— 避免出现在日志、代理访问记录与错误信息中。
   */
  private async callApi(params: URLSearchParams, signal?: AbortSignal): Promise<CseResponse> {
    const key = this.keyManager.getKey();
    if (!key) {
      const retryAt = this.keyManager.nextAvailableAt();
      const wait = retryAt > Date.now() ? `，约 ${Math.ceil((retryAt - Date.now()) / 1000)} 秒后恢复` : '';
      throw new GoogleApiError(`Google Custom Search API 没有可用的 API Key（均在冷却或配额已耗尽${wait}）`);
    }

    const url = new URL(API_ENDPOINT);
    url.search = params.toString();

    let response;
    try {
      response = await httpRequest(url.toString(), {
        headers: { Accept: 'application/json', 'X-goog-api-key': key },
        timeoutMs: this.config.timeout,
        signal,
        throwOnHttpError: false,
        useProxy: true,
      });
    } catch (error) {
      // 网络错误与 Key 无关，不上报
      const msg = error instanceof HttpError || error instanceof Error ? error.message : String(error);
      throw new GoogleApiError(`Google Custom Search API 请求失败: ${msg}`);
    }

    if (!response.ok) {
      const body = response.text().slice(0, 200);
      const error = new GoogleApiError(
        `Google Custom Search API 请求失败: HTTP ${response.status} ${response.statusText} - ${body}`,
        response.status,
      );
      this.keyManager.reportFailure(key, error);
      throw error;
    }

    let data: CseResponse;
    try {
      data = response.json<CseResponse>();
    } catch (error) {
      throw new GoogleApiError(
        `Google Custom Search API 返回了无法解析的响应: ${error instanceof Error ? error.message : String(error)}`,
        response.status,
      );
    }
    if (data.error) {
      const error = new GoogleApiError(
        `Google Custom Search API 返回错误: ${data.error.code} ${data.error.message ?? ''}`.trim(),
        data.error.code,
      );
      this.keyManager.reportFailure(key, error);
      throw error;
    }

    this.keyManager.reportSuccess(key);
    return data;
  }
}
