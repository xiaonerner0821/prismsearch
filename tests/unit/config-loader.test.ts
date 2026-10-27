/**
 * config-loader 单元测试：合并规则、环境变量覆盖、文件解析与校验
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  applyEnvOverrides,
  buildConfig,
  ConfigValidationError,
  deepMerge,
  expandHome,
  getConfig,
  loadConfig,
  mergeEngines,
  reloadConfig,
  resolveConfigFile,
} from '../../src/config/config-loader.js';
import { assertSafeExposure } from '../../src/server/http-transport.js';

describe('expandHome', () => {
  it('展开 ~ 与 ~/ 前缀，其余路径保持不变', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/a/b')).toBe(join(homedir(), 'a/b'));
    expect(expandHome('./rel')).toBe('./rel');
    expect(expandHome('/abs')).toBe('/abs');
  });
});

describe('deepMerge', () => {
  it('对象递归合并，数组与原始值整体替换，undefined 跳过', () => {
    const merged = deepMerge(
      { a: { x: 1, y: 2 }, list: [1, 2], keep: 'yes' },
      { a: { y: 3 }, list: [9], keep: undefined },
    );
    expect(merged).toEqual({ a: { x: 1, y: 3 }, list: [9], keep: 'yes' });
  });

  it('不修改输入对象', () => {
    const target = { a: { x: 1 } };
    deepMerge(target, { a: { x: 2 } });
    expect(target.a.x).toBe(1);
  });

  it('null 视为未设置（YAML 空节点不抹掉默认值）', () => {
    const merged = deepMerge(
      { sqlite: { path: 'x' }, endpoints: [], level: 'info' },
      { sqlite: null, endpoints: null, level: null },
    );
    expect(merged).toEqual({ sqlite: { path: 'x' }, endpoints: [], level: 'info' });
  });
});

describe('mergeEngines', () => {
  const builtin = [
    { name: 'google', enabled: false, rateLimit: { maxRequests: 10, windowMs: 1000 } },
    { name: 'bing', enabled: true },
  ];

  it('同名条目逐字段深度合并，未列出的内置引擎保持原样', () => {
    const merged = mergeEngines(builtin, [{ name: 'google', enabled: true, rateLimit: { maxRequests: 5 } }]);
    const google = merged.find(e => e.name === 'google')!;
    expect(google).toMatchObject({ enabled: true, rateLimit: { maxRequests: 5, windowMs: 1000 } });
    expect(merged.find(e => e.name === 'bing')).toEqual({ name: 'bing', enabled: true });
  });

  it('新增的未知引擎原样追加，且不影响内置定义', () => {
    const merged = mergeEngines(builtin, [{ name: 'custom', enabled: true }]);
    expect(merged.map(e => e.name)).toEqual(['google', 'bing', 'custom']);
    expect(builtin[0].enabled).toBe(false);
  });

  it('非数组或缺少 name 时抛出 ConfigValidationError', () => {
    expect(() => mergeEngines(builtin, { google: {} })).toThrow(ConfigValidationError);
    expect(() => mergeEngines(builtin, [{ enabled: true }])).toThrow(/name/);
  });

  it('user 为空时返回内置列表的拷贝', () => {
    const merged = mergeEngines(builtin, undefined);
    expect(merged).toEqual(builtin);
    expect(merged[0]).not.toBe(builtin[0]);
  });
});

describe('applyEnvOverrides', () => {
  function sample() {
    return {
      server: { port: 3000, host: '127.0.0.1', transport: 'stdio' },
      cache: { enabled: true, ttl: 60 },
      fetcher: { allowedSchemes: ['http', 'https'] },
      engines: [{ name: 'google', enabled: false, rateLimit: { maxRequests: 10 } }],
    } as Record<string, any>;
  }

  it('单下划线写法：按字段名贪心匹配并做类型转换', () => {
    const config = sample();
    const warnings = applyEnvOverrides(config, {
      PRISMSEARCH_SERVER_PORT: '8080',
      PRISMSEARCH_CACHE_ENABLED: 'false',
      PRISMSEARCH_SERVER_HOST: '0.0.0.0',
    });
    expect(warnings).toEqual([]);
    expect(config.server.port).toBe(8080);
    expect(config.cache.enabled).toBe(false);
    expect(config.server.host).toBe('0.0.0.0');
  });

  it('驼峰字段可用多段下划线定位（rate_limit → rateLimit）', () => {
    const config = sample();
    applyEnvOverrides(config, { PRISMSEARCH_ENGINES_GOOGLE_RATE_LIMIT_MAX_REQUESTS: '3' });
    expect(config.engines[0].rateLimit.maxRequests).toBe(3);
  });

  it('双下划线写法：每组是一个完整字段名', () => {
    const config = sample();
    applyEnvOverrides(config, {
      PRISMSEARCH_ENGINES__GOOGLE__ENABLED: 'true',
      PRISMSEARCH_ENGINES__GOOGLE__RATE_LIMIT__MAX_REQUESTS: '7',
    });
    expect(config.engines[0].enabled).toBe(true);
    expect(config.engines[0].rateLimit.maxRequests).toBe(7);
  });

  it('引擎下登记过的可选字段（apiKey）可以通过环境变量写入', () => {
    const config = sample();
    applyEnvOverrides(config, { PRISMSEARCH_ENGINES__GOOGLE__API_KEY: 'AIza-test' });
    expect(config.engines[0].apiKey).toBe('AIza-test');
  });

  it('字符串字段即使值形似数字也保持字符串', () => {
    const config = sample();
    applyEnvOverrides(config, { PRISMSEARCH_SERVER_HOST: '123' });
    expect(config.server.host).toBe('123');
  });

  it('数组字段支持逗号分隔与 JSON 两种写法', () => {
    const a = sample();
    applyEnvOverrides(a, { PRISMSEARCH_FETCHER_ALLOWED_SCHEMES: 'https, http ,' });
    expect(a.fetcher.allowedSchemes).toEqual(['https', 'http']);

    const b = sample();
    applyEnvOverrides(b, { PRISMSEARCH_FETCHER_ALLOWED_SCHEMES: '["https"]' });
    expect(b.fetcher.allowedSchemes).toEqual(['https']);
  });

  it('无法识别的变量产生警告且不写入垃圾字段', () => {
    const config = sample();
    const warnings = applyEnvOverrides(config, { PRISMSEARCH_SERVR_PORT: '1' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('PRISMSEARCH_SERVR_PORT');
    expect(config).toEqual(sample());
  });

  it('保留变量不走通用解析；PRISMSEARCH_AUTH_TOKENS 写入 security.auth.tokens', () => {
    const config = sample();
    const warnings = applyEnvOverrides(config, {
      PRISMSEARCH_HOME: '/tmp/x',
      PRISMSEARCH_WORKER_TOKEN: 'w',
      PRISMSEARCH_AUTH_TOKENS: 'a, b,,c',
      OTHER_VAR: 'ignored',
    });
    expect(warnings).toEqual([]);
    expect(config.security.auth.tokens).toEqual(['a', 'b', 'c']);
    expect(config.security.auth.enabled).toBe(true);
  });

  it('PRISMSEARCH_AUTH_TOKENS 为空时不开启鉴权', () => {
    const config = sample();
    applyEnvOverrides(config, { PRISMSEARCH_AUTH_TOKENS: ' , ' });
    expect(config.security.auth.tokens).toEqual([]);
    expect(config.security.auth.enabled).toBeUndefined();
  });
});

describe('buildConfig', () => {
  it('空配置得到通过校验的完整默认值', () => {
    const { config, warnings } = buildConfig({}, {});
    expect(warnings).toEqual([]);
    expect(config.engines.length).toBeGreaterThan(0);
    // 缓存路径默认落在数据目录下的绝对路径
    expect(config.cache.sqlite.path).toMatch(/cache\.db$/);
  });

  it('文件配置与环境变量叠加，环境变量优先', () => {
    const { config } = buildConfig(
      { server: { port: 4000 } },
      { PRISMSEARCH_SERVER_PORT: '5000' },
    );
    expect(config.server.port).toBe(5000);
  });

  it('Docker 同款环境变量：监听 0.0.0.0 + 仅设置令牌即可通过暴露检查', () => {
    const { config, warnings } = buildConfig({}, {
      PRISMSEARCH_SERVER_TRANSPORT: 'http',
      PRISMSEARCH_SERVER_HOST: '0.0.0.0',
      PRISMSEARCH_SERVER_PORT: '3000',
      PRISMSEARCH_AUTH_TOKENS: 'docker-token',
    });
    expect(warnings).toEqual([]);
    expect(config.security.auth.enabled).toBe(true);
    expect(config.security.auth.tokens).toEqual(['docker-token']);
    expect(() => assertSafeExposure(config)).not.toThrow();
  });

  it('文件里显式 auth.enabled: false 时，环境变量令牌仍会开启鉴权', () => {
    const { config } = buildConfig(
      { security: { auth: { enabled: false } } },
      { PRISMSEARCH_AUTH_TOKENS: 't1' },
    );
    expect(config.security.auth.enabled).toBe(true);
  });

  it('校验失败时抛出带来源与字段路径的 ConfigValidationError', () => {
    const error = (() => {
      try {
        buildConfig({ server: { port: 'not-a-port' } }, {}, 'my.yaml');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ConfigValidationError);
    const err = error as ConfigValidationError;
    expect(err.source).toBe('my.yaml');
    expect(err.issues.some(i => i.startsWith('server.port'))).toBe(true);
    expect(err.message).toContain('my.yaml');
  });
});

describe('loadConfig / resolveConfigFile', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prismsearch-cfg-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('显式指定不存在的文件时报错', async () => {
    await expect(resolveConfigFile(join(dir, 'missing.yaml'))).rejects.toThrow(/不存在/);
  });

  it.each([
    ['config.yaml', 'server:\n  port: 4101\n', 4101],
    ['config.json', '{"server":{"port":4102}}', 4102],
    ['config.toml', '[server]\nport = 4103\n', 4103],
  ])('按扩展名解析 %s', async (name, content, port) => {
    const file = join(dir, name);
    await writeFile(file, content, 'utf-8');
    const loaded = await loadConfig(file);
    expect(loaded.path).toBe(file);
    expect(loaded.config.server.port).toBe(port);
    expect(getConfig().server.port).toBe(port);
  });

  it('reloadConfig 重新读取同一个文件', async () => {
    const file = join(dir, 'reload.yaml');
    await writeFile(file, 'server:\n  port: 4201\n', 'utf-8');
    await loadConfig(file);
    await writeFile(file, 'server:\n  port: 4202\n', 'utf-8');
    const reloaded = await reloadConfig();
    expect(reloaded.config.server.port).toBe(4202);
  });

  it.each([
    ['config/default.yaml'],
    ['config/http.yaml'],
  ])('仓库自带的示例配置 %s 能通过校验且无警告', async rel => {
    const loaded = await loadConfig(join(process.cwd(), rel));
    expect(loaded.warnings).toEqual([]);
  });

  it('语法错误与非对象顶层都报 ConfigValidationError', async () => {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{oops', 'utf-8');
    await expect(loadConfig(bad)).rejects.toThrow(/无法解析配置文件/);

    const list = join(dir, 'list.yaml');
    await writeFile(list, '- a\n- b\n', 'utf-8');
    await expect(loadConfig(list)).rejects.toThrow(/顶层必须是对象/);
  });
});
