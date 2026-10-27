/**
 * PrismSearch 配置 schema（zod）
 *
 * 单一事实来源：运行时校验 + 默认值 + TypeScript 类型（z.infer）都来自这里，
 * 不再维护「interface + DEFAULT_CONFIG」两份可能漂移的定义。
 *
 * 引擎数组的特殊处理：用户配置里的引擎条目会先与同名内置默认条目逐字段合并
 * （见 config-loader），再交给 schema 校验，因此只写 `- name: bing\n  enabled: false`
 * 这样的局部配置是安全的，不会因缺少 timeout 等字段导致请求立即中止。
 */

import { z } from 'zod';

// ===== 通用片段 =====

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

/** 去掉首尾空白；空串视为未设置（防止 yaml 里的 apiKey: "" 屏蔽环境变量） */
const optionalSecret = z
  .string()
  .optional()
  .transform(v => (v && v.trim() ? v.trim() : undefined));

// ===== 服务器 =====

export const ServerConfigSchema = z.object({
  /** 传输协议：stdio（标准输入输出）或 http（Streamable HTTP） */
  transport: z.enum(['stdio', 'http']).default('stdio'),
  port: z.number().int().min(0).max(65535).default(3000),
  /** 监听地址；默认仅本机 */
  host: z.string().min(1).default('127.0.0.1'),
  /**
   * 允许的 Host 头（防 DNS 重绑定）。为空时：监听回环地址则只允许 localhost 系列，
   * 监听其他地址则不校验 Host（此时必须开启鉴权，否则启动报错）。
   */
  allowedHosts: z.array(z.string()).default([]),
  /** 允许的 Origin（浏览器跨域来源），为空时只允许本机来源或无 Origin 请求 */
  allowedOrigins: z.array(z.string()).default([]),
  /** 请求体上限（字节） */
  maxBodyBytes: positiveInt.default(1024 * 1024),
  /** 是否开放 POST /admin/config/reload（始终要求鉴权） */
  enableAdminApi: z.boolean().default(false),
  /** 允许在非回环地址上无鉴权运行（明确知晓风险时才打开） */
  allowUnauthenticatedRemote: z.boolean().default(false),
});

// ===== 搜索引擎 =====

export const EngineRateLimitSchema = z.object({
  /** 时间窗口内最大请求数；0 表示不限制 */
  maxRequests: nonNegativeInt.default(10),
  windowMs: positiveInt.default(60_000),
});

export const EngineFallbackSchema = z.object({
  /**
   * 同源降级：额外的备用 URL（与 alternateUrls 合并，排在其后），
   * 例如 Google 主站失败 → 香港站 → 日本站
   */
  sameOrigin: z.array(z.string().url()).default([]),
  /** 跨源降级：本引擎失败后依次尝试的其他引擎名 */
  crossOrigin: z.array(z.string()).default([]),
});

export const EngineConfigSchema = z.object({
  /** 引擎唯一标识（英文） */
  name: z.string().min(1),
  displayName: z.string().optional(),
  enabled: z.boolean().default(true),
  /** scraper（网页抓取）或 api（接口调用） */
  type: z.enum(['scraper', 'api']).default('scraper'),
  /** API 密钥；支持逗号分隔多 key 轮换。为空时回落到对应环境变量 */
  apiKey: optionalSecret,
  /** Google Custom Search 的 cx；为空时回落到 GOOGLE_CSE_ID */
  searchEngineId: optionalSecret,
  baseUrl: z.string().url(),
  /** 同源备用 URL，baseUrl 失败后依次尝试 */
  alternateUrls: z.array(z.string().url()).default([]),
  /** 单次请求超时（毫秒），覆盖整个请求含 body 读取 */
  timeout: positiveInt.default(15_000),
  /** 优先级，越小越优先 */
  priority: z.number().int().default(10),
  /** 引擎级限流 */
  rateLimit: EngineRateLimitSchema.prefault({}),
  fallback: EngineFallbackSchema.prefault({}),
  /** 擅长的地区（国家/地区码），自动选择时用于区域匹配加分；用户配置整体替换内置默认 */
  regions: z.array(z.string()).default([]),
  /** 擅长的语言（如 zh-CN、en），自动选择时用于语言匹配加分；为空时回落到内置默认 */
  languages: z.array(z.string()).default([]),
});

