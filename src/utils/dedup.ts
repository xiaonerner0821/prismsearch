/**
 * 搜索结果 URL 去重与规范化
 *
 * 规范化只做「同一页面不同写法」的合并：
 * - 协议统一为 https、域名小写并去掉 www.、去掉默认端口 / 末尾斜杠 / fragment
 * - 只移除真正的跟踪参数（utm_*、fbclid、gclid、msclkid、spm 等）
 *
 * 旧实现还会删掉 ref / source，并用 searchParams.sort() 重排参数 —— 这两点都会把
 * 语义不同的 URL 合并成一个：`?ref=abc` 常是站点自身的分页或跳转参数（youtube、github 的
 * `?ref=` 指向不同页面），而 reorder 会让服务端的签名 URL 失效。
 */

import type { SearchResult } from '../engines/engine-interface.js';

/** 只含跟踪用途的参数名（小写比较） */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'twclid', 'igshid',
  'spm', 'scm', 'from_source', '_trksid', 'mc_cid', 'mc_eid',
]);

/** 判断参数是否为跟踪参数：忽略大小写，允许 utm_ 前缀的变体 */
function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_PARAMS.has(lower) || lower.startsWith('utm_');
}

/** 对搜索结果按规范化 URL 去重，保留首次出现的结果 */
export function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of results) {
    const normalized = normalizeUrl(result.url);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduped.push(result);
    }
  }

  return deduped;
}

/** URL 规范化（仅用于判重，不改变返回给调用方的原始 URL） */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // http / https 视为同一页面；其他协议（ftp:、mailto: 等）保持原样
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') parsed.protocol = 'https:';

    // 域名转小写，去掉默认端口（new URL 已处理，这里兜底）；
    // www. 与裸域视为同一站点（各引擎对同一页面给出的写法常常不一致）
    parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }

    parsed.hash = '';

    for (const name of [...parsed.searchParams.keys()]) {
      if (isTrackingParam(name)) parsed.searchParams.delete(name);
    }

    // 去掉路径末尾的斜杠（`/a/b/` 与 `/a/b`、`/` 与空路径都是同一页）
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');

    // 清掉空查询串产生的尾部 '?'；URL#toString 会把空路径补成 '/'，这里一并去掉
    let result = parsed.toString();
    if (result.endsWith('?')) result = result.slice(0, -1);
    if (parsed.pathname === '/' && !parsed.search && result.endsWith('/')) result = result.slice(0, -1);
    return result;
  } catch {
    // URL 解析失败时返回原始值的小写形式
    return url.toLowerCase();
  }
}
