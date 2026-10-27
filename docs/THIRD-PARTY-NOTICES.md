# 第三方软件与内容说明 / Third-Party Notices

PrismSearch 主仓库代码按 [Apache License 2.0](../LICENSE) 发布。本文件记录已知的第三方代码、运行时依赖与外部服务边界；每个依赖仍以其随附许可证和版权声明为准。

## 运行时依赖

Node.js 运行时依赖由 `package.json` 与 `package-lock.json` 锁定。发布包不重新许可这些依赖；安装或再分发时请保留其许可证和 NOTICE 文件。可在干净安装后使用 `npx license-checker --production --summary` 生成核对清单，并检查 `node_modules/*/LICENSE*`。Playwright 为可选依赖，其浏览器发行物另受 Playwright/Chromium 及相关组件许可约束。

## Worker 依赖

`workers/ts-worker` 与 `workers/py-worker` 是可选、独立部署的组件，各自的 `package.json` / `pyproject.toml` 和锁定文件是其依赖来源。Python Worker 的 Python 包和系统库不被主服务的 Apache-2.0 许可证重新许可；部署者应按各包的许可证履行通知义务。

## 外部服务与第三方内容

Google、Microsoft/Bing、Brave、Baidu、Sogou、360、Yandex、DuckDuckGo、Tencent/WeChat 等名称和商标归各自权利人所有。搜索结果、图片、网页、PDF 和微信公众号文章由外部服务提供，可能受版权、隐私、数据库权或服务条款约束。PrismSearch 不授予复制、保存、展示、抓取、绕过访问控制或再分发这些内容的权利；使用者必须自行取得许可并遵守服务商条款、robots 指令和适用法律。

## 设计致谢

微信公众号搜索模块的实现思路受 [Miku_Spider](https://github.com/GobinFan/Miku_Spider) 启发；该项目采用 MIT License。PrismSearch 未复制其源代码或 Cookie 值，运行时 Cookie 动态获取；相关致谢亦见根目录 [NOTICE](../NOTICE)。

本文件不是完整的依赖清单，也不替代各依赖包自身附带的许可证文本。发布前应在目标平台和目标构建产物上重新生成并复核依赖清单。