// ===== 微信公众号文章搜索 =====

export const WechatConfigSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().url().default('https://weixin.sogou.com/weixin'),
  /** 单次 HTTP 请求超时 */
  timeout: positiveInt.default(15_000),
  /** 一次搜索的总截止时间（含重试与真实链接解析） */
  overallTimeoutMs: positiveInt.default(45_000),
  /** 解析文章真实链接的并发数 */
  concurrency: z.number().int().min(1).max(10).default(3),
  /** 搜索页请求失败的重试次数 */
  retries: z.number().int().min(0).max(5).default(2),
  rateLimit: EngineRateLimitSchema.prefault({}),
});

// ===== 缓存 =====

export const CacheConfigSchema = z.object({
  /** sqlite（文件持久化）/ redis（分布式共享）/ memory（进程内，重启丢失） */
  backend: z.enum(['sqlite', 'redis', 'memory']).default('sqlite'),
  /** 过期时间（秒）；0 关闭缓存 */
  ttl: nonNegativeInt.default(3600),
  /** 最大条目数（LRU 淘汰）；redis 后端忽略此项，依赖 TTL 与 maxmemory 策略 */
  maxSize: positiveInt.default(10_000),
  /** 过期清理间隔（秒） */
  cleanupInterval: positiveInt.default(600),
  sqlite: z
    .object({
      /** 数据库路径；未设置时为 ~/.prismsearch/cache.db；支持 ~ 开头 */
      path: z.string().optional(),
    })
    .prefault({}),
  redis: z
    .object({
      url: z.string().default('redis://127.0.0.1:6379'),
      password: optionalSecret,
      keyPrefix: z.string().default('prismsearch:'),
    })
    .prefault({}),
});

// ===== 抓取器 =====

export const ProxyConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** 代理地址列表，如 http://user:pass@host:port */
  pool: z.array(z.string().url()).default([]),
  /** 连续失败后的冷却时长（毫秒），到期自动恢复 */
  cooldownMs: positiveInt.default(5 * 60_000),
});

export const BrowserFetcherConfigSchema = z.object({
  enabled: z.boolean().default(false),
  browserType: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  maxPages: z.number().int().min(1).max(32).default(3),
  pageTimeout: positiveInt.default(30_000),
  headless: z.boolean().default(true),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('domcontentloaded'),
  /** 浏览器 UA；未设置时取 fetcher.userAgent 或内置 UA 池 */
  userAgent: z.string().optional(),
  locale: z.string().default('zh-CN'),
});

export const FetcherConfigSchema = z.object({
  defaultMethod: z.enum(['http', 'browser']).default('http'),
  /** 固定 UA；留空则从内置 UA 池轮换 */
  userAgent: z
    .string()
    .optional()
    .transform(v => (v && v.trim() ? v.trim() : undefined)),
  /** fetch_page 默认超时（毫秒） */
  timeout: positiveInt.default(30_000),
  /** 单个响应体上限（字节） */
  maxBytes: positiveInt.default(5 * 1024 * 1024),
  proxy: ProxyConfigSchema.prefault({}),
  browser: BrowserFetcherConfigSchema.prefault({}),
});

// ===== 进程外抓取 Worker =====

