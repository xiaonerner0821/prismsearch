/**
 * 网页抓取器接口定义
 */

import type { Dispatcher } from 'undici';

// 抓取请求选项
export interface FetchOptions {
  url: string;
  format?: 'html' | 'text' | 'markdown';  // 返回格式，默认markdown
  timeout?: number;                         // 超时时间(ms)，覆盖整个请求（含 body 读取）
  headers?: Record<string, string>;         // 自定义请求头
  userAgent?: string;                       // User-Agent（未指定时取全局 UA 配置/UA 池）
  method?: 'http' | 'browser';             // 抓取方式
  waitForSelector?: string;                 // 等待特定选择器出现（仅browser模式）
  waitForTimeout?: number;                  // 额外等待时间ms（仅browser模式）
  /** 响应体字节上限，超限中止 */
  maxBytes?: number;
  /**
   * 逐跳 URL 校验（SSRF 防护）。HTTP 抓取的每一跳重定向、浏览器抓取的每个
   * 导航与子资源请求都会调用；抛错即拒绝。
   */
  validateUrl?: (url: string) => Promise<void> | void;
  /** 自定义 undici dispatcher（如 SSRF 建连校验 Agent） */
  dispatcher?: Dispatcher;
  /** 外部取消信号 */
  signal?: AbortSignal;
  /**
   * 即使 format 不是 html 也返回 rawHtml（fetch_page 用它做骨架页 / 反爬页检测，
   * 返回给调用方前会去掉）。不支持的抓取器可忽略。
   */
  includeRawHtml?: boolean;
}

// 抓取结果
export interface FetchResult {
  url: string;              // 最终URL（可能有重定向）
  content: string;          // 内容（按format格式化后的）
  rawHtml?: string;         // 原始HTML（仅format=html时有值）
  title?: string;           // 页面标题
  statusCode: number;       // HTTP状态码
  contentType?: string;     // Content-Type
  contentLength?: number;   // 内容长度（字节）
  fetchTime: number;        // 抓取耗时(ms)
  /** 实际执行抓取的后端：http / browser / worker:<name> */
  fetchedBy?: string;
  /** 响应体超过 maxBytes 被截断（内容只含开头部分） */
  truncated?: boolean;
  /** 抓取器自身的提示（如 PDF 只提取了前若干页），fetch_page 会并入结果 warnings */
  warnings?: string[];
}

// 抓取器接口
export interface Fetcher {
  fetch(options: FetchOptions): Promise<FetchResult>;
  readonly name: string;
  close?(): Promise<void>;
}

/** 允许抓取的文本类 Content-Type（其余如图片、视频、压缩包直接拒绝） */
export function isTextualContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return true; // 未声明时交给内容解析兜底
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return (
    mime.startsWith('text/') ||
    mime === 'application/xhtml+xml' ||
    mime === 'application/xml' ||
    mime === 'application/json' ||
    mime === 'application/ld+json' ||
    mime === 'application/rss+xml' ||
    mime === 'application/atom+xml' ||
    mime === 'application/javascript' ||
    mime.endsWith('+xml') ||
    mime.endsWith('+json')
  );
}
