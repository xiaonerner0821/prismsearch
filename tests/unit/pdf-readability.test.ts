/**
 * PDF 文本提取（unpdf 可选依赖，用假模块注入）与 Readability 正文提取（含降级）
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  extractPdfText, formatPdfText, isPdfResponse, setUnpdfLoaderForTest, PdfExtractError, PDF_MAX_PAGES,
} from '../../src/fetcher/pdf-extractor.js';
import { UnsupportedContentTypeError } from '../../src/fetcher/content-type.js';
import { ContentExtractor, setReadabilityLoaderForTest } from '../../src/fetcher/content-extractor.js';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

function fakeUnpdf(numPages: number, opts: { title?: string; fail?: boolean } = {}) {
  let destroyed = false;
  const mod = {
    getDocumentProxy: async () => {
      if (opts.fail) throw new Error('bad xref');
      return {
        numPages,
        getPage: async (n: number) => ({
          getTextContent: async () => ({ items: [{ str: `page ${n} line`, hasEOL: true }, { str: 'more' }] }),
        }),
        getMetadata: async () => ({ info: { Title: opts.title } }),
        destroy: async () => { destroyed = true; },
      };
    },
  };
  return { mod, isDestroyed: () => destroyed };
}

afterEach(() => {
  setUnpdfLoaderForTest(undefined);
  setReadabilityLoaderForTest(undefined);
});

describe('PDF 提取', () => {
  it('isPdfResponse：按声明类型或 %PDF 魔数识别', () => {
    expect(isPdfResponse('application/pdf; charset=binary', new Uint8Array())).toBe(true);
    expect(isPdfResponse(undefined, PDF_BYTES)).toBe(true);
    expect(isPdfResponse('application/octet-stream', PDF_BYTES)).toBe(true);
    expect(isPdfResponse('text/html', PDF_BYTES)).toBe(false);
    expect(isPdfResponse(undefined, new Uint8Array([0x3c, 0x68]))).toBe(false);
  });

  it('逐页提取文本、读取标题，并释放文档', async () => {
    const fake = fakeUnpdf(2, { title: ' Report ' });
    setUnpdfLoaderForTest(async () => fake.mod);
    const pdf = await extractPdfText(PDF_BYTES);
    expect(pdf.pages).toEqual(['page 1 line\nmore', 'page 2 line\nmore']);
    expect(pdf.title).toBe('Report');
    expect(fake.isDestroyed()).toBe(true);
    expect(formatPdfText(pdf, 'markdown')).toMatch(/^## 第 1 页\n\npage 1 line/);
    expect(formatPdfText(pdf, 'text')).toBe('page 1 line\nmore\n\npage 2 line\nmore');
  });

  it('超过页数上限只提取前若干页', async () => {
    setUnpdfLoaderForTest(async () => fakeUnpdf(PDF_MAX_PAGES + 5).mod);
    const pdf = await extractPdfText(PDF_BYTES);
    expect(pdf.pages).toHaveLength(PDF_MAX_PAGES);
    expect(pdf.totalPages).toBe(PDF_MAX_PAGES + 5);
  });

  it('被截断的 PDF 与解析失败报 PdfExtractError；未安装 unpdf 报不支持的内容类型', async () => {
    await expect(extractPdfText(PDF_BYTES, { truncated: true })).rejects.toBeInstanceOf(PdfExtractError);
    setUnpdfLoaderForTest(async () => fakeUnpdf(1, { fail: true }).mod);
    await expect(extractPdfText(PDF_BYTES)).rejects.toThrow(/PDF 解析失败/);
    setUnpdfLoaderForTest(async () => undefined);
    await expect(extractPdfText(PDF_BYTES)).rejects.toBeInstanceOf(UnsupportedContentTypeError);
  });
});

describe('Readability 正文提取', () => {
  const body = 'Readable paragraph with enough words to count as real article content. '.repeat(10);
  const html = `<html><head><title>Page Title</title></head><body>
    <nav><a href="/x">Home</a> <a href="/y">About</a></nav>
    <div class="wrapper"><div class="story"><h1>Headline</h1><p>${body}</p><p>${body}</p>
    <p><a href="/rel">relative link</a></p></div></div>
    <footer>Copyright footer</footer></body></html>`;

  it('依赖可用时提取正文、去掉导航页脚，并改写相对链接', async () => {
    const r = await ContentExtractor.extractReadable(html, { format: 'markdown', baseUrl: 'https://site.test/a/b', contentType: 'text/html' });
    expect(r.extractor).toBe('readability');
    expect(r.title).toBe('Page Title');
    expect(r.content).toContain('Readable paragraph');
    expect(r.content).not.toContain('Copyright footer');
    expect(r.content).toContain('https://site.test/rel');
  });

  it('text 格式同样走 Readability', async () => {
    const r = await ContentExtractor.extractReadable(html, { format: 'text', contentType: 'text/html' });
    expect(r.extractor).toBe('readability');
    expect(r.content).toContain('Readable paragraph');
  });

  it('正文过短、html 格式、非 HTML 文本、依赖缺失时退回启发式', async () => {
    const short = '<html><head><title>T</title></head><body><p>tiny</p></body></html>';
    expect((await ContentExtractor.extractReadable(short, { format: 'markdown', contentType: 'text/html' })).extractor).toBe('heuristic');
    expect((await ContentExtractor.extractReadable(html, { format: 'html', contentType: 'text/html' })).content).toBe(html);
    expect((await ContentExtractor.extractReadable('{"a":1}', { format: 'markdown', contentType: 'application/json' })).extractor).toBe('heuristic');
    setReadabilityLoaderForTest(async () => undefined);
    const r = await ContentExtractor.extractReadable(html, { format: 'markdown', contentType: 'text/html' });
    expect(r.extractor).toBe('heuristic');
    expect(r.content).toContain('Readable paragraph');
  });

  it('Readability 抛错时退回启发式', async () => {
    setReadabilityLoaderForTest(async () => ({
      parseHTML: () => ({ document: {} }),
      Readability: class { parse(): never { throw new Error('boom'); } },
    }));
    expect((await ContentExtractor.extractReadable(html, { format: 'markdown', contentType: 'text/html' })).extractor).toBe('heuristic');
  });
});