export const WorkerEndpointSchema = z.object({
  name: z.string().min(1),
  /** Worker 基础地址；远端必须使用 HTTPS，回环开发可使用 HTTP */
  url: z.string().url().refine(value => {
    try {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch { return false; }
  }, 'Worker URL 只允许 HTTP(S)，不得包含凭据、查询或片段'),
  /** 共享密钥；为空时回落到 PRISMSEARCH_WORKER_TOKEN */
  token: optionalSecret,
  /** 显式允许 HTTP 的非回环开发端点（仅建议测试环境使用） */
  allowInsecureHttp: z.boolean().default(false),
  /** 负载均衡权重 */
  weight: z.number().int().min(1).max(100).default(1),
  /** 最大并发任务数 */
  maxConcurrency: z.number().int().min(1).max(256).default(4),
}).superRefine((endpoint, ctx) => {
  const parsed = new URL(endpoint.url);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.replace(/^\[|\]$/g, ''));
  if (parsed.protocol === 'http:' && !loopback && !endpoint.allowInsecureHttp) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: '非回环 Worker 端点必须使用 HTTPS，或显式设置 allowInsecureHttp' });
  }
});

export const WorkersConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoints: z.array(WorkerEndpointSchema).default([]),
  /** 非回环 Worker 的精确 origin 白名单（协议、主机、端口均匹配） */
  allowedOrigins: z.array(z.string().url().refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && value === url.origin;
  }, 'allowedOrigins 必须为不带路径的精确 HTTP(S) origin')).default([]),
  /** 负载均衡策略 */
  strategy: z.enum(['round-robin', 'least-busy']).default('least-busy'),
  /** 单次任务超时（毫秒） */
  timeoutMs: positiveInt.default(45_000),
  /** 健康检查间隔（毫秒） */
  healthCheckIntervalMs: positiveInt.default(30_000),
  /**
   * fetch_page 何时交给 worker：
   * - browser：仅 method=browser 时（本地无需安装 Playwright）
   * - always：所有抓取都交给 worker
   */
  useFor: z.enum(['browser', 'always']).default('browser'),
  /** 所有 worker 不可用时是否降级为本地抓取 */
  fallbackToLocal: z.boolean().default(true),
});

// ===== 安全 =====

export const SsrfConfigSchema = z.object({
  enabled: z.boolean().default(true),
  allowedProtocols: z.array(z.string()).default(['http:', 'https:']),
  /** 额外禁止的网段（内置已覆盖所有私有 / 保留地址，见 ssrf-guard） */
  blockedIpRanges: z.array(z.string()).default([]),
  /** 兼容的域名白名单；不会绕过私网 IP 校验 */
  whitelist: z.array(z.string()).default([]),
  /** 明确允许访问的私网主机名（仅此列表可绕过私网拦截；不支持通配符） */
  allowedPrivateHosts: z.array(z.string().regex(/^[a-zA-Z0-9.-]+$/)).default([]),
  blacklist: z.array(z.string()).default([]),
  /** 建连时校验目标 IP（防 DNS 重绑定 / TOCTOU） */
  dnsRebindingProtection: z.boolean().default(true),
});

export const RateLimitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxRequests: positiveInt.default(60),
  windowMs: positiveInt.default(60_000),
  /** 分桶方式：client（按鉴权凭证 / 客户端地址）或 global（全局一个桶） */
  keyBy: z.enum(['client', 'global']).default('client'),
});

export const AuthConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** bearer：Authorization: Bearer <token>；api-key：X-API-Key 头 */
    type: z.enum(['bearer', 'api-key']).default('bearer'),
    /** 有效令牌；也可用环境变量 PRISMSEARCH_AUTH_TOKENS（逗号分隔）注入 */
    tokens: z.array(z.string()).default([]),
  })
  .transform(a => ({ ...a, tokens: a.tokens.map(t => t.trim()).filter(Boolean) }))
  .refine(a => !a.enabled || a.tokens.length > 0, {
    message: 'security.auth.enabled 为 true 时必须配置至少一个 token',
    path: ['tokens'],
  });

