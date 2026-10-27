/**
 * 正文提取：HTML → markdown / text / html
 *
 * 策略：先移除脚本、样式、导航、页脚、广告等噪声节点，
 * 再按 article → main → [role=main] → body 的优先级挑选正文容器。
 */

import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

export type OutputFormat = 'markdown' | 'text' | 'html';

const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas',
  'nav', 'footer', 'aside', 'form',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[aria-hidden="true"]',
  '.advertisement', '.ads', '.ad', '.cookie', '.cookie-banner', '.share', '.social',
].join(',');

const CONTENT_CANDIDATES = ['article', 'main', '[role="main"]', '#content', '.content', '.post', '.article'];

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

export interface ExtractResult {
  title?: string;
  content: string;
}

export function extractContent(html: string, format: OutputFormat, baseUrl?: string): ExtractResult {
  const $ = cheerio.load(html);
  const title = ($('meta[property="og:title"]').attr('content') ?? $('title').first().text()).trim() || undefined;

  if (format === 'html') return { title, content: html };

  $(NOISE_SELECTORS).remove();

  // 相对链接转绝对，方便下游使用
  if (baseUrl) {
    $('a[href], img[src]').each((_, el) => {
      const attr = el.tagName === 'img' ? 'src' : 'href';
      const value = $(el).attr(attr);
      if (!value) return;
      try {
        $(el).attr(attr, new URL(value, baseUrl).toString());
      } catch {
        // 非法链接保持原样
      }
    });
  }

  let container = $('body');
  for (const selector of CONTENT_CANDIDATES) {
    // .first() 的返回类型是 Cheerio<AnyNode>，与 $('body') 的 Cheerio<Element> 不同，这里统一为同一类型
    const candidate = $(selector).first() as typeof container;
    // 正文容器至少要有一定长度，避免选中空的 <main>
    if (candidate.length && candidate.text().trim().length >= 200) {
      container = candidate;
      break;
    }
  }

  if (format === 'text') {
    const text = container
      .text()
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { title, content: text };
  }

  const markdown = turndown
    .turndown(container.html() ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, content: markdown };
}
