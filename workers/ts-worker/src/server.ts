/**
 * PrismSearch 抓取 Worker（Node + Playwright）
 *
 * 实现 docs/worker-protocol.md 定义的协议：
 *   GET  /health   健康与能力声明
 *   POST /v1/fetch 抓取（http 或 browser 两种方法）
 *
 * 安全默认值：
 * - 默认只监听 127.0.0.1，显式设置 WORKER_HOST 才对外监听；未配置 token 时拒绝绑定非回环地址
 * - 500 响应只返回通用文案，异常细节只写日志
 * - 目标地址做 SSRF 校验（连接期 + 路由拦截双重校验）
 * - 并发上限，超限返回 429 BUSY
 */

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fetchPage, closeBrowser, closeSharedAgent, detectBrowserCapability, hasBrowserCapability, TargetFetchError } from './fetcher.js';
import { SsrfBlockedError, configureSsrf } from './ssrf.js';

/**
 * 版本号从自身 package.json 读取。src/ 与 dist/ 都在包根目录下一层，
 * 所以 ../package.json 对源码运行（dev / 测试）与编译产物都成立。
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

export const VERSION = readVersion();

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

interface Config {
  host: string;
  port: number;
  token?: string;
  maxConcurrency: number;
  /** 恒为 false：全局私网放行已移除，字段仅为兼容保留（ssrf 模块收到 true 会直接抛错） */
  allowPrivateNetwork: false;
}

export class ConfigError extends Error {}

