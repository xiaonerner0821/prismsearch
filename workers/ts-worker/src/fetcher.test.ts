import { describe, it, expect } from 'vitest';
import { sniffCharset, decodeBody, readLimited, hasBrowserCapability, detectBrowserCapability } from './fetcher.js';

/** 与主进程 http-client 行为一致的字符集嗅探 */
describe('sniffCharset', () => {
  it('BOM 优先', () => {
    expect(sniffCharset(Buffer.from([0xef, 0xbb, 0xbf, 0x41]), 'text/html; charset=gbk')).toBe('utf-8');
    expect(sniffCharset(Buffer.from([0xff, 0xfe, 0x41, 0x00]), '')).toBe('utf-16le');
    expect(sniffCharset(Buffer.from([0xfe, 0xff, 0x00, 0x41]), '')).toBe('utf-16be');
  });

  it('GBK / GB2312 映射为 gb18030 超集', () => {
    expect(sniffCharset(Buffer.from('a'), 'text/html; charset=GB2312')).toBe('gb18030');
    expect(sniffCharset(Buffer.from('a'), 'text/html; charset="gbk"')).toBe('gb18030');
    expect(sniffCharset(Buffer.from('<meta charset="gb2312">'), '')).toBe('gb18030');
    expect(sniffCharset(Buffer.from('<?xml version="1.0" encoding="gbk"?>'), '')).toBe('gb18030');
  });

  it('Header 声明的未知字符集被忽略，回落到嗅探结果', () => {
    expect(sniffCharset(Buffer.from('中文'), 'text/html; charset=x-unknown-xyz')).toBe('utf-8');
  });

  it('无声明时中文 UTF-8 用 utf-8，非法 UTF-8 兜底 gb18030', () => {
    expect(sniffCharset(Buffer.from('中文'), '')).toBe('utf-8');
    // “中文”的 GBK 编码
    expect(sniffCharset(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), '')).toBe('gb18030');
  });

  it('decodeBody 按嗅探结果解码', () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeBody(gbk, 'text/html; charset=gbk')).toBe('中文');
  });
});

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

describe('readLimited 超限截断', () => {
  it('未超限时原样返回且不标记 truncated', async () => {
    const { body, truncated } = await readLimited({ body: streamOf([Buffer.from('abc'), Buffer.from('def')]) }, 6);
    expect(body.toString()).toBe('abcdef');
    expect(truncated).toBe(false);
  });

  it('超限时读到上限即停止并标记 truncated', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(Buffer.from('0123456789'));
      },
    });
    const { body, truncated } = await readLimited({ body: stream }, 25);
    expect(body.toString()).toBe('0123456789012345678901234');
    expect(truncated).toBe(true);
    // 无限流也会停下，不会一直读
    expect(pulled).toBeLessThan(10);
  });

  it('没有 body 时返回空', async () => {
    expect(await readLimited({ body: null }, 10)).toEqual({ body: Buffer.alloc(0), truncated: false });
  });

  it('截断在 UTF-8 多字节字符中间时丢弃半个字符，且不误判为 GB18030', () => {
    // “中文”共 6 字节，截到 4 字节：剩“中”+ 半个“文”
    const cut = Buffer.from('中文').subarray(0, 4);
    expect(sniffCharset(cut, '', true)).toBe('utf-8');
    expect(decodeBody(cut, '', true)).toBe('中');
    expect(decodeBody(cut, 'text/html; charset=utf-8', true)).toBe('中');
  });

  it('截断在 GBK 双字节字符中间时同样丢弃', () => {
    const cut = Buffer.from([0xd6, 0xd0, 0xce]); // “中” + 半个“文”
    expect(decodeBody(cut, 'text/html; charset=gbk', true)).toBe('中');
  });
});

describe('capability 上报', () => {
  it('探测结果是布尔值且幂等', async () => {
    const first = await detectBrowserCapability();
    expect(typeof first).toBe('boolean');
    expect(await detectBrowserCapability()).toBe(first);
    expect(hasBrowserCapability()).toBe(first);
  });
});
