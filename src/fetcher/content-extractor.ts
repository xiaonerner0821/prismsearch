/**
 * 内容提取器 — HTML 转纯文本 / Markdown，去广告
 *
 * - 广告识别按 class / id 的**完整 token** 匹配（旧实现用 [class*="ad-"] 子串匹配，
 *   会误删 head- / thread- / read-more 等正文节点，导致整页正文为空）
 * - 整个提取流程只做一次 cheerio 解析（旧实现去广告、取正文、取标题各解析一遍）
 * - 提供 baseUrl 时把相对链接 / 图片地址改写为绝对地址
 * - Markdown 输出 GFM 表格
 * - 纯文本保留块级元素之间的换行
 * - JSON / 纯文本等非 HTML 内容原样返回，不走 HTML 转换
 * - extractReadable：可选依赖 Readability + linkedom 可用时先做正文识别，失败再退回上述启发式
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import TurndownService from 'turndown';

export type ExtractFormat = 'html' | 'text' | 'markdown';

/** 精确选择器（无误伤风险） */
const AD_EXACT_SELECTORS = [
  'ins.adsbygoogle',
  '[data-ad]', '[data-ads]', '[data-ad-slot]', '[data-ad-client]',
  'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication.com"]', 'iframe[src*="adservice."]',
];

/** class / id 的单个 token 命中即视为广告 */
const AD_TOKEN_RE = /^(?:ad|ads|advert|adverts|advertising|advertisement|adsense|adsbygoogle|adbox|adbanner|adslot|adunit|sponsor|sponsored|sponsored-content|popup-ad|ad[-_].+|ads[-_].+|.+[-_]ads?|advert[-_].+|banner[-_]ad|popup)$/i;

// 需要移除的非内容标签
const NON_CONTENT_TAGS = ['script', 'style', 'noscript', 'svg', 'canvas', 'template'];

// 常见正文容器选择器（按优先级排列）
const MAIN_CONTENT_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '.post-content',
  '.article-content',
  '.entry-content',
  '.content-body',
  '#content',
  '.content',
];

const NOISE_SELECTORS = 'nav, header, footer, aside, .sidebar, .nav, .menu, .breadcrumb';

