/**
 * 微信公众号文章搜索（基于搜狗微信搜索）
 * 搜索地址：https://weixin.sogou.com/weixin?type=2&query=关键词
 *
 * 实现思路参考 Miku_Spider（https://github.com/GobinFan/Miku_Spider，见 NOTICE），
 * 以 TypeScript 原生重写，不依赖 Python。
 *
 * 工作流程：
 * 1. 访问搜狗首页获取会话 Cookie（含反爬必需的 SNUID），全部动态获取，不再写死他人的 Cookie 值
 * 2. 请求搜狗微信搜索页，解析文章列表（标题 / 摘要 / 公众号 / 日期）
 * 3. 并发请求搜狗跳转页，拼接 JS 中的 url 片段还原真实 mp.weixin.qq.com 签名链接
 *
 * 可靠性：
 * - 整体截止时间（wechat.overallTimeoutMs）：所有重试与链接还原共享一个截止信号
 * - 仅对网络错误 / 反爬页重试；页面正常但没有结果时直接返回空列表
 * - 链接还原保持搜狗的原始排序，失败条目跳过，结果截断到 count
 *
 * 注意：返回的文章链接是带签名的临时链接，有效期有限，需要正文时应尽快用 fetch_page 抓取。
 */

import * as cheerio from 'cheerio';
import type { SearchProvider, SearchRequest, SearchResponse, SearchResult, EngineStatus } from '../engine-interface.js';
import { EngineBlockedError, EngineParseError } from '../engine-interface.js';
import { assertParsed } from '../scraper-http.js';
import type { EngineConfig, WechatConfig } from '../../config/config-schema.js';
import { EngineStats } from '../engine-stats.js';
import { HttpError, pickUserAgent } from '../../utils/http-client.js';

/** 搜狗反爬验证码页面特征 */
const ANTISPAM_MARKERS = ['请输入验证码', 'antispam', '异常访问请求'];

/** 搜索结果列表容器特征：有容器却没有条目才可能是「真的没有结果」 */
const RESULT_LIST_MARKER = /news-list|sogou_vr_11002601/;

/** 搜狗微信每页固定 10 条 */
const PAGE_SIZE = 10;

class AntispamError extends Error {
  constructor() {
    super('搜狗返回验证码页面，触发反爬限制');
    this.name = 'AntispamError';
  }
}

type WechatOptions = Pick<WechatConfig, 'overallTimeoutMs' | 'concurrency' | 'retries'>;

const DEFAULT_OPTIONS: WechatOptions = { overallTimeoutMs: 30_000, concurrency: 3, retries: 2 };

export class WechatArticleEngine implements SearchProvider {
  readonly name = 'wechat';
  readonly displayName = '微信公众号（搜狗）';
  private readonly config: EngineConfig;
  private readonly options: WechatOptions;
  private readonly stats = new EngineStats();
  private readonly userAgent = pickUserAgent();
  private lastError?: string;

