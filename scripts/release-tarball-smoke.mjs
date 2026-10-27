// 最终 tarball 安装级 smoke；不调用外网搜索、不需要业务凭据。
// 用法：node scripts/release-tarball-smoke.mjs [tarball]
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'prismsearch-tarball-smoke-'));
const npmRun = (args, cwd) => {
  const cli = process.env.npm_execpath;
  const result = spawnSync(cli ? process.execPath : 'npm', cli ? [cli, ...args] : args, {
    cwd, encoding: 'utf8', timeout: 180_000, shell: !cli && process.platform === 'win32',
    env: { ...process.env, npm_config_engine_strict: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} 失败\n${result.stderr || result.stdout}`);
  return result.stdout;
};

try {
  const archive = process.argv[2] ? resolve(process.argv[2])
    : join(temp, JSON.parse(npmRun(['pack', '--json', '--ignore-scripts', '--pack-destination', temp], root))[0].filename);
  if (!existsSync(archive)) throw new Error(`找不到 tarball: ${archive}`);
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true, name: 'tarball-smoke' }));
  npmRun(['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], temp);
  const entry = join(temp, 'node_modules', pkg.name, pkg.bin.prismsearch);
  const version = spawnSync(process.execPath, [entry, '--version'], { cwd: temp, encoding: 'utf8', timeout: 15_000 });
  if (version.status !== 0 || version.stdout.trim() !== pkg.version) throw new Error(`CLI 版本验证失败: ${version.stderr || version.stdout}`);
  await checkMcp(entry);
  console.log(`tarball smoke 通过：${pkg.name}@${pkg.version}；MCP initialize / tools/list 完整`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

async function checkMcp(entry) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PRISMSEARCH_')) delete env[key];
  Object.assign(env, { PRISMSEARCH_HOME: temp, PRISMSEARCH_SERVER__TRANSPORT: 'stdio', PRISMSEARCH_CACHE__BACKEND: 'memory' });
  const child = spawn(process.execPath, [entry], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.resolve(message);
      } catch { /* 忽略非协议行 */ }
    }
  });
  child.on('error', error => { for (const p of pending.values()) p.reject(error); });
  child.on('exit', code => { for (const p of pending.values()) p.reject(new Error(`进程退出 ${code}: ${stderr}`)); });
  const send = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时: ${stderr}`)), 30_000);
    pending.set(id, { resolve: message => { clearTimeout(timer); pending.delete(id); resolve(message); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tarball-smoke', version: pkg.version } });
    if (init.error || init.result?.serverInfo?.version !== pkg.version) throw new Error('initialize 版本验证失败');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await send(2, 'tools/list', {});
    const names = new Set(list.result?.tools?.map(tool => tool.name));
    for (const name of ['web_search', 'image_search', 'fetch_page', 'wechat_search', 'list_engines']) {
      if (!names.has(name)) throw new Error(`tools/list 缺少 ${name}`);
    }
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  }
}
