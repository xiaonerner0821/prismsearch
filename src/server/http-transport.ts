/**
 * HTTP 传输层（Streamable HTTP，SDK v2）
 *
 * 相比旧实现：
 * - 每个请求由工厂新建 McpServer（createMcpHandler），不再所有会话共用一个实例；
 *   2025 版客户端自动走无状态兼容路径
 * - SSE 心跳由 SDK 负责（keepAlive），长耗时工具调用不会被中间代理断开
 * - Host / Origin 校验防 DNS 重绑定；监听非回环地址时强制要求鉴权
 *   （除非显式 allowUnauthenticatedRemote）
 * - 中间件顺序：/health（无鉴权、最小信息）→ Host/Origin → 鉴权 → 限流 → MCP
 * - 限流按客户端分桶（凭证指纹或 IP），旧实现按工具名全局计数，一个客户端即可耗尽所有人的配额
 * - 配置重载接口改为 POST /admin/config/reload，默认关闭且必须开启鉴权；真正重建依赖
 * - listen 错误（端口占用等）以 Promise 拒绝的形式抛给调用方；close() 优雅关闭
 * - 内部错误不再把 error.message 直接回给客户端
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  toNodeHandler,
  hostHeaderValidation,
  localhostHostValidation,
  originValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node';
import type { PrismSearchConfig } from '../config/config-schema.js';
import { createAuthMiddleware } from '../security/auth.js';
import { RateLimiter } from '../security/rate-limiter.js';
import { getLogger, errorMessage } from '../utils/logger.js';
import { PKG_VERSION } from '../version.js';
import { createMcpServer, type RuntimeHolder } from './mcp-server.js';

export interface HttpTransportOptions {
  holder: RuntimeHolder;
  /** 重新加载配置并重建运行时；返回新配置 */
  reload?: () => Promise<PrismSearchConfig>;
}

export interface HttpTransportHandle {
  /** 实际监听地址（port=0 时可获得随机端口） */
  address: AddressInfo;
  url: string;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const HTTP_REQUEST_TIMEOUT_MS = 120_000;
const HTTP_HEADERS_TIMEOUT_MS = 15_000;
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const MAX_IN_FLIGHT_REQUESTS = 128;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

/** 启动前的安全检查：非回环地址必须开启鉴权 */
export function assertSafeExposure(config: PrismSearchConfig): void {
  const { host, allowUnauthenticatedRemote } = config.server;
  if (!isLoopbackHost(host) && !config.security.auth.enabled && !allowUnauthenticatedRemote) {
    throw new Error(
      `HTTP 服务监听在 ${host}（非本机地址）但未开启鉴权。请配置 security.auth（或环境变量 PRISMSEARCH_AUTH_TOKENS），` +
      '或在明确知晓风险的前提下设置 server.allowUnauthenticatedRemote: true',
    );
  }
}

type Guard = (req: Request, res: Response) => boolean;

function toMiddleware(guard: Guard) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (guard(req, res)) next();
  };
}

function buildHostGuard(config: PrismSearchConfig): Guard | undefined {
  const { allowedHosts, host } = config.server;
  if (allowedHosts.length > 0) return hostHeaderValidation(allowedHosts) as Guard;
  if (isLoopbackHost(host)) return localhostHostValidation() as Guard;
  return undefined; // 非回环且未配置：依赖鉴权
}

function buildOriginGuard(config: PrismSearchConfig): Guard {
  const { allowedOrigins } = config.server;
  return (allowedOrigins.length > 0 ? originValidation(allowedOrigins) : localhostOriginValidation()) as Guard;
}