/**
 * 读取环境变量配置。
 * 监听地址默认始终是 127.0.0.1，必须显式设置 WORKER_HOST 才会对外监听；
 * 未设置 token 时拒绝绑定非回环地址（抛 ConfigError，由 main 退出进程）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.PRISMSEARCH_WORKER_TOKEN?.trim() || undefined;
  const host = env.WORKER_HOST?.trim() || '127.0.0.1';
  const port = Number(env.WORKER_PORT ?? 8787);

  if (!token && !LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(
      '拒绝启动：未设置 PRISMSEARCH_WORKER_TOKEN 时只能监听回环地址。\n' +
      '          Worker 能访问内网，暴露在网络上必须配置 token。',
    );
  }

  const maxConcurrency = Number(env.WORKER_MAX_CONCURRENCY);
  // 旧版全局放行开关：留空或 0 视为未设置，其余任何值都拒绝启动，避免误以为仍然生效
  const legacyPrivate = env.WORKER_ALLOW_PRIVATE_NETWORK?.trim();
  if (legacyPrivate && legacyPrivate !== '0') {
    throw new ConfigError('拒绝启动：WORKER_ALLOW_PRIVATE_NETWORK 已废弃；禁止全局放行私网。');
  }
  const config: Config = {
    host,
    port: Number.isInteger(port) && port > 0 ? port : 8787,
    token,
    maxConcurrency: Number.isInteger(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : 8,
    allowPrivateNetwork: false,
  };
  return config;
}

let inFlight = 0;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const HEADERS_TIMEOUT_MS = 15_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const BODY_READ_TIMEOUT_MS = 15_000;
const MAX_HEADER_BYTES = 16 * 1024;

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function errorBody(code: string, message: string): unknown {
  return { error: { code, message } };
}

async function readJsonBody(req: http.IncomingMessage, limitBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > limitBytes) throw new Error(`请求体超过上限 ${limitBytes} 字节`);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function authorized(req: http.IncomingMessage, config: Config): boolean {
  if (!config.token) return true;
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  // 先做摘要再定长比较：长度不同也不提前返回，避免时序侧信道泄露 token 长度
  const given = createHash('sha256').update(match[1]).digest();
  const expected = createHash('sha256').update(config.token).digest();
  return timingSafeEqual(given, expected);
}

export interface ServerLimits {
  bodyTimeoutMs?: number;
  headersTimeoutMs?: number;
}

export function createServer(config: Config, limits: ServerLimits = {}): http.Server {
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    void handle(req, res, config, limits).catch(error => {
      console.error('[worker] 未捕获的请求错误：', error);
      if (!res.headersSent) send(res, 500, errorBody('INTERNAL', '内部错误'));
      else res.end();
    });
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = limits.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = 100;
  server.maxConnections = Math.max(16, config.maxConcurrency * 2);

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, config: Config, limits: ServerLimits): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, errorBody('NOT_FOUND', '只支持 GET'));
      return;
    }
    send(res, 200, {
      status: 'ok',
      version: VERSION,
      // 如实上报：没装 playwright 时不声称支持 browser，客户端才不会把浏览器请求派过来
      capabilities: hasBrowserCapability() ? ['http', 'browser'] : ['http'],
      inFlight,
      maxConcurrency: config.maxConcurrency,
    });
    return;
  }

  if (url.pathname !== '/v1/fetch') {
    send(res, 404, errorBody('NOT_FOUND', `未知路径 ${url.pathname}`));
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, errorBody('NOT_FOUND', '只支持 POST'));
    return;
  }
  if (!authorized(req, config)) {
    send(res, 401, errorBody('UNAUTHORIZED', '鉴权失败：Authorization: Bearer <token>'));
    return;
  }
  if (inFlight >= config.maxConcurrency) {
    send(res, 429, errorBody('BUSY', `并发已达上限 ${config.maxConcurrency}`));
    return;
  }
  // 检查与占槽之间不能有 await：旧实现读完请求体才 ++，并发请求可同时通过检查突破上限
  inFlight++;
  try {
    let payload: unknown;
    const bodyTimer = setTimeout(() => req.destroy(), limits.bodyTimeoutMs ?? BODY_READ_TIMEOUT_MS);
    bodyTimer.unref();
    try {
      payload = await readJsonBody(req, MAX_BODY_BYTES);
    } catch {
      if (!res.destroyed) send(res, 400, errorBody('BAD_REQUEST', '请求体无法解析或超过上限'));
      return;
    } finally {
      clearTimeout(bodyTimer);
    }

    const body = payload as Record<string, unknown>;
    if (!body || typeof body.url !== 'string' || body.url.trim() === '') {
      send(res, 400, errorBody('BAD_REQUEST', '缺少 url 字段'));
      return;
    }
    if (typeof body.headers !== 'object' && body.headers !== undefined) {
      send(res, 400, errorBody('BAD_REQUEST', 'headers 必须是对象'));
      return;
    }
    if (body.method !== undefined && body.method !== 'http' && body.method !== 'browser') {
      send(res, 400, errorBody('UNSUPPORTED_METHOD', `本 Worker 只支持 method=http/browser，收到 ${String(body.method)}`));
      return;
    }
    if ((body.method ?? 'browser') === 'browser' && !hasBrowserCapability()) {
      // 已确认没装 playwright：直接返回，不必先做 DNS 校验
      send(res, 400, errorBody('UNSUPPORTED_METHOD', '本 Worker 未安装 Playwright，不支持 method=browser'));
      return;
    }

    const result = await fetchPage({
      url: body.url,
      format: body.format as never,
      method: body.method as never,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      maxBytes: typeof body.maxBytes === 'number' ? body.maxBytes : undefined,
      waitForSelector: typeof body.waitForSelector === 'string' ? body.waitForSelector : undefined,
      headers: body.headers as Record<string, string> | undefined,
      userAgent: typeof body.userAgent === 'string' ? body.userAgent : undefined,
    });
    send(res, 200, result);
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      send(res, 403, errorBody('SSRF_BLOCKED', error.message));
      return;
    }
    if (error instanceof TargetFetchError) {
      // 501：本 Worker 不具备该方法（如浏览器不可用）。与 py-worker 一致返回 400 UNSUPPORTED_METHOD，
      // 主进程据此摘掉该 Worker 的能力并换下一个 Worker；其余归为 FETCH_FAILED
      if (error.statusCode === 501) {
        send(res, 400, errorBody('UNSUPPORTED_METHOD', error.message));
      } else {
        send(res, 502, errorBody('FETCH_FAILED', error.message));
      }
      return;
    }
    // 细节只进日志：原始异常信息可能带内部路径、依赖版本等，不回传给客户端
    console.error('[worker] 抓取异常：', error);
    send(res, 500, errorBody('INTERNAL', '内部错误'));
  } finally {
    inFlight--;
  }
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[worker] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  // SSRF 默认值在进程级别生效，抓取器与浏览器路由都会读取
  configureSsrf({ allowPrivateNetwork: config.allowPrivateNetwork });
  // 启动即探测 playwright，让 /health 一开始就能如实回答
  if (!(await detectBrowserCapability())) {
    console.warn('[worker] 未检测到 playwright/browser 能力，/health 将只声明 http');
  }
  const server = createServer(config);

  server.listen(config.port, config.host, () => {
    console.log(
      `[worker] 已启动 http://${config.host}:${config.port}` +
      `（并发上限 ${config.maxConcurrency}，鉴权 ${config.token ? '已启用' : '未启用'}）`,
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] 收到 ${signal}，开始关闭…`);
    server.close();
    await closeBrowser();
    await closeSharedAgent();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// 入口判断：用 pathToFileURL 归一化，否则 Windows 的反斜杠路径比较永远不相等
const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if ((entryUrl && import.meta.url === entryUrl) || process.env.WORKER_AUTOSTART === '1') {
  void main();
}
