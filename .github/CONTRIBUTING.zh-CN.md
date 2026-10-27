# 贡献指南

感谢你考虑为 PrismSearch 做出贡献！本指南将帮助你快速上手。
[English version](CONTRIBUTING.md)

## 开发环境搭建

1. **前置条件**：Node.js 22.19+（`package.json` 的 `engines` 要求）和 Git。
   如需改动 Python Worker，还需要 Python 3.10+
2. **克隆并安装**：
   ```bash
   git clone https://github.com/xiaonerner0821/prismsearch.git
   cd prismsearch
   npm install
   ```
3. **编译**：`npm run build`
4. **测试**：`npm test`
5. **开发模式**：`npm run dev`（监听模式）
6. **发布前自检**（可选）：`npm run selfcheck`——先构建，再检查 shebang、`--version`、必需文件，并经 stdio 握手确认 5 个工具齐全

下文命令以 macOS / Linux shell 为准，Windows 的差异单独注明。

### 抓取 Worker（可选子项目）

仓库里的 `workers/` 是独立的两个 Worker，不属于主包的构建产物，需要单独装依赖：

```bash
# TS Worker（Playwright）
cd workers/ts-worker
npm install
npm run typecheck && npm test
npx playwright install chromium   # 只有跑真实渲染时才需要
cd ../..

# Python Worker（curl_cffi + trafilatura）：在 workers/py-worker/.venv 建虚拟环境
cd workers/py-worker
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"
cd ../..

# 回到仓库根目录执行
npm run test:worker:py   # pytest -q
npm run lint:py          # ruff check .
```

> **Windows：** 改用 `python -m venv .venv` 与 `.venv\Scripts\python -m pip install -e ".[dev]"`。`npm run test:worker:py` / `npm run lint:py`（[`scripts/py-worker-task.mjs`](../scripts/py-worker-task.mjs)）会自动在 `workers/py-worker/.venv`（或 `venv`）下查找 `bin/python` 与 `Scripts/python.exe`，都没有时使用 `PATH` 上的 `python`。

改动 Worker 的协议行为时，请同步更新 [`docs/worker-protocol.md`](../docs/worker-protocol.md)。

## 分支命名规范

- `feature/xxx` — 新功能
- `fix/xxx` — Bug修复
- `docs/xxx` — 文档更新
- `refactor/xxx` — 代码重构

## 提交信息规范

格式：`type(scope): 描述`

类型：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`

示例：
- `feat(engines): 添加DuckDuckGo搜索引擎`
- `fix(cache): 修复SQLite连接泄漏问题`

## Pull Request 流程

1. Fork 本仓库
2. 从 `main` 创建功能分支
3. 编写代码和测试
4. 确保 `npm run lint`、`npm run typecheck` 和 `npm test` 通过
5. 提交 Pull Request 并填写 PR 模板

## 添加新搜索引擎

这是最常见的贡献类型，请按以下步骤操作：

1. 创建 `src/engines/<引擎名>/<引擎名>-web.ts`
2. 实现 `engine-interface.ts` 中的 `SearchProvider` 接口：
   ```typescript
   export interface SearchProvider {
     readonly name: string;        // 引擎唯一标识
     readonly displayName: string; // 显示名称
     search(request: SearchRequest): Promise<SearchResponse>;
     getStatus(): EngineStatus;
     isAvailable(): boolean;
   }
   ```
3. 请求统一通过 `src/engines/scraper-http.ts` 的 `fetchSearchPage` 发出，保证 UA、Referer、超时行为一致
4. 在 `src/server/mcp-server.ts` 的 `ENGINE_CONSTRUCTORS` 中注册，并在 `src/config/config-schema.ts` 的 `BUILTIN_ENGINES` 中添加内置默认值
5. 在 `config/default.yaml` 的 `engines` 列表中列出（默认关闭的写 `enabled: false`）
6. 在 `tests/unit/` 中添加单元测试——优先编写基于 HTML fixture 的解析器测试（参考 `tests/unit/brave-web.test.ts`）

可参考 `src/engines/google/google-web.ts` 作为参考实现。

## 代码规范

- TypeScript strict 模式
- 使用中文注释
- ESLint flat config（`eslint.config.js`）——提交前运行 `npm run lint`
- ESM 模块（import/export 使用 `.js` 扩展名）
- 版本号**只**定义在 `package.json`，代码统一通过 `src/version.ts` 读取——不要在任何地方硬编码版本号

## 测试要求

- 核心功能必须有单元测试
- 使用 Vitest 测试框架
- 运行测试：`npm test`（离线运行，不访问真实网络）
- 监听模式：`npm run test:watch`
- 覆盖率：`npm run test:coverage`，低于 `vitest.config.ts` 中的门槛会直接失败
- 真实联网冒烟测试：`npm run test:live`（`RUN_LIVE_TESTS=1`，CI 每天定时执行）

测试分两个 project：`tests/unit` 全部离线，`tests/integration` 中的联网用例通过
`describe.skipIf` 按环境变量决定是否执行。修改抓取型引擎时请顺手确认对应选择器是否仍有效。

## 开发验证脚本

`scripts/dev/` 目录提供可选的端到端验证脚本。它们基于**编译产物**运行，请先执行 `npm run build`：

| 脚本 | 用途 |
|------|------|
| `node scripts/dev/verify-google-e2e.mjs [关键词]` | 验证 Google 策略：纯 HTTP（预期被 JS 墙拦截）与浏览器渲染 |
| `node scripts/dev/verify-mcp-stdio.mjs [关键词]` | 通过 stdio 传输冒烟测试 MCP 服务（以 Google 调用 `web_search`） |
| `node scripts/dev/verify-with-config.mjs [关键词]` | 验证配置加载与凭据注入（只输出密钥是否已配置） |
| `node scripts/check-cwd-config.mjs` | 排查当前目录下实际加载了哪个配置文件和 API Key |

这些脚本是开发辅助工具，不属于测试套件；运行时可能真实访问搜索引擎。`scripts/` 下其余脚本（`check-versions.mjs`、`selfcheck.mjs`、`py-worker-task.mjs`）由 npm scripts 与 CI 调用。
