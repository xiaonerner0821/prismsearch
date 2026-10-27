/**
 * 基于 winston 的日志系统
 *
 * - 所有日志输出到 stderr（stdout 留给 stdio 协议，绝不能被污染）
 * - 自动展开 Error：包括 meta 中嵌套的 { error }，旧实现会被 json 格式序列化成 {}
 * - 隐私脱敏：redact 开启时，URL 去掉查询串与认证信息，搜索词只记录长度与哈希前缀
 * - flush()：退出前等待文件 transport 落盘
 */

import { createHash } from 'node:crypto';
import winston from 'winston';

let globalLogger: winston.Logger | null = null;
let redactEnabled = true;

export interface LoggerOptions {
  level?: string;
  format?: 'json' | 'text';
  file?: string;
  redact?: boolean;
}

/** 把 Error 转成可序列化对象（含 cause 链） */
export function serializeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return error;
  const out: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (error.stack) out.stack = error.stack;
  const code = (error as { code?: unknown }).code;
  if (code !== undefined) out.code = code;
  if (error.cause !== undefined && depth < 3) out.cause = serializeError(error.cause, depth + 1);
  return out;
}

/** 展开 meta 中任意顶层字段里的 Error */
const expandErrors = winston.format(info => {
  for (const key of Object.keys(info)) {
    const value = (info as Record<string, unknown>)[key];
    if (value instanceof Error) (info as Record<string, unknown>)[key] = serializeError(value);
  }
  return info;
});

export function createLogger(options: LoggerOptions = {}): winston.Logger {
  const level = options.level ?? 'info';
  const fmt = options.format ?? 'json';

  const base = winston.format.combine(
    winston.format.errors({ stack: true }),
    expandErrors(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  );

  const outputFormat = fmt === 'json'
    ? winston.format.combine(base, winston.format.json())
    : winston.format.combine(
        base,
        winston.format.printf(({ timestamp, level: lvl, message, stack, ...meta }) => {
          const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          const stackStr = typeof stack === 'string' ? `\n${stack}` : '';
          return `${String(timestamp)} [${lvl.toUpperCase()}] ${String(message)}${metaStr}${stackStr}`;
        }),
      );

  const transports: winston.transport[] = [
    new winston.transports.Console({ stderrLevels: Object.keys(winston.config.npm.levels) }),
  ];
  if (options.file) {
    transports.push(new winston.transports.File({ filename: options.file }));
  }

  return winston.createLogger({ level, format: outputFormat, transports });
}

/** 初始化全局 logger（配置加载 / 热重载后调用） */
export function initLogger(options: LoggerOptions): void {
  const previous = globalLogger;
  globalLogger = createLogger(options);
  redactEnabled = options.redact ?? true;
  previous?.close();
}

/** 获取全局 logger（未初始化时用默认配置） */
export function getLogger(): winston.Logger {
  globalLogger ??= createLogger();
  return globalLogger;
}

/** 等待所有 transport 写完（退出前调用） */
export async function flushLogger(timeoutMs = 2000): Promise<void> {
  const logger = globalLogger;
  if (!logger) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    logger.on('finish', () => {
      clearTimeout(timer);
      resolve();
    });
    logger.end();
  });
  globalLogger = null;
}

// ===== 脱敏工具 =====

export function isRedactEnabled(): boolean {
  return redactEnabled;
}

/** URL 脱敏：去掉认证信息与查询串 / 片段（redact 关闭时原样返回） */
export function redactUrl(url: string): string {
  if (!redactEnabled) return url;
  try {
    const u = new URL(url);
    const hadQuery = u.search.length > 0;
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return hadQuery ? `${u.toString()}?<redacted>` : u.toString();
  } catch {
    return '<invalid-url>';
  }
}

/** 搜索词脱敏：只保留长度与哈希前缀，便于关联同一查询（redact 关闭时原样返回） */
export function redactQuery(query: string): string {
  if (!redactEnabled) return query;
  const hash = createHash('sha256').update(query).digest('hex').slice(0, 8);
  return `<${query.length} chars #${hash}>`;
}

/** 错误消息摘要（日志 meta 用） */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
