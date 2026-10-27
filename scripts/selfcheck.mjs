// 发布前自检（npm run selfcheck 会先 build）：
//   1) 工作流 / 配置文件 YAML 可解析
//   2) package.json 关键脚本与字段齐备
//   3) 必需的仓库文件存在
//   4) dist/index.js 存在且首行是 shebang
//   5) node dist/index.js --version 与 package.json 一致
//   6) 示例配置可加载且无告警
//   7) 以 stdio 启动服务，完成 MCP initialize + tools/list，5 个工具齐全
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const problems = [];
const ENTRY = 'dist/index.js';
const EXPECTED_TOOLS = ['web_search', 'image_search', 'fetch_page', 'wechat_search', 'list_engines'];

// 1) 所有 YAML 可解析（含 release-drafter、labeler、issue 表单）
const listDir = dir => (existsSync(dir) ? readdirSync(dir).map(f => join(dir, f)) : []);
const yamlFiles = [
  ...listDir('.github/workflows'),
  ...listDir('.github'),
  ...listDir('.github/ISSUE_TEMPLATE'),
  'config/default.yaml',
  'config/http.yaml',
  'docker/docker-compose.yml',
].filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

for (const f of yamlFiles) {
  try {
    parseYaml(readFileSync(f, 'utf8'));
  } catch (e) {
    problems.push(`${f}: YAML 解析失败 - ${e.message}`);
  }
}
console.log(`YAML 解析：检查 ${yamlFiles.length} 个文件`);

// 2) package.json 关键项
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const requiredScripts = ['build', 'clean', 'typecheck', 'lint', 'test', 'test:worker', 'test:worker:py',
  'test:live', 'prepublishOnly', 'verify:pack', 'selfcheck'];
for (const s of requiredScripts) if (!pkg.scripts?.[s]) problems.push(`package.json 缺少脚本 ${s}`);
if (!pkg.engines?.node) problems.push('package.json 缺少 engines.node');
if (!pkg.mcpName) problems.push('package.json 缺少 mcpName');
if (pkg.bin?.prismsearch !== ENTRY) problems.push(`package.json bin.prismsearch 应为 ${ENTRY}`);
if (pkg.main || pkg.types || pkg.exports?.['.']) {
  problems.push('package.json 不应再声明 main / types / exports["."]（入口被 import 即启动服务器）');
}
if (!Array.isArray(pkg.files)) {
  problems.push('package.json 缺少 files');
} else {
  // npm 总会打包 README / LICENSE；这里仍要求显式列出，便于审阅
  for (const f of ['dist', 'config/default.yaml', 'config/http.yaml', 'LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md']) {
    if (!pkg.files.includes(f)) problems.push(`package.json files 缺少 ${f}`);
  }
}
console.log(`package.json：engines.node=${pkg.engines?.node}，脚本 ${Object.keys(pkg.scripts ?? {}).length} 个`);

// 3) 必需的仓库文件
const requiredFiles = ['README.md', 'README.zh-CN.md', 'LICENSE', 'NOTICE', 'SECURITY.md', 'CHANGELOG.md',
  'CODE_OF_CONDUCT.md', 'server.json', 'config/default.yaml', 'config/http.yaml',
  '.github/CODEOWNERS', '.github/CONTRIBUTING.md', '.github/CONTRIBUTING.zh-CN.md', '.github/SUPPORT.md',
  'docs/worker-protocol.md', 'docker/docker-compose.yml', 'docs/THIRD-PARTY-NOTICES.md', 'scripts/server.schema.json'];
for (const f of requiredFiles) {
  if (!existsSync(f)) problems.push(`缺少文件 ${f}`);
}
console.log(`必需文件：检查 ${requiredFiles.length} 个`);

// 官方固定版本 JSON Schema 为本地公开文件；校验器来自锁定 ESLint 工具链。
try {
  const { default: Ajv } = await import('ajv');
  const schema = JSON.parse(readFileSync('scripts/server.schema.json', 'utf8'));
  const server = JSON.parse(readFileSync('server.json', 'utf8'));
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
  if (!validate(server)) problems.push(`server.json schema 校验失败: ${JSON.stringify(validate.errors)}`);
  else console.log('server.json：本地官方 schema 校验通过');
} catch (error) { problems.push(`server.json schema 校验无法完成: ${error.message}`); }

