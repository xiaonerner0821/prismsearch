/**
 * EngineStats 统计与三态熔断器单元测试（注入时钟，不依赖真实时间）
 */

import { describe, it, expect } from 'vitest';
import { EngineStats, type CircuitBreakerOptions } from '../../src/engines/engine-stats.js';

const OPTS: CircuitBreakerOptions = { failureThreshold: 3, baseCooldownMs: 1000, maxCooldownMs: 4000 };

function makeStats() {
  let now = 0;
  const stats = new EngineStats(OPTS, () => now);
  return {
    stats,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('EngineStats 统计', () => {
  it('无历史时成功率为 1、平均延迟为 0、lastUsed 为空', () => {
    const { stats } = makeStats();
    expect(stats.getSuccessRate()).toBe(1);
    expect(stats.getAvgLatency()).toBe(0);
    expect(stats.getLastUsed()).toBeUndefined();
  });

  it('成功率与平均延迟只统计成功请求的延迟', () => {
    const { stats, advance } = makeStats();
    stats.record(true, 100);
    advance(10);
    stats.record(false, 9999, new Error('boom'));
    advance(10);
    stats.record(true, 300);

    expect(stats.getSuccessRate()).toBeCloseTo(2 / 3);
    expect(stats.getAvgLatency()).toBe(200);
    expect(stats.getLastUsed()).toBe(20);
    expect(stats.getLastError()).toBe('boom');
  });

  it('非 Error 的错误也会记录为字符串', () => {
    const { stats } = makeStats();
    stats.record(false, 1, 'plain failure');
    expect(stats.getLastError()).toBe('plain failure');
  });

  it('历史最多保留 100 条', () => {
    const { stats } = makeStats();
    for (let i = 0; i < 100; i++) stats.record(false, 1);
    for (let i = 0; i < 100; i++) stats.record(true, 1);
    expect(stats.getSuccessRate()).toBe(1);
  });

  it('连续失败次数在遇到成功时中断', () => {
    const { stats } = makeStats();
    stats.record(false, 1);
    stats.record(true, 1);
    stats.record(false, 1);
    stats.record(false, 1);
    expect(stats.getConsecutiveFailures()).toBe(2);
  });
});

describe('EngineStats 熔断器', () => {
  it('连续失败达到阈值后熔断', () => {
    const { stats } = makeStats();
    stats.record(false, 1);
    stats.record(false, 1);
    expect(stats.getState()).toBe('closed');
    stats.record(false, 1);
    expect(stats.getState()).toBe('open');
    expect(stats.isAvailable()).toBe(false);
    expect(stats.tryAcquire()).toBe(false);
  });

  it('冷却结束进入半开，只放行一个探测请求', () => {
    const { stats, advance } = makeStats();
    for (let i = 0; i < 3; i++) stats.record(false, 1);
    advance(1000);

    expect(stats.getState()).toBe('half-open');
    expect(stats.isAvailable()).toBe(true);
    expect(stats.tryAcquire()).toBe(true);
    // 探测进行中：其他请求不放行
    expect(stats.isAvailable()).toBe(false);
    expect(stats.tryAcquire()).toBe(false);
  });

  it('探测成功恢复为 closed', () => {
    const { stats, advance } = makeStats();
    for (let i = 0; i < 3; i++) stats.record(false, 1);
    advance(1000);
    stats.tryAcquire();
    stats.record(true, 1);
    expect(stats.getState()).toBe('closed');
    expect(stats.getCooldownMs()).toBe(1000);
  });

  it('探测失败重新熔断，冷却时间指数退避且有上限', () => {
    const { stats, advance } = makeStats();
    for (let i = 0; i < 3; i++) stats.record(false, 1);
    expect(stats.getCooldownMs()).toBe(1000);

    advance(1000);
    stats.tryAcquire();
    stats.record(false, 1);
    expect(stats.getState()).toBe('open');
    expect(stats.getCooldownMs()).toBe(2000);

    // 第二次冷却未结束仍为 open
    advance(1999);
    expect(stats.getState()).toBe('open');
    advance(1);
    expect(stats.getState()).toBe('half-open');
    stats.tryAcquire();
    stats.record(false, 1);
    expect(stats.getCooldownMs()).toBe(4000);

    advance(4000);
    stats.tryAcquire();
    stats.record(false, 1);
    // 达到上限后不再增长
    expect(stats.getCooldownMs()).toBe(4000);
  });

  it('reset 清空状态与历史', () => {
    const { stats } = makeStats();
    for (let i = 0; i < 3; i++) stats.record(false, 1, new Error('x'));
    stats.reset();
    expect(stats.getState()).toBe('closed');
    expect(stats.getLastError()).toBeUndefined();
    expect(stats.getConsecutiveFailures()).toBe(0);
    expect(stats.isAvailable()).toBe(true);
  });
});