/** 纯文本输出时，这些元素前后插入换行 */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tr', 'ul',
]);

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  // GFM 表格：只处理不含嵌套表格的简单表格，其余交给默认规则
  td.addRule('gfmTable', {
    filter: node => node.nodeName === 'TABLE' && !node.querySelector('table'),
    replacement: (_content, node) => {
      const rows = Array.from((node as HTMLTableElement).querySelectorAll('tr'));
      if (rows.length === 0) return '';
      const matrix = rows.map(row =>
        Array.from(row.querySelectorAll('th, td')).map(cell =>
          (cell.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'),
        ),
      );
      const width = Math.max(...matrix.map(r => r.length));
      if (width === 0) return '';
      const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
      const [head, ...body] = matrix.map(pad);
      const lines = [
        `| ${head.join(' | ')} |`,
        `| ${Array(width).fill('---').join(' | ')} |`,
        ...body.map(r => `| ${r.join(' | ')} |`),
      ];
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });
  return td;
}

function isAdElement(el: AnyNode, $: cheerio.CheerioAPI): boolean {
  const $el = $(el);
  const tokens = [
    ...($el.attr('class') ?? '').split(/\s+/),
    ...($el.attr('id') ?? '').split(/\s+/),
  ].filter(Boolean);
  return tokens.some(t => AD_TOKEN_RE.test(t));
}

/** 判断是否为非 HTML 的文本内容（JSON / 纯文本 / CSV 等），这类内容不做 HTML 转换 */
export function isNonHtmlText(contentType: string | undefined, raw: string): boolean {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return false;
  if (mime === 'application/json' || mime.endsWith('+json') || mime === 'application/ld+json') return true;
  if (mime === 'text/plain' || mime === 'text/csv' || mime === 'text/markdown' || mime === 'application/javascript' || mime === 'text/javascript' || mime === 'text/css') {
    return true;
  }
  if (!mime) {
    // 未声明类型：看起来不像 HTML 就当纯文本
    return !/<(?:!doctype|html|head|body|div|p|a)\b/i.test(raw.slice(0, 2048));
  }
  return false;
}

/** Readability 提取出的正文少于该字符数时视为没找到正文（列表页 / 首页等），退回启发式 */
const READABILITY_MIN_TEXT_CHARS = 200;

interface ReadabilityArticle {
  title?: string | null;
  content?: string | null;
  textContent?: string | null;
}

interface ReadabilityDeps {
  parseHTML: (html: string) => { document: unknown };
  Readability: new (document: unknown, options?: Record<string, unknown>) => { parse(): ReadabilityArticle | null };
}

let readabilityLoader: Promise<ReadabilityDeps | undefined> | undefined;

/** 动态加载可选依赖 linkedom + @mozilla/readability；任一未安装返回 undefined */
function loadReadability(): Promise<ReadabilityDeps | undefined> {
  readabilityLoader ??= Promise.all([import('linkedom'), import('@mozilla/readability')]).then(
    ([linkedom, readability]) => ({
      parseHTML: (linkedom as unknown as { parseHTML: ReadabilityDeps['parseHTML'] }).parseHTML,
      Readability: (readability as unknown as { Readability: ReadabilityDeps['Readability'] }).Readability,
    }),
    () => undefined,
  );
  return readabilityLoader;
}

/** 仅测试用：替换 Readability 加载器（返回 undefined 模拟未安装），传 undefined 恢复默认 */
export function setReadabilityLoaderForTest(loader: (() => Promise<ReadabilityDeps | undefined>) | undefined): void {
  readabilityLoader = loader ? loader() : undefined;
}

export class ContentExtractor {
  private static turndown = createTurndown();

  /**
   * 一次解析完成提取，返回指定格式内容与标题。
   * contentType 为非 HTML 文本（JSON / 纯文本）时原样返回（JSON 会美化）。
   */
  static extract(
    raw: string,
    options: { format: ExtractFormat; baseUrl?: string; contentType?: string },
  ): { content: string; title?: string } {
    if (isNonHtmlText(options.contentType, raw)) {
      return { content: ContentExtractor.formatPlain(raw, options.contentType) };
    }

    const $ = cheerio.load(raw);
    const title = $('title').first().text().trim() || undefined;

    if (options.format === 'html') {
      return { content: raw, title };
    }

    $(NON_CONTENT_TAGS.join(',')).remove();
    if (options.baseUrl) ContentExtractor.absolutize($, options.baseUrl);

    if (options.format === 'text') {
      // 纯文本同样要去掉导航 / 页头页脚 / 侧栏，否则正文被站点框架淹没
      $(NOISE_SELECTORS).remove();
      return { content: ContentExtractor.textOf($, $('body').length ? $('body') : $.root()), title };
    }

    ContentExtractor.stripAds($);
    const main = ContentExtractor.mainContentHtml($);
    return { content: ContentExtractor.turndown.turndown(main).trim(), title };
  }

  /**
   * 正文优先的提取：markdown / text 格式下先用 Mozilla Readability（Firefox 阅读模式同款算法，
   * 基于 linkedom 的轻量 DOM）找出正文，正文足够长才采用；可选依赖未安装、解析失败或正文过短时
   * 退回 extract 的选择器启发式。html 格式与非 HTML 文本直接走 extract。
   */
  static async extractReadable(
    raw: string,
    options: { format: ExtractFormat; baseUrl?: string; contentType?: string },
  ): Promise<{ content: string; title?: string; extractor: 'readability' | 'heuristic' }> {
    const fallback = () => ({ ...ContentExtractor.extract(raw, options), extractor: 'heuristic' as const });
    if (options.format === 'html' || isNonHtmlText(options.contentType, raw)) return fallback();

    const deps = await loadReadability();
    if (!deps) return fallback();

    let article: ReadabilityArticle | null;
    try {
      const { document } = deps.parseHTML(raw);
      article = new deps.Readability(document, { keepClasses: false }).parse();
    } catch {
      return fallback();
    }
    const text = article?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (!article?.content || text.length < READABILITY_MIN_TEXT_CHARS) return fallback();

    const pageTitle = cheerio.load(raw)('title').first().text().trim();
    const title = pageTitle || article.title?.trim() || undefined;

    const $ = cheerio.load(article.content);
    $(NON_CONTENT_TAGS.join(',')).remove();
    if (options.baseUrl) ContentExtractor.absolutize($, options.baseUrl);
    if (options.format === 'text') {
      return { content: ContentExtractor.textOf($, $('body').length ? $('body') : $.root()), title, extractor: 'readability' };
    }
    const html = $('body').html() ?? $.html();
    return { content: ContentExtractor.turndown.turndown(html).trim(), title, extractor: 'readability' };
  }

  // HTML转纯文本（保留块级换行）
  static toText(html: string): string {
    return ContentExtractor.extract(html, { format: 'text', contentType: 'text/html' }).content;
  }

  // HTML转Markdown
  static toMarkdown(html: string, baseUrl?: string): string {
    return ContentExtractor.extract(html, { format: 'markdown', baseUrl, contentType: 'text/html' }).content;
  }

  // 提取页面标题
  static extractTitle(html: string): string | undefined {
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();
    return title || undefined;
  }

  // 去广告（保留给外部调用；内部 extract 直接在同一 DOM 上处理）
  static removeAds(html: string): string {
    const $ = cheerio.load(html);
    ContentExtractor.stripAds($);
    $(NON_CONTENT_TAGS.join(',')).remove();
    return $.html();
  }

  // 提取正文内容区域
  static extractMainContent(html: string): string {
    return ContentExtractor.mainContentHtml(cheerio.load(html));
  }

  private static formatPlain(raw: string, contentType?: string): string {
    const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
    if (mime === 'application/json' || mime.endsWith('+json')) {
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        return raw;
      }
    }
    return raw;
  }

  private static stripAds($: cheerio.CheerioAPI): void {
    for (const selector of AD_EXACT_SELECTORS) {
      try {
        $(selector).remove();
      } catch {
        // 无效选择器忽略
      }
    }
    $('[class], [id]')
      .filter((_, el) => isAdElement(el, $))
      // 不删 html / body / 正文容器本身，避免整页被清空
      .filter((_, el) => !['html', 'body', 'main', 'article'].includes((el as { tagName?: string }).tagName ?? ''))
      .remove();
  }

  private static mainContentHtml($: cheerio.CheerioAPI): string {
    for (const selector of MAIN_CONTENT_SELECTORS) {
      const el = $(selector).first();
      if (el.length > 0 && el.text().trim().length > 100) {
        el.find(NOISE_SELECTORS).remove();
        return el.html() ?? '';
      }
    }
    $(NOISE_SELECTORS).remove();
    return $('body').html() ?? $.html();
  }

  private static absolutize($: cheerio.CheerioAPI, baseUrl: string): void {
    const base = $('base[href]').attr('href');
    let resolvedBase = baseUrl;
    try {
      if (base) resolvedBase = new URL(base, baseUrl).toString();
    } catch {
      // 忽略非法 <base>
    }
    const rewrite = (selector: string, attr: string) => {
      $(selector).each((_, el) => {
        const value = $(el).attr(attr);
        if (!value || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(value)) return;
        try {
          $(el).attr(attr, new URL(value, resolvedBase).toString());
        } catch {
          // 保留原值
        }
      });
    };
    rewrite('a[href]', 'href');
    rewrite('img[src]', 'src');
  }

  /** 块级元素前后插入换行后取文本，再逐行合并空白 */
  private static textOf($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>): string {
    root.find('br').replaceWith('\n');
    root.find('*').each((_, el) => {
      const tag = (el as { tagName?: string }).tagName?.toLowerCase();
      if (tag && BLOCK_TAGS.has(tag)) {
        $(el).prepend('\n').append('\n');
      } else if (tag === 'td' || tag === 'th') {
        $(el).append('\t');
      }
    });
    return root
      .text()
      .split('\n')
      .map(line => line.replace(/[ \t\f\v\r\u00a0]+/g, ' ').trim())
      .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
      .join('\n')
      .trim();
  }
}
