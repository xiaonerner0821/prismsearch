/**
 * 百度网页搜索引擎（爬虫方式）
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult, EngineStatus, ImageSearchRequest, ImageSearchResponse } from '../engine-interface.js';
import { EngineBlockedError, pickMeaningfulError } from '../engine-interface.js';
import { TIME_RANGE_DAYS } from '../engine-capabilities.js';
import type { EngineConfig } from '../../config/config-schema.js';
import { EngineStats } from '../engine-stats.js';
import { BaiduImageEngine } from './baidu-image.js';
import { assertParsed, fetchSearchPage } from '../scraper-http.js';
import { isAdElement } from '../ad-filter.js';

export class BaiduWebEngine implements SearchProvider {
  readonly name = 'baidu';
  readonly displayName = '百度';
  private config: EngineConfig;
  private stats = new EngineStats();
  private imageStats = new EngineStats();
  private lastError?: string;
  private imageEngine?: BaiduImageEngine;

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
        const results = await this.fetchAndParse(baseUrl, request, count, page);
        const searchTime = Date.now() - startTime;
        this.stats.record(true, searchTime);
        this.lastError = undefined;
        return {
          results,
          engine: this.name,
          searchTime,
          cached: false,
          page,
          hasMore: results.length >= count,
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

  // 对指定 baseUrl 发起请求并解析结果
  private async fetchAndParse(
    baseUrl: string, request: SearchRequest, count: number, page: number,
  ): Promise<SearchResult[]> {
    const url = new URL(baseUrl);
    url.searchParams.set('wd', request.query);
    url.searchParams.set('rn', String(count));
    if (page > 1) {
      url.searchParams.set('pn', String((page - 1) * count));
    }
    // ie 是查询词的输入编码，与语言无关：始终固定为 UTF-8（百度不支持按语言过滤）
    url.searchParams.set('ie', 'utf-8');
    if (request.timeRange) {
      // gpc：按发布时间的 Unix 秒区间过滤（stftype=1 表示自定义区间）
      const now = Math.floor(Date.now() / 1000);
      const past = now - TIME_RANGE_DAYS[request.timeRange] * 86_400;
      url.searchParams.set('gpc', `stf=${past},${now}|stftype=1`);
    }

    const response = await fetchSearchPage(url.toString(), {
      // 用本轮实际使用的 baseUrl 推导 Referer，配置镜像站时才能对上
      baseUrl,
      timeoutMs: this.config.timeout,
      query: request.query,
      acceptLanguage: 'zh-CN,zh;q=0.9',
      signal: request.signal,
    });
    const html = response.body;

    // 检测验证码页（百度反爬）
    if (this.isCaptchaPage(html, response.url)) {
      throw new EngineBlockedError('百度返回验证码页面，触发反爬限制');
    }
    return assertParsed(this.parseResults(html, count), html, this.displayName);
  }

  // 检测验证码/安全验证页面
  private isCaptchaPage(html: string, finalUrl: string): boolean {
    if (finalUrl.includes('wappass.baidu.com') || finalUrl.includes('/search/error.html')) {
      return true;
    }
    // 旧实现直接搜 'captcha'：正常结果页的百度 JS 里也会出现这个词，会误判成验证码
    return html.includes('百度安全验证') ||
      /id="captcha"|class="[^"]*captcha|请输入验证码|安全验证/.test(html) ||
      (html.includes('verify') && html.includes('baidu') && html.length < 5000);
  }

  // 解析百度搜索结果HTML
  private parseResults(html: string, maxResults: number): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    let position = 0;

    // 百度结果容器：div.result 或 div.c-container（新版）
    $('div.result, div.c-container').each((_, el) => {
      if (position >= maxResults) return false;

      const $el = $(el);

      // 跳过推广（凤巢广告卡片）
      if (isAdElement($, $el)) return;

      const linkEl = $el.find('h3 a').first();
      const title = linkEl.text().trim();
      if (!title) return;

      // 真实URL：优先取容器的 mu 属性，其次取 data-landurl，最后用 href
      const rawUrl =
        $el.attr('mu') ||
        $el.find('[data-landurl]').attr('data-landurl') ||
        linkEl.attr('href') ||
        '';
      const url = rawUrl.startsWith('http') ? rawUrl : linkEl.attr('href') ?? '';
      if (!url) return;

      // 摘要：多级 fallback
      // 1. 已知稳定的语义 class
      // 2. 结构推断：h3 之后的第一个有文本内容的 div/span（排除嵌套链接）
      const snippet = this.extractSnippet($, $el);

      position++;
      results.push({
        title,
        url,
        snippet,
        source: this.name,
        position,
      });
    });

    return results;
  }

  // 多级 fallback 提取摘要
  private extractSnippet($: cheerio.CheerioAPI, $el: cheerio.Cheerio<AnyNode>): string {
    // 第一级：已知稳定选择器
    const knownSelectors = [
      '.c-abstract',
      '.c-gap-top-small',
      'div[class*="abstract"]',
      'span[class*="content"]',
      'div[class*="desc"]',
    ];
    for (const sel of knownSelectors) {
      const text = $el.find(sel).first().text().trim();
      if (text.length > 10) return text;
    }

    // 第二级：h3 之后第一个包含足够文字的 div/p（排除只含链接的节点）
    const h3 = $el.find('h3').first();
    if (h3.length) {
      let sibling = h3.next();
      while (sibling.length) {
        const text = sibling.clone().find('a').remove().end().text().trim();
        if (text.length > 10) return text;
        sibling = sibling.next();
      }
    }

    // 第三级：容器内所有文本，去掉标题部分，取前200字
    const fullText = $el.clone().find('h3').remove().end().text().replace(/\s+/g, ' ').trim();
    return fullText.slice(0, 200);
  }

  // 图片搜索（委托给 BaiduImageEngine）
  async imageSearch(request: ImageSearchRequest): Promise<ImageSearchResponse> {
    if (!this.imageEngine) {
      this.imageEngine = new BaiduImageEngine(this.config);
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