export async function startHttpTransport(options: HttpTransportOptions): Promise<HttpTransportHandle> {
  const logger = getLogger();
  const { holder } = options;
  const config = holder.get().config;
  assertSafeExposure(config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // 在读取 body 之前占槽；SSE 响应仍可长时间运行，但慢上传不能无限占用资源。
  let inFlight = 0;
  app.use((req, res, next) => {
    if (inFlight >= MAX_IN_FLIGHT_REQUESTS && req.path !== '/health') {
      res.setHeader('Connection', 'close');
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: 'server_busy' });
      return;
    }
    inFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight--;
    };
    res.once('finish', release);
    res.once('close', release);
    const timer = setTimeout(() => {
      if (!req.complete) {
        if (!res.headersSent) {
          res.setHeader('Connection', 'close');
          res.status(408).json({ error: 'request_timeout' });
        }
        req.destroy();
      }
    }, HTTP_REQUEST_TIMEOUT_MS);
    timer.unref();
    const clear = () => clearTimeout(timer);
    req.once('end', clear);
    res.once('close', clear);
    next();
  });

  // 1. 健康检查：放在鉴权之前，只暴露最小信息
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: PKG_VERSION });
  });

  // 2. Host / Origin
  const hostGuard = buildHostGuard(config);
  if (hostGuard) app.use(toMiddleware(hostGuard));
  app.use(toMiddleware(buildOriginGuard(config)));

  // 3. 鉴权
  app.use(createAuthMiddleware(config.security.auth));
  if (config.security.auth.enabled) logger.info('HTTP 鉴权已启用', { type: config.security.auth.type });

  // 4. 限流（按客户端或全局分桶，只计 POST —— 心跳与 SSE 重连不消耗配额）
  const rl = config.security.rateLimit;
  const limiter = new RateLimiter({ enabled: rl.enabled, maxRequests: rl.maxRequests, windowMs: rl.windowMs });
  app.use('/mcp', (req, res, next) => {
    if (req.method !== 'POST' || !limiter.isEnabled()) {
      next();
      return;
    }
    const key = rl.keyBy === 'global'
      ? 'global'
      : (res.locals.clientId as string | undefined) ?? `ip:${req.socket.remoteAddress ?? 'unknown'}`;
    const r = limiter.consume(key);
    res.setHeader('RateLimit-Limit', String(rl.maxRequests));
    res.setHeader('RateLimit-Remaining', String(Number.isFinite(r.remaining) ? r.remaining : rl.maxRequests));
    if (!r.allowed) {
      const retryAfter = Math.ceil((r.retryAfter ?? rl.windowMs) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'rate_limited', retryAfter });
      return;
    }
    next();
  });

  // 5. 管理接口（默认关闭，且必须开启鉴权）
  if (config.server.enableAdminApi) {
    if (!config.security.auth.enabled) {
      logger.warn('server.enableAdminApi 已开启但未启用鉴权，管理接口不会注册');
    } else if (options.reload) {
      const reload = options.reload;
      app.post('/admin/config/reload', async (_req, res) => {
        try {
          const next = await reload();
          logger.info('配置已通过管理接口重新加载');
          res.json({
            status: 'ok',
            engines: next.engines.filter(e => e.enabled).map(e => e.name),
            note: 'server.* 与 security.auth 的变更需要重启后生效',
          });
        } catch (error) {
          // 错误详情可能含配置文件绝对路径等内部信息，只写日志，不回显给客户端
          logger.error('配置重载失败', { error: errorMessage(error) });
          res.status(400).json({
            error: 'reload_failed',
            message: '配置重载失败，详情见服务端日志 / Config reload failed; see server logs for details',
          });
        }
      });
    }
  }

  // 6. MCP 端点：每个请求由工厂新建 McpServer
  const mcpHandler = createMcpHandler(() => createMcpServer(holder), {
    onerror: error => logger.warn('MCP 请求处理异常', { error }),
    maxRequestBodySize: config.server.maxBodyBytes,
  });
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: error => logger.error('MCP 适配层异常', { error }),
    maxRequestBodySize: config.server.maxBodyBytes,
  });
  app.all('/mcp', (req, res) => {
    Promise.resolve(nodeHandler(req, res)).catch(error => {
      logger.error('MCP 请求处理失败', { error });
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // 兜底错误处理：不回显内部错误
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('HTTP 请求处理失败', { error });
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  // 启动监听；端口占用等错误通过 Promise 拒绝
  const httpServer: NodeHttpServer = await new Promise((resolve, reject) => {
    const srv = app.listen(config.server.port, config.server.host);
    const onError = (error: NodeJS.ErrnoException) => {
      srv.off('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${config.server.port} 已被占用（${config.server.host}），请修改 server.port`, { cause: error }));
      } else if (error.code === 'EACCES') {
        reject(new Error(`没有权限监听 ${config.server.host}:${config.server.port}`, { cause: error }));
      } else {
        reject(error);
      }
    };
    const onListening = () => {
      srv.off('error', onError);
      resolve(srv);
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
  });

  // 请求体读取与连接头部均设有限时，避免慢连接耗尽线程；SSE 由 SDK 心跳维持。
  httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  httpServer.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  httpServer.maxConnections = MAX_IN_FLIGHT_REQUESTS * 2;

  const address = httpServer.address() as AddressInfo;
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${displayHost}:${address.port}/mcp`;
  logger.info('PrismSearch MCP 服务器已启动（HTTP 模式）', { endpoint: url });

  let closing: Promise<void> | undefined;
  return {
    address,
    url,
    close() {
      closing ??= (async () => {
        limiter.destroy();
        await mcpHandler.close().catch(error => logger.warn('关闭 MCP 处理器失败', { error }));
        await new Promise<void>(resolve => {
          httpServer.close(() => resolve());
          // 断开空闲连接，活动的 SSE 连接在宽限期后强制断开
          httpServer.closeIdleConnections();
          const timer = setTimeout(() => {
            httpServer.closeAllConnections();
            resolve();
          }, 5000);
          timer.unref();
        });
      })();
      return closing;
    },
  };
}
