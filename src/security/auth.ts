/**
 * 远程鉴权 — Bearer Token / API Key
 *
 * 相比旧实现：
 * - 常量时间比较（先对双方做 SHA-256 再 timingSafeEqual，长度差异也不泄露）
 * - 不再接受 ?api_key= 查询参数：凭证会进入代理 / 访问日志与浏览器历史
 * - 认证通过后在 res.locals.clientId 写入凭证指纹，供按客户端限流分桶
 * - 缺凭证与凭证无效统一返回 401 + WWW-Authenticate，不区分以免帮助枚举
 * - /health 的放行由路由顺序决定（在本中间件之前注册），这里不再硬编码路径
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AuthConfig } from '../config/config-schema.js';
import { getLogger } from '../utils/logger.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** 凭证指纹（日志 / 限流分桶用，不可逆） */
export function tokenFingerprint(token: string): string {
  return `tok:${digest(token).toString('hex').slice(0, 16)}`;
}

/** 从请求头提取凭证 */
export function extractToken(
  headers: Record<string, string | string[] | undefined>,
  type: AuthConfig['type'],
): string | undefined {
  if (type === 'bearer') {
    const raw = headers.authorization;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const match = value?.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || undefined;
  }
  const raw = headers['x-api-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

/** 常量时间校验凭证是否在允许列表中 */
export function verifyToken(token: string, allowed: readonly string[]): boolean {
  const candidate = digest(token);
  let ok = false;
  // 遍历全部令牌，不提前退出
  for (const t of allowed) {
    if (timingSafeEqual(candidate, digest(t))) ok = true;
  }
  return ok;
}

export function createAuthMiddleware(config: AuthConfig) {
  const logger = getLogger();
  const challenge = config.type === 'bearer' ? 'Bearer realm="prismsearch"' : 'ApiKey realm="prismsearch"';

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.enabled) {
      next();
      return;
    }

    const token = extractToken(req.headers, config.type);
    if (!token || !verifyToken(token, config.tokens)) {
      logger.warn('认证失败', { path: req.path, ip: req.ip, reason: token ? 'invalid' : 'missing' });
      res.setHeader('WWW-Authenticate', challenge);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    res.locals.clientId = tokenFingerprint(token);
    next();
  };
}
