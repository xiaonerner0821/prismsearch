/**
 * list_engines 工具 — 列出所有搜索引擎（含未启用的）及运行状态
 *
 * 相比旧实现：
 * - 已配置但未启用的引擎也会列出（enabled=false），方便用户知道还有哪些可开
 * - 包含微信公众号引擎（仅用于 wechat_search）
 * - 熔断状态、API Key 是否就绪
 * - 可选的 Worker 健康摘要
 */

import type { EngineRegistry } from '../engines/engine-registry.js';
import { imageStatusOf, isImageAvailable } from '../engines/engine-registry.js';
import type { PrismSearchConfig } from '../config/config-schema.js';
import type { EngineStatus, SearchProvider } from '../engines/engine-interface.js';
import { capabilitiesOf, type EngineCapabilities } from '../engines/engine-capabilities.js';

export interface WorkerStatusSummary {
  name: string;
  url: string;
  healthy: boolean;
  capabilities: string[];
  inFlight: number;
  lastError?: string;
}

export interface ListEnginesToolDeps {
  engineRegistry: EngineRegistry;
  config: PrismSearchConfig;
  wechatEngine?: SearchProvider;
  workers?: () => WorkerStatusSummary[];
}

export interface EngineInfo {
  name: string;
  displayName: string;
  type: 'scraper' | 'api';
  enabled: boolean;
  available: boolean;
  priority: number;
  regions: string[];
  tools: string[];
  supportsImageSearch: boolean;
  capabilities: EngineCapabilities;
  stats: EngineStatsInfo;
  /** 图片搜索的独立统计与熔断状态（仅支持图片搜索的引擎有） */
  imageStats?: EngineStatsInfo & { available: boolean };
}

interface EngineStatsInfo {
  avgLatency: number;
  successRate: number;
  lastUsed?: number;
  lastError?: string;
}

function toStatsInfo(status: EngineStatus): EngineStatsInfo {
  return {
    avgLatency: Math.round(status.latency),
    successRate: Number(status.successRate.toFixed(3)),
    lastUsed: status.lastUsed,
    lastError: status.lastError,
  };
}

export interface ListEnginesResponse {
  engines: EngineInfo[];
  totalConfigured: number;
  totalEnabled: number;
  totalAvailable: number;
  workers?: WorkerStatusSummary[];
}

function fromProvider(provider: SearchProvider, base: Omit<EngineInfo, 'available' | 'stats' | 'supportsImageSearch' | 'capabilities'>): EngineInfo {
  const status = provider.getStatus();
  const supportsImageSearch = typeof provider.imageSearch === 'function';
  const info: EngineInfo = {
    ...base,
    available: status.available,
    supportsImageSearch,
    capabilities: capabilitiesOf(base.name),
    stats: toStatsInfo(status),
  };
  if (supportsImageSearch) {
    info.imageStats = { available: isImageAvailable(provider), ...toStatsInfo(imageStatusOf(provider)) };
  }
  return info;
}

export function handleListEngines(deps: ListEnginesToolDeps): ListEnginesResponse {
  const { engineRegistry, config } = deps;

  const engines: EngineInfo[] = config.engines.map(engineConfig => {
    const base = {
      name: engineConfig.name,
      displayName: engineConfig.displayName ?? engineConfig.name,
      type: engineConfig.type,
      enabled: engineConfig.enabled,
      priority: engineConfig.priority,
      regions: engineConfig.regions,
      tools: ['web_search'],
    };
    const provider = engineConfig.enabled ? engineRegistry.get(engineConfig.name) : undefined;
    if (!provider) {
      return {
        ...base,
        available: false,
        supportsImageSearch: false,
        capabilities: capabilitiesOf(engineConfig.name),
        stats: { avgLatency: 0, successRate: 0 },
      };
    }
    const info = fromProvider(provider, base);
    if (info.supportsImageSearch) info.tools.push('image_search');
    return info;
  });

  engines.push(
    deps.wechatEngine
      ? fromProvider(deps.wechatEngine, {
          name: 'wechat',
          displayName: deps.wechatEngine.displayName,
          type: 'scraper',
          enabled: true,
          priority: 99,
          regions: ['cn'],
          tools: ['wechat_search'],
        })
      : {
          name: 'wechat',
          displayName: '微信公众号（搜狗）',
          type: 'scraper',
          enabled: false,
          available: false,
          priority: 99,
          regions: ['cn'],
          tools: ['wechat_search'],
          supportsImageSearch: false,
          capabilities: capabilitiesOf('wechat'),
          stats: { avgLatency: 0, successRate: 0 },
        },
  );

  engines.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.priority - b.priority);

  const response: ListEnginesResponse = {
    engines,
    totalConfigured: engines.length,
    totalEnabled: engines.filter(e => e.enabled).length,
    totalAvailable: engines.filter(e => e.available).length,
  };
  const workers = deps.workers?.();
  if (workers && workers.length > 0) response.workers = workers;
  return response;
}
