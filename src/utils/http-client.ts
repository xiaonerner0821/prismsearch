/**
 * 统一 HTTP 客户端
 *
 * 所有搜索引擎与抓取器都经由此模块发请求，集中解决以下问题：
 * - 超时覆盖整个请求（含 body 读取），旧实现拿到响应头即 clearTimeout，慢速 body 可无限挂起
 * - 响应体流式读取并限制大小，超限立即中止，避免大文件/二进制导致 OOM
 * - 统一 User-Agent 池（可被 fetcher.userAgent 覆盖），不再各文件写死不同版本的 UA
 * - 代理池接线：复用 ProxyAgent dispatcher，并上报成功/失败
 * - 手动跟随重定向，每一跳都可调用校验钩子（fetch_page / 缩略图用于 SSRF 逐跳校验）
 */

import { fetch as undiciFetch, type Dispatcher } from 'undici';
import type { ProxyPool } from './proxy-pool.js';

/** 维护中的桌面浏览器 UA 池（定期随依赖更新时一并刷新） */
export const USER_AGENT_POOL: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
];

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
export const DEFAULT_MAX_REDIRECTS = 5;

interface HttpDefaults {
  /** 固定 UA；为空时从 UA 池轮换 */
  userAgent?: string;
  timeoutMs: number;
  maxBytes: number;
  proxyPool?: ProxyPool;
}

const defaults: HttpDefaults = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxBytes: DEFAULT_MAX_BYTES,
};

let uaIndex = 0;

/** 由服务器在加载 / 热重载配置后调用 */
export function configureHttpDefaults(options: Partial<HttpDefaults>): void {
  if ('userAgent' in options) defaults.userAgent = options.userAgent?.trim() || undefined;
  if (options.timeoutMs !== undefined) defaults.timeoutMs = options.timeoutMs;
  if (options.maxBytes !== undefined) defaults.maxBytes = options.maxBytes;
  if ('proxyPool' in options) defaults.proxyPool = options.proxyPool;
}

export function getHttpDefaults(): Readonly<HttpDefaults> {
  return defaults;
}

/** 取一个 UA：配置固定值优先，否则轮换 UA 池 */
export function pickUserAgent(): string {
  if (defaults.userAgent) return defaults.userAgent;
  const ua = USER_AGENT_POOL[uaIndex % USER_AGENT_POOL.length];
  uaIndex = (uaIndex + 1) % USER_AGENT_POOL.length;
  return ua;
}

export type HttpErrorCode = 'TIMEOUT' | 'ABORTED' | 'TOO_LARGE' | 'TOO_MANY_REDIRECTS' | 'BLOCKED' | 'HTTP' | 'NETWORK';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: HttpErrorCode,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** 整个请求（含 body 读取）的超时 */
  timeoutMs?: number;
  /** 响应体字节上限 */
  maxBytes?: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
  /** 是否使用代理池（默认 true；显式 dispatcher 优先） */
  useProxy?: boolean;
  /** 显式 dispatcher（如 SSRF 安全 Agent） */
  dispatcher?: Dispatcher;
  /**
   * 重定向处理：
   * - 'follow'：交给底层自动跟随（引擎抓取搜索页用）
   * - 'manual-checked'：手动逐跳跟随，每跳调用 validateUrl
   */
  redirect?: 'follow' | 'manual-checked';
  maxRedirects?: number;
  /** 逐跳 URL 校验（抛错即中止） */
  validateUrl?: (url: string) => Promise<void> | void;
  /** 非 2xx 是否抛错（默认 true） */
  throwOnHttpError?: boolean;
  /**
   * 响应体超过 maxBytes 时的处理：
   * - 'throw'（默认）：中止并抛 TOO_LARGE
   * - 'truncate'：保留前 maxBytes 字节并标记 truncated（fetch_page 用，大页面仍能拿到正文开头）
   */
  onTooLarge?: 'throw' | 'truncate';
}

