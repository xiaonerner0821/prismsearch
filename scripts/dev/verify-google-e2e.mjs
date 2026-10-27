/**
 * Google 引擎端到端验证脚本
 *
 * 用法: npm run build && node scripts/dev/verify-google-e2e.mjs [query]
 *
 * 验证内容：
 * 1. 纯 HTTP 策略（预期：被 enablejs 墙拦截，抛出诊断错误）
 * 2. 浏览器渲染策略（预期：Playwright 渲染后解析到真实结果）
 */

import { GoogleWebEngine } from '../../dist/engines/google/google-web.js';
import { BrowserFetcher } from '../../dist/fetcher/browser-fetcher.js';

const query = process.argv[2] || 'openai';

const engineConfig = {
  name: 'google',
  displayName: 'Google',
  enabled: true,
  type: 'scraper',
  baseUrl: 'https://www.google.com/search',
  alternateUrls: [],
  timeout: 20000,
  priority: 1,
  rateLimit: { maxRequests: 10, windowMs: 60000 },
};

const browserConfig = {
  enabled: true,
  browserType: 'chromium',
  maxPages: 2,
  pageTimeout: 30000,
  headless: true,
  waitUntil: 'domcontentloaded',
};

let exitCode = 0;

// --- 场景1：纯 HTTP（应失败，证明 JS 墙存在） ---
console.log('=== 场景1: 纯 HTTP 策略 ===');
{
  const engine = new GoogleWebEngine(engineConfig);
  try {
    const resp = await engine.search({ query });
    console.log(`结果: ${resp.results.length} 条（意外成功，Google 可能恢复了 HTML 版本）`);
  } catch (e) {
    console.log(`预期内失败: ${e.message}`);
  }
}

// --- 场景2：浏览器渲染（应成功） ---
console.log('\n=== 场景2: 浏览器渲染策略 ===');
{
  const fetcher = new BrowserFetcher(browserConfig);
  const engine = new GoogleWebEngine(engineConfig);
  engine.setBrowserFetcher(fetcher);
  try {
    const resp = await engine.search({ query, count: 10 });
    console.log(`结果: ${resp.results.length} 条, 耗时 ${resp.searchTime}ms`);
    for (const r of resp.results.slice(0, 5)) {
      console.log(`  [${r.position}] ${r.title}`);
      console.log(`      ${r.url}`);
    }
    if (resp.results.length === 0) {
      console.log('!! 浏览器渲染成功但解析到 0 条结果，选择器可能需要更新');
      exitCode = 1;
    }
  } catch (e) {
    console.log(`!! 浏览器策略失败: ${e.message}`);
    exitCode = 1;
  } finally {
    await fetcher.close();
  }
}

process.exit(exitCode);
