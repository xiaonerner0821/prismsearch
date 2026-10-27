import { describe, it, expect } from 'vitest';
import { SsrfGuard, SsrfBlockedError } from '../../src/security/ssrf-guard.js';

const defaultOptions = {
  enabled: true,
  allowedProtocols: ['http:', 'https:'],
  blockedIpRanges: [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '0.0.0.0/8',
  ],
  whitelist: [],
  blacklist: [],
  dnsRebindingProtection: false,
};

describe('SsrfGuard', () => {
  it('disabled时放行所有URL', async () => {
    const guard = new SsrfGuard({ ...defaultOptions, enabled: false });
    const result = await guard.validateUrl('http://127.0.0.1/admin');
    expect(result.safe).toBe(true);
  });

  it('拒绝非法协议', async () => {
    const guard = new SsrfGuard(defaultOptions);
    const result = await guard.validateUrl('file:///etc/passwd');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('不允许的协议');
  });

  it('拒绝ftp协议', async () => {
    const guard = new SsrfGuard(defaultOptions);
    const result = await guard.validateUrl('ftp://example.com/file');
    expect(result.safe).toBe(false);
  });

  it('拒绝无效URL', async () => {
    const guard = new SsrfGuard(defaultOptions);
    const result = await guard.validateUrl('not-a-url');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('URL格式无效');
  });

  it('拒绝127.0.0.1', async () => {
    const guard = new SsrfGuard(defaultOptions);
    const result = await guard.validateUrl('http://127.0.0.1/admin');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('IP地址被禁止');
  });

  it('拒绝10.x.x.x内网IP', async () => {
    const guard = new SsrfGuard(defaultOptions);
    const result = await guard.validateUrl('http://10.0.0.1:8080');
    expect(result.safe).toBe(false);
  });

  it('拒绝192.168.x.x内网IP', async () => {
    const guard = new SsrfGuard(defaultOptions);
    const result = await guard.validateUrl('http://192.168.1.1');
    expect(result.safe).toBe(false);
  });

  it('拒绝169.254.x.x链路本地地址', async () => {
    const guard = new SsrfGuard(defaultOptions);
    const result = await guard.validateUrl('http://169.254.169.254/metadata');
    expect(result.safe).toBe(false);
  });

  it('拒绝172.16-31.x.x内网IP', async () => {
    const guard = new SsrfGuard(defaultOptions);
    const result1 = await guard.validateUrl('http://172.16.0.1');
    expect(result1.safe).toBe(false);
    const result2 = await guard.validateUrl('http://172.31.255.255');
    expect(result2.safe).toBe(false);
  });

  it('黑名单域名被拒绝', async () => {
    const guard = new SsrfGuard({
      ...defaultOptions,
      blacklist: ['evil.com', '*.malware.org'],
    });
    const result = await guard.validateUrl('https://evil.com/path');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('黑名单');
  });

  it('通配符黑名单匹配子域名', async () => {
    const guard = new SsrfGuard({
      ...defaultOptions,
      blacklist: ['*.malware.org'],
    });
    const result = await guard.validateUrl('https://sub.malware.org/path');
    expect(result.safe).toBe(false);
  });

  it('白名单域名仍校验解析后的公网地址', async () => {
    const guard = new SsrfGuard({
      ...defaultOptions,
      whitelist: ['trusted.com'],
    }, { lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
    const result = await guard.validateUrl('https://trusted.com/api');
    expect(result.safe).toBe(true);
  });
});

describe('SsrfGuard：DNS 解析与建连校验', () => {
  type Addr = { address: string; family: number };
  const fakeLookup = (table: Record<string, Addr[] | Error>) =>
    async (hostname: string) => {
      const entry = table[hostname];
      if (entry instanceof Error) throw entry;
      return entry ?? [];
    };
  const opts = { ...defaultOptions, blockedIpRanges: [], dnsRebindingProtection: true };

  it('内置禁止段始终生效（即使用户配置为空）', () => {
    const guard = new SsrfGuard(opts);
    for (const ip of ['127.0.0.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      expect(guard.isBlockedAddress(ip)).toBe(true);
    }
    expect(guard.isBlockedAddress('8.8.8.8')).toBe(false);
    expect(guard.isBlockedAddress('2001:4860:4860::8888')).toBe(false);
    expect(guard.isBlockedAddress('not-an-ip')).toBe(true);
  });

  it('拒绝 IPv6 字面量与 URL 中的认证信息', async () => {
    const guard = new SsrfGuard(opts);
    expect((await guard.validateUrl('http://[::1]/')).safe).toBe(false);
    expect((await guard.validateUrl('http://[::ffff:169.254.169.254]/')).safe).toBe(false);
    const cred = await guard.validateUrl('http://user:pass@example.com/');
    expect(cred.safe).toBe(false);
    expect(cred.reason).toContain('认证信息');
  });

  it('解析结果中任何一个地址落在禁止段都拒绝', async () => {
    const guard = new SsrfGuard(opts, {
      lookup: fakeLookup({
        'mixed.test': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
        'public.test': [{ address: '93.184.216.34', family: 4 }],
      }),
    });
    const mixed = await guard.validateUrl('https://mixed.test/');
    expect(mixed.safe).toBe(false);
    expect(mixed.reason).toContain('10.0.0.5');
    expect((await guard.validateUrl('https://public.test/')).safe).toBe(true);
  });

  it('DNS 解析失败或无结果时拒绝', async () => {
    const guard = new SsrfGuard(opts, {
      lookup: fakeLookup({ 'fail.test': new Error('ENOTFOUND'), 'empty.test': [] }),
    });
    expect((await guard.validateUrl('https://fail.test/')).reason).toContain('DNS解析失败');
    expect((await guard.validateUrl('https://empty.test/')).reason).toContain('DNS解析无结果');
  });

  it('assertSafe 预检失败抛出 SsrfBlockedError', async () => {
    const guard = new SsrfGuard(opts);
    await expect(guard.assertSafe('http://127.0.0.1/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  const runLookup = (guard: SsrfGuard, host: string, all: boolean) =>
    new Promise<{ err: unknown; args: unknown[] }>(resolve => {
      const lookup = guard.createSafeLookup() as unknown as (
        h: string, o: { all?: boolean }, cb: (err: unknown, ...args: unknown[]) => void,
      ) => void;
      lookup(host, { all }, (err, ...args) => resolve({ err, args }));
    });

  it('建连 lookup 过滤禁止地址，只返回允许的地址', async () => {
    const guard = new SsrfGuard(opts, {
      lookup: fakeLookup({
        'rebind.test': [{ address: '127.0.0.1', family: 4 }, { address: '93.184.216.34', family: 4 }],
      }),
    });
    const single = await runLookup(guard, 'rebind.test', false);
    expect(single.err).toBeNull();
    expect(single.args).toEqual(['93.184.216.34', 4]);

    const all = await runLookup(guard, 'rebind.test', true);
    expect(all.args[0]).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('建连 lookup 全部地址被禁止时报 SsrfBlockedError（模拟 DNS 重绑定）', async () => {
    const guard = new SsrfGuard(opts, {
      lookup: fakeLookup({ 'evil.test': [{ address: '169.254.169.254', family: 4 }] }),
    });
    const { err } = await runLookup(guard, 'evil.test', false);
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it('建连 lookup 对普通白名单域名仍过滤私网地址', async () => {
    const guard = new SsrfGuard({ ...opts, whitelist: ['intranet.test'] }, {
      lookup: fakeLookup({ 'intranet.test': [{ address: '10.1.2.3', family: 4 }] }),
    });
    const { err } = await runLookup(guard, 'intranet.test', false);
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it('仅显式 allowedPrivateHosts 可放行受控内网域名', async () => {
    const guard = new SsrfGuard({ ...opts, allowedPrivateHosts: ['intranet.test'] }, {
      lookup: fakeLookup({ 'intranet.test': [{ address: '10.1.2.3', family: 4 }] }),
    });
    const { err, args } = await runLookup(guard, 'intranet.test', false);
    expect(err).toBeNull();
    expect(args).toEqual(['10.1.2.3', 4]);
  });

  it.each(['127.0.0.1', '169.254.169.254', '::1', 'fe80::1'])('显式私网域名例外不能访问回环或元数据：%s', address => {
    const guard = new SsrfGuard({ ...opts, allowedPrivateHosts: ['intranet.test'] }, {
      lookup: fakeLookup({ 'intranet.test': [{ address, family: address.includes(':') ? 6 : 4 }] }),
    });
    return Promise.all([
      guard.validateUrl('http://intranet.test/').then(result => expect(result.safe).toBe(false)),
      runLookup(guard, 'intranet.test', false).then(({ err }) => expect(err).toBeInstanceOf(SsrfBlockedError)),
    ]);
  });

  it('getDispatcher：关闭防护时返回 undefined，开启时复用同一实例', async () => {
    expect(new SsrfGuard({ ...opts, dnsRebindingProtection: false }).getDispatcher()).toBeUndefined();
    expect(new SsrfGuard({ ...opts, enabled: false }).getDispatcher()).toBeUndefined();
    const guard = new SsrfGuard(opts);
    const d = guard.getDispatcher();
    expect(d).toBeDefined();
    expect(guard.getDispatcher()).toBe(d);
    await guard.close();
  });

  it('非法 CIDR 配置在构造时报错', () => {
    expect(() => new SsrfGuard({ ...opts, blockedIpRanges: ['10.0.0.0/33'] })).toThrow(/CIDR/);
    expect(() => new SsrfGuard({ ...opts, blockedIpRanges: ['nope/8'] })).toThrow(/CIDR/);
  });
});
