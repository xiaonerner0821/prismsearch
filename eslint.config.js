// PrismSearch ESLint 配置（Flat Config，ESLint 9+）
// 仅做代码质量检查；格式化交由 .editorconfig 与编辑器处理
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  // 忽略产物与依赖目录
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'data/**',
      'logs/**',
      'workers/py-worker/**',
      'workers/ts-worker/dist/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'workers/ts-worker/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // 基于 typescript-eslint recommended 规则集
      ...tsPlugin.configs.recommended.rules,

      // ---- 项目自定义调整 ----
      // 允许下划线前缀的刻意未使用变量（如 _page）
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // 本项目对外部数据（搜索结果/网页内容）大量使用 any 之外的精确类型成本过高，放宽为警告
      '@typescript-eslint/no-explicit-any': 'off',
      // 允许非空断言（解析器代码中配合运行时校验使用）
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
