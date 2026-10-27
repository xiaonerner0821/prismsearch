/**
 * 抓取器：http（undici，连接期 SSRF 校验）与 browser（Playwright，路由拦截校验）
 */

import { Agent, fetch as undiciFetch } from 'undici';
import { extractContent, type OutputFormat } from './extract.js';
import { assertUrlAllowed, createGuardedAgent, SsrfBlockedError } from './ssrf.js';

export type FetchMethod = 'http' | 'browser';

export interface WorkerFetchRequest {
  url: string;
  format?: OutputFormat;
  method?: FetchMethod;
  timeoutMs?: number;
  maxBytes?: number;
  waitForSelector?: string;
  headers?: Record<string, string>;
  userAgent?: string;
}

export interface WorkerFetchResult {
  url: string;
  content: string;
  rawHtml?: string;
  title?: string;
  statusCode: number;
  contentType?: string;
  contentLength?: number;
  fetchTime: number;
  /** 响应体因 maxBytes 被截断（与主进程 FetchResult.truncated 一致；未截断时不出现） */
  truncated?: boolean;
}

/** 目标站点取不到（对应 FETCH_FAILED） */
export class TargetFetchError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
    this.name = 'TargetFetchError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
];

function pickUserAgent(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return UA_POOL[hash % UA_POOL.length];
}

let sharedAgent: Agent | undefined;
function guardedAgent(): Agent {
  sharedAgent ??= createGuardedAgent();
  return sharedAgent;
}

export async function closeSharedAgent(): Promise<void> {
  if (sharedAgent) {
    await sharedAgent.close();
    sharedAgent = undefined;
  }
}

