/**
 * 代理池 — 管理、轮换代理地址，并复用 undici ProxyAgent
 *
 * - 轮询策略选择代理
 * - 连续失败达到阈值后进入冷却，冷却到期自动恢复（不再需要人工 restore）
 * - 每个代理地址只创建一个 ProxyAgent 并复用，close() 时统一释放连接
 */

import { ProxyAgent, type Dispatcher } from 'undici';
import type { ProxyConfig } from '../config/config-schema.js';

interface ProxyState {
  url: string;
  failCount: number;
  disabledUntil: number;
}

export interface ProxyPoolOptions {
  /** 连续失败多少次后进入冷却 */
  maxFailures?: number;
  /** 冷却时长（毫秒） */
  cooldownMs?: number;
  /** 可注入时钟，便于测试 */
  now?: () => number;
}

export class ProxyPool {
  private readonly proxies = new Map<string, ProxyState>();
  private readonly agents = new Map<string, ProxyAgent>();
  private index = 0;
  private readonly enabled: boolean;
  private readonly maxFailures: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(config?: Partial<ProxyConfig>, options: ProxyPoolOptions = {}) {
    this.enabled = Boolean(config?.enabled) && (config?.pool?.length ?? 0) > 0;
    this.maxFailures = options.maxFailures ?? 3;
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    for (const raw of config?.pool ?? []) {
      const url = raw.trim();
      if (!url) continue;
      // 构造时校验地址合法性，避免运行期才报错
      new URL(url);
      this.proxies.set(url, { url, failCount: 0, disabledUntil: 0 });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 获取下一个可用代理（轮询；冷却到期的代理自动恢复） */
  getProxy(): string | undefined {
    if (!this.enabled) return undefined;
    const available = this.getAvailable();
    if (available.length === 0) return undefined;
    const proxy = available[this.index % available.length];
    this.index = (this.index + 1) % Number.MAX_SAFE_INTEGER;
    return proxy;
  }

  /** 获取某代理对应的复用 dispatcher */
  getDispatcher(proxy: string): Dispatcher {
    let agent = this.agents.get(proxy);
    if (!agent) {
      agent = new ProxyAgent(proxy);
      this.agents.set(proxy, agent);
    }
    return agent;
  }

  /**
   * 选一个代理并返回 { proxy, dispatcher }；未启用时返回 undefined。
   * 所有代理都在冷却时，返回冷却最早结束的那个——启用了代理池就绝不悄悄直连
   * （直连会暴露本机出口 IP，也可能根本不通）。
   */
  acquire(): { proxy: string; dispatcher: Dispatcher } | undefined {
    if (!this.enabled) return undefined;
    const proxy = this.getProxy() ?? this.soonestRecovering();
    if (!proxy) return undefined;
    return { proxy, dispatcher: this.getDispatcher(proxy) };
  }

  private soonestRecovering(): string | undefined {
    let best: ProxyState | undefined;
    for (const state of this.proxies.values()) {
      if (!best || state.disabledUntil < best.disabledUntil) best = state;
    }
    return best?.url;
  }

  reportSuccess(proxy: string): void {
    const state = this.proxies.get(proxy);
    if (state) {
      state.failCount = 0;
      state.disabledUntil = 0;
    }
  }

  /** 连续失败超过阈值进入冷却 */
  reportFailure(proxy: string): void {
    const state = this.proxies.get(proxy);
    if (!state) return;
    state.failCount++;
    if (state.failCount >= this.maxFailures) {
      state.disabledUntil = this.now() + this.cooldownMs;
      state.failCount = 0;
    }
  }

  /** 当前可用的代理列表 */
  getAvailable(): string[] {
    const now = this.now();
    const result: string[] = [];
    for (const state of this.proxies.values()) {
      if (state.disabledUntil <= now) result.push(state.url);
    }
    return result;
  }

  /** 立即恢复所有代理 */
  restore(): void {
    for (const state of this.proxies.values()) {
      state.failCount = 0;
      state.disabledUntil = 0;
    }
  }

  /** 释放所有代理连接 */
  async close(): Promise<void> {
    const agents = [...this.agents.values()];
    this.agents.clear();
    await Promise.allSettled(agents.map(a => a.close()));
  }
}
