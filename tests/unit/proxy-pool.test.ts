/**
 * ProxyPool 单元测试
 *
 * 注意：不实际发起网络请求，只验证轮换、冷却与恢复逻辑。
 * ProxyAgent 只创建不连接，close() 时统一释放。
 */

import { describe, it, expect } from 'vitest';
import { ProxyPool } from '../../src/utils/proxy-pool.js';

const P1 = 'http://proxy1.example.com:8080';
const P2 = 'http://proxy2.example.com:8080';

function makePool(pool: string[] = [P1, P2], options: { maxFailures?: number; cooldownMs?: number } = {}) {
  let now = 1000;
  const instance = new ProxyPool(
    { enabled: true, pool },
    { maxFailures: options.maxFailures ?? 3, cooldownMs: options.cooldownMs ?? 60_000, now: () => now },
  );
  return { pool: instance, advance: (ms: number) => { now += ms; } };
}

describe('ProxyPool 启用与配置', () => {
  it('enabled 为 false 或池为空时不可用', async () => {
    expect(new ProxyPool({ enabled: false, pool: [P1] }).isEnabled()).toBe(false);
    expect(new ProxyPool({ enabled: true, pool: [] }).isEnabled()).toBe(false);

    const disabled = new ProxyPool({ enabled: false, pool: [P1] });
    expect(disabled.getProxy()).toBeUndefined();
    expect(disabled.acquire()).toBeUndefined();
    await disabled.close();
  });

  it('池中的空字符串与重复项被忽略', async () => {
    const pool = new ProxyPool({ enabled: true, pool: ['', '  ', P1, P1, P2] });
    expect(pool.getAvailable()).toEqual([P1, P2]);
    await pool.close();
  });

  it('非法代理地址在构造时就抛错', () => {
    expect(() => new ProxyPool({ enabled: true, pool: ['not a url'] })).toThrow();
  });
});

describe('ProxyPool 轮换', () => {
  it('按顺序轮询全部代理后回到第一个', async () => {
    const { pool } = makePool();
    expect([pool.getProxy(), pool.getProxy(), pool.getProxy()]).toEqual([P1, P2, P1]);
    await pool.close();
  });

  it('acquire 返回代理与其复用 dispatcher', async () => {
    const { pool } = makePool();
    const first = pool.acquire()!;
    expect(first.proxy).toBe(P1);
    expect(pool.getDispatcher(P1)).toBe(first.dispatcher);
    await pool.close();
  });
});

describe('ProxyPool 失败冷却', () => {
  it('达到失败阈值后进入冷却，不再被选中', async () => {
    const { pool } = makePool([P1, P2], { maxFailures: 2 });
    pool.reportFailure(P1);
    expect(pool.getAvailable()).toContain(P1);
    pool.reportFailure(P1);
    expect(pool.getAvailable()).toEqual([P2]);
    await pool.close();
  });

  it('冷却到期后自动恢复可用', async () => {
    const { pool, advance } = makePool([P1], { maxFailures: 1, cooldownMs: 5000 });
    pool.reportFailure(P1);
    expect(pool.getAvailable()).toEqual([]);
    advance(4999);
    expect(pool.getAvailable()).toEqual([]);
    advance(1);
    expect(pool.getAvailable()).toEqual([P1]);
    await pool.close();
  });

  it('成功后清零失败计数，不会累积到冷却', async () => {
    const { pool } = makePool([P1], { maxFailures: 2 });
    pool.reportFailure(P1);
    pool.reportSuccess(P1);
    pool.reportFailure(P1);
    expect(pool.getAvailable()).toEqual([P1]);
    await pool.close();
  });

  it('所有代理都冷却时 getProxy 返回 undefined，acquire 选冷却最早结束的而不是直连', async () => {
    const { pool, advance } = makePool([P1, P2], { maxFailures: 1 });
    pool.reportFailure(P2);
    advance(10);
    pool.reportFailure(P1);
    expect(pool.getProxy()).toBeUndefined();
    expect(pool.acquire()?.proxy).toBe(P2);
    await pool.close();
  });

  it('restore 立即恢复所有代理', async () => {
    const { pool } = makePool([P1, P2], { maxFailures: 1 });
    pool.reportFailure(P1);
    pool.reportFailure(P2);
    pool.restore();
    expect(pool.getAvailable()).toEqual([P1, P2]);
    await pool.close();
  });

  it('对未知代理上报失败不会抛错', async () => {
    const { pool } = makePool();
    expect(() => pool.reportFailure('http://unknown:1')).not.toThrow();
    expect(() => pool.reportSuccess('http://unknown:1')).not.toThrow();
    await pool.close();
  });
});
