/**
 * HTTP 传输层集成测试：起真实 express 服务（随机端口），验证
 * 健康检查、暴露面检查、鉴权、Host 校验、限流、404 与 MCP 初始化握手。
 * 不访问任何外部网络（引擎全部关闭）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildConfig } from '../../src/config/config-loader.js';
import type { PrismSearchConfig } from '../../src/config/config-schema.js';
import { PrismSearchRuntime, RuntimeHolder } from '../../src/server/mcp-server.js';
import {
  assertSafeExposure,
  isLoopbackHost,
  startHttpTransport,
  type HttpTransportHandle,
} from '../../src/server/http-transport.js';

const TOKEN = 'http-test-token';

function makeConfig(overrides: Record<string, unknown> = {}): PrismSearchConfig {
  const engines = ['google', 'bing', 'baidu', 'so', 'sogou', 'duckduckgo', 'yandex', 'brave'].map(name => ({
    name,
    enabled: false,
  }));
  const { config } = buildConfig(
    {
      server: { transport: 'http', host: '127.0.0.1', port: 0 },
      cache: { enabled: false },
      wechat: { enabled: false },
      engines,
      ...overrides,
    },
    {},
  );
  return config;
}

describe('isLoopbackHost / assertSafeExposure', () => {
  it('识别回环地址', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });

  it('非回环地址且未开鉴权时拒绝启动，显式放行或开鉴权后通过', () => {
    const exposed = makeConfig({ server: { host: '0.0.0.0', port: 0 } });
    expect(() => assertSafeExposure(exposed)).toThrow(/未开启鉴权/);

    const allowed = makeConfig({ server: { host: '0.0.0.0', port: 0, allowUnauthenticatedRemote: true } });
    expect(() => assertSafeExposure(allowed)).not.toThrow();

    const authed = makeConfig({
      server: { host: '0.0.0.0', port: 0 },
      security: { auth: { enabled: true, type: 'bearer', tokens: [TOKEN] } },
    });
    expect(() => assertSafeExposure(authed)).not.toThrow();
  });
});

describe('startHttpTransport', () => {
  let handle: HttpTransportHandle;
  let holder: RuntimeHolder;
  let base: string;

  beforeAll(async () => {
    const config = makeConfig({
      security: {
        auth: { enabled: true, type: 'bearer', tokens: [TOKEN] },
        rateLimit: { enabled: true, maxRequests: 3, windowMs: 60_000, keyBy: 'client' },
      },
    });
    const runtime = await PrismSearchRuntime.create(config, { toolLevelRateLimit: false });
    holder = new RuntimeHolder(runtime);
    handle = await startHttpTransport({ holder });
    base = `http://127.0.0.1:${handle.address.port}`;
  });

  afterAll(async () => {
    await handle?.close();
    await holder?.get().close?.();
  });

  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0.0.0' },
    },
  };

  function mcpPost(token: string | null, body: unknown = initBody) {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('/health 无需鉴权且只暴露最小信息', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['status', 'version']);
    expect(body.status).toBe('ok');
  });

  it('url 指向 /mcp', () => {
    expect(handle.url).toMatch(/\/mcp$/);
  });

  it('缺少或错误的 token 返回 401', async () => {
    expect((await mcpPost(null)).status).toBe(401);
    expect((await mcpPost('wrong')).status).toBe(401);
  });

  it('非法 Host 头被拒绝（防 DNS 重绑定）', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: handle.address.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            Host: 'evil.example.com',
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
        res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(initBody));
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).not.toBe(200);
  });

  it('鉴权通过后 MCP initialize 握手成功，并带上限流头', async () => {
    const res = await mcpPost(TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit-limit')).toBe('3');
    const text = await res.text();
    expect(text).toContain('"serverInfo"');
  });

  it('超过限流配额返回 429 与 Retry-After', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) last = await mcpPost(TOKEN);
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await last!.json()).error).toBe('rate_limited');
  });

  it('未知路径返回 404（鉴权后）', async () => {
    const res = await fetch(`${base}/nope`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it('tools/list 返回全部工具与其输入 schema', async () => {
    // 独立的服务实例，避免被上面的限流桶影响
    const config = makeConfig({ security: { auth: { enabled: true, type: 'bearer', tokens: [TOKEN] } } });
    const runtime = await PrismSearchRuntime.create(config, { toolLevelRateLimit: false });
    const localHolder = new RuntimeHolder(runtime);
    const local = await startHttpTransport({ holder: localHolder });
    try {
      const res = await fetch(`http://127.0.0.1:${local.address.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TOKEN}`,
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const tool of ['web_search', 'image_search', 'fetch_page', 'wechat_search', 'list_engines']) {
        expect(text).toContain(tool);
      }
      expect(text).toContain('inputSchema');
    } finally {
      await local.close();
      await localHolder.get().close?.();
    }
  });

  it('管理接口默认未注册', async () => {
    const res = await fetch(`${base}/admin/config/reload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('GET /mcp（SSE 通道）不受限流约束', async () => {
    // 独立实例：先耗尽 POST 配额，再确认 SSE 重连不被限流
    const config = makeConfig({
      security: {
        auth: { enabled: true, type: 'bearer', tokens: [TOKEN] },
        rateLimit: { enabled: true, maxRequests: 1, windowMs: 60_000, keyBy: 'client' },
      },
    });
    const runtime = await PrismSearchRuntime.create(config, { toolLevelRateLimit: false });
    const localHolder = new RuntimeHolder(runtime);
    const local = await startHttpTransport({ holder: localHolder });
    const localBase = `http://127.0.0.1:${local.address.port}`;
    try {
      const post = (body: unknown) =>
        fetch(`${localBase}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify(body),
        });

      expect((await post(initBody)).status).toBe(200);
      expect((await post(initBody)).status).toBe(429);

      // 无状态模式下 SDK 对 GET 按规范回 405（Allow: POST），服务端推送走 POST 响应内的 SSE 流。
      // 这里要确认的是：请求穿过了限流层到达 SDK，而不是被限流挡成 429
      const res = await fetch(`${localBase}/mcp`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' },
      });
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      await res.body?.cancel().catch(() => undefined);
    } finally {
      await local.close();
      await localHolder.get().close?.();
    }
  });
});

describe('startHttpTransport 端口占用', () => {
  it('EADDRINUSE 以可读错误拒绝', async () => {
    const first = makeConfig();
    const runtime = await PrismSearchRuntime.create(first, { toolLevelRateLimit: false });
    const holder = new RuntimeHolder(runtime);
    const a = await startHttpTransport({ holder });
    try {
      const second = makeConfig({ server: { transport: 'http', host: '127.0.0.1', port: a.address.port } });
      const holder2 = new RuntimeHolder(await PrismSearchRuntime.create(second, { toolLevelRateLimit: false }));
      await expect(startHttpTransport({ holder: holder2 })).rejects.toThrow(/已被占用/);
      await holder2.get().close?.();
    } finally {
      await a.close();
      await holder.get().close?.();
    }
  });
});
