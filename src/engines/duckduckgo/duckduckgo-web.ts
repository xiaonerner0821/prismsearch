/**
 * DuckDuckGo 搜索引擎（爬虫方式）
 * 搜索地址：https://html.duckduckgo.com/html/?q=关键词
 * 使用纯 HTML 版本，易于解析
 */

import * as cheerio from 'cheerio';
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult, EngineStatus } from '../engine-interface.js';
import { EngineBlockedError, pickMeaningfulError } from '../engine-interface.js';
import type { EngineConfig } from '../../config/config-schema.js';
import { EngineStats } from '../engine-stats.js';

import { assertParsed, fetchSearchPage } from '../scraper-http.js';
import { isAdElement, isAdUrl } from '../ad-filter.js';

/** 区域码 → DuckDuckGo kl 参数（区域-语言） */
const DDG_REGIONS: Record<string, string> = {
  us: 'us-en',
  uk: 'uk-en',
  gb: 'uk-en',
  cn: 'cn-zh',
  hk: 'hk-tzh',
  tw: 'tw-tzh',
  de: 'de-de',
  fr: 'fr-fr',
  jp: 'jp-jp',
  ru: 'ru-ru',
  kr: 'kr-kr',
  br: 'br-pt',
  in: 'in-en',
  au: 'au-en',
  ca: 'ca-en',
  es: 'es-es',
  it: 'it-it',
};

/** 语言码 → DuckDuckGo 的语言后缀 */
const DDG_LANG_SUFFIX: Record<string, string> = {
  zh: 'zh', 'zh-cn': 'zh', 'zh-tw': 'tzh', 'zh-hk': 'tzh',
  en: 'en', ja: 'jp', ru: 'ru', de: 'de', fr: 'fr', ko: 'kr', es: 'es', it: 'it', pt: 'pt',
};

/**
 * 将通用区域代码映射为 DuckDuckGo kl 参数。
 * 旧实现对未收录的区域直接拼 `${region}-en`，会生成 'xx-en' 这种无效值（DDG 会忽略或报错）；
 * 现在无匹配时返回 undefined，让 DDG 自己按 Accept-Language 决定。
 */
export function mapRegion(region: string, language?: string): string | undefined {
  const key = region.toLowerCase();
  const known = DDG_REGIONS[key];
  if (known) return known;

  // 只给了 region，用语言兜底；都没有就交给 DDG 默认
  const lang = language ? DDG_LANG_SUFFIX[language.toLowerCase()] : undefined;
  if (lang) return `${key}-${lang}`;
  return undefined;
}

export class DuckDuckGoWebEngine implements SearchProvider {
  readonly name = 'duckduckgo';
  readonly displayName = 'DuckDuckGo';
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
    // 使用 GET 查询串：DuckDuckGo 目前对表单 POST 一律返回 202 + 人机验证页，GET 则正常
    const url = new URL(baseUrl);
    url.searchParams.set('q', request.query);
    if (request.region) {
      // DuckDuckGo 使用 kl 参数控制区域，如 us-en, cn-zh, hk-tzh
      const kl = mapRegion(request.region, request.language);
      if (kl) url.searchParams.set('kl', kl);
    }
    if (request.safeSearch) {
      url.searchParams.set('kp', '1'); // 安全搜索开启
    }
    if (request.timeRange) {
      url.searchParams.set('df', request.timeRange[0]); // d / w / m / y
    }
    // 分页：HTML 版用 s 表示结果偏移量。实测只带 s 时 DDG 会原样返回第 1 页，
    // 必须同时带上第 1 页「Next」表单里的会话参数（vqd / dc 等），缺 vqd 还会直接 403。
    // 因此翻页前先取一次第 1 页，拿到表单参数后再请求目标偏移。
    if (page > 1) {
      const offset = (page - 1) * count;
      const firstPage = await this.fetchPage(url.toString(), baseUrl, request);
      const nextParams = DuckDuckGoWebEngine.extractNextPageParams(firstPage);
      if (nextParams) {
        for (const [key, value] of nextParams) {
          if (!url.searchParams.has(key)) url.searchParams.set(key, value);
        }
        url.searchParams.set('dc', String(offset + 1));
      }
      url.searchParams.set('s', String(offset));
    }

