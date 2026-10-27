/**
 * 进程外抓取 Worker 客户端
 *
 * Worker 协议（HTTP + JSON，详见 docs/worker-protocol.md）：
 * - GET  /health    → { status: "ok", version, capabilities: ["http","browser"], inFlight, maxConcurrency }
 * - POST /v1/fetch  → 请求 { url, format, method, timeoutMs, maxBytes, waitForSelector?, headers?, userAgent? }
 *                     成功 200 { url, content, rawHtml?, title?, statusCode, contentType?, contentLength?, fetchTime, truncated? }
 *                     失败 4xx/5xx { error: { code, message } }
 * - 鉴权：Authorization: Bearer <token>（端点 token，缺省取 PRISMSEARCH_WORKER_TOKEN）
 *
 * 客户端职责：
 * - 负载均衡：round-robin（按权重平滑轮询）/ least-busy（在途数 / 权重最小）
 * - 并发上限：每个端点不超过 maxConcurrency
 * - 健康检查：定时探测 /health；请求网络错误或 5xx 立即标记不健康，等待下一轮探测恢复
 * - 故障转移：一个 Worker 失败后换下一个健康 Worker 重试（4xx 视为请求本身的问题，不重试）
 * - 安全：Worker 内部也做 SSRF 校验；返回后主进程再对最终 URL 校验一次
 *
 * 注意：Worker 通常部署在内网，因此访问 Worker 本身不经过 SSRF 调度器。
 */

import type { WorkersConfig } from '../config/config-schema.js';
import type { FetchOptions, FetchResult } from '../fetcher/fetcher-interface.js';
import type { RemoteFetcher, FetchMethod } from '../tools/fetch-page.js';
import type { WorkerStatusSummary } from '../tools/list-engines.js';
import { getLogger, redactUrl } from '../utils/logger.js';
import { PKG_VERSION } from '../version.js';

type Endpoint = WorkersConfig['endpoints'][number];

interface WorkerState {
  endpoint: Endpoint;
  token?: string;
  healthy: boolean;
  capabilities: Set<string>;
  inFlight: number;
  currentWeight: number;
  lastError?: string;
  lastCheckedAt?: number;
}

export class WorkerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WorkerRequestError';
  }
}

const HEALTH_TIMEOUT_MS = 5000;
const HEALTH_MAX_BYTES = 64 * 1024;
/** Worker 返回体上限：正常是几百 KB 的正文，超过这个量级说明对端异常 */
const WORKER_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 限长读取并解析 JSON。
 * response.json() 会把整个响应体读进内存，对端异常（配置错、被代理接管）时可能拖垮主进程。
 */
async function readJsonLimited(response: Response, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WorkerRequestError(`Worker 返回体过大（${declared} 字节）`, response.status, false);
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WorkerRequestError(`Worker 返回体超过上限 ${maxBytes} 字节`, response.status, false);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8');
  if (!text.trim()) return undefined;
  return JSON.parse(text) as Record<string, unknown>;
}

export interface WorkerClientOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** 测试用：不启动定时健康检查 */
  disableHealthTimer?: boolean;
  /** 首次健康检查前假定的能力集合，默认只有 http */
  initialCapabilities?: FetchMethod[];
  /** 单次抓取响应体上限（字节），默认 WORKER_RESPONSE_MAX_BYTES */
  maxResponseBytes?: number;
}

export class WorkerClient implements RemoteFetcher {
  readonly name = 'worker';
  private readonly workers: WorkerState[];
  private readonly fetchImpl: typeof fetch;
  private timer?: ReturnType<typeof setInterval>;
  private rrCursor = 0;
  private closed = false;
  private readonly maxResponseBytes: number;

  constructor(private readonly config: WorkersConfig, options: WorkerClientOptions = {}) {
    const env = options.env ?? process.env;
    this.maxResponseBytes = options.maxResponseBytes ?? WORKER_RESPONSE_MAX_BYTES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    // 先验证整个配置，再启动任何探测，避免部分端点已泄露凭据后才发现错误。
    const states = config.endpoints.map(endpoint => {
      const url = new URL(endpoint.url);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const loopback = ['localhost', '127.0.0.1', '::1'].includes(host);
      const token = endpoint.token?.trim() || env.PRISMSEARCH_WORKER_TOKEN?.trim() || undefined;
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Worker endpoint 只允许无凭据、查询和片段的 HTTP(S) URL');
      }
      if (!loopback) {
        if (!config.allowedOrigins?.includes(url.origin)) throw new Error(`Worker ${endpoint.name} 不在 allowedOrigins 白名单中`);
        if (!token) throw new Error(`远端 Worker ${endpoint.name} 必须配置 token`);
        if (url.protocol !== 'https:' && !endpoint.allowInsecureHttp) throw new Error(`远端 Worker ${endpoint.name} 必须使用 HTTPS`);
      }
      // 复制配置，防止调用方在验证后改写端点，绕过 origin/TLS 约束。
      return { endpoint: { ...endpoint, url: url.toString() }, token };
    });
    this.workers = states.map(({ endpoint, token }) => ({
      endpoint,
      token,
      // 首次健康检查完成前乐观视为健康，避免启动初期全部请求被拒
      healthy: true,
      // 但能力不能乐观：真实能力由 /health 告知。默认只给 http，
      // 否则未装 Playwright 的 Worker 也会被派去渲染，白白失败一轮才降级
      capabilities: new Set<string>(options.initialCapabilities ?? ['http']),
      inFlight: 0,
      currentWeight: 0,
    }));

