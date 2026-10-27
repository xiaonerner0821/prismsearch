/**
 * PDF 文本提取（http 抓取器用）
 *
 * - 依赖可选包 unpdf（内置 pdf.js 的无 DOM 构建），按需动态加载；未安装时报「不支持的内容类型」并提示安装
 * - 只提取前 PDF_MAX_PAGES 页的文本层，扫描件（无文本层）提取结果为空时给出说明
 * - 响应体被 maxBytes 截断的 PDF 无法解析（xref 表在文件末尾），直接报错而不是返回乱码
 */

import { UnsupportedContentTypeError } from './content-type.js';

/** 最多提取的页数：再多基本超出模型一次能读的量，还会拖慢响应 */
export const PDF_MAX_PAGES = 50;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

/** 是否为 PDF：声明了 application/pdf，或未声明 / 声明为通用二进制且以 %PDF 开头 */
export function isPdfResponse(contentType: string | undefined, body: Uint8Array): boolean {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (mime === 'application/pdf' || mime === 'application/x-pdf') return true;
  if (mime && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream') return false;
  return PDF_MAGIC.every((b, i) => body[i] === b);
}

export class PdfExtractError extends Error {
  readonly code = 'UNSUPPORTED_CONTENT_TYPE';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfExtractError';
  }
}

export interface PdfText {
  /** 各页文本（只含已提取的页） */
  pages: string[];
  totalPages: number;
  title?: string;
}

interface PdfTextItem { str?: string; hasEOL?: boolean }
interface PdfPage { getTextContent(): Promise<{ items: PdfTextItem[] }> }
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  getMetadata?(): Promise<{ info?: { Title?: unknown } }>;
  destroy?(): Promise<void>;
}
interface UnpdfModule { getDocumentProxy(data: Uint8Array): Promise<PdfDocument> }

let unpdfLoader: Promise<UnpdfModule | undefined> | undefined;

/** 动态加载 unpdf；未安装返回 undefined（测试可通过 setUnpdfLoaderForTest 注入） */
function loadUnpdf(): Promise<UnpdfModule | undefined> {
  unpdfLoader ??= import('unpdf').then(m => m as unknown as UnpdfModule, () => undefined);
  return unpdfLoader;
}

/** 仅测试用：替换 unpdf 加载器，传 undefined 恢复默认 */
export function setUnpdfLoaderForTest(loader: (() => Promise<UnpdfModule | undefined>) | undefined): void {
  unpdfLoader = loader ? loader() : undefined;
}

export async function extractPdfText(body: Uint8Array, options: { truncated?: boolean; maxPages?: number } = {}): Promise<PdfText> {
  if (options.truncated) {
    throw new PdfExtractError('PDF 超过响应体大小上限（fetcher.maxBytes），被截断的 PDF 无法解析');
  }
  const unpdf = await loadUnpdf();
  if (!unpdf) {
    throw new UnsupportedContentTypeError('application/pdf（需要安装可选依赖 unpdf 才能提取 PDF 文本）');
  }

  let doc: PdfDocument;
  try {
    // pdf.js 会转移 / 改写传入的 buffer，复制一份避免影响调用方
    doc = await unpdf.getDocumentProxy(new Uint8Array(body));
  } catch (error) {
    throw new PdfExtractError(`PDF 解析失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  try {
    const limit = Math.min(doc.numPages, options.maxPages ?? PDF_MAX_PAGES);
    const pages: string[] = [];
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i);
      const { items } = await page.getTextContent();
      let text = '';
      for (const item of items) {
        if (typeof item.str === 'string') text += item.str;
        if (item.hasEOL) text += '\n';
      }
      pages.push(text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
    }
    let title: string | undefined;
    try {
      const meta = await doc.getMetadata?.();
      const raw = meta?.info?.Title;
      if (typeof raw === 'string' && raw.trim()) title = raw.trim();
    } catch {
      // 元数据损坏不影响正文
    }
    return { pages, totalPages: doc.numPages, title };
  } finally {
    await doc.destroy?.().catch(() => undefined);
  }
}

/** 把提取结果排成正文：markdown 用分页标题，text / html 用空行分隔 */
export function formatPdfText(pdf: PdfText, format: 'html' | 'text' | 'markdown'): string {
  const parts = pdf.pages.map((text, i) => (format === 'markdown' ? `## 第 ${i + 1} 页\n\n${text}` : text));
  return parts.join('\n\n').trim();
}
