/**
 * ContentFilter 单元测试
 */

import { describe, it, expect, vi } from 'vitest';
import { ContentFilter } from '../../src/security/content-filter.js';

describe('ContentFilter.checkUrl', () => {
  it('普通 https 地址视为安全', () => {
    const filter = new ContentFilter();
    expect(filter.checkUrl('https://example.com/article?id=1')).toEqual({ safe: true, threats: [] });
  });

  it('禁用时一律放行', () => {
    const filter = new ContentFilter({ enabled: false });
    expect(filter.checkUrl('javascript:alert(1)').safe).toBe(true);
  });

  it('检测不安全协议', () => {
    const filter = new ContentFilter();
    const result = filter.checkUrl('javascript:alert(1)');
    expect(result.safe).toBe(false);
    expect(result.threats.join()).toContain('不安全的协议');
  });

  it('检测超长 URL、IP 直连与多重编码', () => {
    const filter = new ContentFilter();
    expect(filter.checkUrl(`https://example.com/?q=${'a'.repeat(2100)}`).threats.join()).toContain('URL长度异常');
    expect(filter.checkUrl('http://8.8.8.8/').threats.join()).toContain('IP直连');
    expect(filter.checkUrl('https://example.com/?q=%2541').threats.join()).toContain('多重编码');
  });

  it('匹配配置的恶意域名（含子域名）', () => {
    const filter = new ContentFilter({ maliciousDomains: ['evil.com'] });
    expect(filter.checkUrl('https://evil.com/').safe).toBe(false);
    expect(filter.checkUrl('https://a.b.evil.com/').safe).toBe(false);
    // 后缀相同但不是子域名，不应误判
    expect(filter.checkUrl('https://notevil.com/').safe).toBe(true);
  });

  it('可疑域名模式只在开启时检测', () => {
    expect(new ContentFilter().checkUrl('https://bank-login.example.com/').safe).toBe(false);
    expect(new ContentFilter().checkUrl('https://free.tk/').safe).toBe(false);
    expect(
      new ContentFilter({ detectSuspiciousPatterns: false }).checkUrl('https://bank-login.example.com/').safe,
    ).toBe(true);
  });

  it('无效 URL 视为不安全', () => {
    const result = new ContentFilter().checkUrl('not a url');
    expect(result.safe).toBe(false);
    expect(result.threats[0]).toContain('无效的URL格式');
  });
});

describe('ContentFilter.checkContent', () => {
  it('普通正文视为安全', () => {
    expect(new ContentFilter().checkContent('<p>Hello world</p>').safe).toBe(true);
  });

  it.each([
    ['<script>var s = atob("ZXZhbA==")</script>', 'base64'],
    ['<iframe src="x" style="display:none"></iframe>', '隐藏的iframe'],
    ['<iframe src="x" width="0"></iframe>', '隐藏的iframe'],
    ['<script>fetch("/x?c=" + document.cookie)</script>', 'document.cookie'],
    ['<script>eval(payload)</script>', 'eval'],
    ['<form action="https://phish.example/collect"></form>', '外部表单'],
  ])('检测可疑模式：%s', (content, keyword) => {
    const result = new ContentFilter().checkContent(content);
    expect(result.safe).toBe(false);
    expect(result.threats.join()).toContain(keyword);
  });

  it('关闭可疑模式检测后不再报告这些模式', () => {
    const filter = new ContentFilter({ detectSuspiciousPatterns: false });
    expect(filter.checkContent('<script>eval(x)</script>').safe).toBe(true);
  });

  it('敏感关键词大小写不敏感', () => {
    const filter = new ContentFilter({ sensitiveKeywords: ['Secret'] });
    const result = filter.checkContent('this has a SECRET inside');
    expect(result.safe).toBe(false);
    expect(result.threats).toContain('检测到敏感关键词: Secret');
  });

  it('禁用时内容检查一律放行', () => {
    expect(new ContentFilter({ enabled: false }).checkContent('<script>eval(x)</script>').safe).toBe(true);
  });

  it('多个关键词时正文只小写一次（关键词已预先小写）', () => {
    const filter = new ContentFilter({ sensitiveKeywords: ['Alpha', 'BETA', 'gamma', 'Delta'], detectSuspiciousPatterns: false });
    const spy = vi.spyOn(String.prototype, 'toLowerCase');
    const result = filter.checkContent('ALPHA and delta');
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(calls).toBe(1);
    expect(result.threats).toEqual(['检测到敏感关键词: Alpha', '检测到敏感关键词: Delta']);
  });

  it('updateConfig 更新规则后关键词缓存同步刷新', () => {
    const filter = new ContentFilter({ sensitiveKeywords: ['old'] });
    filter.updateConfig({ sensitiveKeywords: ['New'] });
    expect(filter.checkContent('old text').safe).toBe(true);
    expect(filter.checkContent('brand NEW text').threats).toContain('检测到敏感关键词: New');
  });
});

describe('ContentFilter.check', () => {
  it('合并 URL 与内容两侧的威胁', () => {
    const filter = new ContentFilter();
    const result = filter.check('http://8.8.8.8/', '<script>eval(x)</script>');
    expect(result.safe).toBe(false);
    expect(result.threats.length).toBe(2);
  });
});
