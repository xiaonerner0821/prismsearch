/**
 * MCP 服务器核心（SDK v2）
 *
 * 分层：
 * - PrismSearchRuntime：持有所有共享依赖（缓存、引擎、抓取器、安全组件、Worker 客户端），
 *   可整体重建以实现真正的配置热重载
 * - createMcpServer()：工厂函数，按连接（stdio）或按请求（HTTP）生成轻量 McpServer 实例，
 *   共享同一个运行时。旧实现所有 HTTP 会话共用一个 McpServer + transport，存在会话串扰
 *
 * 工具：web_search / image_search / fetch_page / wechat_search / list_engines
 * - 参数 schema 唯一来源于 tool-schemas.ts（zod，带上下界）
 * - 返回 structuredContent（声明 outputSchema）并在 content 中保留同样的 JSON 文本
 * - 带 annotations（只读 / 开放世界），便于客户端做权限提示
 * - 错误信息：已知业务错误原样返回，未知异常只返回通用提示，细节仅写日志
 */

import { McpServer } from '@modelcontextprotocol/server';
import type { PrismSearchConfig, EngineConfig } from '../config/config-schema.js';
import type { CacheProvider } from '../cache/cache-interface.js';
import { createCache, type ManagedCache } from '../cache/cache-factory.js';
import { SsrfGuard } from '../security/ssrf-guard.js';
import { RateLimiter } from '../security/rate-limiter.js';
import { ContentFilter } from '../security/content-filter.js';
import { EngineRegistry } from '../engines/engine-registry.js';
import { EngineSelector } from '../engines/engine-selector.js';
import { HttpFetcher } from '../fetcher/http-fetcher.js';
import { BrowserFetcher } from '../fetcher/browser-fetcher.js';
import type { Fetcher } from '../fetcher/fetcher-interface.js';
import { GoogleWebEngine } from '../engines/google/google-web.js';
import { BingWebEngine } from '../engines/bing/bing-web.js';
import { BaiduWebEngine } from '../engines/baidu/baidu-web.js';
import { SoWebEngine } from '../engines/so/so-web.js';
import { SogouWebEngine } from '../engines/sogou/sogou-web.js';
import { DuckDuckGoWebEngine } from '../engines/duckduckgo/duckduckgo-web.js';
import { YandexWebEngine } from '../engines/yandex/yandex-web.js';
import { BraveWebEngine } from '../engines/brave/brave-web.js';
import { WechatArticleEngine } from '../engines/wechat/wechat-article.js';
import type { SearchProvider } from '../engines/engine-interface.js';
import { handleWebSearch, type SearchProgress } from '../tools/web-search.js';
import { handleImageSearch } from '../tools/image-search.js';
import { handleFetchPage, FetchPageError, type RemoteFetcher } from '../tools/fetch-page.js';
import { handleWechatSearch } from '../tools/wechat-search.js';
import { handleListEngines } from '../tools/list-engines.js';
import { EngineRateLimiters, NoEngineAvailableError } from '../tools/search-runner.js';
import {
  webSearchInput,
  imageSearchInput,
  fetchPageInput,
  wechatSearchInput,
  listEnginesInput,
  searchOutput,
  imageSearchOutput,
  fetchPageOutput,
  listEnginesOutput,
} from '../tools/tool-schemas.js';
import { ProxyPool } from '../utils/proxy-pool.js';
import { configureHttpDefaults } from '../utils/http-client.js';
import { resetApiKeyManagers } from '../utils/api-key-manager.js';
import { getLogger, errorMessage } from '../utils/logger.js';
import { PKG_NAME, PKG_VERSION } from '../version.js';

const ENGINE_CONSTRUCTORS: Record<string, new (config: EngineConfig) => SearchProvider> = {
  google: GoogleWebEngine,
  bing: BingWebEngine,
  baidu: BaiduWebEngine,
  so: SoWebEngine,
  sogou: SogouWebEngine,
  duckduckgo: DuckDuckGoWebEngine,
  yandex: YandexWebEngine,
  brave: BraveWebEngine,
};

