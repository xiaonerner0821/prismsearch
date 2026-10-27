/**
 * 引擎注册中心 — 管理所有搜索引擎的注册与发现
 */

import type { SearchProvider, EngineStatus } from './engine-interface.js';

/** 图片搜索可用性：引擎实现了独立判断就用它，否则视同网页可用性 */
export function isImageAvailable(engine: SearchProvider): boolean {
  return engine.isImageAvailable ? engine.isImageAvailable() : engine.isAvailable();
}

/** 图片搜索统计：引擎有独立的图片统计就用它，否则视同网页统计 */
export function imageStatusOf(engine: SearchProvider): EngineStatus {
  return engine.getImageStatus ? engine.getImageStatus() : engine.getStatus();
}

export class EngineRegistry {
  private engines: Map<string, SearchProvider> = new Map();

  // 注册引擎
  register(provider: SearchProvider): void {
    this.engines.set(provider.name, provider);
  }

  // 注销引擎
  unregister(name: string): void {
    this.engines.delete(name);
  }

  // 获取指定引擎
  get(name: string): SearchProvider | undefined {
    return this.engines.get(name);
  }

  // 获取所有引擎
  getAll(): SearchProvider[] {
    return Array.from(this.engines.values());
  }

  // 获取所有可用引擎
  getAvailable(): SearchProvider[] {
    return this.getAll().filter(e => e.isAvailable());
  }

  // 获取支持图片搜索的可用引擎（图片有独立熔断：网页熔断不影响图片，反之亦然）
  getImageSearchAvailable(): SearchProvider[] {
    return this.getAll().filter(e => typeof e.imageSearch === 'function' && isImageAvailable(e));
  }

  // 获取所有引擎状态
  getStatus(): EngineStatus[] {
    return this.getAll().map(e => e.getStatus());
  }

  // 是否已注册
  has(name: string): boolean {
    return this.engines.has(name);
  }

  // 引擎数量
  get size(): number {
    return this.engines.size;
  }
}

// 全局单例
let globalRegistry: EngineRegistry | null = null;

export function getEngineRegistry(): EngineRegistry {
  if (!globalRegistry) {
    globalRegistry = new EngineRegistry();
  }
  return globalRegistry;
}
