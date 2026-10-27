/**
 * 内容提取器：广告识别按完整 token 匹配（不误删正文）、相对链接改写、表格转 GFM
 */

import { describe, it, expect } from 'vitest';
import { ContentExtractor } from '../../src/fetcher/content-extractor.js';

describe('ContentExtractor 去广告', () => {
  it('只删真正的广告节点，不误伤 head- / thread- / read-more 这类正文 class', () => {
    const html = `<html><body><main>
      <div class="head-line">标题行</div>
      <div class="thread-body">讨论正文</div>
      <div class="read-more">延伸阅读</div>
      <div class="ad-banner">广告</div>
      <div class="advert">广告 2</div>
      <div id="ads">广告 3</div>
      <ins class="adsbygoogle">广告 4</ins>
      <p>${'正文内容。'.repeat(40)}</p>
    </main></body></html>`;
    const md = ContentExtractor.toMarkdown(html);
    expect(md).toContain('标题行');
    expect(md).toContain('讨论正文');
    expect(md).toContain('延伸阅读');
    expect(md).not.toContain('广告');
  });

  it('正文容器不超过 100 字时回退到 body，并移除 nav/header/footer', () => {
    const html = '<html><body><nav>导航</nav><header>页头</header><p>短文</p><footer>页脚</footer></body></html>';
    const text = ContentExtractor.toText(html);
    expect(text).toContain('短文');
    expect(text).not.toContain('导航');
    expect(text).not.toContain('页脚');
  });
});

describe('ContentExtractor 输出格式', () => {
  it('markdown 把相对链接与图片改写为绝对地址', () => {
    const html = `<body><main><p>${'x '.repeat(120)}</p><a href="/p/1">链接</a><img src="/i.png"></main></body>`;
    const md = ContentExtractor.toMarkdown(html, 'https://site.test/blog/post');
    expect(md).toContain('https://site.test/p/1');
    expect(md).toContain('https://site.test/i.png');
  });

  it('简单表格转 GFM 表格', () => {
    const html = `<body><main><p>${'y '.repeat(120)}</p>
      <table><tr><th>列 A</th><th>列 B</th></tr><tr><td>1</td><td>2</td></tr></table>
    </main></body>`;
    const md = ContentExtractor.toMarkdown(html);
    expect(md).toContain('| 列 A | 列 B |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 1 | 2 |');
  });

  it('JSON 内容美化输出，纯文本原样输出', () => {
    const json = ContentExtractor.extract('{"a":1}', { format: 'markdown', contentType: 'application/json' });
    expect(json.content).toBe('{\n  "a": 1\n}');
    const text = ContentExtractor.extract('a < b', { format: 'text', contentType: 'text/plain' });
    expect(text.content).toBe('a < b');
  });

  it('format=html 原样返回并提取标题', () => {
    const html = '<html><head><title> 标题 </title></head><body><p>x</p></body></html>';
    const r = ContentExtractor.extract(html, { format: 'html', contentType: 'text/html' });
    expect(r.content).toBe(html);
    expect(r.title).toBe('标题');
  });
});
