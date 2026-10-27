/**
 * 搜索结果去广告
 *
 * 两层过滤：
 * 1. 解析层（各引擎 parseResults 内调用 isAdElement）：按结果容器上的广告标记识别，
 *    比如推广标签、广告专用的 class / 属性、所在的广告区块。这一层是确定性的，始终生效。
 * 2. 工具层（isAdUrl）：按落地链接识别解析层漏掉的广告，比如广告点击跳转域名、
 *    付费投放的追踪参数。可通过配置 search.adFilter 关闭。
 *
 * 规则来自对各引擎真实结果页的抽样（商业类关键词），页面改版后可能需要补充。
 */

import type * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

/** 结果卡片上的广告标签文字（整段文字完全相等才算，避免误伤正文里出现「广告」二字的结果） */
const AD_LABEL_RE = /^(?:广告|推广|商业推广|赞助|赞助商|ad|ads|sponsored|promoted|реклама)$/i;

/** 广告标签元素：只看文字很短的叶子级元素，不遍历大段正文 */
const AD_LABEL_CANDIDATES = 'span, em, i, b, small, button, a, div, label';

/**
 * 广告容器 / 广告标记选择器（命中自身或任一祖先即为广告）。
 * - 百度：凤巢推广卡片带 data-lp / data-ecimtimesign，class 含 ec-pc- 前缀，标签为 .ec-tuiguang
 * - 360：推广区块 #m-spread-left / #m-spread-right（.e-buss）
 * - Bing：li.b_ad 广告区块及 .b_adSlug 标签
 * - Google：#tads / #bottomads / #tvcap 广告区块、[data-text-ad]
 * - DuckDuckGo：.result--ad、.badge--ad 标签
 * - 搜狗：#promotion_adv_container、.biz_sponsor
 */
const AD_SELF_SELECTOR = [
  '[data-tuiguang]', '[data-lp]', '[data-ecimtimesign]', '.ec_tuiguang_ppim',
  '.result--ad', '.b_ad', '[data-text-ad]', '.res-mediav', '[data-mediav]',
  '.biz_sponsor',
].join(', ');
const AD_REGION_SELECTOR = [
  '#tads', '#bottomads', '#tvcap', '#m-spread-left', '#m-spread-right', '.e-buss',
  '.b_ad', '#promotion_adv_container', '.biz_sponsor',
].join(', ');
const AD_INNER_SELECTOR = [
  '.ec-tuiguang', '.ecfc-tuiguang', '.badge--ad', '.b_adSlug', '.label_theme_direct',
].join(', ');

/** 判断一个结果容器是否为广告 */
export function isAdElement($: cheerio.CheerioAPI, $el: cheerio.Cheerio<AnyNode>): boolean {
  if ($el.is(AD_SELF_SELECTOR)) return true;
  // 百度推广卡片的 class 带 ec-pc- 前缀（如 ec-pc-huanxin-grid），类名后缀经常变
  if (/(?:^|\s)ec-pc-/.test($el.attr('class') ?? '')) return true;
  if ($el.attr('data-click')?.includes('tuiguang')) return true;
  if ($el.closest(AD_REGION_SELECTOR).length) return true;
  if ($el.find(AD_INNER_SELECTOR).length) return true;
  return hasAdLabel($, $el);
}

/** 卡片内有没有一个文字恰好是「广告 / Ad / Sponsored」的小元素 */
function hasAdLabel($: cheerio.CheerioAPI, $el: cheerio.Cheerio<AnyNode>): boolean {
  let found = false;
  $el.find(AD_LABEL_CANDIDATES).each((_, node) => {
    const $n = $(node);
    // 只取元素自身的文字（不含子元素），广告标签都是独立的小元素
    const own = $n.contents().filter((_, c) => c.type === 'text').text().trim();
    if (own.length > 0 && own.length <= 12 && AD_LABEL_RE.test(own)) {
      found = true;
      return false;
    }
    return undefined;
  });
  return found;
}

/** 广告点击 / 跳转链接的特征（主机 + 路径） */
const AD_URL_PATTERNS: RegExp[] = [
  /^https?:\/\/(?:[^/]+\.)?duckduckgo\.com\/y\.js/i,
  /^https?:\/\/(?:[^/]+\.)?bing\.com\/aclk/i,
  /^https?:\/\/(?:[^/]+\.)?googleadservices\.com\//i,
  /^https?:\/\/(?:www\.)?google\.[a-z.]+\/aclk/i,
  /^https?:\/\/(?:www\.)?baidu\.com\/baidu\.php/i,
  /^https?:\/\/e\.so\.com\//i,
  /^https?:\/\/redirect\.simba\.taobao\.com\//i,
  /^https?:\/\/(?:[^/]+\.)?doubleclick\.net\//i,
];

/** 付费投放专用的点击追踪参数：自然结果的落地链接不会带这些 */
const AD_CLICK_PARAMS = ['sdclkid', 'bd_vid', 'gclid', 'msclkid', 'qhclickid', 'sogou_click_id'];
const PAID_UTM_MEDIUM_RE = /^(?:cpc|ppc|sem|paid|paidsearch|paid[-_]search|sem[-_].*|cpc[-_].*|ppc[-_].*)$/i;

/** 按落地链接判断是否为广告 */
export function isAdUrl(raw: string): boolean {
  if (AD_URL_PATTERNS.some(re => re.test(raw))) return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  for (const p of AD_CLICK_PARAMS) {
    if (url.searchParams.has(p)) return true;
  }
  const medium = url.searchParams.get('utm_medium');
  return medium !== null && PAID_UTM_MEDIUM_RE.test(medium);
}