    const html = await this.fetchPage(url.toString(), baseUrl, request);
    return assertParsed(this.parseResults(html, count), html, this.displayName);
  }

  /** 请求一页并识别人机验证页 */
  private async fetchPage(url: string, baseUrl: string, request: SearchRequest): Promise<string> {
    const { body: html, status } = await fetchSearchPage(url, {
      baseUrl,
      timeoutMs: this.config.timeout,
      query: request.query,
      acceptLanguage: request.language ?? 'en-US,en;q=0.9',
      signal: request.signal,
    });

    // 人机验证页：抛错交给降级链处理，不能当作「0 条结果」成功返回
    if (DuckDuckGoWebEngine.isChallengePage(status, html)) {
      throw new EngineBlockedError('DuckDuckGo 返回人机验证页（anomaly challenge），触发反爬限制');
    }
    return html;
  }

  /** 从 HTML 版结果页的「Next」表单提取翻页会话参数（无下一页时返回 undefined） */
  static extractNextPageParams(html: string): URLSearchParams | undefined {
    const $ = cheerio.load(html);
    const form = $('div.nav-link form').filter((_, f) => $(f).find('input[name="vqd"]').length > 0).last();
    if (form.length === 0) return undefined;
    const params = new URLSearchParams();
    form.find('input[name]').each((_, input) => {
      params.set($(input).attr('name')!, $(input).attr('value') ?? '');
    });
    return params;
  }

  /** 解包 DuckDuckGo 的跳转链接（/l/?uddg=...，可能是协议相对地址）；非跳转链接原样返回 */
  static unwrapUrl(href: string): string {
    if (!/duckduckgo\.com\/l\/\?/.test(href)) return href;
    try {
      const realUrl = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg');
      return realUrl ?? href;
    } catch {
      return href;
    }
  }

  /** 识别 DuckDuckGo 的反爬挑战页（202 状态码或 anomaly 表单） */
  static isChallengePage(status: number | undefined, html: string): boolean {
    if (status === 202) return true;
    return /anomaly-modal|id="challenge-form"|bots use DuckDuckGo too/i.test(html);
  }

  private parseResults(html: string, maxResults: number): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    let position = 0;

    // DuckDuckGo HTML 版结果在 div.result 中
    $('div.result, div.web-result').each((_, el) => {
      if (position >= maxResults) return false;

      const $el = $(el);
      if (isAdElement($, $el)) return;
      const linkEl = $el.find('a.result__a').first();
      const snippetEl = $el.find('a.result__snippet, .result__snippet').first();

      const title = linkEl.text().trim();
      const url = DuckDuckGoWebEngine.unwrapUrl(linkEl.attr('href') ?? '');
      const snippet = snippetEl.text().trim();

      if (!title || !url || !url.startsWith('http')) return;
      // 广告的落地链接是 duckduckgo.com/y.js 点击跳转
      if (isAdUrl(url)) return;

      position++;
      results.push({
        title,
        url,
        snippet: snippet || '',
        source: this.name,
        position,
      });
    });

    // 备用选择器（lite 版本）
    if (results.length === 0) {
      // lite 版链接是协议相对的跳转地址（//duckduckgo.com/l/?uddg=...），需先解包再判断
      $('a.result-link, table.t td a[href^="http"]').each((_, el) => {
        if (position >= maxResults) return false;

        const $a = $(el);
        const url = DuckDuckGoWebEngine.unwrapUrl($a.attr('href') ?? '');
        const title = $a.text().trim();
        if (!title || !url.startsWith('http')) return;

        const $row = $a.closest('tr');
        // lite 版广告行带 result-sponsored，链接走 y.js 跳转
        if ($row.is('.result-sponsored') || isAdUrl(url)) return;
        const snippet = $row.next('tr').find('td.result-snippet').text().trim();

        position++;
        results.push({
          title,
          url,
          snippet: snippet || '',
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
