/**
 * WorkerClient 单元测试：负载均衡、故障转移、错误分类、健康检查
 * 全部通过注入 fetchImpl 完成，不起真实 Worker。
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkerClient, WorkerRequestError } from '../../src/workers/worker-client.js';
import type { WorkersConfig } from '../../src/config/config-schema.js';

type Endpoint = { name: string; url: string; token?: string; allowInsecureHttp?: boolean; weight?: number; maxConcurrency?: number };

function makeConfig(endpoints: Endpoint[], overrides: Record<string, unknown> = {}): WorkersConfig {
  return {
    enabled: true,
    strategy: 'round-robin',
    timeoutMs: 5000,
    healthCheckIntervalMs: 60_000,
    useFor: 'browser',
    fallbackToLocal: true,
    endpoints: endpoints.map(e => ({ weight: 1, maxConcurrency: 4, allowInsecureHttp: true, ...e })),
    allowedOrigins: [...new Set(endpoints.map(e => new URL(e.url).origin))],
    ...overrides,  } as unknown as WorkersConfig;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const OK_BODY = { url: 'https://example.com/', content: '# hi', statusCode: 200, title: 'Hi' };

/** 按 Worker 名称路由的 fetch 桩 */
function routedFetch(handlers: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (url.startsWith(prefix)) return handler(url, init);
    }
    throw new Error(`unexpected url ${url}`);
  });
}

const A = 'http://127.0.0.1:8787/';
const B = 'http://localhost:8788/';