// 4) 构建产物与 shebang
let entryOk = false;
if (!existsSync(ENTRY)) {
  problems.push(`缺少 ${ENTRY}，请先 npm run build`);
} else {
  const firstLine = readFileSync(ENTRY, 'utf8').split(/\r?\n/, 1)[0];
  if (!firstLine.startsWith('#!')) {
    problems.push(`${ENTRY} 首行不是 shebang（实际：${JSON.stringify(firstLine.slice(0, 40))}）`);
  } else {
    entryOk = true;
    console.log(`产物：${ENTRY} 首行 ${firstLine}`);
  }
}

// 5) --version
if (entryOk) {
  // Windows 上不经 shell 直接 spawn 'node' 可能找不到，统一用 process.execPath
  const r = spawnSync(process.execPath, [ENTRY, '--version'], { encoding: 'utf8', timeout: 15_000 });
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0) problems.push(`${ENTRY} --version 退出码 ${r.status}：${r.stderr?.trim() ?? ''}`);
  else if (out !== pkg.version) problems.push(`--version 输出 ${JSON.stringify(out)}，与 package.json ${pkg.version} 不一致`);
  else console.log(`--version：${out}`);
}

// 6) 示例配置可加载且无告警
const { loadConfig } = await import('../dist/config/config-loader.js');
for (const f of ['config/default.yaml', 'config/http.yaml']) {
  try {
    const { warnings } = await loadConfig(f);
    if (warnings.length) problems.push(`${f} 加载有告警: ${warnings.join('; ')}`);
  } catch (e) {
    problems.push(`${f} 加载失败: ${e.message}`);
  }
}
console.log('示例配置：default.yaml / http.yaml 加载完毕');

// 7) stdio 握手 + tools/list
if (entryOk) {
  try {
    const tools = await listToolsOverStdio();
    const missing = EXPECTED_TOOLS.filter(t => !tools.includes(t));
    if (missing.length) problems.push(`tools/list 缺少工具: ${missing.join(', ')}（实际: ${tools.join(', ')}）`);
    else console.log(`MCP stdio：initialize 成功，tools/list 返回 ${tools.length} 个工具（${tools.join(', ')}）`);
  } catch (e) {
    problems.push(`MCP stdio 自检失败: ${e.message}`);
  }
}

if (problems.length) {
  console.error('\n发现问题：');
  for (const p of problems) console.error(' -', p);
  process.exit(1);
}
console.log('\n全部自检通过');

/**
 * 以 stdio 启动服务器，发送 initialize → notifications/initialized → tools/list，返回工具名列表。
 * 用临时目录作为 cwd 与 PRISMSEARCH_HOME，内存缓存，避免读到开发者本地配置或写入真实缓存。
 */
async function listToolsOverStdio(timeoutMs = 30_000) {
  const sandbox = mkdtempSync(join(tmpdir(), 'prismsearch-selfcheck-'));
  const env = { ...process.env, PRISMSEARCH_HOME: sandbox, PRISMSEARCH_CACHE__BACKEND: 'memory',
    PRISMSEARCH_SERVER__TRANSPORT: 'stdio', PRISMSEARCH_LOG__LEVEL: 'warn' };
  delete env.PRISMSEARCH_CONFIG;
  const child = spawn(process.execPath, [join(process.cwd(), ENTRY)], {
    cwd: sandbox,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', c => { stderr += c.toString(); });

  const pending = new Map();
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const exited = new Promise((_, reject) => {
    child.on('exit', code => reject(new Error(`服务器进程提前退出（code=${code}）：${stderr.trim().slice(-500)}`)));
    child.on('error', reject);
  });

  const request = (id, method, params) => {
    const response = new Promise(resolve => pending.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`等待 ${method} 响应超时`)), timeoutMs);
    });
    return Promise.race([response, timeout, exited]).finally(() => clearTimeout(timer));
  };

  try {
    const init = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'prismsearch-selfcheck', version: pkg.version },
    });
    if (init.error) throw new Error(`initialize 返回错误: ${JSON.stringify(init.error)}`);
    const serverVersion = init.result?.serverInfo?.version;
    if (serverVersion && serverVersion !== pkg.version) {
      problems.push(`initialize 返回的 serverInfo.version=${serverVersion} 与 package.json 不一致`);
    }
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await request(2, 'tools/list', {});
    if (list.error) throw new Error(`tools/list 返回错误: ${JSON.stringify(list.error)}`);
    return (list.result?.tools ?? []).map(t => t.name);
  } finally {
    child.removeAllListeners('exit');
    exited.catch(() => {});
    child.stdin.end();
    child.kill();
    await new Promise(r => setTimeout(r, 200));
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 上文件可能仍被占用，忽略 */ }
  }
}
