/**
 * http-client 基础行为：超大响应截断 / 超限抛错、取消语义、手动重定向的 Cookie 传递、
 * 代理故障分类
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpRequest, HttpError, configureHttpDefaults } from '../../src/utils/http-client.js';
import type { ProxyPool } from '../../src/utils/proxy-pool.js';

// 有 dispatcher（代理 / SSRF Agent）时 http-client 走 undici 的 fetch，这里一并打桩
const undiciFetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async importOriginal => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: undiciFetchMock,
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  undiciFetchMock.mockReset();
  configureHttpDefaults({ proxyPool: undefined, userAgent: undefined });
});

function bigBody(bytes: number): Response {
  return new Response(new Uint8Array(bytes).fill(0x61), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

describe('响应体大小限制', () => {
  it('truncate 模式截断并标记，throw 模式抛 TOO_LARGE', async () => {
    globalThis.fetch = vi.fn(async () => bigBody(200)) as unknown as typeof fetch;
    const truncated = await httpRequest('https://a.test/', { maxBytes: 50, onTooLarge: 'truncate' });
    expect(truncated.body.byteLength).toBe(50);
    expect(truncated.truncated).toBe(true);

    await expect(httpRequest('https://a.test/', { maxBytes: 50 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('content-length 声明的尺寸超限时提前失败', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('x', { headers: { 'content-length': '9999', 'content-type': 'text/html' } }),
    ) as unknown as typeof fetch;
    await expect(httpRequest('https://a.test/', { maxBytes: 10 })).rejects.toBeInstanceOf(HttpError);
  });
});

describe('取消与超时', () => {
  it('调用前已取消立即抛 ABORTED，不等超时', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(httpRequest('https://a.test/', { signal: ac.signal, timeoutMs: 60_000 }))
      .rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('请求中取消：错误码为 ABORTED 而不是 TIMEOUT', async () => {
    const ac = new AbortController();
    globalThis.fetch = vi.fn((_url: unknown, init: unknown) => new Promise((_, reject) => {
      (init as RequestInit).signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      setTimeout(() => ac.abort(), 5);
    })) as unknown as typeof fetch;
    await expect(httpRequest('https://a.test/', { signal: ac.signal, timeoutMs: 60_000 }))
      .rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('超时归为 TIMEOUT', async () => {
    globalThis.fetch = vi.fn((_url: unknown, init: unknown) => new Promise((_, reject) => {
      (init as RequestInit).signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
      });
    })) as unknown as typeof fetch;
    await expect(httpRequest('https://a.test/', { timeoutMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('手动重定向', () => {
  it('每跳都校验 URL，并带上上一跳种下的 Cookie', async () => {
    const calls: Array<{ url: string; cookie?: string }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
      const headers = new Headers((init as RequestInit).headers as HeadersInit);
      calls.push({ url: String(url), cookie: headers.get('cookie') ?? undefined });
      if (String(url) === 'https://a.test/start') {
        return new Response(null, {
          status: 302,
          headers: { location: '/next', 'set-cookie': 'sid=abc; Path=/' },
        });
      }
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch;

    const validated: string[] = [];
    const res = await httpRequest('https://a.test/start', {
      redirect: 'manual-checked',
      validateUrl: url => { validated.push(url); },
      headers: { Cookie: 'user=1' },
    });
    expect(res.url).toBe('https://a.test/next');
    expect(res.text()).toBe('ok');
    expect(validated).toEqual(['https://a.test/start', 'https://a.test/next']);
    expect(calls[1].cookie).toBe('user=1; sid=abc');
  });

  it('超过重定向上限抛 TOO_MANY_REDIRECTS；被校验拦截抛 BLOCKED', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: '/loop' } }),
    ) as unknown as typeof fetch;
    await expect(httpRequest('https://a.test/', { redirect: 'manual-checked', maxRedirects: 2 }))
      .rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });

    await expect(httpRequest('https://a.test/', {
      redirect: 'manual-checked',
      validateUrl: () => { throw new Error('内网地址'); },
    })).rejects.toMatchObject({ code: 'BLOCKED' });
  });
});

describe('代理池故障分类', () => {
  function fakePool() {
    const reportSuccess = vi.fn();
    const reportFailure = vi.fn();
    return {
      pool: {
        acquire: () => ({ proxy: 'http://proxy.test:8080', dispatcher: {} }),
        reportSuccess,
        reportFailure,
      } as unknown as ProxyPool,
      reportSuccess,
      reportFailure,
    };
  }

  it('网络错误与超时上报代理失败；HTTP 状态错误与取消不上报', async () => {
    const { pool, reportFailure, reportSuccess } = fakePool();
    configureHttpDefaults({ proxyPool: pool });

    undiciFetchMock.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
    await expect(httpRequest('https://a.test/')).rejects.toMatchObject({ code: 'NETWORK' });
    expect(reportFailure).toHaveBeenCalledWith('http://proxy.test:8080');

    reportFailure.mockClear();
    undiciFetchMock.mockImplementation(async () => new Response('nope', { status: 500 }));
    await expect(httpRequest('https://a.test/')).rejects.toMatchObject({ code: 'HTTP' });
    // 5xx 说明代理链路本身是通的，记成功不记失败
    expect(reportFailure).not.toHaveBeenCalled();
    expect(reportSuccess).toHaveBeenCalledWith('http://proxy.test:8080');

    reportFailure.mockClear();
    reportSuccess.mockClear();
    const ac = new AbortController();
    ac.abort();
    await expect(httpRequest('https://a.test/', { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(reportFailure).not.toHaveBeenCalled();
    expect(reportSuccess).not.toHaveBeenCalled();
  });

  it('成功响应上报代理成功', async () => {
    const { pool, reportSuccess } = fakePool();
    configureHttpDefaults({ proxyPool: pool });
    undiciFetchMock.mockImplementation(async () => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
    await httpRequest('https://a.test/');
    expect(reportSuccess).toHaveBeenCalledWith('http://proxy.test:8080');
  });
});
