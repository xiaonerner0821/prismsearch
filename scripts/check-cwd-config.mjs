// 诊断：从当前工作目录解析配置，打印实际加载的配置文件、候选路径与关键配置（密钥只显示是否存在）
// 用法：npm run build && node scripts/check-cwd-config.mjs [配置文件路径]
import { existsSync } from 'node:fs';
import { loadConfig, configCandidates } from '../dist/config/config-loader.js';

const { config, path, warnings } = await loadConfig(process.argv[2]);

console.log('工作目录      :', process.cwd());
console.log('配置文件      :', path ?? '(未找到，使用内置默认值 + 环境变量)');
if (process.env.PRISMSEARCH_CONFIG) console.log('PRISMSEARCH_CONFIG:', process.env.PRISMSEARCH_CONFIG);
console.log('候选路径（按优先级）:');
for (const c of configCandidates()) console.log(`  ${existsSync(c) ? '✔' : ' '} ${c}`);

console.log('传输方式      :', config.server.transport, config.server.transport === 'http' ? `${config.server.host}:${config.server.port}` : '');
console.log('缓存          :', config.cache.ttl > 0 ? `${config.cache.backend}（TTL ${config.cache.ttl}s）` : '关闭（ttl=0）', config.cache.ttl > 0 && config.cache.backend === 'sqlite' ? config.cache.sqlite.path : '');
console.log('浏览器抓取    :', config.fetcher.browser?.enabled ? '开启' : '关闭');
console.log('Worker        :', config.workers?.enabled ? `${config.workers.endpoints?.length ?? 0} 个端点` : '关闭');
console.log('已启用引擎    :', config.engines.filter(e => e.enabled).map(e => e.name).join(', ') || '(无)');

const google = config.engines.find(e => e.name === 'google');
const brave = config.engines.find(e => e.name === 'brave');
console.log('Google API Key:', google?.apiKey ? '已配置' : '未配置', '| CSE ID:', google?.searchEngineId ? '已配置' : '未配置');
console.log('Brave API Key :', brave?.apiKey ? '已配置' : '未配置');

if (warnings.length) {
  console.log('告警:');
  for (const w of warnings) console.log('  -', w);
}
