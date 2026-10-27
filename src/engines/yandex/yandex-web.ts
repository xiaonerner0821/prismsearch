/**
 * Yandex 搜索引擎（爬虫方式）
 * 搜索地址：https://yandex.com/search/?text=关键词
 */

import * as cheerio from 'cheerio';
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult, EngineStatus } from '../engine-interface.js';
import { EngineBlockedError, pickMeaningfulError } from '../engine-interface.js';
import type { EngineConfig } from '../../config/config-schema.js';
import { EngineStats } from '../engine-stats.js';

import { assertParsed, fetchSearchPage } from '../scraper-http.js';
import { isAdElement } from '../ad-filter.js';

/** 区域码 → Yandex 地区 ID（lr） */
const YANDEX_REGIONS: Record<string, string> = {
  ru: '225',
  ua: '187',
  by: '149',
  kz: '159',
  tr: '983',
  us: '84',
  uk: '102',
  gb: '102',
  de: '96',
  fr: '124',
  cn: '134',
  jp: '137',
};

/**
 * 将语言代码映射为 Yandex 的 lang 参数。
 * 旧实现按原样查表，'zh-cn' / 'EN-us' 这类大小写变体查不到，直接透传成无效值
 */
export function mapYandexLanguage(lang: string): string {
  const lower = lang.toLowerCase();
  const mapping: Record<string, string> = {
    'ru': 'ru', 'ru-ru': 'ru',
    'en': 'en', 'en-us': 'en', 'en-gb': 'en',
    'zh-cn': 'zh', 'zh': 'zh',
    'tr': 'tr', 'uk': 'uk', 'de': 'de', 'fr': 'fr',
  };
  return mapping[lower] ?? lower.split('-')[0];
}

export class YandexWebEngine implements SearchProvider {
  readonly name = 'yandex';
  readonly displayName = 'Yandex';
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

    // 同源降级（yandex.com → yandex.ru）
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

  private async fetchAndParse(
    baseUrl: string, request: SearchRequest, count: number, page: number,
  ): Promise<SearchResult[]> {
    const url = new URL(baseUrl);
    url.searchParams.set('text', request.query);
    if (page > 1) {
      url.searchParams.set('p', String(page - 1)); // Yandex 分页从 0 开始
    }
    if (request.language) {
      url.searchParams.set('lang', mapYandexLanguage(request.language));
    }
    // 区域：Yandex 用 lr（地区 ID）控制结果地域
    if (request.region) {
      const lr = YANDEX_REGIONS[request.region.toLowerCase()];
      if (lr) url.searchParams.set('lr', lr);
    }
    // numdoc 控制每页结果数
    url.searchParams.set('numdoc', String(count));

    const { body: html, url: finalUrl } = await fetchSearchPage(url.toString(), {
      baseUrl,
      timeoutMs: this.config.timeout,
      query: request.query,
      acceptLanguage: request.language ?? 'en-US,en;q=0.9,ru;q=0.8',
      signal: request.signal,
    });

    // 检测验证码
    if ((html.includes('captcha') && html.includes('SmartCaptcha')) ||
        finalUrl.includes('/showcaptcha')) {
      throw new EngineBlockedError('Yandex 返回验证码页面，触发反爬限制');
    }

    return assertParsed(this.parseResults(html, count), html, this.displayName);
  }

  private parseResults(html: string, maxResults: number): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    let position = 0;

    // Yandex 结果在 li.serp-item 中
    $('li.serp-item').each((_, el) => {
      if (position >= maxResults) return false;

      const $el = $(el);

      // 跳过广告
      if ($el.attr('data-cid')?.startsWith('0/') || isAdElement($, $el)) return;

      const linkEl = $el.find('a.OrganicTitle-Link, a.link_theme_normal, h2 a').first();
      const title = linkEl.text().trim() || $el.find('h2').text().trim();
      if (!title) return;

      const url = linkEl.attr('href') ?? '';
      if (!url || !url.startsWith('http')) return;

      // 摘要提取
      const snippet = $el.find('.OrganicTextContentSpan, .TextContainer, .organic__content-wrapper .text-container').text().trim()
        || $el.find('.Organic-ContentWrapper span, div[data-log-node="text"]').text().trim();

      position++;
      results.push({
        title,
        url,
        snippet: snippet || '',
        source: this.name,
        position,
      });
    });

    // 备用选择器
    if (results.length === 0) {
      $('div.organic, div[data-fast-name="organic"]').each((_, el) => {
        if (position >= maxResults) return false;

        const $el = $(el);
        const linkEl = $el.find('a[href^="http"]').first();
        const title = $el.find('h2').text().trim() || linkEl.text().trim();
        const url = linkEl.attr('href') ?? '';
        if (!title || !url) return;

        const snippet = $el.find('.OrganicTextContentSpan, span.ExtendedText-Full, span.ExtendedText-Short').text().trim();
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
