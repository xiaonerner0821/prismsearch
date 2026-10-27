/**
 * 360搜索引擎（爬虫方式）
 * 搜索地址：https://www.so.com/s?q=关键词
 */

import * as cheerio from 'cheerio';
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult, EngineStatus } from '../engine-interface.js';
import { EngineBlockedError, pickMeaningfulError } from '../engine-interface.js';
import type { EngineConfig } from '../../config/config-schema.js';
import { EngineStats } from '../engine-stats.js';

import { assertParsed, fetchSearchPage } from '../scraper-http.js';
import { isAdElement } from '../ad-filter.js';

export class SoWebEngine implements SearchProvider {
  readonly name = 'so';
  readonly displayName = '360搜索';
  private config: EngineConfig;
  private stats = new EngineStats();
  private lastError?: string;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const startTime = Date.now();
    const count = request.count ?? 10;
    const page = request.page ?? 1;

    // 同源降级
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

  private async fetchAndParse(
    baseUrl: string, request: SearchRequest, count: number, page: number,
  ): Promise<{ results: SearchResult[]; hasMore: boolean }> {
    const url = new URL(baseUrl);
    url.searchParams.set('q', request.query);
    if (page > 1) {
      // 360搜索的分页参数 pn 从 1 开始表示第几页
      url.searchParams.set('pn', String(page));
    }
    if (request.timeRange) {
      url.searchParams.set('adv_t', request.timeRange[0]); // d / w / m / y
    }

    const { body, url: finalUrl } = await fetchSearchPage(url.toString(), {
      baseUrl,
      timeoutMs: this.config.timeout,
      query: request.query,
      signal: request.signal,
    });

    if (SoWebEngine.isBlockedPage(body, finalUrl)) {
      throw new EngineBlockedError('360搜索返回验证码页面，触发反爬限制');
    }
    // 360 不支持自定义每页条数，且实测每页常只有 7 条左右（卡片占位），count 只能在解析时截断。
    // 因此不能用「条数 >= count」判断是否还有下一页，改看分页器上的「下一页」链接
    const results = assertParsed(this.parseResults(body, count), body, this.displayName);
    return { results, hasMore: results.length >= count || SoWebEngine.hasNextPage(body) };
  }

  /** 分页器上是否有「下一页」链接（id="snext"） */
  static hasNextPage(html: string): boolean {
    return /id=["']?snext\b/.test(html);
  }

  /** 识别 360 的验证码 / 风控页 */
  static isBlockedPage(html: string, finalUrl: string): boolean {
    if (/qcaptcha|\/captcha\//i.test(finalUrl)) return true;
    return /请输入验证码|访问异常|id="captcha"/.test(html);
  }

  /** 摘要候选容器（按优先级） */
  private static readonly SNIPPET_SELECTORS = [
    '.res-desc', '.res-comm-con', '.res-list-summary', '.mh-desc', '.mh-first-cont',
  ];

  static extractSnippet($: cheerio.CheerioAPI, $el: ReturnType<cheerio.CheerioAPI>): string {
    for (const selector of SoWebEngine.SNIPPET_SELECTORS) {
      const text = $el.find(selector).first().text().replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 300);
    }
    return '';
  }

  private parseResults(html: string, maxResults: number): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    let position = 0;

    // 360搜索结果在 li.res-list 中
    $('li.res-list').each((_, el) => {
      if (position >= maxResults) return false;

      const $el = $(el);

      // 跳过广告
      if (isAdElement($, $el)) return;

      const linkEl = $el.find('h3 a').first();
      const title = linkEl.text().trim();
      if (!title) return;

      const rawUrl = linkEl.attr('href') ?? '';
      const dataUrl = linkEl.attr('data-url') || $el.attr('data-url') || rawUrl;
      const finalUrl = dataUrl.startsWith('http') ? dataUrl : rawUrl;
      if (!finalUrl) return;

      // 摘要提取：普通结果在 .res-desc；百科 / 文库 / 问答 / 资讯卡片的摘要容器各不相同，按顺序取第一个非空
      const snippet = SoWebEngine.extractSnippet($, $el);

      position++;
      results.push({
        title,
        url: finalUrl,
        snippet: snippet || '',
        source: this.name,
        position,
      });
    });

    // 备用选择器
    if (results.length === 0) {
      $('div.result, div.vrwrap').each((_, el) => {
        if (position >= maxResults) return false;

        const $el = $(el);
        if (isAdElement($, $el)) return;
        const linkEl = $el.find('a[href^="http"]').first();
        const title = $el.find('h3').text().trim() || linkEl.text().trim();
        const url = linkEl.attr('href') ?? '';
        if (!title || !url) return;

        const snippet = $el.find('p, .res-desc, .str_info').text().trim();
        position++;
        results.push({
          title,
          url,
          snippet: snippet.slice(0, 300) || '',
          source: this.name,
          position,
        });
      });
    }

    return results;
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

  tryAcquire(): boolean {
    return this.stats.tryAcquire();
  }
}
