/**
 * 骨架页 / 需 JS 渲染 / 反爬挑战页检测
 */

import { describe, it, expect } from 'vitest';
import { detectJsRequiredPage, visibleTextOf } from '../../src/fetcher/render-detector.js';

const article = `<!doctype html><html><head><title>Article</title><script src="/a.js"></script>
<script src="/b.js"></script><script src="/c.js"></script></head><body><main>
<p>${'This is a real article paragraph with plenty of readable text. '.repeat(10)}</p>
<noscript>Please enable JavaScript for comments.</noscript></main></body></html>`;

describe('detectJsRequiredPage', () => {
  it('Cloudflare「Just a moment...」挑战页', () => {
    expect(detectJsRequiredPage({ title: 'Just a moment...', html: '<html></html>' })).toMatchObject({ needsBrowser: true, kind: 'challenge' });
    const html = '<html><head><title>x</title></head><body><div id="cf-challenge-running"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>';
    expect(detectJsRequiredPage({ html, statusCode: 403 })).toMatchObject({ needsBrowser: true, kind: 'challenge' });
  });

  it('正文很短且 noscript 要求启用 JavaScript', () => {
    const html = '<!doctype html><html><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="x"></div></body></html>';
    expect(detectJsRequiredPage({ html, contentType: 'text/html' })).toMatchObject({ needsBrowser: true, kind: 'noscript' });
    const zh = '<html><body><noscript>请启用 JavaScript 后访问</noscript></body></html>';
    expect(detectJsRequiredPage({ html: zh })).toMatchObject({ needsBrowser: true });
  });

  it('空 SPA 挂载点 + 脚本 / 大量脚本而几乎无正文 → 骨架页', () => {
    const spa = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/main.js"></script></body></html>';
    expect(detectJsRequiredPage({ html: spa, contentType: 'text/html; charset=utf-8' })).toMatchObject({ needsBrowser: true, kind: 'skeleton' });
    const heavy = `<html><body><span>Loading</span>${'<script>var a=1;</script>'.repeat(5)}</body></html>`;
    expect(detectJsRequiredPage({ html: heavy })).toMatchObject({ needsBrowser: true, kind: 'skeleton' });
  });

  it('正常文章（即便带脚本和 noscript）不判定', () => {
    expect(detectJsRequiredPage({ html: article, contentType: 'text/html' }).needsBrowser).toBe(false);
  });

  it('非 HTML 内容、短小但无脚本的页面不判定', () => {
    expect(detectJsRequiredPage({ html: '{"a":1}', contentType: 'application/json' }).needsBrowser).toBe(false);
    expect(detectJsRequiredPage({ html: '<html><body><p>Short page.</p></body></html>' }).needsBrowser).toBe(false);
  });

  it('无 rawHtml 时只依据正文是否为「请启用 JavaScript」', () => {
    expect(detectJsRequiredPage({ text: 'JavaScript is required to view this page.' }).needsBrowser).toBe(true);
    expect(detectJsRequiredPage({ text: 'hello world' }).needsBrowser).toBe(false);
  });

  it('visibleTextOf 去掉脚本、样式与标签', () => {
    expect(visibleTextOf('<style>p{}</style><p>a&nbsp;b</p><script>x()</script>')).toBe('a b');
  });
});
