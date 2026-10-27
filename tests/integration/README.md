# 集成测试 / Integration Tests

本目录存放**真实网络**的端到端集成测试。默认情况下它们不会运行
（`npm test` 只跑 `tests/unit/` 的离线单元测试），以避免 CI 被搜索引擎的
反爬策略与网络抖动影响。CI 的 `live-tests.yml` 每天定时运行一次，失败时自动开 issue。

## 运行方式

测试直接运行源码（vitest 负责转译），不需要先编译。

```bash
# 默认测 duckduckgo、brave、bing
npm run test:live

# 只测指定引擎；all 表示全部内置引擎
LIVE_TEST_ENGINES=duckduckgo,baidu npm run test:live
LIVE_TEST_ENGINES=all npm run test:live
```

Windows PowerShell：

```powershell
$env:LIVE_TEST_ENGINES='duckduckgo,baidu'; npm run test:live
```

| 环境变量 | 作用 |
| --- | --- |
| `RUN_LIVE_TESTS` | 设为 1 才会执行（`npm run test:live` 已自动设置） |
| `LIVE_TEST_ENGINES` | 逗号分隔的引擎名，或 `all`；写错引擎名会直接报错 |
| `BRAVE_API_KEY` | Brave 用例需要；缺失时跳过 |

可选引擎：`duckduckgo`、`brave`、`bing`、`baidu`、`sogou`、`so`、`yandex`、`google`。
本机网络访问不了某个引擎时（例如部分地区连不上 Bing），该用例会以网络错误失败，
这属于环境问题，不代表解析器坏了。

## 约定

- 文件内的测试必须用 `describe.skipIf(!process.env.RUN_LIVE_TESTS)` 保护
- 引擎配置取自内置默认值，与生产环境一致，不要手写简化配置
- 每个用例设置充足的超时（≥ 30s），并容忍搜索引擎的偶发限流
- 需要凭据的引擎（Google API / Brave）在对应环境变量缺失时跳过
- 集成测试只做冒烟验证（能返回结构化结果），不断言具体排名内容
