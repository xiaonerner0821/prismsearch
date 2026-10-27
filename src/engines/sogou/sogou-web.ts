/**
 * 搜狗搜索引擎（爬虫方式）
 * 搜索地址：https://www.sogou.com/web?query=关键词
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult, EngineStatus } from '../engine-interface.js';
import { EngineBlockedError, pickMeaningfulError } from '../engine-interface.js';
import type { EngineConfig } from '../../config/config-schema.js';
import { EngineStats } from '../engine-stats.js';

import { assertParsed, fetchRedirectTarget, fetchSearchPage, ScraperHttpError, type ScraperFetchResult } from '../scraper-http.js';
import { isAdElement } from '../ad-filter.js';

/** 跳转解包：并发上限、单条超时、总耗时上限、跳转页响应体上限 */
const UNWRAP_CONCURRENCY = 5;
const UNWRAP_ITEM_TIMEOUT_MS = 3_000;
const UNWRAP_TOTAL_TIMEOUT_MS = 6_000;
const UNWRAP_MAX_BYTES = 64 * 1024;
/** 搜狗名义上的每页条数 */
const SOGOU_PAGE_SIZE = 10;
/** 搜狗风控时返回的非标准状态码（实测为 399，无响应体） */
const SOGOU_BLOCK_STATUSES = new Set([399]);

/** 由搜索响应的 Set-Cookie 拼出后续请求的 Cookie 头（只取 name=value） */
function cookieHeaderFrom(headers: ScraperFetchResult['headers']): string | undefined {
  let list: string[] = [];
  // 代理路径下是 npm undici 的 Headers，与全局 Headers 不是同一个类，按鸭子类型判断
  if (typeof (headers as Headers).get === 'function') {
    const h = headers as Headers;
    const single = h.get('set-cookie');
    list = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
  } else {
    const raw = (headers as Record<string, string | string[] | undefined>)['set-cookie'];
    list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  }
  const pairs = list.map(line => line.split(';')[0].trim()).filter(p => p.indexOf('=') > 0);
  return pairs.length ? pairs.join('; ') : undefined;
}

export class SogouWebEngine implements SearchProvider {
  readonly name = 'sogou';
  readonly displayName = '搜狗搜索';
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
          // 搜狗每页名义 10 条，实测常因卡片占位只有 7~9 条，且静态 HTML 里没有分页器；
          // 用「条数 >= count」会让几乎所有请求都报告没有下一页。拿到至少半页就认为还有更多
          hasMore: results.length >= count || results.length >= SOGOU_PAGE_SIZE / 2,
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
    url.searchParams.set('query', request.query);
    if (page > 1) {
      url.searchParams.set('page', String(page));
    }
    // ie 是查询词的输入编码，与语言无关：始终固定为 UTF-8（搜狗不支持按语言过滤）
    url.searchParams.set('ie', 'utf8');
    if (request.timeRange) {
      // s_from=inttime_day / week / month / year，需配合 tsn=1 才生效
      url.searchParams.set('s_from', `inttime_${request.timeRange}`);
      url.searchParams.set('tsn', '1');
    }

    let fetched: ScraperFetchResult;
    try {
      fetched = await fetchSearchPage(url.toString(), {
        baseUrl,
        timeoutMs: this.config.timeout,
        query: request.query,
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof ScraperHttpError && SOGOU_BLOCK_STATUSES.has(error.status)) {
        throw new EngineBlockedError(`搜狗返回风控状态码 HTTP ${error.status}，触发反爬限制`);
      }
      throw error;
    }
    const { body, url: finalUrl, headers } = fetched;

    if (SogouWebEngine.isBlockedPage(body, finalUrl)) {
      throw new EngineBlockedError('搜狗返回验证码页面，触发反爬限制');
    }

    // 搜狗不支持自定义每页条数（固定 10 条），count 只能在解析时截断
    const results = assertParsed(this.parseResults(body, count, baseUrl), body, this.displayName);
    await this.unwrapRedirects(results, {
      baseUrl,
      query: request.query,
      cookie: cookieHeaderFrom(headers),
      signal: request.signal,
    });
    return results;
  }

