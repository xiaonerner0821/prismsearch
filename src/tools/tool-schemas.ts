/**
 * 工具参数 / 输出 schema —— 唯一事实来源
 *
 * - inputSchema：交给 MCP SDK，自动转为 JSON Schema 并在调用时校验；
 *   count / page / timeout 都有整数与上下界约束（旧实现允许 count=-1、page=1e9、timeout=0）
 * - outputSchema：声明 structuredContent 的结构，客户端可直接按字段消费，
 *   同时 content 中保留同样的 JSON 文本以兼容只读 text 的旧客户端
 */

import { z } from 'zod';
import { BUILTIN_ENGINE_NAMES } from '../config/config-schema.js';

const engineEnum = z.enum(BUILTIN_ENGINE_NAMES);

/** 实现了 imageSearch 的内置引擎；新增图片能力时需同步这里，image-search 运行时仍会二次校验 */
export const IMAGE_ENGINE_NAMES = ['google', 'bing', 'brave', 'baidu'] as const;
const imageEngineEnum = z.enum(IMAGE_ENGINE_NAMES);

// ===== 输入 =====

const baseSearchInput = z.object({
  query: z.string().trim().min(1).max(500).describe('Search keywords'),
  engine: engineEnum.optional().describe('Search engine to use; auto-selected (with fallback) if omitted'),
  region: z.string().max(10).optional().describe('Region code, e.g. cn, us, hk'),
  language: z.string().max(20).optional().describe('Language code, e.g. zh-CN, en'),
  count: z.number().int().min(1).max(50).default(10).describe('Number of results (1-50)'),
  page: z.number().int().min(1).max(10).default(1).describe('Page number (1-10)'),
  safeSearch: z.boolean().default(false).describe('Enable safe search'),
});

export const webSearchInput = baseSearchInput.extend({
  timeRange: z.enum(['day', 'week', 'month', 'year']).optional()
    .describe('Only return results published within the past day/week/month/year (engines without support ignore it and add a warning)'),
  mode: z.enum(['fallback', 'aggregate']).default('fallback')
    .describe('fallback: one engine, switch on failure (default). aggregate: query 2-3 engines concurrently and merge results by rank fusion'),
});

export const imageSearchInput = baseSearchInput.extend({
  engine: imageEngineEnum.optional().describe('Image-capable engine to use; auto-selected (with fallback) if omitted'),
  imageSize: z.enum(['small', 'medium', 'large']).optional().describe('Filter by image size'),
  imageType: z.enum(['photo', 'clipart', 'gif', 'transparent']).optional().describe('Filter by image type'),
  includeThumbnails: z.boolean().default(false).describe('Inline small thumbnails as base64 data URIs (max 20, 50KB each)'),
});

export const fetchPageInput = z.object({
  url: z.string().url().max(4096).describe('URL of the webpage to fetch (http/https only)'),
  format: z.enum(['html', 'text', 'markdown']).default('markdown').describe('Response format'),
  timeout: z.number().int().min(1000).max(120_000).optional().describe('Timeout in milliseconds (1000-120000)'),
  method: z.enum(['http', 'browser']).optional().describe('http (fast) or browser (renders JavaScript)'),
  waitForSelector: z.string().max(500).optional().describe('Browser only: CSS selector to wait for before extracting'),
  maxLength: z.number().int().min(100).max(1_000_000).optional()
    .describe('Max characters of content to return (default 20000); use nextStartIndex to read the rest'),
  startIndex: z.number().int().min(0).optional()
    .describe('Character offset to start from (for reading long pages in segments; default 0)'),
});

export const wechatSearchInput = z.object({
  query: z.string().trim().min(1).max(200).describe('Search keywords (Chinese works best)'),
  count: z.number().int().min(1).max(10).default(10).describe('Number of results (1-10)'),
  page: z.number().int().min(1).max(10).default(1).describe('Page number (1-10)'),
});

export const listEnginesInput = z.object({});

// ===== 输出 =====

const searchResult = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  source: z.string(),
  position: z.number(),
  timestamp: z.string().optional(),
  sources: z.array(z.string()).optional(),
});

export const searchOutput = z.object({
  results: z.array(searchResult),
  totalResults: z.number().optional(),
  engine: z.string(),
  searchTime: z.number(),
  cached: z.boolean(),
  page: z.number(),
  hasMore: z.boolean(),
  /** 聚合模式下实际成功返回结果的引擎 */
  engines: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});

export const imageSearchOutput = z.object({
  results: z.array(z.object({
    title: z.string(),
    imageUrl: z.string(),
    thumbnailUrl: z.string(),
    sourceUrl: z.string(),
    sourceTitle: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    position: z.number(),
    source: z.string(),
    thumbnailBase64: z.string().optional(),
  })),
  engine: z.string(),
  searchTime: z.number(),
  cached: z.boolean(),
  page: z.number(),
  hasMore: z.boolean(),
  warnings: z.array(z.string()).optional(),
});

export const fetchPageOutput = z.object({
  url: z.string(),
  content: z.string(),
  rawHtml: z.string().optional(),
  title: z.string().optional(),
  statusCode: z.number(),
  contentType: z.string().optional(),
  contentLength: z.number().optional(),
  fetchTime: z.number(),
  fetchedBy: z.string().optional(),
  cached: z.boolean().optional(),
  /** content 被 maxLength 截断（后面还有内容，用 nextStartIndex 续读） */
  truncated: z.boolean().optional(),
  /** 完整正文的字符数 */
  totalLength: z.number().optional(),
  /** 下一段的 startIndex；没有更多内容时不出现 */
  nextStartIndex: z.number().optional(),
  /** 响应体超过 maxBytes，只抓到了开头部分 */
  bodyTruncated: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
});

export const listEnginesOutput = z.object({
  engines: z.array(z.object({
    name: z.string(),
    displayName: z.string(),
    type: z.enum(['scraper', 'api']),
    enabled: z.boolean(),
    available: z.boolean(),
    priority: z.number(),
    regions: z.array(z.string()),
    tools: z.array(z.string()),
    supportsImageSearch: z.boolean(),
    /** 该引擎是否支持各可选搜索参数（不支持的参数会被忽略并在结果 warnings 中说明） */
    capabilities: z.object({
      safeSearch: z.boolean(),
      region: z.boolean(),
      language: z.boolean(),
      timeRange: z.boolean(),
    }),
    stats: z.object({
      avgLatency: z.number(),
      successRate: z.number(),
      lastUsed: z.number().optional(),
      lastError: z.string().optional(),
    }),
    /** 图片搜索的独立统计（仅支持图片搜索的引擎有） */
    imageStats: z.object({
      available: z.boolean(),
      avgLatency: z.number(),
      successRate: z.number(),
      lastUsed: z.number().optional(),
      lastError: z.string().optional(),
    }).optional(),
  })),
  totalConfigured: z.number(),
  totalEnabled: z.number(),
  totalAvailable: z.number(),
  workers: z.array(z.object({
    name: z.string(),
    url: z.string(),
    healthy: z.boolean(),
    capabilities: z.array(z.string()),
    inFlight: z.number(),
    lastError: z.string().optional(),
  })).optional(),
});

export type WebSearchInput = z.infer<typeof webSearchInput>;
export type ImageSearchInput = z.infer<typeof imageSearchInput>;
export type FetchPageInput = z.infer<typeof fetchPageInput>;
export type WechatSearchInput = z.infer<typeof wechatSearchInput>;
