/**
 * Yandex 网页搜索引擎单元测试（基于 HTML fixture，离线）
 * 覆盖：li.serp-item 解析、Direct 广告过滤、分页 p 从 0 开始、
 *       语言映射、SmartCaptcha 验证码检测、备用选择器
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { YandexWebEngine } from '../../src/engines/yandex/yandex-web.js';
import { EngineParseError } from '../../src/engines/engine-interface.js';
import type { EngineConfig } from '../../src/config/config-schema.js';
import { makeResponse } from './helpers/mock-response.js';

// 正常 SERP：两条自然结果，链接分别使用 OrganicTitle-Link 与 link_theme_normal，
// 摘要分别命中 .OrganicTextContentSpan 与 .TextContainer（二者不能嵌套，否则 text() 会重复拼接）
const SERP_HTML = '<!DOCTYPE html><html><body><ul class="serp-list">'
  + '<li class="serp-item" data-cid="d1">'
  + '<h2><a class="OrganicTitle-Link" href="https://openai.com">OpenAI</a></h2>'
  + '<div><span class="OrganicTextContentSpan">OpenAI is an AI research company.</span></div>'
  + '</li>'
  + '<li class="serp-item" data-cid="d2">'
  + '<h2><a class="link_theme_normal" href="https://www.typescriptlang.org/docs/">TypeScript Docs</a></h2>'
  + '<div class="TextContainer">TypeScript documentation.</div>'
  + '</li>'
  + '</ul></body></html>';

// 广告节点：data-cid 以 "0/" 开头（Direct 广告）与 .label_theme_direct 标记
const AD_HTML = '<!DOCTYPE html><html><body><ul class="serp-list">'
  + '<li class="serp-item" data-cid="0/12345">'
  + '<h2><a class="OrganicTitle-Link" href="https://ad1.example.com">Direct Ad</a></h2>'
  + '</li>'
  + '<li class="serp-item" data-cid="d9">'
  + '<div><span class="label_theme_direct">Ad</span></div>'
  + '<h2><a class="OrganicTitle-Link" href="https://ad2.example.com">Labeled Ad</a></h2>'
  + '</li>'
  + '<li class="serp-item" data-cid="d10">'
  + '<h2><a class="OrganicTitle-Link" href="https://organic.example.com">自然结果</a></h2>'
  + '<span class="OrganicTextContentSpan">唯一保留的自然结果摘要。</span>'
  + '</li>'
  + '</ul></body></html>';

// 备用结构：div.organic
const FALLBACK_HTML = '<!DOCTYPE html><html><body>'
  + '<div class="organic">'
  + '<h2>备用有机结果</h2>'
  + '<a href="https://backup.example.com/x">备用链接</a>'
  + '<span class="ExtendedText-Full">备用结构的摘要文本。</span>'
  + '</div>'
  + '</body></html>';

// SmartCaptcha 验证码页特征
const CAPTCHA_HTML = '<html><body><div class="SmartCaptcha">captcha required</div></body></html>';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    name: 'yandex',
    displayName: 'Yandex',
    enabled: true,
    type: 'scraper',
    baseUrl: 'https://yandex.com/search/',
    timeout: 5000,
    priority: 7,
    rateLimit: { maxRequests: 10, windowMs: 60000 },
    ...overrides,
  };
}

function mockFetchHtml(html: string, opts: { status?: number; url?: string } = {}) {
  return vi.fn().mockImplementation(async () =>
    makeResponse(html, { status: opts.status ?? 200, url: opts.url ?? 'https://yandex.com/search/?text=x' }),
  );
}

describe('YandexWebEngine', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('接口形状：name/displayName 与可用性', () => {
    const engine = new YandexWebEngine(makeConfig());
    expect(engine.name).toBe('yandex');
    expect(engine.displayName).toBe('Yandex');
    expect(engine.isAvailable()).toBe(true);
    expect(engine.getStatus().name).toBe('yandex');

    const disabled = new YandexWebEngine(makeConfig({ enabled: false }));
    expect(disabled.isAvailable()).toBe(false);
  });

  it('解析多条结果并携带分页/语言参数', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    const engine = new YandexWebEngine(makeConfig());

    const resp = await engine.search({ query: 'openai', count: 10, page: 2, language: 'zh-CN' });

    expect(resp.engine).toBe('yandex');
    expect(resp.results).toHaveLength(2);
    expect(resp.results[0]).toMatchObject({
      title: 'OpenAI',
      url: 'https://openai.com',
      snippet: 'OpenAI is an AI research company.',
      source: 'yandex',
      position: 1,
    });
    expect(resp.results[1]).toMatchObject({
      title: 'TypeScript Docs',
      url: 'https://www.typescriptlang.org/docs/',
      snippet: 'TypeScript documentation.',
      position: 2,
    });

    // 验证请求参数：Yandex 分页 p 从 0 开始，zh-CN 映射为 zh
    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('text')).toBe('openai');
    expect(calledUrl.searchParams.get('numdoc')).toBe('10');
    expect(calledUrl.searchParams.get('p')).toBe('1');
    expect(calledUrl.searchParams.get('lang')).toBe('zh');
  });

  it('过滤 data-cid 以 0/ 开头与 label_theme_direct 的 Direct 广告', async () => {
    globalThis.fetch = mockFetchHtml(AD_HTML);
    const engine = new YandexWebEngine(makeConfig());

    const resp = await engine.search({ query: 'test' });
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]).toMatchObject({
      title: '自然结果',
      url: 'https://organic.example.com',
      snippet: '唯一保留的自然结果摘要。',
      position: 1,
    });
  });

  it('空结果页返回空数组且 hasMore 为 false', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><ul class="serp-list"></ul>По вашему запросу ничего не найдено.</body></html>');
    const engine = new YandexWebEngine(makeConfig());

    const resp = await engine.search({ query: 'asdfqwer-no-match' });
    expect(resp.results).toEqual([]);
    expect(resp.hasMore).toBe(false);
  });

  it('解析不到结果且不像无结果页时抛 EngineParseError', async () => {
    globalThis.fetch = mockFetchHtml('<html><body><ul class="serp-list"></ul></body></html>');
    const engine = new YandexWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toBeInstanceOf(EngineParseError);
  });

  it('语言与区域参数：语言大小写不敏感，区域映射为 lr', async () => {
    globalThis.fetch = mockFetchHtml(SERP_HTML);
    const engine = new YandexWebEngine(makeConfig());

    await engine.search({ query: 'x', language: 'ZH-CN', region: 'ru' });
    const calledUrl = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('lang')).toBe('zh');
    expect(calledUrl.searchParams.get('lr')).toBe('225');
  });

  it('命中 SmartCaptcha 特征时抛出验证码错误', async () => {
    globalThis.fetch = mockFetchHtml(CAPTCHA_HTML);
    const engine = new YandexWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toThrow(/验证码|反爬/);
    expect(engine.getStatus().lastError).toContain('验证码');
  });

  it('最终 URL 落到 /showcaptcha 时识别为验证码页', async () => {
    globalThis.fetch = mockFetchHtml('<html><body>ok</body></html>', {
      url: 'https://yandex.com/showcaptcha?cc=1',
    });
    const engine = new YandexWebEngine(makeConfig());

    await expect(engine.search({ query: 'x' })).rejects.toThrow(/验证码|反爬/);
  });

  it('主选择器无匹配时使用 div.organic 备用选择器', async () => {
    globalThis.fetch = mockFetchHtml(FALLBACK_HTML);
    const engine = new YandexWebEngine(makeConfig());

    const resp = await engine.search({ query: 'test' });
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]).toMatchObject({
      title: '备用有机结果',
      url: 'https://backup.example.com/x',
      snippet: '备用结构的摘要文本。',
      source: 'yandex',
      position: 1,
    });
  });
});
