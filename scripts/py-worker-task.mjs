// 统一调用 py-worker 的 Python 工具链：优先用 venv，其次系统 python
// 用法：node scripts/py-worker-task.mjs test|lint
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const task = process.argv[2];
const dir = join(process.cwd(), 'workers', 'py-worker');

const venvCandidates = [
  join(dir, '.venv', 'Scripts', 'python.exe'),
  join(dir, 'venv', 'Scripts', 'python.exe'),
  join(dir, '.venv', 'bin', 'python'),
  join(dir, 'venv', 'bin', 'python'),
];
const python = venvCandidates.find(p => existsSync(p)) ?? 'python';

const tasks = {
  test: ['-m', 'pytest', '-q'],
  lint: ['-m', 'ruff', 'check', '.'],
};

const args = tasks[task];
if (!args) {
  console.error(`未知任务: ${task}（可选: ${Object.keys(tasks).join(', ')}）`);
  process.exit(1);
}

console.log(`> ${python} ${args.join(' ')}  (cwd: workers/py-worker)`);
const result = spawnSync(python, args, { cwd: dir, stdio: 'inherit' });
if (result.error) {
  console.error(`无法执行 Python（${python}）: ${result.error.message}`);
  console.error('提示：py-worker 需要先创建虚拟环境并安装依赖，见 workers/py-worker/README.md');
  process.exit(1);
}
process.exit(result.status ?? 1);
