# Contributing to PrismSearch

Thank you for considering contributing to PrismSearch! This guide will help you get started.
[中文版本](CONTRIBUTING.zh-CN.md)

## Development Setup

1. **Prerequisites**: Node.js 22.19+ (required by `engines` in `package.json`) and Git.
   Python 3.10+ is also needed if you work on the Python Worker
2. **Clone and install**:
   ```bash
   git clone https://github.com/xiaonerner0821/prismsearch.git
   cd prismsearch
   npm install
   ```
3. **Build**: `npm run build`
4. **Test**: `npm test`
5. **Dev mode**: `npm run dev` (watch mode)
6. **Pre-release self-check** (optional): `npm run selfcheck` — builds, then checks the shebang, `--version`, required files and an MCP stdio handshake listing all 5 tools

Commands below use macOS / Linux shell syntax; Windows notes are given inline.

### Fetch Workers (optional subprojects)

`workers/` contains two standalone Workers. They are not part of the main package build and have their own dependencies:

```bash
# TS Worker (Playwright)
cd workers/ts-worker
npm install
npm run typecheck && npm test
npx playwright install chromium   # only needed for real rendering
cd ../..

# Python Worker (curl_cffi + trafilatura): create a venv at workers/py-worker/.venv
cd workers/py-worker
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"
cd ../..

# Run from the repository root
npm run test:worker:py   # pytest -q
npm run lint:py          # ruff check .
```

> **Windows:** use `python -m venv .venv` and `.venv\Scripts\python -m pip install -e ".[dev]"`. `npm run test:worker:py` / `npm run lint:py` ([`scripts/py-worker-task.mjs`](../scripts/py-worker-task.mjs)) automatically pick up `workers/py-worker/.venv` (or `venv`) under both `bin/python` and `Scripts/python.exe`, falling back to the `python` on `PATH`.

If you change Worker protocol behavior, update [`docs/worker-protocol.md`](../docs/worker-protocol.md) as well.

## Branch Naming

- `feature/xxx` — New features
- `fix/xxx` — Bug fixes
- `docs/xxx` — Documentation updates
- `refactor/xxx` — Code refactoring

## Commit Messages

Format: `type(scope): description`

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

Examples:
- `feat(engines): add DuckDuckGo search engine`
- `fix(cache): resolve SQLite connection leak`

## Pull Request Process

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes with tests
4. Ensure `npm run lint`, `npm run typecheck` and `npm test` pass
5. Submit a pull request and fill in the PR template

## Adding a New Search Engine

This is the most common contribution. Follow these steps:

1. Create `src/engines/<engine-name>/<engine-name>-web.ts`
2. Implement the `SearchProvider` interface from `engine-interface.ts`:
   ```typescript
   export interface SearchProvider {
     readonly name: string;
     readonly displayName: string;
     search(request: SearchRequest): Promise<SearchResponse>;
     getStatus(): EngineStatus;
     isAvailable(): boolean;
   }
   ```
3. Send requests through `fetchSearchPage` (`src/engines/scraper-http.ts`) so UA, Referer and timeouts stay consistent
4. Register your engine in `src/server/mcp-server.ts` (`ENGINE_CONSTRUCTORS` map) and add its built-in defaults to `BUILTIN_ENGINES` in `src/config/config-schema.ts`
5. Mention it in `config/default.yaml` under `engines:` (`enabled: false` if opt-in)
6. Add unit tests in `tests/unit/` — fixture-based parser tests preferred (see `tests/unit/brave-web.test.ts`)

Refer to `src/engines/google/google-web.ts` as a reference implementation.

## Code Standards

- TypeScript with strict mode
- Chinese comments (中文注释)
- ESLint flat config (`eslint.config.js`) — run `npm run lint` before committing
- ESM modules (import/export with `.js` extensions)
- Version is defined **only** in `package.json`; code reads it via `src/version.ts` — never hardcode a version string

## Testing

- Unit tests required for core functionality
- Use Vitest framework
- Run tests: `npm test` (offline, never touches the real network)
- Watch mode: `npm run test:watch`
- Coverage: `npm run test:coverage` — fails below the thresholds in `vitest.config.ts`
- Live smoke tests: `npm run test:live` (`RUN_LIVE_TESTS=1`; CI runs these daily)

Tests are split into two projects: `tests/unit` is fully offline, while live cases in `tests/integration` are gated by `describe.skipIf` on an environment variable. When touching a scraper engine, please double-check its selectors still work.

## Dev Verification Scripts

The `scripts/dev/` directory contains optional end-to-end helpers. They run against the **built** output, so run `npm run build` first:

| Script | Purpose |
|--------|---------|
| `node scripts/dev/verify-google-e2e.mjs [query]` | Verify Google strategies: plain HTTP (expected to hit the JS wall) and browser rendering |
| `node scripts/dev/verify-mcp-stdio.mjs [query]` | Smoke-test the MCP server over stdio transport (calls `web_search` with Google) |
| `node scripts/dev/verify-with-config.mjs [query]` | Verify config loading and credential injection (prints only whether keys are set) |
| `node scripts/check-cwd-config.mjs` | Debug which config file and API keys get picked up from the current directory |

These are development aids, not part of the test suite; they may hit live search engines. The remaining scripts in `scripts/` (`check-versions.mjs`, `selfcheck.mjs`, `py-worker-task.mjs`) are used by npm scripts and CI.
