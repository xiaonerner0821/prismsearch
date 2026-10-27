/**
 * Bing 网页搜索引擎（爬虫方式）
 */

import * as cheerio from 'cheerio';
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult, EngineStatus, ImageSearchRequest, ImageSearchResponse } from '../engine-interface.js';
import { EngineBlockedError, pickMeaningfulError, EngineParseError } from '../engine-interface.js';
import type { EngineConfig } from '../../config/config-schema.js';
import { EngineStats } from '../engine-stats.js';
import { BingImageEngine } from './bing-image.js';
import { assertParsed, fetchSearchPage } from '../scraper-http.js';
import { isAdElement } from '../ad-filter.js';

/** 区域码 → Bing 市场码（mkt）。未列出的区域只传 cc */
const BING_MARKETS: Record<string, string> = {
  cn: 'zh-CN',
  hk: 'zh-HK',
  tw: 'zh-TW',
  us: 'en-US',
  uk: 'en-GB',
  gb: 'en-GB',
  jp: 'ja-JP',
  de: 'de-DE',
  fr: 'fr-FR',
  ru: 'ru-RU',
};

/** Bing 忽略了翻页参数（请求非首页却返回第 1 页） */
export class BingPaginationIgnoredError extends EngineParseError {
  constructor() {
    super('Bing 忽略了翻页参数（返回的仍是第 1 页），无法获取后续页结果');
    this.name = 'BingPaginationIgnoredError';
  }
}

/** Bing HTML 版每页实际返回的条数（约值） */
const BING_PAGE_SIZE = 10;
/** 一次搜索最多拼接的子请求数 */
const BING_MAX_SUBREQUESTS = 6;

/**
 * 时间过滤：ez1 / ez2 / ez3 = 过去 24 小时 / 一周 / 一月；
 * 一年用自定义区间 ez5_<起始日>_<结束日>（自 1970-01-01 起的天数）
 */
export function bingTimeFilter(range: NonNullable<SearchRequest['timeRange']>, now = Date.now()): string {
  switch (range) {
    case 'day': return 'ex1:"ez1"';
    case 'week': return 'ex1:"ez2"';
    case 'month': return 'ex1:"ez3"';
    default: {
      const today = Math.floor(now / 86_400_000);
      return `ex1:"ez5_${today - 365}_${today}"`;
    }
  }
}

export class BingWebEngine implements SearchProvider {
  readonly name = 'bing';
  readonly displayName = 'Bing';
  private config: EngineConfig;
  private stats = new EngineStats();
  private imageStats = new EngineStats();
  private lastError?: string;
  private imageEngine?: BingImageEngine;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const startTime = Date.now();
    const count = request.count ?? 10;
    const page = request.page ?? 1;

    // 同源降级：依次尝试主 URL 和备用 URL
    const baseUrls = [this.config.baseUrl, ...(this.config.alternateUrls ?? [])];
    const errors: unknown[] = [];

    for (const baseUrl of baseUrls) {
      try {
        const { results, hasMore } = await this.fetchAndParse(baseUrl, request, count, page);
        const searchTime = Date.now() - startTime;
        this.stats.record(true, searchTime);
        this.lastError = undefined;
        return {
          results,
          engine: this.name,
          searchTime,
          cached: false,
          page,
          hasMore,
        };
      } catch (error) {
        errors.push(error);
      }
    }

