import { describe, it, expect } from 'vitest';
import { deduplicateResults, normalizeUrl } from '../../src/utils/dedup.js';
import type { SearchResult } from '../../src/engines/engine-interface.js';

describe('normalizeUrl', () => {
  it('去除尾部斜杠', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('统一为https', () => {
    expect(normalizeUrl('http://example.com/page')).toBe('https://example.com/page');
  });

  it('去除hash片段', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
  });

  it('去除跟踪参数', () => {
    const url = 'https://example.com/page?id=1&utm_source=google&fbclid=abc';
    const normalized = normalizeUrl(url);
    expect(normalized).toContain('id=1');
    expect(normalized).not.toContain('utm_source');
    expect(normalized).not.toContain('fbclid');
  });

  it('域名转小写', () => {
    expect(normalizeUrl('https://EXAMPLE.COM/Path')).toBe('https://example.com/Path');
  });

  it('无效URL返回小写原始值', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});

describe('deduplicateResults', () => {
  const makeResult = (url: string, source: string, position: number): SearchResult => ({
    title: `Title for ${url}`,
    url,
    snippet: 'Some snippet',
    source,
    position,
  });

  it('去除重复URL', () => {
    const results = [
      makeResult('https://example.com/page', 'google', 1),
      makeResult('https://example.com/page', 'bing', 2),
      makeResult('https://other.com/page', 'google', 3),
    ];

    const deduped = deduplicateResults(results);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].source).toBe('google'); // 保留首次出现的
  });

  it('http和https视为相同URL', () => {
    const results = [
      makeResult('https://example.com/page', 'google', 1),
      makeResult('http://example.com/page', 'bing', 2),
    ];

    const deduped = deduplicateResults(results);
    expect(deduped).toHaveLength(1);
  });

  it('带尾部斜杠和不带视为相同', () => {
    const results = [
      makeResult('https://example.com/page/', 'google', 1),
      makeResult('https://example.com/page', 'bing', 2),
    ];

    const deduped = deduplicateResults(results);
    expect(deduped).toHaveLength(1);
  });

  it('空数组返回空数组', () => {
    expect(deduplicateResults([])).toEqual([]);
  });
});