  /**
   * 解包仍是搜狗加密跳转（/link?url=<加密串>）的结果链接：
   * 逐条 GET 跳转地址但不跟随重定向，从 Location 或跳转页 JS / meta refresh 取真实地址。
   * 并发、单条超时与总耗时都有上限；任何失败都保留原链接，不影响搜索结果本身。
   */
  private async unwrapRedirects(
    results: SearchResult[],
    ctx: { baseUrl: string; query: string; cookie?: string; signal?: AbortSignal },
  ): Promise<void> {
    const pending = results.filter(r => SogouWebEngine.isSogouRedirect(r.url));
    if (pending.length === 0 || ctx.signal?.aborted) return;

    const budget = AbortSignal.timeout(UNWRAP_TOTAL_TIMEOUT_MS);
    const signal = ctx.signal ? AbortSignal.any([budget, ctx.signal]) : budget;
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < pending.length && !signal.aborted) {
        const result = pending[next++];
        const target = await this.resolveRedirect(result.url, ctx, signal).catch(() => undefined);
        if (target) result.url = target;
      }
    };
    await Promise.all(Array.from({ length: Math.min(UNWRAP_CONCURRENCY, pending.length) }, worker));
  }

  private async resolveRedirect(
    link: string,
    ctx: { baseUrl: string; query: string; cookie?: string },
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const res = await fetchRedirectTarget(link, {
      baseUrl: ctx.baseUrl,
      timeoutMs: Math.min(UNWRAP_ITEM_TIMEOUT_MS, this.config.timeout),
      query: ctx.query,
      maxBytes: UNWRAP_MAX_BYTES,
      signal,
      ...(ctx.cookie ? { headers: { Cookie: ctx.cookie } } : {}),
    });
    const candidate = res.location
      ?? (res.status !== undefined && res.status < 400 && res.body ? SogouWebEngine.extractRedirectTarget(res.body) : undefined);
    return SogouWebEngine.acceptTarget(candidate);
  }

  /** 是否为搜狗站内跳转链接（需要请求才能还原的那种） */
  static isSogouRedirect(url: string): boolean {
    const parsed = SogouWebEngine.parseLink(url);
    if (!parsed) return false;
    return /(^|\.)sogou\.com$/i.test(parsed.hostname) && parsed.pathname === '/link';
  }

  /** 从跳转页正文中提取目标地址：window.location.replace("...") / URL='...' / meta refresh */
  static extractRedirectTarget(html: string): string | undefined {
    const patterns = [
      /location\.replace\(\s*["']([^"']+)["']\s*\)/i,
      /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*?url\s*=\s*'?([^"'>\s]+)/i,
      /\bURL\s*=\s*'([^']+)'/,
      /location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    ];
    for (const re of patterns) {
      const m = re.exec(html);
      if (m?.[1]) return m[1].replace(/&amp;/g, '&').trim();
    }
    return undefined;
  }

  /** 只接受 http(s) 且不再是搜狗跳转的地址 */
  private static acceptTarget(raw: string | undefined): string | undefined {
    if (!raw || !/^https?:\/\//i.test(raw)) return undefined;
    const parsed = SogouWebEngine.parseLink(raw);
    if (!parsed || SogouWebEngine.isSogouRedirect(raw)) return undefined;
    return raw;
  }

  /** 结果节点上直接携带的真实地址（零请求，优先于跳转解包） */
  private static directUrlFrom($el: cheerio.Cheerio<AnyNode>, $link: cheerio.Cheerio<AnyNode>): string | undefined {
    const candidates = [
      $link.attr('data-url'),
      $el.attr('data-url'),
      $el.find('[data-url]').first().attr('data-url'),
    ];
    for (const c of candidates) {
      const url = c?.trim();
      if (url && /^https?:\/\//i.test(url) && !SogouWebEngine.isSogouRedirect(url)) return url;
    }
    return undefined;
  }

  /**
   * 识别搜狗验证码页。
   * 旧实现搜 body 里的 'antispam'：正常结果页的脚本里也有这个词，会把正常页误判为验证码
   */
  static isBlockedPage(html: string, finalUrl: string): boolean {
    if (finalUrl.includes('/antispam/')) return true;
    return html.includes('用户您好，我们的系统检测到您网络中存在异常访问请求') ||
      /id="seccodeForm"|id="seccodeInput"/.test(html);
  }

  /**
   * 搜狗结果链接多为站内跳转 /link?url=<加密串>，无法离线还原（由 unwrapRedirects 请求解包）；
   * 若跳转参数本身是明文 URL（部分结果如此）则直接解开，否则补全为绝对地址。
   */
  static resolveLink(raw: string, baseUrl: string): string {
    // 已是绝对地址：原样保留，避免 URL 规范化改写用户看到的链接（如补出末尾斜杠）
    if (/^https?:\/\//i.test(raw)) {
      const parsed = SogouWebEngine.parseLink(raw);
      if (parsed) {
        const target = parsed.searchParams.get('url');
        if (parsed.pathname === '/link' && target && /^https?:\/\//i.test(target)) return target;
      }
      return raw;
    }

    let absolute: URL;
    try {
      absolute = new URL(raw, baseUrl);
    } catch {
      return raw;
    }
    if (absolute.pathname === '/link') {
      const target = absolute.searchParams.get('url');
      if (target && /^https?:\/\//i.test(target)) return target;
    }
    return absolute.toString();
  }

  private static parseLink(raw: string): URL | undefined {
    try {
      return new URL(raw);
    } catch {
      return undefined;
    }
  }

  private parseResults(html: string, maxResults: number, baseUrl: string): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    let position = 0;

    // 搜狗结果在 div.vrwrap 或 div.rb 中
    $('div.vrwrap, div.rb').each((_, el) => {
      if (position >= maxResults) return false;

      const $el = $(el);
      if (isAdElement($, $el)) return;
      const linkEl = $el.find('h3 a').first();
      const title = linkEl.text().trim();
      if (!title) return;

      const rawUrl = linkEl.attr('href') ?? '';
      if (!rawUrl) return;

      // 摘要提取
      const snippet = $el.find('.str_info, .str-info, p.str_time, .space-txt, .text-layout').first().text().trim()
        || $el.find('p').not('h3').first().text().trim();

      position++;
      results.push({
        title,
        url: SogouWebEngine.directUrlFrom($el, linkEl) ?? SogouWebEngine.resolveLink(rawUrl, baseUrl),
        snippet: snippet || '',
        source: this.name,
        position,
      });
    });

    // 备用选择器
    if (results.length === 0) {
      $('div.results div.result, .section').each((_, el) => {
        if (position >= maxResults) return false;

        const $el = $(el);
        if (isAdElement($, $el)) return;
        const linkEl = $el.find('a').first();
        const title = $el.find('h3').text().trim() || linkEl.text().trim();
        const url = linkEl.attr('href') ?? '';
        if (!title || !url) return;

        const snippet = $el.find('p, .ft, .str_info').text().trim();
        position++;
        results.push({
          title,
          url: SogouWebEngine.resolveLink(url, baseUrl),
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