const SERVER_INSTRUCTIONS = [
  'PrismSearch aggregates multiple search engines with automatic fallback.',
  'Use web_search for general queries, image_search for images, wechat_search for WeChat Official Account articles,',
  'and fetch_page to read a result page (method=browser for JavaScript-heavy sites).',
  'WeChat article links are short-lived signed URLs: fetch them promptly. Call list_engines to see engine health.',
].join(' ');

/** 允许原样返回给客户端的错误类型（白名单：只有这些消息是写给调用方看的） */
const USER_FACING_ERRORS = new Set([
  'FetchPageError',
  'NoEngineAvailableError',
  'SsrfBlockedError',
  'RateLimitError',
  'HttpError',
  'ZodError',
  'ToolInputError',
  'EngineParseError',
  'EngineBlockedError',
  'BrowserNotInstalledError',
]);

export class RateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`请求过于频繁，请 ${Math.ceil(retryAfterMs / 1000)} 秒后重试`);
    this.name = 'RateLimitError';
  }
}

export interface RuntimeOptions {
  /**
   * 是否在工具层做全局限流。HTTP 模式下限流在 HTTP 层按客户端分桶完成，此处关闭；
   * stdio 模式只有一个客户端，在工具层限流。
   */
  toolLevelRateLimit: boolean;
  /** 可注入的 Worker 抓取器（由 index 根据 config.workers 构造） */
  remoteFetcher?: RemoteFetcher & { close?(): Promise<void>; status?(): ReturnType<NonNullable<Parameters<typeof handleListEngines>[0]['workers']>> };
}

/** 所有共享依赖的集合；配置热重载时整体替换 */
export class PrismSearchRuntime {
  private constructor(
    readonly config: PrismSearchConfig,
    readonly cache: CacheProvider,
    private readonly managedCache: ManagedCache,
    readonly ssrfGuard: SsrfGuard,
    readonly toolLimiter: RateLimiter | undefined,
    readonly engineLimiters: EngineRateLimiters,
    readonly wechatLimiter: RateLimiter | undefined,
    readonly engineRegistry: EngineRegistry,
    readonly engineSelector: EngineSelector,
    readonly fetchers: { http: Fetcher; browser?: BrowserFetcher },
    readonly contentFilter: ContentFilter,
    readonly proxyPool: ProxyPool,
    readonly wechatEngine: SearchProvider | undefined,
    readonly remoteFetcher: RuntimeOptions['remoteFetcher'],
  ) {}

