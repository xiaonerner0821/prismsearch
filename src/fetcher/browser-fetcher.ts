/**
 * 基于 Playwright 的浏览器抓取器 — 支持 JavaScript 渲染页面
 *
 * SSRF 防护：提供 validateUrl 时通过 page.route 拦截**所有**请求
 * （导航、重定向后的跳转、子资源），对每个 URL 逐一校验，不合规立即 abort。
 * 旧实现只校验初始 URL，页面内 302 或 iframe 可直达内网。
 */

import { ContentExtractor } from './content-extractor.js';
import { BrowserPool, type PlaywrightPage } from './browser-pool.js';
import type { Fetcher, FetchOptions, FetchResult } from './fetcher-interface.js';
import type { BrowserFetcherConfig } from '../config/config-schema.js';
import { getLogger, redactUrl } from '../utils/logger.js';
import { assertTextualResponse, UnsupportedContentTypeError } from './content-type.js';

interface PlaywrightResponse {
  status(): number;
  headers(): Record<string, string>;
  body?(): Promise<Uint8Array>;
}

/** 子资源类型中需要校验的（data:/blob:/about: 等非网络请求不校验） */
const NETWORK_RESOURCE_TYPES = new Set([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'xhr',
  'fetch',
  'websocket',
  'manifest',
  'other',
]);

export class BrowserFetcher implements Fetcher {
  readonly name = 'browser';
  private readonly pool: BrowserPool;
  private readonly config: BrowserFetcherConfig;

  constructor(config: BrowserFetcherConfig) {
    this.config = config;
    this.pool = new BrowserPool(config);
  }

  async fetch(options: FetchOptions): Promise<FetchResult> {
    const startTime = Date.now();
    const format = options.format ?? 'markdown';
    const timeout = options.timeout ?? this.config.pageTimeout;
    const logger = getLogger();

    // 整个抓取（排队 + 导航 + 等待选择器）共用一个截止时间，不超过调用方给的 timeout
    const deadline = startTime + timeout;
    const remaining = () => Math.max(1, deadline - Date.now());

    if (options.signal?.aborted) throw new Error(`浏览器抓取已取消: ${options.url}`);
    const pooled = await this.pool.acquire({ timeoutMs: timeout, signal: options.signal });
    const { page } = pooled;
    // 客户端取消时立即关闭页面，让 goto / waitForSelector 尽快抛出
    const onAbort = () => void page.close().catch(() => undefined);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.installSsrfInterception(page, options, logger);

      const extraHeaders: Record<string, string> = { ...(options.headers ?? {}) };
      if (options.userAgent) extraHeaders['User-Agent'] = options.userAgent;
      if (Object.keys(extraHeaders).length > 0) {
        await page.setExtraHTTPHeaders(extraHeaders);
      }

      const rawResponse = await page.goto(options.url, {
        timeout: remaining(),
        waitUntil: this.config.waitUntil,
      });
      const response = rawResponse as PlaywrightResponse | null;

      // 主文档类型检查（与 http 抓取器一致）：PDF / 图片 / 二进制流不当作页面处理
      const declaredType = response?.headers()['content-type'] || undefined;
      if (response) {
        let body: Uint8Array | undefined;
        if (!declaredType && typeof response.body === 'function') {
          body = await response.body().catch(() => undefined);
        }
        assertTextualResponse(declaredType, body);
      }

      // 等待特定选择器（非致命：超时后继续使用已渲染的内容，
      // 让调用方有机会拿到部分页面或识别反爬页，而不是直接失败）
      if (options.waitForSelector) {
        try {
          await page.waitForSelector(options.waitForSelector, {
            timeout: Math.min(options.waitForTimeout ?? 10000, remaining()),
          });
        } catch (error: unknown) {
          if (options.signal?.aborted) throw error;
          logger.warn('等待选择器超时，继续使用当前页面内容', {
            url: redactUrl(options.url),
            selector: options.waitForSelector,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (options.waitForTimeout) {
        await page.waitForTimeout(Math.min(options.waitForTimeout, remaining()));
      }

      const rawHtml = await page.content();
      const fetchTime = Date.now() - startTime;
      const finalUrl = page.url();
      const { content, title } = await ContentExtractor.extractReadable(rawHtml, {
        format,
        baseUrl: finalUrl,
        contentType: 'text/html',
      });

      logger.debug('浏览器抓取完成', { url: redactUrl(options.url), fetchTime });

      return {
        url: finalUrl,
        content,
        rawHtml: format === 'html' ? rawHtml : undefined,
        title,
        statusCode: response?.status() ?? 200,
        contentType: declaredType,
        contentLength: Buffer.byteLength(rawHtml, 'utf8'),
        fetchTime,
        fetchedBy: this.name,
      };
    } catch (error: unknown) {
      if (options.signal?.aborted) throw new Error(`浏览器抓取已取消: ${options.url}`, { cause: error });
      // 内容类型不支持是确定性结论，原样抛出（保留 code，fetch_page 据此不再降级重试）
      if (error instanceof UnsupportedContentTypeError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`浏览器抓取失败: ${options.url} - ${msg}`, { cause: error });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      await this.pool.release(pooled);
    }
  }

  /** 安装请求拦截：对每个网络请求做 SSRF 校验 */
  private async installSsrfInterception(
    page: PlaywrightPage,
    options: FetchOptions,
    logger: ReturnType<typeof getLogger>,
  ): Promise<void> {
    const validate = options.validateUrl;
    if (!validate || typeof page.route !== 'function') return;

    await page.route('**/*', async (route, request) => {
      const url = request.url();
      const type = request.resourceType();
      if (!NETWORK_RESOURCE_TYPES.has(type)) {
        await route.continue().catch(() => undefined);
        return;
      }
      // 只对网络协议校验；data:/blob:/about: 等由浏览器内部处理
      if (!/^https?:/i.test(url)) {
        await route.continue().catch(() => undefined);
        return;
      }
      try {
        await validate(url);
        await route.continue().catch(() => undefined);
      } catch (error: unknown) {
        logger.warn('浏览器请求被 SSRF 防护拦截', {
          url: sanitizeUrl(url),
          reason: error instanceof Error ? error.message : String(error),
        });
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

/** 日志用：去掉查询串与认证信息 */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '<invalid-url>';
  }
}