  constructor(config: EngineConfig, options: Partial<WechatOptions> = {}) {
    this.config = config;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private get origin(): string {
    return new URL(this.config.baseUrl).origin;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const startTime = Date.now();
    const count = Math.min(Math.max(request.count ?? PAGE_SIZE, 1), PAGE_SIZE);
    const page = request.page ?? 1;
    const timeout = AbortSignal.timeout(this.options.overallTimeoutMs);
    // 客户端取消与整体截止时间合并：任一触发都停止重试与链接还原
    const deadline = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;

    try {
      const { results, rawCount } = await this.searchWithRetry(request.query, count, page, deadline);
      const searchTime = Date.now() - startTime;
      this.stats.record(true, searchTime);
      this.lastError = undefined;
      return {
        results,
        engine: this.name,
        searchTime,
        cached: false,
        page,
        hasMore: rawCount >= PAGE_SIZE,
      };
    } catch (error) {
      const searchTime = Date.now() - startTime;
      const cancelled = request.signal?.aborted === true;
      const message = cancelled
        ? '微信搜索已取消'
        : timeout.aborted
          ? `微信搜索超时（${this.options.overallTimeoutMs}ms）`
          : error instanceof Error ? error.message : String(error);
      this.lastError = message;
      // 客户端主动取消与引擎健康无关，不计入熔断
      const abortError = Object.assign(new Error(message), { name: 'AbortError' });
      this.stats.record(false, searchTime, cancelled ? abortError : message);
      if (cancelled) throw Object.assign(new Error(message, { cause: error }), { name: 'AbortError' });
      if (timeout.aborted) throw new HttpError(message, undefined, 'TIMEOUT');
      // 验证码 / 解析失败 / HTTP 错误保留原类型：工具层按类型决定是否把原因展示给调用方，
      // 包成普通 Error 会让用户只看到「内部错误」
      if (error instanceof EngineBlockedError || error instanceof EngineParseError || error instanceof HttpError) throw error;
      throw new Error(message, { cause: error });
    }
  }

  /** 网络错误与反爬页重试（每次换新 Cookie）；正常页面无结果直接返回 */
  private async searchWithRetry(
    query: string, count: number, page: number, deadline: AbortSignal,
  ): Promise<{ results: SearchResult[]; rawCount: number }> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      if (deadline.aborted) break;
      if (attempt > 0) await sleep(800 * attempt + Math.random() * 500, deadline);
      try {
        const cookie = await this.fetchSessionCookie(deadline);
        const html = await this.fetchSearchPage(query, page, cookie, deadline);
        const items = this.parseSearchPage(html);
        // 结果列表容器在但为空 = 真的没有结果；连容器都没有说明页面不是搜索页（改版或软拦截），
        // 交给解析错误走降级链，而不是静默返回 0 条被缓存下来
        if (items.length === 0) {
          if (!RESULT_LIST_MARKER.test(html)) assertParsed(items, html, '搜狗微信');
          return { results: [], rawCount: 0 };
        }
        const results = await this.resolveUrls(items, count, cookie, deadline);
        return { results, rawCount: items.length };
      } catch (error) {
        lastError = error;
        // 页面结构问题换 Cookie 重试也无济于事
        if (error instanceof EngineParseError) throw error;
      }
    }
    // 重试用尽仍是反爬页：明确报「被拦截」，与其他引擎的验证码处理一致
    if (lastError instanceof AntispamError) {
      throw new EngineBlockedError('搜狗微信搜索触发反爬验证码拦截，请稍后重试');
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? '微信搜索失败'));
  }

  /** 访问搜狗页面，收集 Set-Cookie（必须含 SNUID） */
  private async fetchSessionCookie(deadline: AbortSignal): Promise<string> {
    // 实测（2026-10）：微信首页与视频页已不再下发 SNUID，只有网页搜索结果页会下发，放在首位
    const sources = [
      'https://www.sogou.com/web?ie=utf8&query=%E5%A4%A9%E6%B0%94',
      `${this.origin}/`,
      'https://v.sogou.com/v?ie=utf8&query=&p=40030600',
    ];
    for (const url of sources) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': this.userAgent, 'Accept-Language': 'zh-CN,zh;q=0.9' },
          redirect: 'manual',
          signal: AbortSignal.any([deadline, AbortSignal.timeout(8000)]),
        });
        await resp.body?.cancel().catch(() => undefined);
        const jar = new Map<string, string>();
        for (const c of getSetCookies(resp.headers)) {
          const pair = c.split(';', 1)[0];
          const eq = pair.indexOf('=');
          if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        if (jar.has('SNUID')) {
          return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        }
      } catch {
        if (deadline.aborted) throw new Error('微信搜索超时');
        // 尝试下一个来源
      }
    }
    throw new EngineBlockedError('无法获取搜狗 SNUID Cookie（会话 Cookie 未下发，疑似出口 IP 被风控）');
  }

  private async fetchSearchPage(query: string, page: number, cookie: string, deadline: AbortSignal): Promise<string> {
    const url = new URL(this.config.baseUrl);
    url.searchParams.set('type', '2'); // 2 = 搜文章（1 = 搜公众号）
    url.searchParams.set('query', query);
    url.searchParams.set('ie', 'utf8');
    if (page > 1) url.searchParams.set('page', String(page));

    const resp = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${this.origin}/`,
        Cookie: cookie,
      },
      redirect: 'manual',
      signal: AbortSignal.any([deadline, AbortSignal.timeout(this.config.timeout)]),
    });

    if (resp.status !== 200) {
      await resp.body?.cancel().catch(() => undefined);
      // 302 到 antispam / antispider 页同样视为反爬（实测现在跳的是 /antispider/?antip=wx_...）
      if (resp.status >= 300 && resp.status < 400 && /antispam|antispider/i.test(resp.headers.get('location') ?? '')) {
        throw new AntispamError();
      }
      throw new HttpError(`搜狗微信搜索返回 HTTP ${resp.status}`, resp.status, 'HTTP');
    }

    const html = await resp.text();
    if (ANTISPAM_MARKERS.some(m => html.includes(m))) throw new AntispamError();
    return html;
  }

  /** 解析搜索结果页，提取文章元信息（URL 留待 resolveUrls 还原） */
  parseSearchPage(html: string): ParsedItem[] {
    const $ = cheerio.load(html);
    const items: ParsedItem[] = [];

    $('li[id^="sogou_vr_11002601_box_"]').each((_, el) => {
      const $el = $(el);
      const linkEl = $el.find('h3 a[target="_blank"]').first();
      const title = linkEl.text().replace(/\s+/g, ' ').trim();
      const href = linkEl.attr('href') ?? '';
      if (!title || !href) return;

      const snippet = $el.find('p.txt-info').first().text().replace(/\s+/g, ' ').trim();
      const account = $el.find('span.all-time-y2').first().text().trim()
        || $el.find('a[href*="websearch/weixin"]').first().text().trim();

      // 日期藏在 span.s2 的 <script>document.write(timeConvert('...'))</script> 里
      let timestamp: string | undefined;
      const scriptText = $el.find('span.s2 script').first().text()
        || $el.find('span.s2').first().find('script').html() || '';
      const tsMatch = /timeConvert\('?(\d{9,})'?\)/.exec(scriptText) || /'(\d{9,})'/.exec(scriptText);
      if (tsMatch) timestamp = new Date(Number(tsMatch[1]) * 1000).toISOString();

      items.push({
        title,
        snippet,
        account,
        timestamp,
        sogouUrl: href.startsWith('http') ? href : `${this.origin}${href}`,
      });
    });

    return items;
  }

  /** 并发还原真实文章链接；保持原始顺序，凑够 count 条即停止派发新任务 */
  private async resolveUrls(
    items: ParsedItem[], count: number, cookie: string, deadline: AbortSignal,
  ): Promise<SearchResult[]> {
    const resolved: Array<string | undefined> = new Array(items.length);
    let next = 0;
    let successes = 0;

    const worker = async (): Promise<void> => {
      while (next < items.length && successes < count && !deadline.aborted) {
        const index = next++;
        const url = await this.resolveArticleUrl(items[index].sogouUrl, cookie, deadline);
        if (url) {
          resolved[index] = url;
          successes++;
        }
      }
    };

    const concurrency = Math.max(1, Math.min(this.options.concurrency, items.length));
    await Promise.all(Array.from({ length: concurrency }, worker));

    const results: SearchResult[] = [];
    items.forEach((item, i) => {
      const url = resolved[i];
      if (!url || results.length >= count) return;
      results.push({
        title: item.title,
        url,
        snippet: item.account ? `【${item.account}】${item.snippet}` : item.snippet,
        source: this.name,
        position: results.length + 1,
        timestamp: item.timestamp,
      });
    });
    return results;
  }

  /** 请求搜狗跳转页，从 JS 片段拼接真实 mp.weixin.qq.com 链接 */
  private async resolveArticleUrl(sogouUrl: string, cookie: string, deadline: AbortSignal): Promise<string> {
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      if (deadline.aborted) return '';
      if (attempt > 0) {
        await sleep(500 * attempt + Math.random() * 300, deadline).catch(() => undefined);
        cookie = await this.fetchSessionCookie(deadline).catch(() => cookie);
      }
      try {
        const resp = await fetch(sogouUrl, {
          headers: { 'User-Agent': this.userAgent, Referer: `${this.origin}/`, Cookie: cookie },
          redirect: 'manual',
          signal: AbortSignal.any([deadline, AbortSignal.timeout(this.config.timeout)]),
        });
        if (resp.status !== 200) {
          await resp.body?.cancel().catch(() => undefined);
          continue;
        }
        const url = extractArticleUrl(await resp.text());
        if (url) return url;
      } catch {
        // 重试
      }
    }
    return '';
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
}

/**
 * 从搜狗跳转页 HTML 中还原文章链接（导出供测试）。
 * 跳转页用多段 `url += '...'` 拼接，并插入 @ 混淆；
 * 部分页面中 `&timestamp` 被当作 HTML 实体 `&times` 解码成「×tamp」，需要修正。
 */
export function extractArticleUrl(html: string): string {
  const parts = [...html.matchAll(/url\s*\+=\s*'([^']*)'/g)].map(m => m[1]);
  if (parts.length === 0) return '';
  const url = parts
    .join('')
    .replace(/@/g, '')
    .replace(/\u00d7tamp/g, '&timestamp')
    .replace(/&amp;/g, '&');
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'mp.weixin.qq.com' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

export interface ParsedItem {
  title: string;
  snippet: string;
  account: string;
  timestamp?: string;
  sogouUrl: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}
