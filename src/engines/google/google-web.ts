/**
 * Google 网页搜索引擎
 *
 * 支持三种策略，按优先级自动编排、失败后自动降级：
 * 1. api     — Google Custom Search API（需 apiKey + searchEngineId，或环境变量
 *              GOOGLE_API_KEY / GOOGLE_CSE_ID）。结果为空属于正常响应。
 * 2. browser — Playwright 渲染 google.com 搜索页后解析（需启用 fetcher.browser，
 *              解决 Google 强制 JS 渲染的 enablejs 墙问题）。
 * 3. http    — 纯 HTTP 爬虫（Google 已于 2025 年起强制 JS 渲染，通常拿不到结果，
 *              作为最后兜底保留）。
 *
 * 成功策略会被"粘性"记忆，后续请求优先使用，避免每次都先踩一遍已失效的策略。
 */

import * as cheerio from 'cheerio';
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult, EngineStatus, ImageSearchRequest, ImageSearchResponse } from '../engine-interface.js';
import { EngineBlockedError, EngineParseError, pickMeaningfulError } from '../engine-interface.js';
import type { EngineConfig } from '../../config/config-schema.js';
import type { Fetcher } from '../../fetcher/fetcher-interface.js';
import { EngineStats } from '../engine-stats.js';
import { getLogger } from '../../utils/logger.js';
import { GoogleImageEngine } from './google-image.js';
import { GoogleCustomSearchClient } from './google-api.js';

import { fetchSearchPage } from '../scraper-http.js';
import { isAdElement } from '../ad-filter.js';
import { pickUserAgent } from '../../utils/http-client.js';

/** 还原 /goto 跳转链接的总时长上限：只是锦上添花，不能拖慢搜索 */
const GOTO_RESOLVE_TIMEOUT_MS = 5000;

type Strategy = 'api' | 'browser' | 'http';

export class GoogleWebEngine implements SearchProvider {
  readonly name = 'google';
  readonly displayName = 'Google';
  private config: EngineConfig;
  private stats = new EngineStats();
  private imageStats = new EngineStats();
  private lastError?: string;
  private imageEngine?: GoogleImageEngine;
  private browserFetcher?: Fetcher;
  private apiClient: GoogleCustomSearchClient | null;
  /** 上次成功的策略，后续请求优先使用 */
  private preferredStrategy?: Strategy;

  constructor(config: EngineConfig) {
    this.config = config;
    this.apiClient = GoogleCustomSearchClient.create(config);
  }

