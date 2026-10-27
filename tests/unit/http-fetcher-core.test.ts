import { beforeEach, describe, expect, it, vi } from 'vitest';
const { request, extract } = vi.hoisted(() => ({ request: vi.fn(), extract: vi.fn() }));
vi.mock('../../src/utils/http-client.js', async original => ({ ...(await original<typeof import('../../src/utils/http-client.js')>()), httpRequest: request }));
vi.mock('../../src/fetcher/content-extractor.js', () => ({ ContentExtractor: { extractReadable: extract } }));
import { HttpFetcher } from '../../src/fetcher/http-fetcher.js';
import { HttpError } from '../../src/utils/http-client.js';

beforeEach(() => {
  vi.clearAllMocks();
  request.mockResolvedValue({ url: 'https://final.test/', status: 404, headers: new Headers({ 'content-type': 'text/html' }), body: new TextEncoder().encode('<p>正文</p>'), text: () => '<p>正文</p>', truncated: true });
  extract.mockResolvedValue({ content: '正文', title: '标题' });
});
describe('HttpFetcher 文本及错误路径', () => {
  it('透传限制、取消信号和 dispatcher，并禁用代理与校验重定向', async () => {
    const signal = new AbortController().signal;
    const validateUrl = vi.fn();
    const dispatcher = {} as never;
    const result = await new HttpFetcher({ timeoutMs: 123, maxBytes: 456 }).fetch({ url: 'https://test/', signal, validateUrl, dispatcher, userAgent: 'Test', headers: { Accept: 'text/plain' }, includeRawHtml: true });
    expect(request).toHaveBeenCalledWith('https://test/', expect.objectContaining({ timeoutMs: 123, maxBytes: 456, signal, dispatcher, useProxy: false, redirect: 'manual-checked', validateUrl, headers: { Accept: 'text/plain', 'User-Agent': 'Test' }, throwOnHttpError: false, onTooLarge: 'truncate' }));
    expect(result).toMatchObject({ url: 'https://final.test/', statusCode: 404, content: '正文', rawHtml: '<p>正文</p>', truncated: true, fetchedBy: 'http' });
  });
  it('默认和显式格式控制 rawHtml，调用参数覆盖构造默认', async () => {
    const fetcher = new HttpFetcher();
    expect((await fetcher.fetch({ url: 'https://test/' })).rawHtml).toBeUndefined();
    expect((await fetcher.fetch({ url: 'https://test/', format: 'html', timeout: 9, maxBytes: 10 })).rawHtml).toBe('<p>正文</p>');
    expect(request).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ timeoutMs: 9, maxBytes: 10, redirect: 'follow', useProxy: true }));
  });
  it('超时和其他错误保留 cause 并提供稳定提示', async () => {
    request.mockRejectedValueOnce(new HttpError('timeout', undefined, 'TIMEOUT'));
    await expect(new HttpFetcher().fetch({ url: 'https://test/', timeout: 5 })).rejects.toThrow('请求超时 (5ms)');
    for (const error of [new Error('offline'), 'offline']) {
      request.mockRejectedValueOnce(error);
      await expect(new HttpFetcher().fetch({ url: 'https://test/' })).rejects.toMatchObject({ message: '抓取失败: https://test/ - offline', cause: error });
    }
  });
  it('二进制响应拒绝进入正文提取', async () => {
    request.mockResolvedValueOnce({ headers: new Headers({ 'content-type': 'image/png' }), body: new Uint8Array([0]) });
    await expect(new HttpFetcher().fetch({ url: 'https://test/' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE' });
    expect(extract).not.toHaveBeenCalled();
  });
});
