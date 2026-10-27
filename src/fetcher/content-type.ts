/**
 * 抓取内容类型判定（http / browser 抓取器共用）
 *
 * fetch_page 只抓取文本类页面：图片、PDF、压缩包等二进制内容直接拒绝。
 * 该拒绝是确定性的（换抓取器重抓结果相同），fetch_page 据 code 判断不再降级重试。
 */

import { isTextualContentType } from './fetcher-interface.js';

/** 常见二进制文件魔数（PDF / ZIP / PNG / JPEG / GIF / GZIP） */
const BINARY_MAGIC: number[][] = [
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x50, 0x4b, 0x03, 0x04], // PK..
  [0x89, 0x50, 0x4e, 0x47], // .PNG
  [0xff, 0xd8, 0xff],       // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x1f, 0x8b],             // gzip
];

/** 未声明 Content-Type 时判断是否为二进制：魔数命中，或前 1KB 含 NUL 字节 */
export function looksBinary(body: Uint8Array): boolean {
  if (BINARY_MAGIC.some(sig => sig.every((b, i) => body[i] === b))) return true;
  // UTF-16 文本本身含大量 NUL，有 BOM 时不算二进制
  if ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff)) return false;
  const n = Math.min(body.length, 1024);
  for (let i = 0; i < n; i++) if (body[i] === 0) return true;
  return false;
}

/** 内容类型不受支持（非文本 / 疑似二进制） */
export class UnsupportedContentTypeError extends Error {
  readonly code = 'UNSUPPORTED_CONTENT_TYPE';

  constructor(readonly contentType: string | undefined) {
    super(`不支持的内容类型: ${contentType ?? '未声明（疑似二进制）'}（fetch_page 只抓取文本类页面）`);
    this.name = 'UnsupportedContentTypeError';
  }
}

/**
 * 校验响应是否可作为文本页面处理：声明了非文本类型，或未声明且 body 像二进制时抛错。
 * body 可省略（如浏览器拿不到原始字节时只按声明类型判断）。
 */
export function assertTextualResponse(contentType: string | undefined, body?: Uint8Array): void {
  if (!isTextualContentType(contentType) || (!contentType && body && looksBinary(body))) {
    throw new UnsupportedContentTypeError(contentType);
  }
}
