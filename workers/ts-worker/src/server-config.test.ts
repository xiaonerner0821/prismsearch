import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';

// 模拟抓取阶段抛出带内部细节的未知异常，验证 500 不回传原始信息
const SECRET_DETAIL = 'ENOENT /opt/internal/secret-path.so';
vi.mock('./fetcher.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./fetcher.js')>();
  return {
    ...actual,
    hasBrowserCapability: () => true,
    fetchPage: async () => {
      throw new Error(SECRET_DETAIL);
    },
  };
});

const { createServer, loadConfig, ConfigError, VERSION } = await import('./server.js');

describe('loadConfig 监听地址', () => {
  it('未设置 WORKER_HOST 时始终监听 127.0.0.1（即使配置了 token）', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(loadConfig({ PRISMSEARCH_WORKER_TOKEN: 'tok' }).host).toBe('127.0.0.1');
  });

  it('显式设置 WORKER_HOST 且有 token 时按设置监听', () => {
    const config = loadConfig({ PRISMSEARCH_WORKER_TOKEN: 'tok', WORKER_HOST: '0.0.0.0' });
    expect(config.host).toBe('0.0.0.0');
    expect(config.token).toBe('tok');
  });

  it('无 token 时拒绝绑定非回环地址', () => {
    expect(() => loadConfig({ WORKER_HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ WORKER_HOST: '0.0.0.0', PRISMSEARCH_WORKER_TOKEN: '   ' })).toThrow(ConfigError);
  });

  it('无 token 时允许显式绑定回环地址', () => {
    expect(loadConfig({ WORKER_HOST: '::1' }).host).toBe('::1');
    expect(loadConfig({ WORKER_HOST: 'localhost' }).host).toBe('localhost');
  });
});

describe('loadConfig 旧版全局私网开关', () => {
  it('留空或 0 视为未设置', () => {
    expect(loadConfig({ WORKER_ALLOW_PRIVATE_NETWORK: '' }).allowPrivateNetwork).toBe(false);
    expect(loadConfig({ WORKER_ALLOW_PRIVATE_NETWORK: '0' }).allowPrivateNetwork).toBe(false);
  });

  it.each(['1', 'true', 'yes', ' 1 '])('值 %j 拒绝启动', value => {
    expect(() => loadConfig({ WORKER_ALLOW_PRIVATE_NETWORK: value })).toThrow(/已废弃/);
  });
});

describe('版本号', () => {
  it('从自身 package.json 读取', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe('500 响应', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = createServer({ host: '127.0.0.1', port: 0, maxConcurrency: 2, allowPrivateNetwork: false });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('只返回通用文案，不泄露原始异常信息', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${base}/v1/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', method: 'browser' }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL');
      expect(body.error.message).not.toContain(SECRET_DETAIL);
      // 细节写进日志
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