describe('WorkerClient 安全边界', () => {
  const remote = 'https://worker.example:8443/base';
  const opts = { env: {}, disableHealthTimer: true };

  it('非回环必须精确匹配 allowedOrigins，并且必须有 token', () => {
    const config = makeConfig([{ name: 'remote', url: remote, token: 'tk' }], { allowedOrigins: [] });
    expect(() => new WorkerClient(config, opts)).toThrow(/allowedOrigins/);
    expect(() => new WorkerClient(makeConfig([{ name: 'remote', url: remote }]), opts)).toThrow(/token/);
    expect(() => new WorkerClient(makeConfig([{ name: 'remote', url: remote, token: 'tk' }], {
      allowedOrigins: ['https://worker.example:8443.evil'],
    }), opts)).toThrow(/allowedOrigins/);
  });

  it('非回环 HTTP 必须逐端点显式允许，允许后仍要求 token', () => {
    const endpoint = { name: 'remote', url: 'http://worker.example:8787', token: 'tk', allowInsecureHttp: false };
    expect(() => new WorkerClient(makeConfig([endpoint]), opts)).toThrow(/HTTPS/);
    expect(() => new WorkerClient(makeConfig([{ ...endpoint, allowInsecureHttp: true }]), opts)).not.toThrow();
  });

  it.each(['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])('回环开发无需 token/allowlist：%s', url => {
    expect(() => new WorkerClient(makeConfig([{ name: 'local', url, allowInsecureHttp: false }], { allowedOrigins: [] }), opts)).not.toThrow();
  });

  it.each(['file:///etc/passwd', 'https://u:p@worker.example', 'https://worker.example?q=x', 'https://worker.example#x'])('拒绝不安全 endpoint：%s', url => {
    expect(() => new WorkerClient(makeConfig([{ name: 'bad', url, token: 'tk' }]), opts)).toThrow();
  });

  it('配置验证后复制端点，且健康检查与抓取都禁止重定向', async () => {
    const fetchImpl = vi.fn(async () => json(200, { ...OK_BODY, status: 'ok', capabilities: ['http'] }));
    const config = makeConfig([{ name: 'remote', url: remote, token: 'tk' }]);
    const client = new WorkerClient(config, { ...opts, fetchImpl: fetchImpl as unknown as typeof fetch });
    config.endpoints[0].url = 'http://169.254.169.254/';
    await client.checkAll();
    await client.fetch({ url: 'https://example.com/', method: 'http' } as never);
    for (const [url, init] of fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toMatch(/^https:\/\/worker\.example:8443\/base\//);
      expect(init.redirect).toBe('error');
    }
  });
});

describe('WorkerClient 请求', () => {
  it('成功时返回结果，并带上 Bearer token 与协议字段', async () => {
    const fetchImpl = routedFetch({ [A]: () => json(200, OK_BODY) });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A, token: 'tk' }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });

    const result = await client.fetch({ url: 'https://example.com/', method: 'browser' } as never);
    expect(result).toMatchObject({ url: 'https://example.com/', content: '# hi', statusCode: 200, fetchedBy: 'worker:a' });

    const [calledUrl, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${A}v1/fetch`);
    expect(init.redirect).toBe('error');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tk');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ url: 'https://example.com/', method: 'browser', format: 'markdown' });
  });

  it('未配置端点 token 时回落到环境变量 PRISMSEARCH_WORKER_TOKEN', async () => {
    const fetchImpl = routedFetch({ [A]: () => json(200, OK_BODY) });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: { PRISMSEARCH_WORKER_TOKEN: 'from-env' },
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });
    await client.fetch({ url: 'https://example.com/' } as never);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer from-env');
  });

  it('网络错误：标记不健康并故障转移到下一个 Worker', async () => {
    const fetchImpl = routedFetch({
      [A]: () => {
        throw new TypeError('connect ECONNREFUSED');
      },
      [B]: () => json(200, OK_BODY),
    });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }, { name: 'b', url: B }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });

    // 轮询起点可能是 a 或 b，跑两次保证 a 至少被选中一次
    await client.fetch({ url: 'https://example.com/' } as never);
    await client.fetch({ url: 'https://example.com/' } as never);

    const a = client.status().find(s => s.name === 'a')!;
    expect(a.healthy).toBe(false);
    expect(a.lastError).toContain('ECONNREFUSED');
  });

  it('SSRF_BLOCKED（403）不重试，也不把 Worker 标记为不健康', async () => {
    const fetchImpl = routedFetch({
      [A]: () => json(403, { error: { code: 'SSRF_BLOCKED', message: '目标地址指向内网' } }),
      [B]: () => json(403, { error: { code: 'SSRF_BLOCKED', message: '目标地址指向内网' } }),
    });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }, { name: 'b', url: B }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });

    const error = await client.fetch({ url: 'http://10.0.0.1/' } as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerRequestError);
    expect((error as WorkerRequestError).retryable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.status().every(s => s.healthy)).toBe(true);
  });

  it('401 鉴权失败：标记不健康并换下一个 Worker', async () => {
    const fetchImpl = routedFetch({
      [A]: () => json(401, { error: { code: 'UNAUTHORIZED', message: 'bad token' } }),
      [B]: () => json(401, { error: { code: 'UNAUTHORIZED', message: 'bad token' } }),
    });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }, { name: 'b', url: B }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });

    await expect(client.fetch({ url: 'https://example.com/' } as never)).rejects.toThrow(/鉴权失败/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.status().every(s => !s.healthy)).toBe(true);
  });

  it('FETCH_FAILED（502）换 Worker 重试，但不标记 Worker 不健康', async () => {
    const fetchImpl = routedFetch({
      [A]: () => json(502, { error: { code: 'FETCH_FAILED', message: '目标站超时' } }),
      [B]: () => json(502, { error: { code: 'FETCH_FAILED', message: '目标站超时' } }),
    });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }, { name: 'b', url: B }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });

    await expect(client.fetch({ url: 'https://example.com/' } as never)).rejects.toThrow(/目标站超时/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.status().every(s => s.healthy)).toBe(true);
  });

  it('500 INTERNAL 标记不健康', async () => {
    const fetchImpl = routedFetch({ [A]: () => json(500, { error: { code: 'INTERNAL', message: 'crash' } }) });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });
    await expect(client.fetch({ url: 'https://example.com/' } as never)).rejects.toThrow(/crash/);
    expect(client.hasHealthyWorker()).toBe(false);
  });

  it('400 BAD_REQUEST 不重试', async () => {
    const fetchImpl = routedFetch({
      [A]: () => json(400, { error: { code: 'BAD_REQUEST', message: '缺少 url' } }),
      [B]: () => json(200, OK_BODY),
    });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }, { name: 'b', url: B }], { strategy: 'least-busy' }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });
    // least-busy 在负载相同时从第一个开始比较，确保先打到 a
    const error = await client.fetch({ url: 'https://example.com/' } as never).catch((e: unknown) => e);
    if (error) {
      expect((error as WorkerRequestError).retryable).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('返回体缺少必需字段视为无效响应', async () => {
    const fetchImpl = routedFetch({ [A]: () => json(200, { content: 'x' }) });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });
    await expect(client.fetch({ url: 'https://example.com/' } as never)).rejects.toThrow(/返回格式无效/);
  });

  it('Worker 跟随重定向后，主进程会再校验最终 URL', async () => {
    const fetchImpl = routedFetch({ [A]: () => json(200, { ...OK_BODY, url: 'http://169.254.169.254/' }) });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });
    const validateUrl = vi.fn(async (u: string) => {
      if (u.includes('169.254')) throw new Error('SSRF: 禁止访问元数据地址');
    });
    await expect(
      client.fetch({ url: 'https://example.com/', validateUrl } as never),
    ).rejects.toThrow(/元数据/);
    expect(validateUrl).toHaveBeenCalledWith('http://169.254.169.254/');
  });

  it('关闭后拒绝新请求', async () => {
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }]), {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });
    await client.close();
    await expect(client.fetch({ url: 'https://example.com/' } as never)).rejects.toThrow(/已关闭/);
  });
});

describe('WorkerClient 负载均衡', () => {
  it('平滑加权轮询按权重分配', () => {
    const client = new WorkerClient(
      makeConfig([
        { name: 'a', url: A, weight: 3 },
        { name: 'b', url: B, weight: 1 },
      ]),
      { fetchImpl: vi.fn() as unknown as typeof fetch, disableHealthTimer: true, initialCapabilities: ['http', 'browser'] },
    );
    const picks = Array.from({ length: 8 }, () => client.pick('browser')!.endpoint.name);
    expect(picks.filter(n => n === 'a')).toHaveLength(6);
    expect(picks.filter(n => n === 'b')).toHaveLength(2);
    // 平滑：不会出现连续 4 次都是 a
    expect(picks.join('')).not.toContain('aaaa');
  });

  it('least-busy 选择在途请求/权重最小的 Worker', async () => {
    let releaseA!: () => void;
    const fetchImpl = routedFetch({
      [A]: () => new Promise<Response>(resolve => {
        releaseA = () => resolve(json(200, OK_BODY));
      }),
      [B]: () => json(200, OK_BODY),
    });
    const client = new WorkerClient(
      makeConfig([{ name: 'a', url: A }, { name: 'b', url: B }], { strategy: 'least-busy' }),
      { fetchImpl: fetchImpl as unknown as typeof fetch, disableHealthTimer: true, initialCapabilities: ['http', 'browser'] },
    );

    // 让 a 占着一个在途请求
    const first = client.pick('browser')!;
    const pending = client.fetch({ url: 'https://example.com/' } as never);
    await Promise.resolve();
    const busy = client.status().find(s => s.inFlight > 0);
    if (busy) {
      const next = client.pick('browser')!;
      expect(next.endpoint.name).not.toBe(busy.name);
    }
    expect(first).toBeDefined();
    releaseA?.();
    await pending.catch(() => undefined);
  });

  it('达到 maxConcurrency 的 Worker 不会被选中', () => {
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A, maxConcurrency: 1 }]), {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });
    const worker = client.pick('browser')!;
    (worker as unknown as { inFlight: number }).inFlight = 1;
    expect(client.pick('browser')).toBeUndefined();
  });

  it('没有 Worker 支持该方法时报错', async () => {
    const fetchImpl = routedFetch({ [A]: () => json(200, { status: 'ok', capabilities: ['http'] }) });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });
    await client.checkAll();
    expect(client.supports('browser')).toBe(false);
    expect(client.supports('http')).toBe(true);
    await expect(client.fetch({ url: 'https://example.com/', method: 'browser' } as never)).rejects.toThrow(/没有可用的 Worker/);
  });

  it('首次健康检查前默认只有 http 能力，不会盲目派发浏览器任务', async () => {
    const fetchImpl = routedFetch({ [A]: () => json(200, OK_BODY) });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
    });

    expect(client.status()[0].capabilities).toEqual(['http']);
    expect(client.supports('browser')).toBe(false);
    await expect(client.fetch({ url: 'https://example.com/', method: 'browser' } as never))
      .rejects.toThrow(/没有可用的 Worker/);
  });

  it('/health 报告 browser 能力后才允许派发浏览器任务', async () => {
    const fetchImpl = routedFetch({
      [`${A}health`]: () => json(200, { status: 'ok', capabilities: ['http', 'browser'] }),
      [`${A}v1/fetch`]: () => json(200, OK_BODY),
    });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
    });

    await client.checkAll();
    const result = await client.fetch({ url: 'https://example.com/', method: 'browser' } as never);
    expect(result).toMatchObject({ fetchedBy: 'worker:a' });
  });

  it('UNSUPPORTED_METHOD 收窄该 Worker 的能力，并可换 Worker 重试', async () => {
    const fetchImpl = routedFetch({
      [`${A}health`]: () => json(200, { status: 'ok', capabilities: ['http', 'browser'] }),
      [`${B}health`]: () => json(200, { status: 'ok', capabilities: ['http', 'browser'] }),
      [`${A}v1/fetch`]: () => json(400, { error: { code: 'UNSUPPORTED_METHOD', message: '浏览器抓取未启用' } }),
      [`${B}v1/fetch`]: () => json(200, OK_BODY),
    });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }, { name: 'b', url: B }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
    });
    await client.checkAll();

    const result = await client.fetch({ url: 'https://example.com/', method: 'browser' } as never);
    expect(result).toMatchObject({ fetchedBy: 'worker:b' });
    const a = client.status().find(s => s.name === 'a')!;
    expect(a.capabilities).not.toContain('browser');
  });

  it('响应体超过上限时报错，不会无限读入内存', async () => {
    const huge = { ...OK_BODY, content: 'x'.repeat(200_000) };
    const fetchImpl = routedFetch({ [A]: () => json(200, huge) });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
      maxResponseBytes: 1024,
    });
    await expect(client.fetch({ url: 'https://example.com/' } as never)).rejects.toThrow(/过大|上限/);
  });
});

describe('WorkerClient 健康检查', () => {
  it('health 非 ok 时标记不健康，恢复后自动重新可用', async () => {
    let healthy = false;
    const fetchImpl = routedFetch({
      [A]: () => (healthy ? json(200, { status: 'ok', capabilities: ['http', 'browser'] }) : json(503, { status: 'down' })),
    });
    const client = new WorkerClient(makeConfig([{ name: 'a', url: A }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });

    await client.checkAll();
    expect(client.hasHealthyWorker()).toBe(false);
    expect(client.status()[0].lastError).toContain('503');

    healthy = true;
    await client.checkAll();
    expect(client.hasHealthyWorker()).toBe(true);
    expect(client.status()[0].lastError).toBeUndefined();
    expect(fetchImpl.mock.calls[0][0]).toBe(`${A}health`);
  });

  it('端点 URL 不带结尾斜杠时也能正确拼接路径', async () => {
    const fetchImpl = vi.fn(async () => json(200, { status: 'ok', capabilities: ['http'] }));
    const client = new WorkerClient(makeConfig([{ name: 'a', url: 'http://localhost:8787/prefix' }]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableHealthTimer: true,
      initialCapabilities: ['http', 'browser'],
    });
    await client.checkAll();
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe('http://localhost:8787/prefix/health');
  });
});
