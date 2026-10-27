import { describe, it, expect, afterEach } from 'vitest';
import { isBlockedIp, assertUrlAllowed, configureSsrf, SsrfBlockedError } from './ssrf.js';

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::10.0.0.1',
    '0:0:0:0:0:0:0:1', '2001:db8::1', '2002:7f00:1::', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  ])('拒绝内网/保留地址 %s', ip => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    '放行公网地址 %s',
    ip => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it('无法解析的输入一律拒绝', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

describe('assertUrlAllowed', () => {
  afterEach(() => configureSsrf({}));

  it('拒绝非 http(s) 协议', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlAllowed('gopher://x')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('拒绝携带凭据的 URL', async () => {
    await expect(assertUrlAllowed('http://user:pass@example.com/')).rejects.toThrow(/用户名或密码/);
  });

  it('拒绝 IP 字面量的内网地址（含 IPv6 方括号形式）', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1:8080/')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlAllowed('http://[::1]/')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('localhost 解析到回环时拒绝', async () => {
    await expect(assertUrlAllowed('http://localhost/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('放行公网 IP 字面量', async () => {
    const url = await assertUrlAllowed('https://1.1.1.1/');
    expect(url.hostname).toBe('1.1.1.1');
  });

  it('allowPrivateNetwork 全局放行已禁用', async () => {
    expect(() => configureSsrf({ allowPrivateNetwork: true })).toThrow(/全局/);
    await expect(assertUrlAllowed('http://127.0.0.1/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
