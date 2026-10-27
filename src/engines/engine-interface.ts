/**
 * 搜索引擎统一接口定义
 */

// ===== 网页搜索接口 =====

/** 结果发布时间范围过滤 */
export type TimeRange = 'day' | 'week' | 'month' | 'year';

// 搜索请求参数
export interface SearchRequest {
  query: string;           // 搜索关键词
  engine?: string;         // 指定引擎名
  region?: string;         // 搜索区域（如 'cn', 'us', 'hk'）
  language?: string;       // 语言（如 'zh-CN', 'en'）
  count?: number;          // 结果数量（默认10）
  page?: number;           // 页码（默认1）
  safeSearch?: boolean;    // 安全搜索
  /** 只返回该时间范围内发布 / 更新的结果；不支持的引擎忽略（工具层给出 warning） */
  timeRange?: TimeRange;
  /** 取消信号（客户端取消 / 整体截止时间）；不参与缓存 key */
  signal?: AbortSignal;
}

// 单条搜索结果
export interface SearchResult {
  title: string;           // 标题
  url: string;             // 链接
  snippet: string;         // 摘要
  source: string;          // 来源引擎名
  position: number;        // 排序位置
  timestamp?: string;      // 时间
  /** 聚合模式下返回了该结果的全部引擎（按各自排名先后） */
  sources?: string[];
}

// 搜索响应
export interface SearchResponse {
  results: SearchResult[];
  totalResults?: number;   // 估计总数
  engine: string;          // 实际使用的引擎
  searchTime: number;      // 搜索耗时(ms)
  cached: boolean;         // 是否来自缓存
  page: number;
  hasMore: boolean;
  /** 工具层附加的提示（如所用引擎不支持某个参数而被忽略） */
  warnings?: string[];
  /** 聚合模式下实际返回了结果的引擎 */
  engines?: string[];
}

// ===== 图片搜索接口 =====

// 图片搜索请求参数
export interface ImageSearchRequest {
  query: string;                          // 搜索关键词
  engine?: string;                        // 指定引擎名
  region?: string;                        // 搜索区域
  language?: string;                      // 语言
  count?: number;                         // 结果数量（默认10）
  page?: number;                          // 页码（默认1）
  safeSearch?: boolean;                   // 安全搜索
  imageSize?: 'small' | 'medium' | 'large';   // 图片尺寸过滤
  imageType?: 'photo' | 'clipart' | 'gif' | 'transparent'; // 图片类型
  includeThumbnails?: boolean;            // 是否返回base64缩略图（默认false）
  /** 取消信号；不参与缓存 key */
  signal?: AbortSignal;
}

// 单条图片搜索结果
export interface ImageSearchResult {
  title: string;           // 图片标题
  imageUrl: string;        // 原图URL
  thumbnailUrl: string;    // 缩略图URL
  sourceUrl: string;       // 来源页面URL
  sourceTitle?: string;    // 来源页面标题
  width?: number;          // 原图宽度
  height?: number;         // 原图高度
  position: number;        // 排序位置
  source: string;          // 来源引擎名
  thumbnailBase64?: string; // base64缩略图（includeThumbnails=true时）
}

// 图片搜索响应
export interface ImageSearchResponse {
  results: ImageSearchResult[];
  engine: string;          // 实际使用的引擎
  searchTime: number;      // 搜索耗时(ms)
  cached: boolean;         // 是否来自缓存
  page: number;
  hasMore: boolean;
  /** 给调用方的提示（如指定的引擎不可用、已降级） */
  warnings?: string[];
}

// ===== 引擎状态 =====

// 引擎状态
export interface EngineStatus {
  name: string;
  available: boolean;
  latency: number;         // 平均延迟(ms)
  successRate: number;     // 成功率(0-1)
  lastUsed?: number;       // 上次使用时间戳
  lastError?: string;      // 上次错误信息
}

// 搜索引擎提供者接口 — 所有引擎必须实现
export interface SearchProvider {
  readonly name: string;
  readonly displayName: string;
  search(request: SearchRequest): Promise<SearchResponse>;
  getStatus(): EngineStatus;
  isAvailable(): boolean;
  // 图片搜索（可选，非所有引擎都支持）
  imageSearch?(request: ImageSearchRequest): Promise<ImageSearchResponse>;
  /** 图片搜索是否可用（独立熔断）；未实现时视同 isAvailable() */
  isImageAvailable?(): boolean;
  /** 图片搜索的统计（成功率、延迟等）；未实现时视同 getStatus() */
  getImageStatus?(): EngineStatus;
  /**
   * 真正发请求前申请执行名额（熔断器 half-open 状态只放行一个探测）。
   * 返回 false 表示熔断中，调用方应跳过该引擎。未实现时视为恒放行。
   */
  tryAcquire?(kind: 'web' | 'image'): boolean;
}

/** 引擎拿到的页面里解析不出结果，且页面也不像「真的没有结果」——多半是反爬或页面改版 */
export class EngineParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineParseError';
  }
}

/** 引擎遇到验证码 / 反爬挑战页 */
export class EngineBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineBlockedError';
  }
}

/**
 * 该错误是否应当计入引擎熔断。
 *
 * - 4xx（429 除外）：参数不合法、查询被拒、鉴权失败等，换个引擎也一样，属于调用方问题，
 *   计入熔断会让一次坏请求把引擎打到熔断，进而连累后续所有正常查询
 * - 主动取消（aborted）：用户取消或整体截止时间到了，与引擎健康无关
 * - 429 / 5xx / 网络错误 / 超时 / 验证码 / 解析失败：引擎侧问题，计入
 */
export function isPenalizingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;

  // AbortSignal 取消：AbortError / DOMException('AbortError')
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError') return false;

  // HttpError.code === 'ABORTED'
  if ((error as { code?: unknown }).code === 'ABORTED') return false;

  // HttpError.status / ScraperHttpError.status / GoogleApiError.statusCode / BraveApiError.statusCode
  const status = (error as { status?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return false;
  }
  return true;
}

/**
 * 依次尝试多个地址 / 策略都失败时，挑出最能说明问题的那个错误抛给调用方。
 *
 * 旧实现一律抛最后一次的错误：主域名明明是「需要 JS 渲染」或「验证码」，
 * 却被最后一个备用域名的 DNS / 网络错误（如 "fetch failed"）盖住，排查方向完全跑偏。
 * 优先级：主动取消 > 验证码 / 反爬 > 解析失败 > 有 HTTP 状态码 > 其他 > 超时 / 网络错误；
 * 同级取最早出现的（主地址的错误通常比备用地址更有代表性）。
 */
export function pickMeaningfulError(errors: unknown[]): unknown {
  let best: unknown;
  let bestRank = -1;
  for (const error of errors) {
    const rank = errorRank(error);
    if (rank > bestRank) {
      best = error;
      bestRank = rank;
    }
  }
  return best;
}

function errorRank(error: unknown): number {
  if (!error || typeof error !== 'object') return 2;
  const e = error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
  if (e.name === 'AbortError' || e.code === 'ABORTED') return 6;
  if (error instanceof EngineBlockedError) return 5;
  if (error instanceof EngineParseError) return 4;
  if (typeof (e.status ?? e.statusCode) === 'number') return 3;
  if (e.code === 'TIMEOUT' || e.code === 'NETWORK' || e.name === 'TimeoutError') return 1;
  return 2;
}