    if (!options.disableHealthTimer && this.workers.length > 0) {
      void this.checkAll();
      this.timer = setInterval(() => void this.checkAll(), config.healthCheckIntervalMs);
      this.timer.unref?.();
    }
  }

  // ===== RemoteFetcher =====

  hasHealthyWorker(): boolean {
    return this.workers.some(w => w.healthy);
  }

  supports(method: FetchMethod): boolean {
    return this.workers.some(w => w.capabilities.has(method));
  }

  status(): WorkerStatusSummary[] {
    return this.workers.map(w => ({
      name: w.endpoint.name,
      url: w.endpoint.url,
      healthy: w.healthy,
      capabilities: [...w.capabilities],
      inFlight: w.inFlight,
      lastError: w.lastError,
    }));
  }

  async fetch(options: FetchOptions): Promise<FetchResult> {
    if (this.closed) throw new Error('Worker 客户端已关闭');
    const method: FetchMethod = options.method ?? 'browser';
    const tried = new Set<WorkerState>();
    let lastError: unknown;

    for (;;) {
      const worker = this.pick(method, tried);
      if (!worker) break;
      tried.add(worker);
      try {
        const result = await this.dispatch(worker, method, options);
        // 主进程对最终 URL 再做一次 SSRF 校验（Worker 跟随了重定向）
        if (options.validateUrl && result.url !== options.url) await options.validateUrl(result.url);
        return result;
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof WorkerRequestError) || error.retryable;
        getLogger().warn('Worker 抓取失败', {
          worker: worker.endpoint.name,
          url: redactUrl(options.url),
          error: error instanceof Error ? error.message : String(error),
          retryable,
        });
        if (!retryable) break;
      }
    }

    if (lastError) throw lastError;
    throw new Error(`没有可用的 Worker 支持 ${method} 抓取`);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ===== 负载均衡 =====

  private eligible(method: FetchMethod, exclude: Set<WorkerState>): WorkerState[] {
    return this.workers.filter(w =>
      !exclude.has(w) &&
      w.healthy &&
      w.capabilities.has(method) &&
      w.inFlight < w.endpoint.maxConcurrency,
    );
  }

  /** 选出下一个 Worker；全部忙碌时返回 undefined */
  pick(method: FetchMethod, exclude: Set<WorkerState> = new Set()): WorkerState | undefined {
    const candidates = this.eligible(method, exclude);
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];

    if (this.config.strategy === 'least-busy') {
      let best = candidates[0];
      let bestLoad = best.inFlight / best.endpoint.weight;
      for (let i = 1; i < candidates.length; i++) {
        // 起点轮转，负载相同时也能分散
        const c = candidates[(i + this.rrCursor) % candidates.length];
        const load = c.inFlight / c.endpoint.weight;
        if (load < bestLoad) {
          best = c;
          bestLoad = load;
        }
      }
      this.rrCursor = (this.rrCursor + 1) % 1_000_000;
      return best;
    }

    // 平滑加权轮询（nginx 算法）
    let total = 0;
    let best: WorkerState | undefined;
    for (const c of candidates) {
      c.currentWeight += c.endpoint.weight;
      total += c.endpoint.weight;
      if (!best || c.currentWeight > best.currentWeight) best = c;
    }
    best!.currentWeight -= total;
    return best;
  }

  // ===== 请求 =====

  private headers(worker: WorkerState, json: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `prismsearch/${PKG_VERSION}`,
    };
    if (json) h['Content-Type'] = 'application/json';
    if (worker.token) h.Authorization = `Bearer ${worker.token}`;
    return h;
  }

  /** 测试与显式配置验证：Worker URL 不允许重定向到其它 origin */
  private endpointUrl(worker: WorkerState, path: string): string {
    const url = new URL(path, worker.endpoint.url.endsWith('/') ? worker.endpoint.url : `${worker.endpoint.url}/`);
    if (url.origin !== new URL(worker.endpoint.url).origin) throw new Error('Worker endpoint origin 被非法改变');
    return url.toString();
  }

  private async dispatch(worker: WorkerState, method: FetchMethod, options: FetchOptions): Promise<FetchResult> {
    const timeoutMs = Math.min(options.timeout ?? this.config.timeoutMs, this.config.timeoutMs);
    // Worker 端用 timeoutMs 执行抓取，客户端额外留出网络余量
    const signals = [AbortSignal.timeout(timeoutMs + 5000)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);

    worker.inFlight++;
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpointUrl(worker, 'v1/fetch'), {
          method: 'POST',
          redirect: 'error',
          headers: this.headers(worker, true),
          body: JSON.stringify({
            url: options.url,
            format: options.format ?? 'markdown',
            method,
            timeoutMs,
            maxBytes: options.maxBytes,
            waitForSelector: options.waitForSelector,
            headers: options.headers,
            userAgent: options.userAgent,
          }),
          signal,
        });
      } catch (error) {
        this.markUnhealthy(worker, error);
        throw new WorkerRequestError(`Worker ${worker.endpoint.name} 无法访问: ${errorText(error)}`, undefined, true);
      }

      // 超限必须原样抛出（否则会被误报成「返回格式无效」再换 Worker 重试）；只有 JSON 解析失败才吞掉
      const body = await readJsonLimited(response, this.maxResponseBytes).catch((error: unknown) => {
        if (error instanceof WorkerRequestError) throw error;
        return undefined;
      });
      if (!response.ok) {
        const err = body?.error as { code?: string; message?: string } | undefined;
        const message = err?.message ?? `HTTP ${response.status}`;
        // 目标地址本身不安全：换 Worker 也没意义，且 Worker 是健康的（必须先于鉴权分支判断，二者都可能是 403）
        if (err?.code === 'SSRF_BLOCKED') {
          throw new WorkerRequestError(message, response.status, false);
        }
        if (response.status === 401 || response.status === 403) {
          this.markUnhealthy(worker, new Error('鉴权失败，请检查 Worker token'));
          throw new WorkerRequestError(`Worker ${worker.endpoint.name} 鉴权失败`, response.status, true);
        }
        // 该 Worker 不支持这个方法（如 py-worker 只做 http）：摘掉能力后换下一个 Worker
        if (err?.code === 'UNSUPPORTED_METHOD') {
          worker.capabilities.delete(method);
          throw new WorkerRequestError(
            `Worker ${worker.endpoint.name} 不支持 ${method} 抓取`,
            response.status,
            true,
          );
        }
        if (response.status >= 500 || response.status === 429) {
          if (response.status >= 500 && err?.code !== 'FETCH_FAILED') this.markUnhealthy(worker, new Error(message));
          throw new WorkerRequestError(`Worker ${worker.endpoint.name}: ${message}`, response.status, true);
        }
        // 其余 4xx：目标被拒、参数错误等，换 Worker 也没用
        throw new WorkerRequestError(message, response.status, false);
      }

      if (!body || typeof body.content !== 'string' || typeof body.url !== 'string' || typeof body.statusCode !== 'number') {
        throw new WorkerRequestError(`Worker ${worker.endpoint.name} 返回格式无效`, response.status, true);
      }
      worker.lastError = undefined;
      return {
        url: body.url,
        content: body.content,
        rawHtml: typeof body.rawHtml === 'string' ? body.rawHtml : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        statusCode: body.statusCode,
        contentType: typeof body.contentType === 'string' ? body.contentType : undefined,
        contentLength: typeof body.contentLength === 'number' ? body.contentLength : Buffer.byteLength(body.content),
        fetchTime: typeof body.fetchTime === 'number' ? body.fetchTime : 0,
        fetchedBy: `worker:${worker.endpoint.name}`,
        // Worker 读到 maxBytes 上限时截断并标记，与本地 HttpFetcher 语义一致
        ...(body.truncated === true ? { truncated: true } : {}),
      };
    } finally {
      worker.inFlight--;
    }
  }

  // ===== 健康检查 =====

  async checkAll(): Promise<void> {
    await Promise.all(this.workers.map(w => this.check(w)));
  }

  private async check(worker: WorkerState): Promise<void> {
    try {
      const response = await this.fetchImpl(this.endpointUrl(worker, 'health'), {
        redirect: 'error',
        headers: this.headers(worker, false),
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const body = await readJsonLimited(response, HEALTH_MAX_BYTES).catch(() => undefined);
      if (!response.ok || body?.status !== 'ok') {
        throw new Error(`health 返回 HTTP ${response.status}`);
      }
      if (Array.isArray(body.capabilities)) {
        worker.capabilities = new Set(body.capabilities.filter((c): c is string => typeof c === 'string'));
      }
      if (!worker.healthy) getLogger().info('Worker 恢复健康', { worker: worker.endpoint.name });
      worker.healthy = true;
      worker.lastError = undefined;
    } catch (error) {
      this.markUnhealthy(worker, error);
    } finally {
      worker.lastCheckedAt = Date.now();
    }
  }

  private markUnhealthy(worker: WorkerState, error: unknown): void {
    if (worker.healthy) {
      getLogger().warn('Worker 标记为不健康', { worker: worker.endpoint.name, error: errorText(error) });
    }
    worker.healthy = false;
    worker.lastError = errorText(error);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
