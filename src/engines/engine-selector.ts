/**
 * 自动引擎选择策略
 * 综合考虑可用性、成功率、延迟、优先级和语言匹配
 * 支持异源降级顺序配置（crossOrigin fallback）
 */

import type { SearchRequest, SearchProvider } from './engine-interface.js';
import type { EngineRegistry } from './engine-registry.js';
import { imageStatusOf, isImageAvailable } from './engine-registry.js';
import type { EngineConfig } from '../config/config-schema.js';
import { BUILTIN_ENGINES } from '../config/config-schema.js';

// 权重配置
// fallbackOrder 需要比 priority 更有决定性：用户在配置里显式指定的降级顺序是明确意图，
// 不该被内置的默认优先级表压过去（旧实现二者都是 0.10，配了 crossOrigin 也常常翻不过来）
const WEIGHTS = {
  successRate: 0.30,   // 成功率权重
  latency: 0.20,       // 延迟权重
  priority: 0.10,      // 优先级权重
  languageMatch: 0.15, // 语言匹配权重
  regionMatch: 0.10,   // 区域匹配权重
  fallbackOrder: 0.15, // 异源降级配置顺序权重
};

// CJK字符范围（中日韩统一表意文字）
const CJK_REGEX = /[一-鿿㐀-䶿　-〿぀-ゟ゠-ヿ가-힯]/;

// 引擎的语言亲和性 / 服务区域：来自 engines[].languages / engines[].regions 配置，
// 内置默认值定义在 BUILTIN_ENGINES；未注入配置（或配置为空数组）时回落到内置值
const BUILTIN_BY_NAME = new Map(BUILTIN_ENGINES.map(e => [e.name, e]));

// 中文优先的引擎
const CJK_PREFERRED_ENGINES = ['baidu', 'sogou', 'so', 'bing', 'brave', 'google', 'duckduckgo', 'yandex'];
// 英文优先的引擎
const EN_PREFERRED_ENGINES = ['google', 'bing', 'brave', 'duckduckgo', 'yandex', 'baidu', 'sogou', 'so'];

export class EngineSelector {
  private engineConfigs: Map<string, EngineConfig> = new Map();

  // 注入引擎配置（用于读取 fallback.crossOrigin 信息）
  setEngineConfigs(configs: EngineConfig[]): void {
    this.engineConfigs.clear();
    for (const cfg of configs) {
      this.engineConfigs.set(cfg.name, cfg);
    }
  }

  // 根据请求参数自动选择最佳引擎（返回单个引擎，兼容旧调用方）
  select(request: SearchRequest, registry: EngineRegistry): SearchProvider | null {
    const candidates = this.rank(request, registry);
    return candidates[0] ?? null;
  }

  // 返回按优先级排序的引擎候选列表，供降级循环使用
  rank(request: SearchRequest, registry: EngineRegistry): SearchProvider[] {
    // 如果指定了引擎，将其排在首位，其余引擎按该引擎的 crossOrigin 配置排序
    if (request.engine) {
      const specified = registry.get(request.engine);
      // 指定的引擎也要尊重熔断/停用：仍在冷却期时直接跳到降级链，
      // 旧实现无条件把它排第一位，等于熔断器对显式指定完全失效
      if (specified && specified.isAvailable()) {
        const rest = this.rankWithFallbackOrder(request, registry, request.engine)
          .filter(e => e.name !== request.engine);
        return [specified, ...rest];
      }
      return this.rankWithFallbackOrder(request, registry, request.engine)
        .filter(e => e.name !== request.engine);
    }

    return this.rankAll(request, registry);
  }

  // 返回按优先级排序的图片搜索引擎候选列表
  rankForImage(request: SearchRequest, registry: EngineRegistry): SearchProvider[] {
    if (request.engine) {
      const specified = registry.get(request.engine);
      const supportsImage = specified && typeof specified.imageSearch === 'function';
      // 显式指定了不支持图片搜索的引擎：只有它能满足，直接报无候选
      if (specified && !supportsImage) return [];

      const rest = this.rankAllForImage(request, registry).filter(e => e.name !== request.engine);
      if (specified && supportsImage && isImageAvailable(specified)) {
        return [specified, ...rest];
      }
      return rest;
    }
    return this.rankAllForImage(request, registry);
  }

  // 对支持图片搜索的可用引擎按综合评分排序（图片用图片自己的统计与 crossOrigin 顺序）
  private rankAllForImage(request: SearchRequest, registry: EngineRegistry): SearchProvider[] {
    const available = registry.getImageSearchAvailable();
    if (available.length === 0) return [];

    const crossOriginOrder = this.crossOriginOf(request.engine);
    return available
      .map(engine => ({
        engine,
        score: this.calculateScore(engine, request, imageStatusOf(engine)) + this.fallbackBonus(engine.name, crossOriginOrder),
      }))
      .sort((a, b) => b.score - a.score)
      .map(s => s.engine);
  }

