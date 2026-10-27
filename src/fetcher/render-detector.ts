/**
 * 「需要 JS 渲染」页面检测（纯函数）
 *
 * fetch_page 在未显式指定 method 且走 http 抓取时，用它判断结果是否只是
 * 前端框架骨架、noscript 提示或反爬挑战页；命中且浏览器可用时改用 browser 重抓。
 *
 * 判定刻意保守：宁可漏判（返回 http 结果）也不误判（白白多花一次浏览器渲染）。
 */

export interface RenderDetectionInput {
  /** 原始 HTML（http 抓取器可提供；Worker 结果可能没有） */
  html?: string;
  /** 已提取的正文（markdown / text），html 缺失时作为兜底依据 */
  text?: string;
  title?: string;
  contentType?: string;
  statusCode?: number;
}

export type RenderDetectionKind = 'challenge' | 'noscript' | 'skeleton';

export interface RenderDetectionResult {
  needsBrowser: boolean;
  kind?: RenderDetectionKind;
  reason?: string;
}

/** 可见文本低于该长度才考虑「骨架页」判定 */
export const SKELETON_MAX_TEXT_CHARS = 200;

/** 常见反爬 / 浏览器挑战页特征（Cloudflare、DDoS-Guard、Sucuri 等） */
const CHALLENGE_TITLE_PATTERNS: RegExp[] = [
  /^\s*just a moment\.{0,3}\s*$/i,
  /attention required!?\s*\|\s*cloudflare/i,
  /^\s*ddos-guard\s*$/i,
  /checking your browser/i,
];

const CHALLENGE_HTML_PATTERNS: RegExp[] = [
  /\bcf-challenge\b/i,
  /\bcf_chl_/i,
  /\/cdn-cgi\/challenge-platform\//i,
  /\bchallenge-platform\b/i,
  /<title>\s*just a moment\.{0,3}\s*<\/title>/i,
  /checking your browser before accessing/i,
  /ddos-guard\.net\/(?:check|js-challenge)/i,
  /sucuri website firewall/i,
];

/** 「请启用 JavaScript」类提示（中英文） */
const ENABLE_JS_PATTERNS: RegExp[] = [
  /(?:enable|turn on|activate)\s+javascript/i,
  /javascript\s+(?:is\s+)?(?:required|disabled|must be enabled|needs to be enabled)/i,
  /requires?\s+javascript/i,
  /(?:启用|开启|打开|允许)\s*javascript/i,
  /javascript\s*(?:已被?禁用|未启用|被禁用)/i,
];

/** SPA 挂载点：空的 root / app / __next / __nuxt 容器 */
const EMPTY_MOUNT_RE = /<div[^>]+id\s*=\s*["'](?:root|app|__next|__nuxt|main-app)["'][^>]*>\s*<\/div>/i;

const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
const NOSCRIPT_RE = /<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi;

/** 去掉脚本 / 样式 / 标签后的可见文本（只用于长度判定，不追求精确） */
export function visibleTextOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, 'x')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHtmlLike(contentType: string | undefined, html: string | undefined): boolean {
  if (contentType) {
    const mime = contentType.split(';')[0].trim().toLowerCase();
    return mime === 'text/html' || mime === 'application/xhtml+xml';
  }
  return !!html && /<(?:!doctype\s+html|html|body|head)\b/i.test(html);
}

/** 判断 http 抓取结果是否需要浏览器渲染才能拿到正文 */
export function detectJsRequiredPage(input: RenderDetectionInput): RenderDetectionResult {
  const { html, title } = input;

  // PDF 等非 HTML 文档不存在「需要 JS 渲染」的问题
  if (/^application\/(?:x-)?pdf\b/i.test(input.contentType ?? '')) return { needsBrowser: false };

  // 1. 反爬挑战页（常见 403 / 503，也可能 200）
  if (title && CHALLENGE_TITLE_PATTERNS.some(re => re.test(title))) {
    return { needsBrowser: true, kind: 'challenge', reason: `反爬挑战页（标题「${title.trim()}」）` };
  }
  if (html) {
    const hit = CHALLENGE_HTML_PATTERNS.find(re => re.test(html));
    if (hit) return { needsBrowser: true, kind: 'challenge', reason: '反爬挑战页（检测到浏览器校验脚本）' };
  }

  if (!html) {
    // 没有原始 HTML（如 Worker 结果）：只看正文是否是一句「请启用 JavaScript」
    const text = (input.text ?? '').trim();
    if (text.length > 0 && text.length < SKELETON_MAX_TEXT_CHARS && ENABLE_JS_PATTERNS.some(re => re.test(text))) {
      return { needsBrowser: true, kind: 'noscript', reason: '正文仅为「请启用 JavaScript」提示' };
    }
    return { needsBrowser: false };
  }

  if (!isHtmlLike(input.contentType, html)) return { needsBrowser: false };

  const visible = visibleTextOf(html);
  const short = visible.length < SKELETON_MAX_TEXT_CHARS;

  // 2. noscript 里要求启用 JavaScript，且可见正文很少（大量正文的站点常也带 noscript，不算）
  if (short) {
    for (const m of html.matchAll(NOSCRIPT_RE)) {
      const inner = visibleTextOf(m[1] ?? '');
      if (ENABLE_JS_PATTERNS.some(re => re.test(inner))) {
        return { needsBrowser: true, kind: 'noscript', reason: 'noscript 提示需要启用 JavaScript' };
      }
    }
  }

  // 3. 骨架页：正文极短，而脚本很多 / 很大，或有空的 SPA 挂载点
  if (short) {
    let scriptCount = 0;
    let scriptBytes = 0;
    for (const m of html.matchAll(SCRIPT_RE)) {
      scriptCount++;
      scriptBytes += m[1]?.length ?? 0;
    }
    const emptyMount = EMPTY_MOUNT_RE.test(html);
    const scriptHeavy = scriptCount >= 3 || scriptBytes > Math.max(2000, visible.length * 20);
    if ((emptyMount && scriptCount >= 1) || (scriptHeavy && visible.length < SKELETON_MAX_TEXT_CHARS / 2)) {
      return {
        needsBrowser: true,
        kind: 'skeleton',
        reason: `疑似前端渲染骨架页（可见文本 ${visible.length} 字符，脚本 ${scriptCount} 个）`,
      };
    }
  }

  return { needsBrowser: false };
}
