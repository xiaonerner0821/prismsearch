/**
 * 真实网络冒烟集成测试
 *
 * 默认跳过；仅在设置 RUN_LIVE_TESTS=1 时运行，见 tests/integration/README.md
 * 只验证「能拿到结构化结果」，不断言具体排名（搜索结果随时在变）。
 *
 * 环境变量：
 *   RUN_LIVE_TESTS=1         开启联网测试
 *   LIVE_TEST_ENGINES=a,b    只测指定引擎（默认 duckduckgo,brave,bing）；all 表示全部
 *   BRAVE_API_KEY            Brave 需要；未设置时该用例跳过
 *
 * 引擎配置取自内置默认值（与生产一致），而不是手写的简化配置。
 */
import { describe, it, expect } from 'vitest';
import { buildConfig } from '../../src/config/config-loader.js';
import type { EngineConfig } from '../../src/config/config-schema.js';
import type { SearchProvider } from '../../src/engines/engine-interface.js';
import { DuckDuckGoWebEngine } from '../../src/engines/duckduckgo/duckduckgo-web.js';
import { BraveWebEngine } from '../../src/engines/brave/brave-web.js';
import { BingWebEngine } from '../../src/engines/bing/bing-web.js';
import { BaiduWebEngine } from '../../src/engines/baidu/baidu-web.js';
import { SogouWebEngine } from '../../src/engines/sogou/sogou-web.js';
import { SoWebEngine } from '../../src/engines/so/so-web.js';
import { YandexWebEngine } from '../../src/engines/yandex/yandex-web.js';
import { GoogleWebEngine } from '../../src/engines/google/google-web.js';

const RUN_LIVE = !!process.env.RUN_LIVE_TESTS;

type Ctor = new (config: EngineConfig) => SearchProvider;

interface LiveCase {
  ctor: Ctor;
  query: string;
  /** 缺少该环境变量时跳过 */
  requiresEnv?: string;
}

const CASES: Record<string, LiveCase> = {
  duckduckgo: { ctor: DuckDuckGoWebEngine, query: 'model context protocol' },
  brave: { ctor: BraveWebEngine, query: 'model context protocol', requiresEnv: 'BRAVE_API_KEY' },
  bing: { ctor: BingWebEngine, query: 'model context protocol' },
  baidu: { ctor: BaiduWebEngine, query: '模型上下文协议' },
  sogou: { ctor: SogouWebEngine, query: '模型上下文协议' },
  so: { ctor: SoWebEngine, query: '模型上下文协议' },
  yandex: { ctor: YandexWebEngine, query: 'model context protocol' },
  google: { ctor: GoogleWebEngine, query: 'model context protocol' },
};

const DEFAULT_ENGINES = ['duckduckgo', 'brave', 'bing'];

function selectedEngines(): string[] {
  const raw = process.env.LIVE_TEST_ENGINES?.trim();
  if (!raw) return DEFAULT_ENGINES;
  if (raw === 'all') return Object.keys(CASES);
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  const unknown = names.filter(n => !(n in CASES));
  if (unknown.length) {
    throw new Error(`LIVE_TEST_ENGINES 包含未知引擎: ${unknown.join(', ')}（可选: ${Object.keys(CASES).join(', ')}）`);
  }
  return names;
}

function engineConfig(name: string): EngineConfig {
  const { config } = buildConfig({ engines: [{ name, enabled: true, timeout: 30_000 }] }, process.env);
  const found = config.engines.find(e => e.name === name);
  if (!found) throw new Error(`内置配置中没有引擎 ${name}`);
  return found;
}

describe.skipIf(!RUN_LIVE)('集成：真实搜索引擎冒烟', () => {
  for (const name of RUN_LIVE ? selectedEngines() : []) {
    const c = CASES[name];
    const missing = c.requiresEnv && !process.env[c.requiresEnv];

    it.skipIf(!!missing)(`${name} 返回结构化结果${missing ? `（未设置 ${c.requiresEnv}，跳过）` : ''}`, async () => {
      const engine = new c.ctor(engineConfig(name));
      const resp = await engine.search({ query: c.query, count: 5 });
      expect(resp.results.length).toBeGreaterThan(0);
      expect(resp.results[0].url).toMatch(/^https?:\/\//);
      expect(resp.results[0].title.length).toBeGreaterThan(0);
    }, 60_000);
  }
});