export async function fetchWithHttp(req: WorkerFetchRequest): Promise<WorkerFetchResult> {
  const start = Date.now();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;

  await assertUrlAllowed(req.url);

  const headers: Record<string, string> = {
    'User-Agent': req.userAgent ?? pickUserAgent(req.url),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...sanitizeHeaders(req.headers),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 用 undici 的 fetch：既能拿到跟随重定向后的最终 URL，也支持传入自定义 dispatcher
    const res = await undiciFetch(req.url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
      dispatcher: guardedAgent(),
    });

    const finalUrl = res.url || req.url;
    // 跟随重定向后再校验一次最终地址
    await assertUrlAllowed(finalUrl);

    // 超大页面截断保留开头（与主进程 http-fetcher 一致），而不是整页失败
    const { body: buffer, truncated } = await readLimited(res, maxBytes);
    const contentType = res.headers.get('content-type') ?? '';
    const html = decodeBody(buffer, contentType, truncated);

    const format: OutputFormat = req.format ?? 'markdown';
    const { title, content } = extractContent(html, format, finalUrl);
    return {
      url: finalUrl,
      content,
      // rawHtml 只在 format=html 时返回（与协议、主进程抓取器一致），避免每次回传两份页面
      rawHtml: format === 'html' ? html : undefined,
      title,
      statusCode: res.status,
      contentType,
      contentLength: buffer.byteLength,
      fetchTime: Date.now() - start,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    if (error instanceof SsrfBlockedError || error instanceof TargetFetchError) throw error;
    if (isSsrfConnectError(error)) {
      throw new SsrfBlockedError(`目标地址指向内网或保留地址：${errorText(error)}`);
    }
    throw new TargetFetchError(`抓取失败：${errorText(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** GB2312 / GBK 统一按超集 GB18030 解码 */
function normalizeCharset(raw: string | undefined): string | undefined {
  const cs = raw?.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!cs) return undefined;
  if (cs === 'gb2312' || cs === 'gbk' || cs === 'x-gbk') return 'gb18030';
  return cs;
}

function isSupportedCharset(cs: string): boolean {
  try {
    new TextDecoder(cs);
    return true;
  } catch {
    return false;
  }
}

/**
 * 字符集嗅探（与主进程 http-client 一致）：
 * BOM → Content-Type → 前 4KB 的 <meta charset> / http-equiv / <?xml encoding?>
 * → 严格 UTF-8 校验 → 回退 GB18030（中文站点最常见的未声明编码）
 */
export function sniffCharset(body: Buffer, contentType: string, truncated = false): string {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';

  const fromHeader = normalizeCharset(/charset=([^;]+)/i.exec(contentType)?.[1]);
  if (fromHeader && isSupportedCharset(fromHeader)) return fromHeader;

  const head = new TextDecoder('latin1').decode(body.subarray(0, 4096));
  const meta =
    /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1];
  const fromMeta = normalizeCharset(meta);
  if (fromMeta && isSupportedCharset(fromMeta)) return fromMeta;

  try {
    // 截断时末尾可能是半个多字节字符：stream 模式不把它当非法，避免误判为 GB18030
    new TextDecoder('utf-8', { fatal: true }).decode(body, { stream: truncated });
    return 'utf-8';
  } catch {
    return 'gb18030';
  }
}

/** 解码响应体；truncated 时丢弃末尾不完整的多字节字符，而不是输出替换符 */
export function decodeBody(body: Buffer, contentType: string, truncated = false): string {
  return new TextDecoder(sniffCharset(body, contentType, truncated)).decode(body, { stream: truncated });
}

/** 流式读取并限制大小：读到 maxBytes 即停止并截断，避免把超大响应整段吞进内存 */
export async function readLimited(
  res: { body?: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  if (!res.body) return { body: Buffer.alloc(0), truncated: false };

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      const remain = maxBytes - total;
      if (remain > 0) chunks.push(Buffer.from(value.subarray(0, remain)));
      total = maxBytes;
      truncated = true;
      // 只取消读取，不中止整个请求：剩余数据不再下载
      await reader.cancel().catch(() => undefined);
      break;
    }
    total += value.byteLength;
    chunks.push(Buffer.from(value));
  }
  return { body: Buffer.concat(chunks, total), truncated };
}

// ===== 浏览器渲染 =====

interface PlaywrightPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  route(pattern: string, handler: (route: PlaywrightRoute) => void): Promise<void>;
  close(): Promise<void>;
}

interface PlaywrightRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

interface PlaywrightBrowser {
  newPage(options?: Record<string, unknown>): Promise<PlaywrightPage>;
  close(): Promise<void>;
  isConnected?(): boolean;
}

interface PlaywrightChromium {
  launch(options?: Record<string, unknown>): Promise<PlaywrightBrowser>;
}

let browserPromise: Promise<PlaywrightBrowser | undefined> | undefined;
/** Playwright 是否可用（未安装时 /health 不该声称支持 browser） */
let playwrightInstalled: boolean | undefined;

async function launchBrowser(): Promise<PlaywrightBrowser | undefined> {
  try {
    const { chromium } = (await import('playwright')) as unknown as { chromium: PlaywrightChromium };
    playwrightInstalled = true;
    return await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (error) {
    // 区分「没装 playwright」与「装了但启动失败」：前者永久不可用，后者下次重试
    playwrightInstalled = (error as NodeJS.ErrnoException | undefined)?.code !== 'ERR_MODULE_NOT_FOUND';
    console.error('[worker] 未能启动 Playwright 浏览器，browser 方法不可用：', errorText(error));
    return undefined;
  }
}

async function getBrowser(): Promise<PlaywrightBrowser | undefined> {
  // 浏览器进程崩溃后旧 Promise 仍会返回一个已断开的对象，必须检测并重启
  if (browserPromise) {
    const current = await browserPromise;
    if (current && current.isConnected?.() !== false) return current;
    browserPromise = undefined;
  }
  browserPromise = launchBrowser();
  return browserPromise;
}

/** 当前是否具备 browser 能力（供 /health 如实上报） */
export function hasBrowserCapability(): boolean {
  return playwrightInstalled !== false;
}

/**
 * 启动时探测 playwright 是否可用（只加载模块，不启动浏览器）。
 * 让 /health 在真正被抓取前就能给出如实的 capabilities，而不是一律声称支持 browser。
 */
export async function detectBrowserCapability(): Promise<boolean> {
  if (playwrightInstalled !== undefined) return playwrightInstalled;
  try {
    await import('playwright');
    playwrightInstalled = true;
  } catch {
    playwrightInstalled = false;
  }
  return playwrightInstalled;
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser?.close().catch(() => undefined);
    browserPromise = undefined;
  }
}

export async function fetchWithBrowser(req: WorkerFetchRequest): Promise<WorkerFetchResult> {
  const start = Date.now();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await assertUrlAllowed(req.url);
  const browser = await getBrowser();
  if (!browser) throw new TargetFetchError('Worker 未安装 Playwright，无法使用 browser 方法', 501);

  const page = await browser.newPage({
    userAgent: req.userAgent ?? pickUserAgent(req.url),
    locale: 'zh-CN',
  });

  try {
    // 每个子资源请求都校验一次，避免渲染过程中被引导去请求内网
    await page.route('**/*', route => {
      const target = route.request().url();
      if (/^(data|blob|about):/i.test(target)) {
        void route.continue();
        return;
      }
      void assertUrlAllowed(target)
        .then(() => route.continue())
        .catch(() => route.abort('blockedbyclient'));
    });

    if (req.headers) await page.setExtraHTTPHeaders(sanitizeHeaders(req.headers));

    const response = await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const statusCode = (response as { status?: () => number } | null)?.status?.() ?? 200;

    if (req.waitForSelector) {
      // 用剩余预算而不是固定 15s，否则导航用掉大半 timeout 后仍可能超时
      const remaining = Math.max(1, timeoutMs - (Date.now() - start));
      // 选择器等不到不算失败：页面已加载，返回当前已渲染的内容比整页报错更有用
      // （旧实现直接抛错，选择器写错或元素懒加载时调用方拿不到任何内容）
      await page.waitForSelector(req.waitForSelector, { timeout: remaining }).catch((error: unknown) => {
        console.error('[worker] waitForSelector 未命中，返回当前页面内容：', errorText(error));
      });
    }

    // 再对最终地址校验一次（可能被重定向到内网）
    const finalUrl = page.url();
    await assertUrlAllowed(finalUrl);

    const html = await page.content();
    const title = (await page.title()) || undefined;
    const format: OutputFormat = req.format ?? 'markdown';
    const { content } = extractContent(html, format, finalUrl);

    return {
      url: finalUrl,
      content,
      rawHtml: format === 'html' ? html : undefined,
      title,
      statusCode,
      contentType: 'text/html',
      contentLength: Buffer.byteLength(html),
      fetchTime: Date.now() - start,
    };
  } catch (error) {
    if (error instanceof SsrfBlockedError || error instanceof TargetFetchError) throw error;
    throw new TargetFetchError(`浏览器渲染失败：${errorText(error)}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function fetchPage(req: WorkerFetchRequest): Promise<WorkerFetchResult> {
  const method = req.method ?? 'browser';
  return method === 'http' ? fetchWithHttp(req) : fetchWithBrowser(req);
}

// ===== 工具函数 =====

/** 过滤掉可能破坏请求的头部：鉴权、Host、Content-Length 等由 Worker 自己掌握 */
function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {};
  const blocked = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'authorization']);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (blocked.has(key.toLowerCase())) continue;
    if (typeof value !== 'string') continue;
    out[key] = value;
  }
  return out;
}

function isSsrfConnectError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ESSRFBLOCKED';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