export interface HttpResponse {
  status: number;
  statusText: string;
  ok: boolean;
  /** 最终 URL（跟随重定向后） */
  url: string;
  headers: Headers;
  body: Uint8Array;
  /** 响应体是否因 maxBytes 被截断（仅 onTooLarge='truncate' 时可能为 true） */
  truncated: boolean;
  /** 按 Content-Type / BOM / <meta> 嗅探出的字符集解码 */
  text(): string;
  json<T = unknown>(): T;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 流式读取 body；超过上限时按 mode 抛错或截断 */
async function readBodyLimited(
  res: Response,
  maxBytes: number,
  controller: AbortController,
  mode: 'throw' | 'truncate' = 'throw',
): Promise<{ body: Uint8Array; truncated: boolean }> {
  const declared = Number(res.headers.get('content-length'));
  if (mode === 'throw' && Number.isFinite(declared) && declared > maxBytes) {
    controller.abort();
    throw new HttpError(`响应体过大（${declared} 字节，上限 ${maxBytes}）`, res.status, 'TOO_LARGE');
  }
  if (!res.body) return { body: new Uint8Array(0), truncated: false };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      if (mode === 'throw') {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new HttpError(`响应体超过上限 ${maxBytes} 字节`, res.status, 'TOO_LARGE');
      }
      const remain = maxBytes - total;
      if (remain > 0) chunks.push(value.subarray(0, remain));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { body: out, truncated };
}

/** 常见字符集别名 → TextDecoder 标签；GB2312/GBK 统一按超集 GB18030 解码 */
function normalizeCharset(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cs = raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!cs) return undefined;
  if (cs === 'gb2312' || cs === 'gbk' || cs === 'x-gbk' || cs === 'gb_2312-80') return 'gb18030';
  return cs;
}

function isSupportedCharset(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * 嗅探响应体字符集，优先级：BOM > Content-Type charset > HTML/XML 头部声明 >
 * 合法 UTF-8 则 utf-8，否则 GB18030（国内老站不声明编码时最常见的情况）。
 */
export function sniffCharset(body: Uint8Array, contentType: string | null | undefined): string {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';

  const fromHeader = normalizeCharset(/charset=([^;]+)/i.exec(contentType ?? '')?.[1]);
  if (fromHeader && isSupportedCharset(fromHeader)) return fromHeader;

  // 只扫描前 4KB 的 ASCII 部分寻找 <meta charset> / http-equiv / <?xml encoding?>
  const head = new TextDecoder('latin1').decode(body.subarray(0, 4096));
  const meta =
    /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1];
  const fromMeta = normalizeCharset(meta);
  if (fromMeta && isSupportedCharset(fromMeta)) return fromMeta;

  // 无任何声明：合法 UTF-8 就用 UTF-8，否则按 GB18030 兜底
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    return 'utf-8';
  } catch {
    return 'gb18030';
  }
}