  // 从配置里取某引擎的 crossOrigin 降级顺序；未指定引擎时为空
  private crossOriginOf(sourceEngine: string | undefined): string[] {
    if (!sourceEngine) return [];
    return this.engineConfigs.get(sourceEngine)?.fallback?.crossOrigin ?? [];
  }

  // crossOrigin 列表内的引擎按列表位置获得加分（越靠前越高）
  private fallbackBonus(engineName: string, crossOriginOrder: string[]): number {
    const idx = crossOriginOrder.indexOf(engineName);
    if (idx < 0) return 0;
    return WEIGHTS.fallbackOrder * (1 - idx / Math.max(crossOriginOrder.length, 1));
  }

  // 对所有可用引擎按综合评分排序
  private rankAll(request: SearchRequest, registry: EngineRegistry): SearchProvider[] {
    const available = registry.getAvailable();
    if (available.length === 0) return [];
    if (available.length === 1) return [available[0]];

    return available
      .map(engine => ({ engine, score: this.calculateScore(engine, request) }))
      .sort((a, b) => b.score - a.score)
      .map(s => s.engine);
  }

  // 带异源降级配置顺序的排序（当指定引擎失败后，优先按 crossOrigin 列表顺序降级）
  private rankWithFallbackOrder(
    request: SearchRequest, registry: EngineRegistry, sourceEngine: string,
  ): SearchProvider[] {
    const available = registry.getAvailable();
    if (available.length === 0) return [];

    const crossOriginOrder = this.crossOriginOf(sourceEngine);
    return available
      .map(engine => ({
        engine,
        score: this.calculateScore(engine, request) + this.fallbackBonus(engine.name, crossOriginOrder),
      }))
      .sort((a, b) => b.score - a.score)
      .map(s => s.engine);
  }

  // 计算引擎综合评分；status 默认取网页统计，图片排序时传入图片统计
  private calculateScore(engine: SearchProvider, request: SearchRequest, status = engine.getStatus()): number {

    // 成功率评分 (0-1)
    const successScore = status.successRate;

    // 延迟评分 (0-1)，延迟越低评分越高，以5000ms为基准
    const latencyScore = status.latency > 0
      ? Math.max(0, 1 - status.latency / 5000)
      : 1;

    // 优先级评分 (0-1)，优先级数值越小越好（1最高）
    const priorityScore = Math.max(0, 1 - (this.getEnginePriority(engine.name) - 1) / 10);

    // 语言匹配评分 (0-1)
    const languageScore = this.getLanguageMatchScore(engine.name, request);

    // 区域匹配评分 (0-1)
    const regionScore = this.getRegionMatchScore(engine.name, request);

    // 加权求和
    return (
      WEIGHTS.successRate * successScore +
      WEIGHTS.latency * latencyScore +
      WEIGHTS.priority * priorityScore +
      WEIGHTS.languageMatch * languageScore +
      WEIGHTS.regionMatch * regionScore
    );
  }

  // 计算区域匹配评分：请求指定了区域且该引擎覆盖该区域时加分
  private getRegionMatchScore(engineName: string, request: SearchRequest): number {
    if (!request.region) return 0.5;
    const regions = this.affinityOf(engineName, 'regions');
    const wanted = request.region.toLowerCase();
    return regions.some(r => r.toLowerCase() === wanted) ? 1 : 0.4;
  }

  /** 读取引擎的区域 / 语言亲和性：配置非空则用配置，否则用内置默认 */
  private affinityOf(engineName: string, field: 'regions' | 'languages'): readonly string[] {
    const configured = this.engineConfigs.get(engineName)?.[field];
    if (configured && configured.length > 0) return configured;
    return BUILTIN_BY_NAME.get(engineName)?.[field] ?? [];
  }

  // 获取引擎优先级（数值越小优先级越高）
  private getEnginePriority(engineName: string): number {
    const config = this.engineConfigs.get(engineName);
    if (config) return config.priority;
    const defaults: Record<string, number> = {
      google: 1, bing: 2, baidu: 3, so: 4, sogou: 5, duckduckgo: 6, yandex: 7, brave: 2,
    };
    return defaults[engineName] ?? 8;
  }

  // 计算语言匹配评分（大小写不敏感，'zh-cn' 与 'zh-CN' 等价）
  private getLanguageMatchScore(engineName: string, request: SearchRequest): number {
    if (request.language) {
      const affinities = this.affinityOf(engineName, 'languages');
      const wanted = request.language.toLowerCase();
      const primary = wanted.split('-')[0];
      if (affinities.some(a => a.toLowerCase() === wanted)) return 1;
      // 只差地区（zh 与 zh-CN）：算部分匹配，而不是直接按不匹配处理
      if (affinities.some(a => a.toLowerCase().split('-')[0] === primary)) return 0.75;
      return 0.5;
    }

    // 根据查询内容自动判断
    const isCjk = CJK_REGEX.test(request.query);
    const preferredOrder = isCjk ? CJK_PREFERRED_ENGINES : EN_PREFERRED_ENGINES;
    const index = preferredOrder.indexOf(engineName);

    if (index === -1) return 0.3;
    return 1 - index * (0.7 / Math.max(preferredOrder.length - 1, 1));
  }
}