    const searchTime = Date.now() - startTime;
    const lastError = pickMeaningfulError(errors);
    this.lastError = lastError instanceof Error ? (lastError as Error).message : String(lastError);
    this.stats.record(false, searchTime, lastError);
    throw lastError;
  }

  /**
   * 对指定 baseUrl 取出第 page 页的 count 条结果。
   *
   * Bing HTML 版基本忽略 count，每页固定约 10 条（常常只有 8~9 条，夹杂广告位时更少）。
   * 旧实现按 first=(page-1)*count+1 计算偏移、一次请求取完，count>10 时只拿到一页，
   * 翻页还会跳过结果。现在按「实际返回条数」推进偏移，多次请求拼接到 count 条：
   * - 首个子请求失败按引擎失败处理（交给同源 / 异源降级）；后续子请求失败则返回已拿到的部分
   * - 子页结果不足半页、或全部与已有结果重复时视为到底
   */
  private async fetchAndParse(
    baseUrl: string, request: SearchRequest, count: number, page: number,
  ): Promise<{ results: SearchResult[]; hasMore: boolean }> {
    const sliceStart = (page - 1) * count;
    const maxRequests = Math.min(BING_MAX_SUBREQUESTS, Math.ceil(count / BING_PAGE_SIZE) + 1);
    const collected: SearchResult[] = [];
    const seen = new Set<string>();
    let offset = sliceStart;
    let lastPageSize = 0;

    for (let i = 0; i < maxRequests && collected.length < count; i++) {
      let pageResults: SearchResult[];
      try {
        pageResults = await this.fetchOnePage(baseUrl, request, offset);
      } catch (error) {
        if (i === 0) throw error;
        // 拼接中途 Bing 不再翻页（或子请求失败）：返回已拿到的部分，且不再声称还有更多
        if (error instanceof BingPaginationIgnoredError) lastPageSize = 0;
        break;
      }
      lastPageSize = pageResults.length;
      let fresh = 0;
      for (const r of pageResults) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        collected.push(r);
        fresh++;
      }
      offset += pageResults.length;
      if (fresh === 0 || pageResults.length < BING_PAGE_SIZE / 2) break;
    }

    const results = collected.slice(0, count).map((r, i) => ({ ...r, position: sliceStart + i + 1 }));
    const hasMore = collected.length > count || (collected.length >= count && lastPageSize >= BING_PAGE_SIZE / 2);
    return { results, hasMore };
  }

  /** 请求一页 Bing 结果（从第 offset+1 条开始） */
  private async fetchOnePage(baseUrl: string, request: SearchRequest, offset: number): Promise<SearchResult[]> {
    const url = new URL(baseUrl);
    url.searchParams.set('q', request.query);
    url.searchParams.set('count', String(BING_PAGE_SIZE));
    if (offset > 0) {
      url.searchParams.set('first', String(offset + 1));
    }
    if (request.timeRange) {
      url.searchParams.set('filters', bingTimeFilter(request.timeRange));
    }
    if (request.language) {
      url.searchParams.set('setlang', request.language);
    }
    // 区域：mkt 决定结果市场（如 en-GB），cc 决定国家（ISO 3166-1 alpha-2）
    if (request.region) {
      const region = request.region.toLowerCase();
      const market = BING_MARKETS[region];
      // cc 要的是国家码，'uk' 不是合法值（英国是 GB）
      url.searchParams.set('cc', region === 'uk' ? 'GB' : region.toUpperCase());
      if (market) url.searchParams.set('mkt', market);
    }
    if (request.safeSearch) {
      // 网页搜索的安全搜索参数是 adlt（strict/moderate/off），safesearch 只对图片搜索有效
      url.searchParams.set('adlt', 'strict');
    }

    const { body } = await fetchSearchPage(url.toString(), {
      baseUrl,
      timeoutMs: this.config.timeout,
      query: request.query,
      acceptLanguage: request.language ?? 'zh-CN,zh;q=0.9,en;q=0.8',
      signal: request.signal,
    });

    if (BingWebEngine.isBlockedPage(body)) {
      throw new EngineBlockedError('Bing 返回验证码 / 反爬页面，触发风控限制');
    }
    // 实测 cn.bing.com 对无 JS 的客户端忽略 first（无论带不带 Cookie / FORM），翻页请求原样返回第 1 页。
    // 以分页器上的当前页码为准：请求了非首页却拿到第 1 页时抛错，避免把第 1 页的结果当作后续页返回
    if (offset > 0 && BingWebEngine.currentPage(body) === 1) {
      throw new BingPaginationIgnoredError();
    }
    return assertParsed(this.parseResults(body, BING_PAGE_SIZE * 2), body, this.displayName);
  }

  /** 从分页器读取当前页码（a.sb_pagS 的 aria-label 或文本），读不到时返回 undefined */
  static currentPage(html: string): number | undefined {
    const $ = cheerio.load(html);
    const el = $('a.sb_pagS').first();
    if (el.length === 0) return undefined;
    const m = /(\d+)/.exec(el.attr('aria-label') ?? el.text());
    return m ? Number(m[1]) : undefined;
  }

  /** 识别 Bing 的验证码 / 反爬页 */
  static isBlockedPage(html: string): boolean {
    return /id="b_captcha"|\/challenge\/verify|Please solve the challenge|unusual traffic/i.test(html);
  }

  /**
   * 还原 Bing 点击跟踪链接：https://www.bing.com/ck/a?...&u=a1<base64url(真实地址)>
   * 解不出 http(s) 地址时原样返回。
   */
  static unwrapClickUrl(href: string | undefined): string | undefined {
    if (!href || !/^https?:\/\/[^/]*bing\.com\/ck\/a\?/i.test(href)) return href;
    try {
      const u = new URL(href).searchParams.get('u');
      if (!u || !u.startsWith('a1')) return href;
      const decoded = Buffer.from(u.slice(2), 'base64url').toString('utf8');
      return /^https?:\/\//i.test(decoded) ? decoded : href;
    } catch {
      return href;
    }
  }

  // 解析Bing搜索结果HTML
  private parseResults(html: string, maxResults: number): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    let position = 0;

    // Bing结果在 li.b_algo 中
    $('li.b_algo').each((_, el) => {
      if (position >= maxResults) return false;

      const $el = $(el);
      if (isAdElement($, $el)) return;
      const linkEl = $el.find('h2 a').first();
      const snippetEl = $el.find('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4').first();

      const url = BingWebEngine.unwrapClickUrl(linkEl.attr('href'));
      const title = linkEl.text().trim();
      const snippet = snippetEl.text().trim();

      if (url && title && url.startsWith('http')) {
        position++;
        results.push({
          title,
          url,
          snippet: snippet || '',
          source: this.name,
          position,
        });
      }
    });

    return results;
  }

  // 图片搜索（委托给 BingImageEngine）
  async imageSearch(request: ImageSearchRequest): Promise<ImageSearchResponse> {
    if (!this.imageEngine) {
      this.imageEngine = new BingImageEngine(this.config);
    }
    const startTime = Date.now();
    try {
      const result = await this.imageEngine.search(request);
      this.imageStats.record(true, Date.now() - startTime);
      return result;
    } catch (error) {
      this.imageStats.record(false, Date.now() - startTime, error);
      throw error;
    }
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
    return this.stats.isAvailable();
  }

  isImageAvailable(): boolean {
    if (!this.config.enabled) return false;
    return this.imageStats.isAvailable();
  }

  getImageStatus(): EngineStatus {
    return this.imageStats.toStatus(this.name, this.isImageAvailable());
  }

  tryAcquire(kind: 'web' | 'image'): boolean {
    return kind === 'image' ? this.imageStats.tryAcquire() : this.stats.tryAcquire();
  }
}
