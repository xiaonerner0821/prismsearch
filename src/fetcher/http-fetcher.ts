/**
 * HTTP 抓取器
 *
 * 基于统一 http-client：
 * - 超时覆盖整个请求（含 body 读取）
 * - 响应体流式限长
 * - 提供 validateUrl 时手动逐跳跟随重定向并校验每一跳（SSRF）
 * - 提供 dispatcher（SSRF 建连校验 Agent）时在建连阶段校验目标 IP；
 *   此时不走代理池（经代理时校验的是代理地址而非真实目标，校验失去意义）
 * - PDF 提取文本层（可选依赖 unpdf，限制页数）
 * - 拒绝其它非文本类 Content-Type（图片 / 视频 / 压缩包等）
 */

import { ContentExtractor } from './content-extractor.js';
import { httpRequest, HttpError, DEFAULT_MAX_BYTES } from '../utils/http-client.js';
import type { Fetcher, FetchOptions, FetchResult } from './fetcher-interface.js';
import { assertTextualResponse } from './content-type.js';
import { extractPdfText, formatPdfText, isPdfResponse } from './pdf-extractor.js';

// 兼容旧导入路径：判定函数已抽到 content-type.ts 与浏览器抓取器共用
export { looksBinary } from './content-type.js';

export interface HttpFetcherOptions {
  /** 默认超时（毫秒），由 fetcher.timeout 配置 */
  timeoutMs?: number;
  /** 默认响应体上限（字节），由 fetcher.maxBytes 配置 */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT = 30_000;

export class HttpFetcher implements Fetcher {
  readonly name = 'http';
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: HttpFetcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async fetch(options: FetchOptions): Promise<FetchResult> {
    const startTime = Date.now();
    const format = options.format ?? 'markdown';
    const timeoutMs = options.timeout ?? this.timeoutMs;

    const headers: Record<string, string> = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...options.headers,
    };
    if (options.userAgent) headers['User-Agent'] = options.userAgent;

    let response;
    try {
      response = await httpRequest(options.url, {
        headers,
        timeoutMs,
        maxBytes: options.maxBytes ?? this.maxBytes,
        signal: options.signal,
        dispatcher: options.dispatcher,
        useProxy: !options.dispatcher,
        redirect: options.validateUrl ? 'manual-checked' : 'follow',
        validateUrl: options.validateUrl,
        // 4xx/5xx 也返回内容，由调用方决定是否缓存
        throwOnHttpError: false,
        // 超大页面截断保留开头，而不是整页失败
        onTooLarge: 'truncate',
      });
    } catch (error: unknown) {
      if (error instanceof HttpError && error.code === 'TIMEOUT') {
        throw new Error(`请求超时 (${timeoutMs}ms): ${options.url}`, { cause: error });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`抓取失败: ${options.url} - ${message}`, { cause: error });
    }

    const contentType = response.headers.get('content-type') ?? undefined;

    // PDF：提取文本层（不同于其它二进制类型直接拒绝）
    if (isPdfResponse(contentType, response.body)) {
      const pdf = await extractPdfText(response.body, { truncated: response.truncated });
      const content = formatPdfText(pdf, format);
      const notes: string[] = [];
      if (pdf.pages.length < pdf.totalPages) notes.push(`PDF 共 ${pdf.totalPages} 页，只提取了前 ${pdf.pages.length} 页`);
      if (!content) notes.push('PDF 没有可提取的文本层（可能是扫描件）');
      return {
        url: response.url,
        content,
        title: pdf.title,
        statusCode: response.status,
        contentType: contentType ?? 'application/pdf',
        contentLength: response.body.byteLength,
        fetchTime: Date.now() - startTime,
        fetchedBy: this.name,
        ...(notes.length ? { warnings: notes } : {}),
      };
    }

    assertTextualResponse(contentType, response.body);

    const raw = response.text();
    const { content, title } = await ContentExtractor.extractReadable(raw, { format, baseUrl: response.url, contentType });

    return {
      url: response.url,
      content,
      rawHtml: format === 'html' || options.includeRawHtml ? raw : undefined,
      title,
      statusCode: response.status,
      contentType,
      contentLength: response.body.byteLength,
      fetchTime: Date.now() - startTime,
      fetchedBy: this.name,
      ...(response.truncated ? { truncated: true } : {}),
    };
  }
}
