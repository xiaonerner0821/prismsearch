import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';

// 模拟「没装 playwright / 浏览器启动失败」的 Worker
const state = vi.hoisted(() => ({ browserInstalled: false }));
vi.mock('./fetcher.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./fetcher.js')>();
  return {
    ...actual,
    hasBrowserCapability: () => state.browserInstalled,
    fetchPage: async () => {
      throw new actual.TargetFetchError('Worker 未安装 Playwright，无法使用 browser 方法', 501);
    },
  };
});

const { createServer } = await import('./server.js');

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

function post(body: unknown) {
  return fetch(`${base}/v1/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('browser 不可用时返回 UNSUPPORTED_METHOD，让主进程换 Worker', () => {
  it('已探测到没装 playwright：直接 400 UNSUPPORTED_METHOD', async () => {
    state.browserInstalled = false;
    const res = await post({ url: 'https://example.com', method: 'browser' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('UNSUPPORTED_METHOD');

    // 缺省 method 即 browser
    const dflt = await post({ url: 'https://example.com' });
    expect((await dflt.json()).error.code).toBe('UNSUPPORTED_METHOD');
  });

  it('抓取阶段才发现浏览器不可用（TargetFetchError 501）：同样 400 UNSUPPORTED_METHOD', async () => {
    state.browserInstalled = true;
    const res = await post({ url: 'https://example.com', method: 'browser' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('UNSUPPORTED_METHOD');
    expect(body.error.message).toContain('Playwright');
  });
});
