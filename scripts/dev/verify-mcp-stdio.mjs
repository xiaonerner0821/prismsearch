/**
 * 通过 MCP stdio 协议端到端测试真实服务器进程
 * 用法: npm run build && node scripts/dev/verify-mcp-stdio.mjs [query]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const query = process.argv[2] || 'openai';
const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

// 用 process.execPath 而不是 'node'：Windows 上 spawn 不经 shell 时找不到 node 的 PATHEXT 变体
const server = spawn(process.execPath, [entry], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdoutBuf = '';
const responses = new Map();
server.stdout.on('data', chunk => {
  stdoutBuf += chunk.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    } catch { /* 非 JSON 行忽略 */ }
  }
});

server.stderr.on('data', chunk => {
  for (const line of chunk.toString().split('\n')) {
    if (line.includes('策略') || line.includes('浏览器') || line.includes('Custom') || line.includes('引擎')) {
      console.log('[stderr]', line.slice(0, 200));
    }
  }
});

const send = (id, method, params) => {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
};

const waitFor = (id, timeoutMs = 60000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (responses.has(id)) { clearInterval(timer); resolve(responses.get(id)); }
    else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error(`等响应 ${id} 超时`)); }
  }, 50);
});

try {
  send(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'verify', version: '1.0' },
  });
  await waitFor(1);
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  console.log(`调用 web_search(engine=google, query="${query}")...`);
  const t0 = Date.now();
  send(2, 'tools/call', { name: 'web_search', arguments: { query, engine: 'google', count: 10 } });
  const resp = await waitFor(2, 90000);
  console.log(`总耗时 ${Date.now() - t0}ms`);

  const text = resp.result?.content?.[0]?.text ?? JSON.stringify(resp.error ?? resp);
  const data = JSON.parse(text);
  console.log(`engine=${data.engine}, results=${data.results?.length ?? 0}, searchTime=${data.searchTime}ms`);
  for (const r of (data.results ?? []).slice(0, 5)) {
    console.log(`  [${r.position}] ${r.title}\n      ${r.url}`);
  }
} finally {
  server.kill();
}
