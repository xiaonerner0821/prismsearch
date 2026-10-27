// 版本一致性检查（与 .github/workflows/release.yml 中的 verify 步骤等价）
// 以 package.json 为准，校验：
//   - server.json 的 version 与 packages[0].version（及其余 packages[].version）
//   - workers/ts-worker/package.json 的 version
//   - workers/py-worker/pyproject.toml 的 [project] version
//   - package.json mcpName 与 server.json name
// Worker 源码中的版本在运行时读取各自的包元数据，因此不检查源码。
import { readFileSync } from 'node:fs';

const bad = [];

function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    bad.push(`无法读取 ${file}: ${e.message}`);
    return null;
  }
}

function readJson(file) {
  const text = read(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    bad.push(`${file} 不是合法 JSON: ${e.message}`);
    return null;
  }
}

const pkg = readJson('package.json');
if (!pkg?.version) {
  console.error('package.json 缺少 version');
  process.exit(1);
}
const v = pkg.version;

// server.json（MCP Registry 元数据）
const server = readJson('server.json');
if (server) {
  if (server.version !== v) bad.push(`server.json version=${server.version}`);
  const packages = server.packages ?? [];
  if (packages.length === 0) {
    bad.push('server.json packages 为空');
  } else {
    if (packages[0].version !== v) bad.push(`server.json packages[0].version=${packages[0].version}`);
    for (const [i, p] of packages.entries()) {
      if (i > 0 && p.version !== v) bad.push(`server.json packages[${i}](${p.identifier}).version=${p.version}`);
    }
  }
  if (pkg.mcpName !== server.name) bad.push(`mcpName(${pkg.mcpName}) != server.json name(${server.name})`);
}

// ts-worker
const ts = readJson('workers/ts-worker/package.json');
if (ts && ts.version !== v) bad.push(`workers/ts-worker/package.json version=${ts.version}`);

// py-worker：只取 [project] 段内的 version，避免误读其他段（如工具配置）里的同名键
const toml = read('workers/py-worker/pyproject.toml');
if (toml !== null) {
  const section = toml.match(/^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? '';
  const py = section.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1];
  if (py !== v) bad.push(`workers/py-worker/pyproject.toml [project].version=${py ?? '(未找到)'}`);
}

if (bad.length) {
  console.error(`版本不一致（package.json = ${v}）：`);
  for (const b of bad) console.error(' -', b);
  process.exit(1);
}
console.log(`版本一致性通过：package.json / server.json(version + packages[0]) / ts-worker / py-worker 均为 ${v}`);
console.log(`Registry 名称一致：${server.name}`);
