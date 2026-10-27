/**
 * 各内置引擎对可选搜索参数的支持情况
 *
 * - list_engines 据此对外声明能力，调用方可以提前知道哪些参数会被忽略
 * - web_search 在实际使用的引擎不支持调用方给出的参数时附加 warning，而不是静默丢弃
 * - 指定了 timeRange 且自动选引擎时，支持时间过滤的引擎排到候选前面
 *
 * 新增引擎或补充参数映射时同步这里；未登记的引擎视为全部不支持。
 */

import type { SearchRequest } from './engine-interface.js';

export interface EngineCapabilities {
  /** 安全搜索 */
  safeSearch: boolean;
  /** 区域（结果地域 / 市场） */
  region: boolean;
  /** 语言（界面语言或结果语言） */
  language: boolean;
  /** 时间范围过滤 */
  timeRange: boolean;
}

const NONE: EngineCapabilities = { safeSearch: false, region: false, language: false, timeRange: false };

/**
 * 百度 / 搜狗 / 360 没有公开的区域、语言、安全搜索 URL 参数（结果固定面向中国大陆简体中文），
 * 只能做时间过滤；DuckDuckGo 的语言只能与区域组合成 kl 生效；Yandex 没有可靠的时间过滤参数。
 */
const CAPABILITIES: Record<string, EngineCapabilities> = {
  google: { safeSearch: true, region: true, language: true, timeRange: true },
  bing: { safeSearch: true, region: true, language: true, timeRange: true },
  brave: { safeSearch: true, region: true, language: true, timeRange: true },
  duckduckgo: { safeSearch: true, region: true, language: false, timeRange: true },
  yandex: { safeSearch: false, region: true, language: true, timeRange: false },
  baidu: { safeSearch: false, region: false, language: false, timeRange: true },
  sogou: { safeSearch: false, region: false, language: false, timeRange: true },
  so: { safeSearch: false, region: false, language: false, timeRange: true },
};

export function capabilitiesOf(engine: string): EngineCapabilities {
  return CAPABILITIES[engine] ?? NONE;
}

/** 请求里用到、但该引擎不支持的参数名 */
export function unsupportedParams(engine: string, req: Pick<SearchRequest, 'safeSearch' | 'region' | 'language' | 'timeRange'>): string[] {
  const caps = capabilitiesOf(engine);
  const missing: string[] = [];
  if (req.safeSearch && !caps.safeSearch) missing.push('safeSearch');
  if (req.region && !caps.region) missing.push('region');
  if (req.language && !caps.language) missing.push('language');
  if (req.timeRange && !caps.timeRange) missing.push('timeRange');
  return missing;
}

/** 生成「某引擎忽略了哪些参数」的 warning；全部支持时返回 undefined */
export function unsupportedParamsWarning(engine: string, req: Pick<SearchRequest, 'safeSearch' | 'region' | 'language' | 'timeRange'>): string | undefined {
  const missing = unsupportedParams(engine, req);
  if (missing.length === 0) return undefined;
  return `引擎 ${engine} 不支持参数 ${missing.join(', ')}，已忽略`;
}

/** 时间范围对应的天数（引擎只接受自定义日期区间时用） */
export const TIME_RANGE_DAYS: Record<NonNullable<SearchRequest['timeRange']>, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};
