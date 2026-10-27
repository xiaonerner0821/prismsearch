/**
 * HttpFetcher 的 PDF 分支：识别 PDF、提取文本、页数上限 / 扫描件 warning、截断报错
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const httpRequest = vi.fn();
vi.mock('../../src/utils/http-client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/utils/http-client.js')>()),
  httpRequest: (...args: unknown[]) => httpRequest(...args),
}));

const { HttpFetcher } = await import('../../src/fetcher/http-fetcher.js');
const { setUnpdfLoaderForTest, PdfExtractError } = await import('../../src/fetcher/pdf-extractor.js');

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

function pdfResponse(contentType: string | undefined, truncated = false) {
  return {
    url: 'https://site.test/doc.pdf',
    status: 200,
    headers: new Headers(contentType ? { 'content-type': contentType } : {}),
    body: PDF_BYTES,
    truncated,
    text: () => '',
  };
}

function fakeUnpdf(numPages: number, pageText: string) {
  return {
    getDocumentProxy: async () => ({
      numPages,
      getPage: async () => ({ getTextContent: async () => ({ items: pageText ? [{ str: pageText }] : [] }) }),
      getMetadata: async () => ({ info: { Title: 'Doc' } }),
    }),
  };
}

afterEach(() => {
  httpRequest.mockReset();
  setUnpdfLoaderForTest(undefined);
});

describe('HttpFetcher PDF', () => {
  it('提取文本层并带标题与内容类型', async () => {
    httpRequest.mockResolvedValue(pdfResponse('application/pdf'));
    setUnpdfLoaderForTest(async () => fakeUnpdf(1, 'hello pdf'));
    const r = await new HttpFetcher().fetch({ url: 'https://site.test/doc.pdf', format: 'markdown' });
    expect(r.content).toBe('## 第 1 页\n\nhello pdf');
    expect(r.title).toBe('Doc');
    expect(r.contentType).toBe('application/pdf');
    expect(r.warnings).toBeUndefined();
  });

  it('未声明类型时按魔数识别；超过页数上限给出 warning', async () => {
    httpRequest.mockResolvedValue(pdfResponse(undefined));
    setUnpdfLoaderForTest(async () => fakeUnpdf(60, 'x'));
    const r = await new HttpFetcher().fetch({ url: 'https://site.test/doc.pdf', format: 'text' });
    expect(r.warnings?.join()).toMatch(/共 60 页/);
  });

  it('没有文本层时给出扫描件 warning', async () => {
    httpRequest.mockResolvedValue(pdfResponse('application/pdf'));
    setUnpdfLoaderForTest(async () => fakeUnpdf(1, ''));
    const r = await new HttpFetcher().fetch({ url: 'https://site.test/doc.pdf', format: 'text' });
    expect(r.content).toBe('');
    expect(r.warnings?.join()).toMatch(/扫描件/);
  });

  it('响应体被截断的 PDF 报错', async () => {
    httpRequest.mockResolvedValue(pdfResponse('application/pdf', true));
    await expect(new HttpFetcher().fetch({ url: 'https://site.test/doc.pdf' })).rejects.toBeInstanceOf(PdfExtractError);
  });
});
