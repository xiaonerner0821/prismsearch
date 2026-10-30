// 同步 DeepSeek Harness 插件包 integrations/dsh/ 与主包
// 以根目录为准：
//   - package.json version → integrations/dsh/package.json version
//                          → cordis.patch.yml 中固定的 prismsearch@<version>
//   - skills/prismsearch/SKILL.md → integrations/dsh/skills/prismsearch/SKILL.md
//   - assets/logo.svg → integrations/dsh/icon.svg
//   - LICENSE → integrations/dsh/LICENSE
// 用法：node scripts/sync-dsh-plugin.mjs          写入
//       node scripts/sync-dsh-plugin.mjs --check  只检查，不一致时退出码 1（CI 用）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const check = process.argv.includes('--check');
const DIR = 'integrations/dsh';
const PIN = /prismsearch@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const drift = [];

function readOrNull(file) {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

function sync(file, expected) {
  const buf = Buffer.isBuffer(expected) ? expected : Buffer.from(expected, 'utf8');
  const current = readOrNull(file);
  if (current && current.equals(buf)) return;
  drift.push(file);
  if (!check) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buf);
  }
}

// 原样复制的文件
sync(`${DIR}/skills/prismsearch/SKILL.md`, readFileSync('skills/prismsearch/SKILL.md'));
sync(`${DIR}/icon.svg`, readFileSync('assets/logo.svg'));
sync(`${DIR}/LICENSE`, readFileSync('LICENSE'));

// 插件包版本：只替换 version 字段，保留其余格式
const pkgFile = `${DIR}/package.json`;
const pkgText = readFileSync(pkgFile, 'utf8');
sync(pkgFile, pkgText.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));

// patch 中固定启动的 prismsearch 版本
const patchFile = `${DIR}/cordis.patch.yml`;
const patchText = readFileSync(patchFile, 'utf8');
if (!PIN.test(patchText)) {
  console.error(`${patchFile} 中找不到 prismsearch@<version>`);
  process.exit(1);
}
sync(patchFile, patchText.replace(PIN, `prismsearch@${version}`));

if (drift.length === 0) {
  console.log(`DSH 插件包已与主包同步（${version}）`);
} else if (check) {
  console.error(`DSH 插件包未同步（主包 ${version}），请运行 node scripts/sync-dsh-plugin.mjs：`);
  for (const f of drift) console.error(' -', f);
  process.exit(1);
} else {
  console.log(`已同步 DSH 插件包到 ${version}：`);
  for (const f of drift) console.log(' -', f);
}