  static async create(config: PrismSearchConfig, options: RuntimeOptions): Promise<PrismSearchRuntime> {
    const logger = getLogger();

    // 出站 HTTP 默认值：UA、超时、响应体上限、代理池
    const proxyPool = new ProxyPool(config.fetcher.proxy, { cooldownMs: config.fetcher.proxy.cooldownMs });
    configureHttpDefaults({
      userAgent: config.fetcher.userAgent,
      timeoutMs: config.fetcher.timeout,
      maxBytes: config.fetcher.maxBytes,
      proxyPool: proxyPool.isEnabled() ? proxyPool : undefined,
    });
    if (proxyPool.isEnabled()) logger.info('代理池已启用', { size: config.fetcher.proxy.pool.length });

    const managedCache = await createCache(config.cache);
    const ssrfGuard = new SsrfGuard(config.security.ssrf);

    const toolLimiter = options.toolLevelRateLimit
      ? new RateLimiter({
          enabled: config.security.rateLimit.enabled,
          maxRequests: config.security.rateLimit.maxRequests,
          windowMs: config.security.rateLimit.windowMs,
        })
      : undefined;

    // 引擎（API Key 管理器随配置重建，以便热重载后读取新 Key）
    resetApiKeyManagers();
    const engineRegistry = new EngineRegistry();
    for (const engineConfig of config.engines) {
      if (!engineConfig.enabled) continue;
      const Ctor = ENGINE_CONSTRUCTORS[engineConfig.name];
      if (!Ctor) {
        logger.warn('未知的搜索引擎，已跳过', { engine: engineConfig.name });
        continue;
      }
      try {
        engineRegistry.register(new Ctor(engineConfig));
      } catch (error) {
        logger.error('初始化搜索引擎失败', { engine: engineConfig.name, error });
      }
    }
    const engineSelector = new EngineSelector();
    engineSelector.setEngineConfigs(config.engines.filter(e => e.enabled));
    const engineLimiters = new EngineRateLimiters(config.engines.filter(e => e.enabled));

    // 微信公众号引擎（独立配置段）
    let wechatEngine: SearchProvider | undefined;
    let wechatLimiter: RateLimiter | undefined;
    if (config.wechat.enabled) {
      wechatEngine = new WechatArticleEngine({
        name: 'wechat',
        displayName: '微信公众号（搜狗）',
        enabled: true,
        type: 'scraper',
        apiKey: undefined,
        searchEngineId: undefined,
        baseUrl: config.wechat.baseUrl,
        alternateUrls: [],
        timeout: config.wechat.timeout,
        priority: 99,
        rateLimit: config.wechat.rateLimit,
        fallback: { sameOrigin: [], crossOrigin: [] },
        regions: ['cn'],
        languages: ['zh', 'zh-CN'],
      }, config.wechat);
      wechatLimiter = new RateLimiter({
        maxRequests: config.wechat.rateLimit.maxRequests,
        windowMs: config.wechat.rateLimit.windowMs,
      });
    }

    // 抓取器
    const http = new HttpFetcher({ timeoutMs: config.fetcher.timeout, maxBytes: config.fetcher.maxBytes });
    let browser: BrowserFetcher | undefined;
    if (config.fetcher.browser.enabled) {
      browser = new BrowserFetcher({
        ...config.fetcher.browser,
        userAgent: config.fetcher.browser.userAgent ?? config.fetcher.userAgent,
      });
      logger.info('浏览器抓取器已启用', { type: config.fetcher.browser.browserType });
    }

    // 浏览器抓取器注入给需要的引擎：Google 对纯 HTTP 请求基本只返回 enablejs 提示页
    if (browser) {
      for (const engine of engineRegistry.getAll()) {
        if (engine instanceof GoogleWebEngine) engine.setBrowserFetcher(browser);
      }
    }

    const contentFilter = new ContentFilter({
      enabled: config.security.contentFilter.mode !== 'off',
      maliciousDomains: config.security.contentFilter.maliciousDomains,
      sensitiveKeywords: config.security.contentFilter.sensitiveKeywords,
      detectSuspiciousPatterns: config.security.contentFilter.detectSuspiciousPatterns,
    });

    logger.info('运行时已就绪', {
      engines: engineRegistry.getAll().map(e => e.name),
      wechat: !!wechatEngine,
      cache: managedCache.cache.backend,
      workers: !!options.remoteFetcher,
    });

    return new PrismSearchRuntime(
      config,
      managedCache.cache,
      managedCache,
      ssrfGuard,
      toolLimiter,
      engineLimiters,
      wechatLimiter,
      engineRegistry,
      engineSelector,
      { http, browser },
      contentFilter,
      proxyPool,
      wechatEngine,
      options.remoteFetcher,
    );
  }

  /** 工具层限流（仅 stdio 模式启用） */
  consumeToolQuota(tool: string): void {
    if (!this.toolLimiter) return;
    const r = this.toolLimiter.consume('global');
    if (!r.allowed) {
      getLogger().warn('请求被限流', { tool });
      throw new RateLimitError(r.retryAfter ?? this.config.security.rateLimit.windowMs);
    }
  }

  async close(): Promise<void> {
    const logger = getLogger();
    const steps: Array<[string, () => Promise<void> | void]> = [
      ['cache', () => this.managedCache.close()],
      ['browser', () => this.fetchers.browser?.close()],
      ['ssrf', () => this.ssrfGuard.close()],
      ['proxy', () => this.proxyPool.close()],
      ['limiters', () => {
        this.toolLimiter?.destroy();
        this.wechatLimiter?.destroy();
        this.engineLimiters.destroy();
      }],
    ];
    for (const [name, fn] of steps) {
      try {
        await fn();
      } catch (error) {
        logger.warn('关闭组件失败', { component: name, error });
      }
    }
  }
}