  /** 注入浏览器抓取器（Playwright），由服务器初始化时调用 */
  setBrowserFetcher(fetcher: Fetcher): void {
    this.browserFetcher = fetcher;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const startTime = Date.now();
    const count = request.count ?? 10;
    const page = request.page ?? 1;
    const logger = getLogger();

    const strategies = this.orderStrategies();
    const errors: unknown[] = [];

    for (const strategy of strategies) {
      try {
        const { results, totalResults } = await this.runStrategy(strategy, request, count, page);
        const searchTime = Date.now() - startTime;
        this.stats.record(true, searchTime);
        this.lastError = undefined;
        this.preferredStrategy = strategy;
        return {
          results,
          totalResults,
          engine: this.name,
          searchTime,
          cached: false,
          page,
          hasMore: results.length >= count,
        };
      } catch (error) {
        errors.push(error);
        logger.warn('Google 策略失败，尝试下一策略', {
          strategy,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const searchTime = Date.now() - startTime;
    const lastError = pickMeaningfulError(errors);
    this.lastError = lastError instanceof Error ? (lastError as Error).message : String(lastError);
    this.stats.record(false, searchTime, lastError);
    throw lastError;
  }

  // 按优先级排列策略：api → browser → http，上次成功的策略排在最前
  private orderStrategies(): Strategy[] {
    const strategies: Strategy[] = [];
    if (this.apiClient) strategies.push('api');
    if (this.browserFetcher) strategies.push('browser');
    strategies.push('http');

    if (this.preferredStrategy && strategies.includes(this.preferredStrategy)) {
      return [this.preferredStrategy, ...strategies.filter(s => s !== this.preferredStrategy)];
    }
    return strategies;
  }

  // 执行单个策略，返回解析后的结果
  private async runStrategy(
    strategy: Strategy,
    request: SearchRequest,
    count: number,
    page: number,
  ): Promise<{ results: SearchResult[]; totalResults?: number }> {
    switch (strategy) {
      case 'api':
        // API 返回空结果是正常响应（查询确实无匹配），不按失败处理
        return this.apiClient!.search(request, count, page);

      case 'browser': {
        // 依次尝试主 URL 和备用 URL，渲染后解析
        const baseUrls = [this.config.baseUrl, ...(this.config.alternateUrls ?? [])];
        const errors: unknown[] = [];
        for (const baseUrl of baseUrls) {
          try {
            const results = await this.fetchViaBrowser(baseUrl, request, count, page);
            if (results.length === 0) {
              throw new EngineParseError('浏览器渲染后的 Google 页面未解析到搜索结果');
            }
            return { results };
          } catch (error) {
            errors.push(error);
          }
        }
        throw pickMeaningfulError(errors);
      }

      case 'http':
      default: {
        // 同源降级：依次尝试主 URL 和备用 URL
        const baseUrls = [this.config.baseUrl, ...(this.config.alternateUrls ?? [])];
        const errors: unknown[] = [];
        for (const baseUrl of baseUrls) {
          try {
            return { results: await this.fetchAndParse(baseUrl, request, count, page) };
          } catch (error) {
            errors.push(error);
            // 拿到了 JS 墙 / 验证码这类「内容级」结论时，其他 Google 域名给出的是同一套页面，不必再逐个超时
            if (error instanceof EngineParseError || error instanceof EngineBlockedError) break;
          }
        }
        throw pickMeaningfulError(errors);
      }
    }
  }

  // 构建搜索页 URL（http 与 browser 策略共用）
  private buildSearchUrl(
    baseUrl: string, request: SearchRequest, count: number, page: number,
  ): string {
    const url = new URL(baseUrl);
    url.searchParams.set('q', request.query);
    url.searchParams.set('num', String(count));
    if (page > 1) {
      url.searchParams.set('start', String((page - 1) * count));
    }
    if (request.region) {
      url.searchParams.set('gl', request.region);
    }
    if (request.language) {
      url.searchParams.set('hl', request.language);
    }
    if (request.safeSearch) {
      url.searchParams.set('safe', 'active');
    }
    if (request.timeRange) {
      // qdr:d / w / m / y —— 过去一天 / 周 / 月 / 年
      url.searchParams.set('tbs', `qdr:${request.timeRange[0]}`);
    }
    return url.toString();
  }

  // 浏览器渲染策略：Playwright 加载页面并等待结果容器出现，然后解析 HTML
  private async fetchViaBrowser(
    baseUrl: string, request: SearchRequest, count: number, page: number,
  ): Promise<SearchResult[]> {
    if (!this.browserFetcher) {
      throw new Error('浏览器抓取器未启用（请设置 fetcher.browser.enabled: true 并安装 playwright）');
    }

    const url = this.buildSearchUrl(baseUrl, request, count, page);
    const result = await this.browserFetcher.fetch({
      url,
      format: 'html',
      timeout: this.config.timeout,
      // SOCS 同意 Cookie，避免部分地区被重定向到 consent 页
      headers: { 'Cookie': 'SOCS=CAESHAgBEhIaAB' },
      // 等待结果容器渲染出来；#search 比具体结果类名更稳定
      waitForSelector: '#search',
      waitForTimeout: Math.min(this.config.timeout, 10000),
      signal: request.signal,
    });

    // 被重定向到反爬验证码页
    if (result.url.includes('/sorry/')) {
      throw new EngineBlockedError('Google 触发反爬验证（/sorry/ 验证码页），请降低请求频率或更换出口 IP');
    }

    const html = result.rawHtml ?? result.content;
    const gotos = new Map<SearchResult, string>();
    const results = this.parseResults(html, count, gotos);
    await GoogleWebEngine.resolveGotoLinks(gotos, result.url, request.signal);
    return results;
  }

  /**
   * 渲染版结果链接是不透明的 /goto?url=<令牌>，DOM 里没有真实地址。
   * cite 面包屑只是展示用的（会截断、会省略路径段），拼出来的 URL 实测经常是错的，
   * 所以向结果页所在的 Google 域名请求 /goto，取 302 的 Location 作为真实地址；
   * 解析失败的才保留面包屑兜底。
   */
  static async resolveGotoLinks(gotos: Map<SearchResult, string>, pageUrl: string, signal?: AbortSignal): Promise<void> {
    if (gotos.size === 0) return;
    let origin: string;
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      return;
    }
    // 只向 Google 自己的域名发请求（结果页地址来自浏览器跳转后的最终 URL）
    if (!/^https:\/\/(?:www\.)?google\.[a-z.]+$/i.test(origin)) return;
    const deadline = AbortSignal.timeout(GOTO_RESOLVE_TIMEOUT_MS);
    const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
    await Promise.all([...gotos].map(async ([item, href]) => {
      try {
        const resp = await fetch(new URL(href, origin).toString(), {
          redirect: 'manual',
          headers: { 'User-Agent': pickUserAgent(), Cookie: 'SOCS=CAESHAgBEhIaAB' },
          signal: sig,
        });
        await resp.body?.cancel().catch(() => undefined);
        const location = resp.headers.get('location');
        if (resp.status >= 300 && resp.status < 400 && location && /^https?:\/\//.test(location)) {
          const target = new URL(location);
          // 跳到的仍是 Google 自己（地区跳转等）说明不是目标页，保留兜底
          if (!/(^|\.)google\.[a-z.]+$/i.test(target.hostname)) {
            target.hash = ''; // 去掉 #:~:text= 文本片段高亮
            item.url = target.toString();
          }
        }
      } catch {
        // 保留 cite 兜底地址
      }
    }));
  }

  // 纯 HTTP 策略：对指定 baseUrl 发起请求并解析结果
  private async fetchAndParse(
    baseUrl: string, request: SearchRequest, count: number, page: number,
  ): Promise<SearchResult[]> {
    const url = this.buildSearchUrl(baseUrl, request, count, page);

    const { body: html, url: finalUrl } = await fetchSearchPage(url, {
      baseUrl,
      timeoutMs: this.config.timeout,
      query: request.query,
      acceptLanguage: request.language ?? 'zh-CN,zh;q=0.9,en;q=0.8',
      signal: request.signal,
    });
    if (finalUrl.includes('/sorry/')) {
      throw new EngineBlockedError('Google 触发反爬验证（/sorry/ 验证码页），请降低请求频率或更换出口 IP');
    }
    const results = this.parseResults(html, count);

    // Google 现已强制 JS 渲染（返回 enablejs 提示页，HTTP 200 但无任何结果）。
    // 解析不到结果时按失败处理并抛出异常，让上层触发降级到备用引擎，
    // 而不是把空结果当作成功响应返回。
    if (results.length === 0) {
      const jsWall = html.includes('enablejs') || html.includes('JavaScript');
      throw new EngineParseError(jsWall
        ? 'Google 返回了要求 JavaScript 渲染的页面（enablejs），爬虫方式无法获取结果'
        : 'Google 页面中未解析到搜索结果（页面结构可能已变化）');
    }

    return results;
  }

  // 解析Google搜索结果HTML
  private parseResults(html: string, maxResults: number, gotos?: Map<SearchResult, string>): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    let position = 0;

    // Google搜索结果通常在 div.g 中
    $('div.g').each((_, el) => {
      if (position >= maxResults) return false;

      const $el = $(el);
      if (isAdElement($, $el)) return;
      const linkEl = $el.find('a').first();
      const titleEl = $el.find('h3').first();
      // 摘要可能在多种选择器下
      const snippetEl = $el.find('div.VwiC3b, span.aCOpRe, div[data-sncf], div.IsZvec').first();

      const url = linkEl.attr('href');
      const title = titleEl.text().trim();
      const snippet = snippetEl.text().trim();

      // 过滤无效结果
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

    // 渲染版 DOM（浏览器策略）：结果在 div.tF2Cxc 中，链接是 /goto?url=<令牌>
    // 不透明跳转，真实 URL 需从 cite 面包屑还原
    if (results.length === 0) {
      $('div.tF2Cxc').each((_, el) => {
        if (position >= maxResults) return false;

        const $el = $(el);
        if (isAdElement($, $el)) return;
        const title = $el.find('h3').first().text().trim();
        const href = $el.find('a').first().attr('href') ?? '';
        const cite = $el.find('cite').first().text().trim();
        const snippet = $el.find('div.VwiC3b, span.aCOpRe, div[data-sncf], div.IsZvec').first().text().trim();

        // 优先用直链；goto 跳转链接则从 cite 面包屑还原（https://site.com › path → https://site.com/path）
        let url = '';
        if (href.startsWith('http') && !/google\.[^/]+\/goto/.test(href)) {
          url = href;
        } else if (cite.startsWith('http')) {
          url = cite
            .split('›')
            .map(s => s.trim())
            .filter(s => s && !s.includes('...'))
            .join('/');
        }

        if (url && title) {
          position++;
          const item: SearchResult = {
            title,
            url,
            snippet: snippet || '',
            source: this.name,
            position,
          };
          results.push(item);
          if (/^\/goto\?|google\.[^/]+\/goto\?/.test(href)) gotos?.set(item, href);
        }
      });
    }

    // 备用选择器：如果以上都没找到结果，尝试其他结构
    if (results.length === 0) {
      $('div[data-hveid] a[href^="http"]').each((_, el) => {
        if (position >= maxResults) return false;

        const $el = $(el);
        const url = $el.attr('href');
        const $parent = $el.closest('div[data-hveid]');
        if (isAdElement($, $parent)) return;
        const title = $el.find('h3').text().trim() || $el.text().trim();
        const snippet = $parent.find('span, div').not('h3').text().trim();

        if (url && title && url.startsWith('http')) {
          position++;
          results.push({
            title,
            url,
            snippet: snippet.slice(0, 300) || '',
            source: this.name,
            position,
          });
        }
      });
    }

    return results;
  }

  // 图片搜索（优先 Custom Search API，否则回退到爬虫引擎）
  async imageSearch(request: ImageSearchRequest): Promise<ImageSearchResponse> {
    const startTime = Date.now();
    const count = request.count ?? 10;
    const page = request.page ?? 1;
    const logger = getLogger();

    // 策略1：Custom Search API（配置了凭据时优先，结果为空属于正常响应）
    if (this.apiClient) {
      try {
        const { results } = await this.apiClient.imageSearch(request, count, page);
        this.imageStats.record(true, Date.now() - startTime);
        return {
          results,
          engine: this.name,
          searchTime: Date.now() - startTime,
          cached: false,
          page,
          hasMore: results.length >= count,
        };
      } catch (error) {
        logger.warn('Google 图片搜索 API 失败，回退到爬虫', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 策略2：爬虫（GoogleImageEngine）
    if (!this.imageEngine) {
      this.imageEngine = new GoogleImageEngine(this.config);
    }
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
    // 连续失败超过5次视为不可用
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
