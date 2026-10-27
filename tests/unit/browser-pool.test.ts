/**
 * BrowserPool 关闭期间的在途启动、BrowserFetcher 主文档 Content-Type 检查
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserFetcherConfig } from '../../src/config/config-schema.js';

interface FakeBrowser {
  close: ReturnType<typeof vi.fn>;
  newContext: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  isConnected: () => boolean;
}

const launchState = vi.hoisted(() => ({
  resolveLaunch: undefined as undefined | ((b: unknown) => void),
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: () => new Promise(resolve => { launchState.resolveLaunch = resolve; }),
  },
}));

const { BrowserPool } = await import('../../src/fetcher/browser-pool.js');
const { BrowserFetcher } = await import('../../src/fetcher/browser-fetcher.js');
const { UnsupportedContentTypeError } = await import('../../src/fetcher/content-type.js');

const config = {
  maxPages: 2, headless: true, browserType: 'chromium', pageTimeout: 5000, waitUntil: 'domcontentloaded',
} as unknown as BrowserFetcherConfig;

function fakeBrowser(): FakeBrowser {
  return {
    close: vi.fn(async () => undefined),
    newContext: vi.fn(async () => ({
      addInitScript: async () => undefined,
      newPage: async () => ({ close: async () => undefined }),
      close: async () => undefined,
    })),
    on: vi.fn(),
    isConnected: () => true,
  };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('BrowserPool.close 与在途启动', () => {
  beforeEach(() => { launchState.resolveLaunch = undefined; });

  it('close 等待在途 launch，启动完成后立即关闭新浏览器并让 acquire 失败', async () => {
    const pool = new BrowserPool(config);
    const acquiring = pool.acquire({ timeoutMs: 1000 }).catch(e => e as Error);
    // 等动态 import 完成、launch 被调用
    for (let i = 0; i < 20 && !launchState.resolveLaunch; i++) await tick();
    expect(launchState.resolveLaunch).toBeTypeOf('function');

    let closed = false;
    const closing = pool.close().then(() => { closed = true; });
    await tick();
    expect(closed).toBe(false); // 仍在等在途启动

    const browser = fakeBrowser();
    launchState.resolveLaunch!(browser);
    await closing;

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.newContext).not.toHaveBeenCalled();
    const err = await acquiring;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/已关闭/);
    // 关闭后不再持有浏览器引用
    expect((pool as unknown as { browser: unknown }).browser).toBeNull();
  });

  it('未关闭时正常启动并复用同一浏览器', async () => {
    const pool = new BrowserPool(config);
    const acquiring = pool.acquire();
    for (let i = 0; i < 20 && !launchState.resolveLaunch; i++) await tick();
    const browser = fakeBrowser();
    launchState.resolveLaunch!(browser);
    const pooled = await acquiring;
    expect(browser.newContext).toHaveBeenCalledTimes(1);
    await pool.release(pooled);
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

function fetcherWithResponse(response: { status(): number; headers(): Record<string, string>; body?(): Promise<Uint8Array> } | null) {
  const fetcher = new BrowserFetcher(config);
  const page = {
    close: vi.fn(async () => undefined),
    goto: vi.fn(async () => response),
    content: vi.fn(async () => '<html><head><title>T</title></head><body><p>hello world</p></body></html>'),
    url: () => 'https://a.test/',
    setExtraHTTPHeaders: async () => undefined,
    waitForSelector: async () => undefined,
    waitForTimeout: async () => undefined,
    title: async () => 'T',
  };
  const pool = {
    acquire: vi.fn(async () => ({ page, context: { close: async () => undefined } })),
    release: vi.fn(async () => undefined),
    close: async () => undefined,
  };
  (fetcher as unknown as { pool: unknown }).pool = pool;
  return { fetcher, page, pool };
}

describe('BrowserFetcher 主文档 Content-Type', () => {
  it.each(['application/pdf', 'image/png', 'application/octet-stream'])('拒绝 %s 并释放页面', async type => {
    const { fetcher, page, pool } = fetcherWithResponse({ status: () => 200, headers: () => ({ 'content-type': type }) });
    const err = await fetcher.fetch({ url: 'https://a.test/x' }).catch(e => e);
    expect(err).toBeInstanceOf(UnsupportedContentTypeError);
    expect((err as { code: string }).code).toBe('UNSUPPORTED_CONTENT_TYPE');
    expect(page.content).not.toHaveBeenCalled();
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it('未声明类型时按魔数识别二进制', async () => {
    const { fetcher } = fetcherWithResponse({
      status: () => 200,
      headers: () => ({}),
      body: async () => new TextEncoder().encode('%PDF-1.7 ...'),
    });
    await expect(fetcher.fetch({ url: 'https://a.test/x' })).rejects.toBeInstanceOf(UnsupportedContentTypeError);
  });

  it('HTML 正常提取，并回传声明的 Content-Type', async () => {
    const { fetcher } = fetcherWithResponse({ status: () => 200, headers: () => ({ 'content-type': 'text/html; charset=utf-8' }) });
    const r = await fetcher.fetch({ url: 'https://a.test/', format: 'text' });
    expect(r.content).toContain('hello world');
    expect(r.contentType).toBe('text/html; charset=utf-8');
    expect(r.statusCode).toBe(200);
  });
});
