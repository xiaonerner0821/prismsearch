// 生成可审计的 npm 第三方依赖归属清单，不联网、不安装额外工具。
// 用法：node scripts/generate-third-party-inventory.mjs [输出目录]
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const root = process.cwd();
const out = join(root, process.argv[2] || 'release-artifacts');
mkdirSync(out, { recursive: true });
const projects = [{ name: 'prismsearch', dir: root }, { name: 'ts-worker', dir: join(root, 'workers', 'ts-worker') }];
const rows = [];
for (const project of projects) {
  const lockPath = join(project.dir, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  for (const [location, meta] of Object.entries(lock.packages || {})) {
    if (!location || !meta.version || meta.dev === true || meta.devOptional === true) continue;
    const packagePath = join(project.dir, location);
    let installed = meta;
    const manifest = join(packagePath, 'package.json');
    if (existsSync(manifest)) { try { installed = { ...meta, ...JSON.parse(readFileSync(manifest, 'utf8')) }; } catch {} }
    const licenseCandidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'];
    const licensePath = licenseCandidates.find(name => existsSync(join(packagePath, name)));
    rows.push({ project: project.name, name: installed.name || location.split('/').pop(), version: installed.version, license: installed.license || installed.licenses || null, repository: typeof installed.repository === 'string' ? installed.repository : installed.repository?.url || null, path: relative(root, packagePath).replaceAll('\\', '/'), licenseFile: licensePath ? relative(root, join(packagePath, licensePath)).replaceAll('\\', '/') : null, licenseSha256: licensePath ? createHash('sha256').update(readFileSync(join(packagePath, licensePath))).digest('hex') : null });
  }
}
rows.sort((a, b) => `${a.project}/${a.name}`.localeCompare(`${b.project}/${b.name}`));
writeFileSync(join(out, 'third-party-npm.json'), JSON.stringify({ generatedAt: new Date().toISOString(), source: 'package-lock.json + installed package manifests/LICENSE files', dependencies: rows }, null, 2) + '\n');
const md = ['# 第三方 npm 依赖归属清单', '', '该清单由锁文件、已安装 package.json 与 LICENSE 文件生成；不联网、不安装工具。', '', '| 项目 | 包 | 版本 | License | Repository | 路径 |', '| --- | --- | --- | --- | --- | --- |', ...rows.map(r => `| ${r.project} | ${r.name} | ${r.version} | ${String(r.license ?? '未声明').replaceAll('|', '\\|')} | ${r.repository || '未声明'} | ${r.path} |`), ''];
writeFileSync(join(out, 'third-party-npm.md'), md.join('\n'));
console.log(`已生成 ${rows.length} 个 npm 依赖记录`);