export const ContentFilterConfigSchema = z.object({
  /**
   * off：不检查；warn：结果附带风险提示；block：命中即拒绝返回内容
   */
  mode: z.enum(['off', 'warn', 'block']).default('warn'),
  maliciousDomains: z.array(z.string()).default([]),
  sensitiveKeywords: z.array(z.string()).default([]),
  detectSuspiciousPatterns: z.boolean().default(true),
});

export const SecurityConfigSchema = z.object({
  ssrf: SsrfConfigSchema.prefault({}),
  rateLimit: RateLimitConfigSchema.prefault({}),
  auth: AuthConfigSchema.prefault({}),
  contentFilter: ContentFilterConfigSchema.prefault({}),
});

// ===== 搜索 =====

export const SearchConfigSchema = z.object({
  /**
   * 一次搜索（含所有引擎降级尝试）的总时长上限（毫秒）。
   * 单个引擎各有超时，但候选引擎多时逐个超时叠加会让工具调用长时间无响应。
   */
  deadlineMs: positiveInt.default(45_000),
  /**
   * 去广告：按落地链接（广告点击跳转域名、付费投放追踪参数）再过滤一遍引擎解析层漏掉的广告。
   * 解析层按页面广告标记的过滤始终生效，不受此开关影响。
   */
  adFilter: z.boolean().default(true),
});

// ===== 日志 =====

export const LogConfigSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  format: z.enum(['json', 'text']).default('json'),
  /** 日志文件；不设置则输出到 stderr（stdout 留给 stdio 协议） */
  file: z.string().optional(),
  /** 在 info 级别日志中隐藏搜索词与 URL 查询串（隐私） */
  redact: z.boolean().default(true),
});

// ===== 顶层 =====

export const PrismSearchConfigSchema = z.object({
  server: ServerConfigSchema.prefault({}),
  engines: z.array(EngineConfigSchema),
  wechat: WechatConfigSchema.prefault({}),
  cache: CacheConfigSchema.prefault({}),
  fetcher: FetcherConfigSchema.prefault({}),
  workers: WorkersConfigSchema.prefault({}),
  security: SecurityConfigSchema.prefault({}),
  search: SearchConfigSchema.prefault({}),
  log: LogConfigSchema.prefault({}),
});

// ===== 类型（全部由 schema 推导） =====

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type EngineRateLimitConfig = z.infer<typeof EngineRateLimitSchema>;
export type EngineFallbackConfig = z.infer<typeof EngineFallbackSchema>;
export type EngineConfig = z.infer<typeof EngineConfigSchema>;
export type EngineConfigInput = z.input<typeof EngineConfigSchema>;
export type WechatConfig = z.infer<typeof WechatConfigSchema>;
export type CacheConfig = z.infer<typeof CacheConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type BrowserFetcherConfig = z.infer<typeof BrowserFetcherConfigSchema>;
export type FetcherConfig = z.infer<typeof FetcherConfigSchema>;
export type WorkerEndpointConfig = z.infer<typeof WorkerEndpointSchema>;
export type WorkersConfig = z.infer<typeof WorkersConfigSchema>;
export type SsrfConfig = z.infer<typeof SsrfConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ContentFilterConfig = z.infer<typeof ContentFilterConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export type LogConfig = z.infer<typeof LogConfigSchema>;
export type PrismSearchConfig = z.infer<typeof PrismSearchConfigSchema>;
export type PrismSearchConfigInput = z.input<typeof PrismSearchConfigSchema>;

// ===== 内置引擎默认条目 =====

/**
 * 内置引擎的默认配置。用户配置中的同名条目会逐字段覆盖这里的值；
 * 用户未列出的内置引擎保持此处的 enabled 状态。
 */
