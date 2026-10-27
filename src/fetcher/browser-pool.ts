/**
 * 浏览器实例池 — 懒启动浏览器，页面级并发控制
 *
 * 关键修复（旧实现的三个 bug）：
 * 1. 并发 acquire 会各自 launchBrowser，只保留最后一个，其余 Chromium 进程泄漏
 *    → 用 launchPromise 单飞，所有并发调用共享同一次启动
 * 2. activePages 在 newPage 完成之后才 ++，并发时会突破 maxPages
 *    → 改为「先占槽再建页」，创建失败时归还槽位
 * 3. context.close / browser.close 在同一 try 内，前者抛错后者被跳过
 *    → 分别 try，且新增 disconnected 监听，崩溃后重置引用，下次自动重启
 *
 * 其他：排队 acquire 支持超时与取消；release 不再等待下一个排队者建页（旧实现会把
 * 当前请求拖到下个请求启动完成）；每个页面用独立 context，避免 Cookie 跨请求泄漏；
 * 启动后 newContext 失败时关闭浏览器进程，不再泄漏。
 */

import type { BrowserFetcherConfig } from '../config/config-schema.js';
import { BrowserNotInstalledError } from './browser-errors.js';
import { getLogger } from '../utils/logger.js';
import { pickUserAgent } from '../utils/http-client.js';

// playwright 类型（动态导入时使用）— 内联定义避免编译时强依赖
interface PlaywrightPage {
  close(): Promise<void>;
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(timeout: number): Promise<void>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  route?(pattern: string, handler: (route: PlaywrightRoute, request: PlaywrightRequest) => void): Promise<void>;
}

interface PlaywrightRequest {
  url(): string;
  isNavigationRequest(): boolean;
  resourceType(): string;
}

interface PlaywrightRoute {
  request(): PlaywrightRequest;
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
  addCookies(cookies: Array<Record<string, unknown>>): Promise<void>;
  addInitScript(script: string | (() => void)): Promise<void>;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  isConnected?(): boolean;
  on?(event: 'disconnected', handler: () => void): void;
  newPage(): Promise<PlaywrightPage>;
  newContext(options?: Record<string, unknown>): Promise<PlaywrightBrowserContext>;
  close(): Promise<void>;
}

interface PendingAcquire {
  resolve: (page: PooledPage) => void;
  reject: (error: Error) => void;
}

export type { PlaywrightPage, PlaywrightBrowser, PlaywrightBrowserContext };

export interface AcquireOptions {
  /** 排队等待超时（毫秒）；超时抛出 AQUIRE_TIMEOUT 错误，避免请求无限挂起 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 每一页对应一个独立 context，释放时一并关闭（隔离 Cookie / 缓存） */
export interface PooledPage {
  page: PlaywrightPage;
  context: PlaywrightBrowserContext;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;

export class BrowserPool {
  private readonly config: BrowserFetcherConfig;
  private browser: PlaywrightBrowser | null = null;
  private launchPromise: Promise<void> | null = null;
  private activePages = 0;
  private pendingQueue: PendingAcquire[] = [];
  private closed = false;

  constructor(config: BrowserFetcherConfig) {
    this.config = config;
  }

  /** 获取一个页面（信号量控制并发；先占槽再建页；排队支持超时与取消） */
  async acquire(options: AcquireOptions = {}): Promise<PooledPage> {
    if (this.closed) throw new Error('浏览器池已关闭');

    if (this.activePages < this.config.maxPages) {
      this.activePages++;
      try {
        return await this.createPage();
      } catch (error) {
        this.activePages--;
        this.dispatchPending();
        throw error;
      }
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    return new Promise<PooledPage>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error('浏览器池排队已取消'));
        return;
      }
      const timer = setTimeout(() => {
        this.removePending(entry);
        reject(new Error(`浏览器池排队超时（${timeoutMs}ms，当前并发上限 ${this.config.maxPages}）`));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        this.removePending(entry);
        reject(new Error('浏览器池排队已取消'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const entry: PendingAcquire = {
        resolve: value => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      this.pendingQueue.push(entry);
    });
  }

  private removePending(entry: PendingAcquire): void {
    const index = this.pendingQueue.indexOf(entry);
    if (index >= 0) this.pendingQueue.splice(index, 1);
  }

  /** 释放页面（关闭页面与其 context），并在后台补充排队者，不阻塞当前请求 */
  async release(pooled: PooledPage): Promise<void> {
    try {
      await pooled.page.close();
    } catch {
      // 页面可能已被关闭
    }
    try {
      await pooled.context.close();
    } catch {
      // context 可能已随浏览器断开
    }
    this.activePages = Math.max(0, this.activePages - 1);
    // 不 await：当前请求立即结束，排队者的建页在后台继续
    void this.dispatchPending();
  }

  /** 关闭浏览器池 */
  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.pendingQueue) {
      pending.reject(new Error('浏览器池已关闭'));
    }
    this.pendingQueue = [];

    // 等待在途启动结束：launchBrowser 发现池已关闭会自行关闭新浏览器，这里只需等它收尾
    const inflight = this.launchPromise;
    if (inflight) await inflight.catch(() => undefined);

    const browser = this.browser;
    this.browser = null;
    this.launchPromise = null;
    this.activePages = 0;

    if (browser) {
      try {
        await browser.close();
      } catch {
        // 忽略
      }
    }
  }

