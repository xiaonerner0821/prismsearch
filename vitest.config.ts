// Vitest 配置
//
// 两个 project：
// - unit：纯离线单元测试，CI 每次都跑（npm test）
// - integration：访问真实搜索引擎的联网测试，默认跳过，
//   需设置 RUN_LIVE_TESTS=1（npm run test:live），由定时工作流执行
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          // 真实网络请求慢且不稳定，放宽超时并允许一次重试
          testTimeout: 60_000,
          retry: 1,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // text：终端输出；lcov：CI 上传 Codecov；html：本地打开 coverage/index.html 查看
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/.gitkeep', 'src/index.ts'],
      // 基于当前离线测试覆盖率设定，避免新增模块测试后回退。
      thresholds: {
        lines: 85,
        functions: 79,
        branches: 73,
        statements: 82,
        'src/server/mcp-server.ts': { lines: 95, functions: 93, branches: 85, statements: 94 },
        'src/fetcher/browser-fetcher.ts': { lines: 95, functions: 80, branches: 85, statements: 90 },
        'src/fetcher/http-fetcher.ts': { lines: 100, functions: 100, branches: 95, statements: 100 },
        'src/cache/redis-cache.ts': { lines: 95, functions: 100, branches: 90, statements: 93 },
        'src/tools/wechat-search.ts': { lines: 100, functions: 100, branches: 85, statements: 100 },
        'src/server/stdio-transport.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