export const BUILTIN_ENGINES: readonly EngineConfigInput[] = [
  {
    name: 'google',
    displayName: 'Google',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://www.google.com/search',
    alternateUrls: [
      'https://www.google.com.hk/search',
      'https://www.google.co.jp/search',
      'https://www.google.com.sg/search',
    ],
    priority: 1,
    fallback: { crossOrigin: ['bing', 'duckduckgo', 'brave', 'baidu'] },
    regions: ['us', 'gb', 'uk', 'de', 'fr', 'jp', 'hk', 'tw', 'cn', 'ru'],
    languages: ['en', 'en-US', 'en-GB', 'fr', 'de', 'es', 'ja'],
  },
  {
    name: 'bing',
    displayName: 'Bing',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://www.bing.com/search',
    alternateUrls: ['https://cn.bing.com/search'],
    priority: 2,
    fallback: { crossOrigin: ['google', 'duckduckgo', 'baidu'] },
    regions: ['us', 'gb', 'uk', 'cn', 'hk', 'tw', 'de', 'fr', 'jp'],
    languages: ['en', 'en-US', 'en-GB', 'zh-CN'],
  },
  {
    name: 'brave',
    displayName: 'Brave Search',
    enabled: true,
    type: 'api',
    baseUrl: 'https://api.search.brave.com/res/v1/web/search',
    priority: 3,
    fallback: { crossOrigin: ['google', 'bing', 'duckduckgo'] },
    regions: ['us', 'gb', 'uk', 'de', 'fr'],
    languages: ['en', 'en-US', 'en-GB', 'zh-CN', 'zh'],
  },
  {
    name: 'baidu',
    displayName: '百度',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://www.baidu.com/s',
    alternateUrls: ['https://m.baidu.com/s'],
    priority: 4,
    fallback: { crossOrigin: ['sogou', 'so', 'bing'] },
    regions: ['cn', 'hk', 'tw'],
    languages: ['zh', 'zh-CN', 'zh-TW'],
  },
  {
    name: 'duckduckgo',
    displayName: 'DuckDuckGo',
    enabled: false,
    type: 'scraper',
    baseUrl: 'https://html.duckduckgo.com/html/',
    alternateUrls: ['https://lite.duckduckgo.com/lite/'],
    priority: 5,
    fallback: { crossOrigin: ['google', 'bing', 'brave'] },
    regions: ['us', 'gb', 'uk', 'de', 'fr'],
    languages: ['en', 'en-US', 'en-GB', 'de', 'fr'],
  },
  {
    name: 'sogou',
    displayName: '搜狗搜索',
    enabled: false,
    type: 'scraper',
    baseUrl: 'https://www.sogou.com/web',
    priority: 6,
    fallback: { crossOrigin: ['baidu', 'so', 'bing'] },
    regions: ['cn', 'hk', 'tw'],
    languages: ['zh', 'zh-CN'],
  },
  {
    name: 'so',
    displayName: '360搜索',
    enabled: false,
    type: 'scraper',
    baseUrl: 'https://www.so.com/s',
    alternateUrls: ['https://m.so.com/s'],
    priority: 7,
    fallback: { crossOrigin: ['baidu', 'sogou', 'bing'] },
    regions: ['cn', 'hk', 'tw'],
    languages: ['zh', 'zh-CN'],
  },
  {
    name: 'yandex',
    displayName: 'Yandex',
    enabled: false,
    type: 'scraper',
    baseUrl: 'https://yandex.com/search/',
    alternateUrls: ['https://yandex.ru/search/'],
    priority: 8,
    fallback: { crossOrigin: ['google', 'bing', 'duckduckgo'] },
    regions: ['ru', 'tr', 'by', 'kz', 'ua'],
    languages: ['ru', 'ru-RU', 'tr', 'uk'],
  },
];

/** 内置引擎名集合（工具参数 enum 与 list_engines 使用） */
export const BUILTIN_ENGINE_NAMES = BUILTIN_ENGINES.map(e => e.name) as [string, ...string[]];

/** 完整默认配置（经 schema 解析，保证与校验规则一致） */
export const DEFAULT_CONFIG: PrismSearchConfig = PrismSearchConfigSchema.parse({
  engines: BUILTIN_ENGINES,
});
