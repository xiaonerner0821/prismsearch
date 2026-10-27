import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/security/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      maxRequests: 3,
      windowMs: 1000,
    });
  });

  afterEach(() => {
    limiter.destroy();
  });

  it('允许未超限的请求', () => {
    const result = limiter.consume('test-key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it('超限后拒绝请求', () => {
    limiter.consume('test-key');
    limiter.consume('test-key');
    limiter.consume('test-key');
    const result = limiter.consume('test-key');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('不同key独立计数', () => {
    limiter.consume('key-a');
    limiter.consume('key-a');
    limiter.consume('key-a');

    const result = limiter.consume('key-b');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it('check不消耗配额', () => {
    const check1 = limiter.check('test-key');
    expect(check1.allowed).toBe(true);
    expect(check1.remaining).toBe(3);

    const check2 = limiter.check('test-key');
    expect(check2.remaining).toBe(3); // 仍然是3
  });

  it('reset重置指定key', () => {
    limiter.consume('test-key');
    limiter.consume('test-key');
    limiter.reset('test-key');

    const result = limiter.consume('test-key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it('resetAll重置所有key', () => {
    limiter.consume('key-a');
    limiter.consume('key-b');
    limiter.resetAll();

    expect(limiter.check('key-a').remaining).toBe(3);
    expect(limiter.check('key-b').remaining).toBe(3);
  });

  it('窗口过期后恢复配额', async () => {
    limiter.consume('test-key');
    limiter.consume('test-key');
    limiter.consume('test-key');

    // 等待窗口过期
    await new Promise(resolve => setTimeout(resolve, 1100));

    const result = limiter.consume('test-key');
    expect(result.allowed).toBe(true);
  });
});