/** 运行时持有者：热重载时原子替换，进行中的请求继续使用旧实例 */
export class RuntimeHolder {
  private current: PrismSearchRuntime;

  constructor(runtime: PrismSearchRuntime) {
    this.current = runtime;
  }

  get(): PrismSearchRuntime {
    return this.current;
  }

  /** 用新配置重建运行时；成功后替换并在宽限期后关闭旧实例 */
  async reload(config: PrismSearchConfig, options: RuntimeOptions, graceMs = 30_000): Promise<void> {
    const next = await PrismSearchRuntime.create(config, options);
    const previous = this.current;
    this.current = next;
    const timer = setTimeout(() => {
      previous.close().catch(error => getLogger().warn('关闭旧运行时失败', { error }));
    }, graceMs);
    timer.unref?.();
  }

  async close(): Promise<void> {
    await this.current.close();
  }
}

// ===== 工具结果封装 =====

function okResult(data: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function errorResult(tool: string, error: unknown) {
  const logger = getLogger();
  const name = error instanceof Error ? error.name : '';
  const userFacing = USER_FACING_ERRORS.has(name) || error instanceof FetchPageError || error instanceof NoEngineAvailableError;
  logger.error('工具执行失败', { tool, error });
  // 只放行白名单类型的消息：按「消息里有没有中文」判断会漏出第三方库的内部报错
  const message = userFacing ? errorMessage(error) : '内部错误，请查看服务端日志';
  const payload: Record<string, unknown> = { error: message };
  if (error instanceof FetchPageError) payload.code = error.code;
  if (error instanceof RateLimitError) payload.retryAfterMs = error.retryAfterMs;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

/**
 * 客户端在 _meta.progressToken 里要了进度时，返回一个发 notifications/progress 的回调；否则 undefined。
 * 通知是尽力而为：发送失败只记日志，不影响工具调用本身。
 */
export function progressNotifier(mcpReq: {
  _meta?: { progressToken?: string | number };
  notify: (notification: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
}): ((event: SearchProgress) => void) | undefined {
  const token = mcpReq._meta?.progressToken;
  if (token === undefined) return undefined;
  return (event) => {
    const params = { progressToken: token, progress: event.progress, message: event.message, ...(event.total !== undefined ? { total: event.total } : {}) };
    mcpReq.notify({ method: 'notifications/progress', params }).catch((error: unknown) => {
      getLogger().debug('发送进度通知失败', { error });
    });
  };
}

const READ_ONLY_OPEN_WORLD = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * MCP 服务器工厂。每次调用返回一个新的 McpServer，工具回调在调用时才读取
 * holder 中的当前运行时，因此热重载对新请求立即生效。
 */
export function createMcpServer(holder: RuntimeHolder): McpServer {
  const server = new McpServer(
    { name: PKG_NAME, version: PKG_VERSION, title: 'PrismSearch' },
    { instructions: SERVER_INSTRUCTIONS, maxToolInputElements: 1000 },
  );

  server.registerTool(
    'web_search',
    {
      title: 'Web Search',
      description: 'Search the web across multiple engines (Google, Bing, Brave, Baidu, DuckDuckGo, Sogou, 360, Yandex) with automatic engine selection and fallback. Returns titles, URLs and snippets.',
      inputSchema: webSearchInput,
      outputSchema: searchOutput,
      annotations: READ_ONLY_OPEN_WORLD,
    },
    async (args, ctx) => {
      try {
        const rt = holder.get();
        rt.consumeToolQuota('web_search');
        const response = await handleWebSearch(args, {
          cache: rt.cache,
          engineRegistry: rt.engineRegistry,
          engineSelector: rt.engineSelector,
          limiters: rt.engineLimiters,
          deadlineMs: rt.config.search.deadlineMs,
          adFilter: rt.config.search.adFilter,
          onProgress: progressNotifier(ctx.mcpReq),
        }, ctx.mcpReq.signal);
        return okResult(response);
      } catch (error) {
        return errorResult('web_search', error);
      }
    },
  );

  server.registerTool(
    'image_search',
    {
      title: 'Image Search',
      description: 'Search images across engines that support it. Optionally inline small thumbnails as base64 data URIs.',
      inputSchema: imageSearchInput,
      outputSchema: imageSearchOutput,
      annotations: READ_ONLY_OPEN_WORLD,
    },
    async (args, ctx) => {
      try {
        const rt = holder.get();
        rt.consumeToolQuota('image_search');
        const response = await handleImageSearch(args, {
          cache: rt.cache,
          engineRegistry: rt.engineRegistry,
          engineSelector: rt.engineSelector,
          ssrfGuard: rt.ssrfGuard,
          limiters: rt.engineLimiters,
          deadlineMs: rt.config.search.deadlineMs,
        }, ctx.mcpReq.signal);
        return okResult(response);
      } catch (error) {
        return errorResult('image_search', error);
      }
    },
  );

  server.registerTool(
    'fetch_page',
    {
      title: 'Fetch Page',
      description: 'Fetch a public web page and return it as markdown, plain text or HTML. Private/internal addresses are blocked. Use method=browser for JavaScript-rendered pages.',
      inputSchema: fetchPageInput,
      outputSchema: fetchPageOutput,
      annotations: READ_ONLY_OPEN_WORLD,
    },
    async (args, ctx) => {
      try {
        const rt = holder.get();
        rt.consumeToolQuota('fetch_page');
        const { workers } = rt.config;
        const result = await handleFetchPage(args, {
          cache: rt.cache,
          ssrfGuard: rt.ssrfGuard,
          fetchers: rt.fetchers,
          defaultMethod: rt.config.fetcher.defaultMethod,
          defaultTimeoutMs: rt.config.fetcher.timeout,
          maxBytes: rt.config.fetcher.maxBytes,
          contentFilter: rt.contentFilter,
          contentFilterMode: rt.config.security.contentFilter.mode,
          remote: rt.remoteFetcher
            ? { fetcher: rt.remoteFetcher, useFor: workers.useFor, fallbackToLocal: workers.fallbackToLocal }
            : undefined,
        }, ctx.mcpReq.signal);
        return okResult(result);
      } catch (error) {
        return errorResult('fetch_page', error);
      }
    },
  );

  server.registerTool(
    'wechat_search',
    {
      title: 'WeChat Article Search',
      description: 'Search WeChat Official Account (微信公众号) articles via Sogou. Returns titles, account names, dates and short-lived signed URLs — fetch them promptly with fetch_page.',
      inputSchema: wechatSearchInput,
      outputSchema: searchOutput,
      annotations: READ_ONLY_OPEN_WORLD,
    },
    async (args, ctx) => {
      try {
        const rt = holder.get();
        rt.consumeToolQuota('wechat_search');
        const response = await handleWechatSearch(args, {
          cache: rt.cache,
          engine: rt.wechatEngine,
          limiter: rt.wechatLimiter,
        }, ctx.mcpReq.signal);
        return okResult(response);
      } catch (error) {
        return errorResult('wechat_search', error);
      }
    },
  );

  server.registerTool(
    'list_engines',
    {
      title: 'List Engines',
      description: 'List all configured search engines with their enabled state, health, latency, success rate and supported tools.',
      inputSchema: listEnginesInput,
      outputSchema: listEnginesOutput,
      annotations: { ...READ_ONLY_OPEN_WORLD, openWorldHint: false },
    },
    async () => {
      try {
        const rt = holder.get();
        const response = handleListEngines({
          engineRegistry: rt.engineRegistry,
          config: rt.config,
          wechatEngine: rt.wechatEngine,
          workers: rt.remoteFetcher?.status ? () => rt.remoteFetcher!.status!() : undefined,
        });
        return okResult(response);
      } catch (error) {
        return errorResult('list_engines', error);
      }
    },
  );

  return server;
}
