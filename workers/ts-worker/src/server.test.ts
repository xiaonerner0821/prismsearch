import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createServer } from './server.js';

const TOKEN = 'test-token-123';
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    maxConcurrency: 2,
    allowPrivateNetwork: false,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function post(body: unknown, token: string | null = TOKEN) {
  return fetch(`${base}/v1/fetch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('ts-worker HTTP 协议', () => {
  it('服务器启用有限的请求头、请求体及 keep-alive 超时', () => {
    expect(server.requestTimeout).toBeGreaterThan(0);
    expect(server.headersTimeout).toBeGreaterThan(0);
    expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
    expect(server.keepAliveTimeout).toBeGreaterThan(0);
    expect(server.maxHeadersCount).toBe(100);
  });

  it('GET /health 返回 ok 与能力声明（无需鉴权）', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // capabilities 如实反映 playwright 是否可用，这里只断言 http 一定在
    expect(body.status).toBe('ok');
    expect(body.capabilities).toContain('http');
    expect(body.maxConcurrency).toBe(2);
    expect(typeof body.inFlight).toBe('number');
  });

  it('未知路径返回 404 NOT_FOUND', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('GET /v1/fetch 返回 405', async () => {
    const res = await fetch(`${base}/v1/fetch`);
    expect(res.status).toBe(405);
  });

  it('缺少或错误的 token 返回 401 UNAUTHORIZED', async () => {
    const missing = await post({ url: 'https://example.com' }, null);
    expect(missing.status).toBe(401);
    expect((await missing.json()).error.code).toBe('UNAUTHORIZED');

    const wrong = await post({ url: 'https://example.com' }, 'wrong');
    expect(wrong.status).toBe(401);
  });

  it('请求体不是 JSON 或缺少 url 时返回 400 BAD_REQUEST', async () => {
    const bad = await post('{not json');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('BAD_REQUEST');

    const noUrl = await post({ format: 'markdown' });
    expect(noUrl.status).toBe(400);
    expect((await noUrl.json()).error.message).toContain('url');
  });

  it('目标指向内网时返回 403 SSRF_BLOCKED', async () => {
    const res = await post({ url: 'http://127.0.0.1:1/', method: 'http' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('SSRF_BLOCKED');

    const meta = await post({ url: 'http://169.254.169.254/latest/meta-data', method: 'http' });
    expect(meta.status).toBe(403);
  });

  it('未知 method 返回 400 UNSUPPORTED_METHOD（与 py-worker 一致）', async () => {
    const res = await post({ url: 'https://example.com', method: 'ftp' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('UNSUPPORTED_METHOD');
  });

  it('非 http(s) 协议同样返回 SSRF_BLOCKED', async () => {
    const res = await post({ url: 'file:///etc/passwd', method: 'http' });
    expect(res.status).toBe(403);
  });
});