export function decodeBody(body: Uint8Array, contentType: string | null | undefined): string {
  const charset = sniffCharset(body, contentType);
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** 手动跟随重定向时的极简 Cookie 罐（按 host 存储 name=value，只服务于本次请求链） */
class RedirectCookieJar {
  private readonly jar = new Map<string, Map<string, string>>();

  store(url: string, headers: Headers): void {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    if (list.length === 0) return;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    const cookies = this.jar.get(host) ?? new Map<string, string>();
    for (const line of list) {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    this.jar.set(host, cookies);
  }

  /** 取发往 url 的 Cookie 头：同 host 或父域（a.example.com 带上 example.com 的） */
  header(url: string): string | undefined {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return undefined;
    }
    const parts: string[] = [];
    for (const [h, cookies] of this.jar) {
      if (host === h || host.endsWith(`.${h}`)) {
        for (const [k, v] of cookies) parts.push(`${k}=${v}`);
      }
    }
    return parts.length ? parts.join('; ') : undefined;
  }
}

/**
 * 发送 HTTP 请求。
 * 超时由单一 AbortController 管理，覆盖连接、重定向与 body 读取全过程。
 */
export async function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? defaults.timeoutMs;
  const maxBytes = options.maxBytes ?? defaults.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const redirectMode = options.redirect ?? 'follow';

  // 调用前就已取消：立即失败，不再等到超时才报「请求超时」
  if (options.signal?.aborted) {
    throw new HttpError('请求已取消', undefined, 'ABORTED');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new HttpError(`请求超时 (${timeoutMs}ms)`, undefined, 'TIMEOUT')), timeoutMs);
  timer.unref?.();
  const onExternalAbort = () => controller.abort(new HttpError('请求已取消', undefined, 'ABORTED'));
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  // 代理选择：显式 dispatcher > 代理池
  let proxy: string | undefined;
  let dispatcher = options.dispatcher;
  if (!dispatcher && options.useProxy !== false) {
    const acquired = defaults.proxyPool?.acquire();
    if (acquired) {
      proxy = acquired.proxy;
      dispatcher = acquired.dispatcher;
    }
  }

  const headers: Record<string, string> = {
    'User-Agent': pickUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...options.headers,
  };

  const cookieJar = redirectMode === 'manual-checked' ? new RedirectCookieJar() : undefined;
  const userCookie = Object.entries(headers).find(([k]) => k.toLowerCase() === 'cookie')?.[1];

  try {
    let currentUrl = url;
    let method: string = options.method ?? 'GET';
    let body = options.body;
    let res: Response;
    for (let hop = 0; ; hop++) {
      if (options.validateUrl) {
        try {
          await options.validateUrl(currentUrl);
        } catch (error) {
          throw new HttpError(error instanceof Error ? error.message : String(error), undefined, 'BLOCKED');
        }
      }

      // 重定向链上种下的 Cookie 带到下一跳（部分站点靠 302 种 Cookie，不带会循环跳转）
      const hopHeaders = { ...headers };
      const jarCookie = cookieJar?.header(currentUrl);
      if (jarCookie) {
        for (const k of Object.keys(hopHeaders)) if (k.toLowerCase() === 'cookie') delete hopHeaders[k];
        hopHeaders.Cookie = userCookie ? `${userCookie}; ${jarCookie}` : jarCookie;
      }

      const init = {
        method,
        headers: hopHeaders,
        body,
        redirect: redirectMode === 'follow' ? 'follow' : 'manual',
        signal: controller.signal,
      } as const;

      // 有 dispatcher 时必须使用 npm undici 的 fetch，保证 dispatcher 与 fetch 实现同版本；
      // 否则使用全局 fetch（便于测试替换）
      res = dispatcher
        ? (await undiciFetch(currentUrl, { ...init, dispatcher })) as unknown as Response
        : await globalThis.fetch(currentUrl, init);

      if (redirectMode === 'manual-checked' && REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location) break;
        if (hop >= maxRedirects) {
          throw new HttpError(`重定向次数超过上限 ${maxRedirects}`, res.status, 'TOO_MANY_REDIRECTS');
        }
        cookieJar?.store(currentUrl, res.headers);
        // 303 / 301,302 的 POST 按浏览器语义改为 GET 并丢弃 body
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    const read = await readBodyLimited(res, maxBytes, controller, options.onTooLarge);
    const responseBody = read.body;
    const finalUrl = res.url || currentUrl;

    if (proxy) defaults.proxyPool?.reportSuccess(proxy);

    if (!res.ok && options.throwOnHttpError !== false) {
      throw new HttpError(`HTTP ${res.status}: ${res.statusText}`, res.status, 'HTTP');
    }

    const contentType = res.headers.get('content-type');
    let decoded: string | undefined;
    return {
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      url: finalUrl,
      headers: res.headers,
      body: responseBody,
      truncated: read.truncated,
      text: () => (decoded ??= decodeBody(responseBody, contentType)),
      json: <T>() => JSON.parse(decoded ??= decodeBody(responseBody, contentType)) as T,
    };
  } catch (error: unknown) {
    const normalized = normalizeError(error, controller, timeoutMs);
    // 只有网络层 / 超时才算代理故障；HTTP 状态错误、用户取消、SSRF 拦截、体积超限、重定向过多都与代理无关
    if (proxy && (normalized.code === 'NETWORK' || normalized.code === 'TIMEOUT')) {
      defaults.proxyPool?.reportFailure(proxy);
    }
    throw normalized;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function normalizeError(error: unknown, controller: AbortController, timeoutMs: number): HttpError {
  if (error instanceof HttpError) return error;
  const reason: unknown = controller.signal.reason;
  if (controller.signal.aborted && reason instanceof HttpError) return reason;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new HttpError(`请求超时 (${timeoutMs}ms)`, undefined, 'TIMEOUT');
  }
  return new HttpError(error instanceof Error ? error.message : String(error), undefined, 'NETWORK');
}

/** 便捷方法：GET 并返回文本 */
export async function httpGetText(url: string, options: HttpRequestOptions = {}): Promise<string> {
  const res = await httpRequest(url, options);
  return res.text();
}

/** 便捷方法：GET 并解析 JSON */
export async function httpGetJson<T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<T> {
  const res = await httpRequest(url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  return res.json<T>();
}