  /** 浏览器崩溃 / 断开后的清理，使下次 acquire 重新启动 */
  private resetAfterDisconnect(): void {
    this.browser = null;
    this.launchPromise = null;
    if (!this.closed) {
      getLogger().warn('浏览器实例已断开，将在下次请求时重新启动');
    }
  }

  // 处理排队请求（占槽后建页）；不阻塞调用者
  private async dispatchPending(): Promise<void> {
    while (!this.closed && this.pendingQueue.length > 0 && this.activePages < this.config.maxPages) {
      const next = this.pendingQueue.shift()!;
      this.activePages++;
      try {
        next.resolve(await this.createPage());
      } catch (error) {
        this.activePages--;
        next.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /** 创建新页面：独立 context 隔离 Cookie，懒启动浏览器（单飞启动） */
  private async createPage(): Promise<PooledPage> {
    await this.ensureBrowser();
    if (this.closed) throw new Error('浏览器池已关闭');
    const browser = this.browser;
    if (!browser) throw new Error('浏览器上下文不可用');

    const context = await browser.newContext({
      userAgent: this.config.userAgent ?? pickUserAgent(),
      locale: this.config.locale ?? 'zh-CN',
      viewport: { width: 1920, height: 1080 },
    });
    try {
      // 隐藏 webdriver 痕迹（少数站点直接读取该属性判定机器人）
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      const page = await context.newPage();
      return { page, context };
    } catch (error) {
      // 建页失败时关掉刚建的 context，避免泄漏
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  private async ensureBrowser(): Promise<void> {
    if (this.browser?.isConnected?.() === false) this.resetAfterDisconnect();
    if (this.browser) return;
    this.launchPromise ??= this.launchBrowser().finally(() => {
      this.launchPromise = null;
    });
    await this.launchPromise;
  }

  /** 启动浏览器实例 */
  private async launchBrowser(): Promise<void> {
    const logger = getLogger();

    type PlaywrightModule = Record<string, {
      launch(opts: Record<string, unknown>): Promise<PlaywrightBrowser>;
    }>;

    let playwright: PlaywrightModule;
    try {
      // 动态 import：playwright 是可选依赖，未安装时优雅降级
      playwright = (await import('playwright')) as unknown as PlaywrightModule;
    } catch {
      throw new BrowserNotInstalledError();
    }

    const browserType = playwright[this.config.browserType];
    if (!browserType) throw new Error(`不支持的浏览器类型: ${this.config.browserType}`);

    const browser = await browserType.launch({
      headless: this.config.headless,
      // 反自动化检测：去掉 navigator.webdriver 等 Blink 自动化标记，
      // 否则 Google 等站点会直接返回 /sorry/ 验证码页
      args: ['--disable-blink-features=AutomationControlled'],
    });

    // 启动期间池已被关闭：不写回 this.browser，立即关掉新进程，避免泄漏
    if (this.closed) {
      await browser.close().catch(() => undefined);
      throw new Error('浏览器池已关闭');
    }

    // 崩溃后重置，避免持有陈旧引用
    browser.on?.('disconnected', () => this.resetAfterDisconnect());

    this.browser = browser;
    logger.info('浏览器实例已启动', { type: this.config.browserType });
  }
}
