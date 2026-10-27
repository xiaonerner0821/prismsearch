/**
 * 用真实配置文件验证 Google 引擎完整策略链（不经过 MCP 协议层）
 * 用法: npm run build && node scripts/dev/verify-with-config.mjs [query]
 */
import { loadConfig } from '../../dist/config/config-loader.js';
import { initLogger } from '../../dist/utils/logger.js';
import { GoogleWebEngine } from '../../dist/engines/google/google-web.js';
import { BrowserFetcher } from '../../dist/fetcher/browser-fetcher.js';

const query = process.argv[2] || 'openai';

initLogger({ level: 'warn', format: 'text' });
// loadConfig 返回 { config, path, warnings }
const { config, path, warnings } = await loadConfig();
for (const w of warnings) console.warn(`[警告] ${w}`);
console.log(`配置文件: ${path ?? '(内置默认值)'}`);

const googleCfg = config.engines.find(e => e.name === 'google');
if (!googleCfg) {
  console.log('配置中没有 google 引擎');
  process.exit(1);
}
// 只输出是否配置，不输出密钥的任何片段
const apiKeySet = Boolean(googleCfg.apiKey || process.env.GOOGLE_API_KEY);
const cxSet = Boolean(googleCfg.searchEngineId || process.env.GOOGLE_CSE_ID);
console.log(`配置: apiKey=${apiKeySet ? '已配置' : '未配置'} cx=${cxSet ? '已配置' : '未配置'}`);

const engine = new GoogleWebEngine(googleCfg);
let fetcher;
if (config.fetcher.browser?.enabled) {
  fetcher = new BrowserFetcher(config.fetcher.browser);
  engine.setBrowserFetcher(fetcher);
  console.log('浏览器抓取器: 已注入');
}

try {
  const resp = await engine.search({ query, count: 10 });
  console.log(`\n✅ 成功: ${resp.results.length} 条, ${resp.searchTime}ms`);
  for (const r of resp.results.slice(0, 5)) {
    console.log(`  [${r.position}] ${r.title}\n      ${r.url}`);
  }
} catch (e) {
  console.log(`\n❌ 所有策略均失败: ${e.message}`);
  process.exitCode = 1;
} finally {
  await fetcher?.close();
}
