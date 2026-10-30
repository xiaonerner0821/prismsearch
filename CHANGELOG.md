# Changelog

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 修复

- `fetch_page`：未启用浏览器抓取时（默认配置，包括 DeepSeek Harness 插件）也会检测前端渲染骨架页、noscript 提示页和反爬挑战页，并在 `warnings` 中说明正文可能缺失以及启用浏览器渲染的方法。此前这类页面会被当作正常结果返回，没有任何提示。
- `fetch_page`：HTTP 403 / 503 且几乎没有正文的页面视为疑似拦截非浏览器请求，浏览器可用时自动改用浏览器重抓。
- Agent Skill：按上述行为改写 `fetch_page` 的使用指引，浏览器不可用时不再建议用 `method: "browser"` 重试。

## [0.3.2] - 2026-10-29

首个公开版本后的维护版本，运行时代码与 0.3.1 相同。

### 修复

- 发布流水线：`npm publish` 改为用带 `./` 前缀的明确 tarball 路径，避免 npm 把 `release-artifacts/xxx.tgz` 误解析为 GitHub 仓库简写。
- Logo：按棱镜折射的真实光路重绘，入射光止于棱镜表面，各色光都向底边偏折（红光最小、紫光最大）。

### 工程与维护

- `server.json` 迁移到 MCP Registry schema 2025-12-11，同步更新本地校验用的官方 schema。

## [0.3.1] - 2026-10-28

0.3.0 的 tag 已在本地创建但未推送、未发布到任何渠道；0.3.1 是实际首个公开版本，包含开源前的安全加固。

### 安全与兼容性

- 主服务和两个 Worker 增加请求体读取截止时间、连接/并发上限；SSE 的响应生命周期与上传超时分离。
- 非回环 Worker 必须配置精确 `workers.allowedOrigins` 和令牌，默认要求 HTTPS；可信 Docker 内网需逐端点显式设置 `allowInsecureHttp`。Worker 协议请求禁止自动跟随重定向。
- `security.ssrf.whitelist` 不再隐式绕过私网 IP 校验；受控内网例外改用明确的 `allowedPrivateHosts`。Worker 不再支持全局关闭私网防护的环境开关。
- Python/TS Worker 的参数解析异常不再向客户端回显底层异常详情。
- 旧版 `WORKER_ALLOW_PRIVATE_NETWORK` 设为空或 `0` 以外的任何值（如 `true`）都会让 Worker 拒绝启动，不再只拦截 `1`。
- docker compose 的 Redis 服务必须设置 `PRISMSEARCH_REDIS_PASSWORD`（启用 `requirepass`），镜像按 digest 固定。

### 工程与维护

- 发布门禁增加两个 Worker 的校验、哈希锁定的 Python 依赖、依赖审计、镜像运行检查、安装最终 tarball 后的 CLI/MCP smoke。
- GitHub Release 等待 npm 与镜像发布成功，附带生产依赖 SBOM/清单；补充 Registry schema 校验与发布环境保护要求。
- 补齐 Redis、微信公众号工具与 stdio 生命周期离线测试；修复 Redis 密码注入、坏 JSON 命中统计、阻塞式清理，以及 stdio 重复退出通知/监听器清理。
- 公开发布指南与仓库初始化脚本，补充隐私/版权、第三方归属、运维与反向代理、漏洞响应和贡献自查说明。
- README 说明 npm 包只提供 CLI / MCP Server、不提供 JavaScript 库 API；修正中英文 README 两处不一致。
- 首发 npm token 改为 `release` 环境 Secret，并补充有效期与吊销要求；PR 模板补充 CHANGELOG、双语文档、`server.json`、Worker/Docker 与安全边界自查项。

## 0.3.0 - 2026-10-27（未公开发布）

原计划的首个公开版本，tag 仅在本地创建，未推送，也没有 npm 包、镜像或 GitHub Release；其内容已全部包含在 0.3.1 中。
此前的 0.2.0 同样仅为内部预览版，下文的「变更」「破坏性变更」均相对该内部预览版而言。

本版本主要围绕「远程抓取能力」与「工程完备性」两条线。

### 新增

- **抓取 Worker 体系**：新增两种可选的远程抓取 Worker，通过统一的 HTTP + JSON 协议接入，
  主服务可按策略把请求委派出去，全部 Worker 不可用时自动回落到本地抓取
  - `workers/ts-worker`：基于 Playwright 的浏览器渲染 Worker，应对强制 JS 渲染与验证码前置页
  - `workers/py-worker`：基于 curl_cffi 的 TLS 指纹伪装 Worker，配合 trafilatura 做正文提取
  - 协议文档见 [`docs/worker-protocol.md`](docs/worker-protocol.md)
- 负载均衡支持平滑加权轮询与「最空闲优先」两种策略，配合健康检查与故障转移
- 各 Worker 独立提供 Dockerfile，docker-compose 通过 `with-workers` profile 一键启动整套环境
- 新增 `search.deadlineMs` 配置：限制单次搜索整条降级链的总时长，到点即停止尝试后续引擎
- 搜索请求合并（singleflight）：并发的相同查询共享一次上游请求，单个调用方取消只停止自己的等待
- 自动选引擎时的翻页亲和：第 2 页起沿用第 1 页实际使用的引擎，结果不再在引擎之间跳动
- 第 1 页多取少量结果，去重后重新编号，保证仍能凑满 `count`，并据此给出 `hasMore`
- Google Custom Search API 与 Brave 网页搜索在 `count` 超过单次上限时自动连续请求多页
- Bing 支持 `cc` / `mkt` / `adlt`，DuckDuckGo 支持 `kl` 区域语言组合与 `s` 分页，Yandex 支持 `lr` 地区；
  README 新增「各引擎参数支持」对照表
- `fetch_page` 与 `wechat_search` 支持客户端取消，取消时中止正在进行的上游请求
- `fetch_page` 新增 `maxLength`（默认 20000 字符）与 `startIndex`，返回 `totalLength` / `nextStartIndex`，支持分段续读（命中同一份缓存）
- `web_search` 新增 `timeRange`（day / week / month / year），已映射到 Google、Bing、Brave、DuckDuckGo、百度、搜狗、360；参与缓存 key 与翻页引擎亲和，自动选引擎时优先支持时间过滤的引擎
- `web_search` 新增 `mode=aggregate`：并发查询排名前 3 的可用引擎，用倒数排名融合（RRF）合并去重，结果带 `sources`、响应带 `engines`；默认仍为 `fallback`
- `list_engines` 新增 `capabilities`，声明每个引擎支持的可选参数；`web_search` 在实际引擎忽略了某些参数时返回 `warnings`
- 正文提取优先使用 Mozilla Readability（`@mozilla/readability` + `linkedom`），失败或正文过短时回退原启发式
- PDF 文本提取（`unpdf`，最多前 50 页；扫描件给出 warning）
- 客户端带 `progressToken` 时，`web_search` 每尝试一个引擎发送一次 `notifications/progress`
- 引擎配置新增 `languages`，与 `regions` 一起可覆盖内置的区域 / 语言亲和表

### 破坏性变更

- `fetch_page` 的 `truncated` 改为表示本次返回的正文被 `maxLength` 截断；原来「响应体超过 maxBytes」的含义移到 `bodyTruncated`
- `fetch_page` 在 `format=html` 时不再额外返回 `rawHtml`，HTML 只在 `content` 中返回一份
- npm 包不再提供库入口（移除 `main` / `types` / `exports["."]`），只作为命令行程序（`bin`）使用；
  `dist/index.js` 被导入即会启动服务器，不适合程序化调用

### 变更

- 升级到 MCP SDK v2（`@modelcontextprotocol/server` + `@modelcontextprotocol/node`），
  HTTP 传输改为每个请求由工厂新建实例，SSE 心跳由 SDK 负责
- 最低 Node.js 版本提升到 22.19
- `@mozilla/readability`、`linkedom`、`unpdf`、`redis` 改为常规依赖（Docker 镜像省略可选依赖时，
  正文提取、PDF、Redis 缓存仍可用）；只有 `playwright` 保留为可选依赖
- 所有抓取型引擎统一走公共抓取层：UA 按查询词稳定挑选，Referer 由引擎的 `baseUrl` 推导，
  配置镜像或备用地址时自动跟随
- Brave 图片搜索改为按页切片请求（该接口本身不支持分页参数）
- 配置热重载接口更名为 `POST /admin/config/reload`，默认关闭且必须开启鉴权后才注册；
  重载失败时只返回通用提示，详细原因写入服务端日志
- 引擎熔断只统计真正的引擎故障：用户取消与 4xx（429 除外）不再计入失败；熔断中的引擎在占用限流配额前就被跳过，
  指定的引擎熔断时降级到下一个候选
- 引擎返回 0 条且页面不像「无结果」页时报解析错误、遇到验证码页时报「被拦截」，不再把反爬页当成空结果缓存
- 只缓存非空的搜索结果；图片搜索的 base64 缩略图不进缓存，命中缓存时按需补抓
- 返回给客户端的错误改为白名单：只透传参数错误、解析 / 拦截、浏览器未安装等面向用户的错误，其余统一为通用提示
- URL 去重规则重写：忽略 `utm_*` 等跟踪参数、http/https、主机名大小写、默认端口与末尾斜杠，保留其余参数顺序；
  `www.` 与裸域视为同一站点
- API Key 连续失败时按指数退避冷却，恢复成功后重置
- 配置了浏览器抓取器时，Google 引擎自动启用浏览器渲染策略
- 纯文本格式的 `fetch_page` 同样去掉导航、页头页脚等页面框架
- `list_engines` 为支持图片搜索的引擎新增 `imageStats`（图片独立的可用性、成功率、延迟），与网页统计分开展示
- 图片搜索排序改用图片自己的统计，并同样遵守引擎配置的 `fallback.crossOrigin` 顺序；
  `crossOrigin` 权重上调（0.10 → 0.15，priority 0.15 → 0.10），显式配置的降级顺序不再被默认优先级压过
- 自动选引擎的第 1 页遇到空结果时，换一个引擎再试一次；都为空时仍返回空结果而不是报错
- 调用方输入错误（`ToolInputError` / 标注 `fallback: false` 的错误）直接返回，不再沿降级链重试
- Worker 协议：`maxBytes` 超限改为截断并返回 `truncated: true`；新增 `UNSUPPORTED_METHOD` 错误码说明
- `fetch_page` 未指定 method 时，检测到骨架页 / 需 JS 渲染页 / 反爬挑战页会自动改用浏览器重抓；
  `method=browser` 而 Playwright 不可用时退回 http 并给出 warning（显式 `method=http` 不升级）
- `--help` 改为中英双语

### 修复

- Brave 网页搜索请求第 11 页及以后时，接口会静默忽略越界的 `offset` 并返回重复结果，现在明确报错
- Worker 返回的最终地址未做二次校验，存在经由 Worker 重定向绕过 SSRF 防护的路径
- Worker 返回 `403` 时被一律当作鉴权失败，导致目标地址被拒时徒劳重试所有 Worker 并误标记为不健康
- DuckDuckGo 对表单 POST 一律返回人机验证页，导致该引擎长期静默返回 0 条结果；改用 GET 请求，
  并把验证页识别为失败交给降级链，而不是当作「无结果」
- Google / Bing 图片搜索写死了官方域名，忽略引擎配置的 `baseUrl`，配置镜像站时不生效
- YAML 配置里只写了注释的空节点（如 `sqlite:`）会被解析为 null 并抹掉默认值，导致校验失败；现在视为未设置
- 仓库自带的示例配置与 schema 脱节（缺少 Worker、内容过滤、Host/Origin 等配置段），已重写并纳入回归测试
- npm 包内的 sourcemap 指向未发布的源码目录，现在内联源码，堆栈可直接定位；不再生成指向 src 的声明映射
- 只设置 `PRISMSEARCH_AUTH_TOKENS` 时令牌写入了但鉴权未开启，导致 Docker 等监听 `0.0.0.0` 的部署拒绝启动；
  现在非空令牌会自动开启 `security.auth`
- `--help` 列出的 `PRISMSEARCH_TRANSPORT` / `PORT` / `HOST` 实际不生效，已改为正确的 `PRISMSEARCH_SERVER_*`
- `image_search` 的 `engine` 参数枚举收窄为支持图片搜索的引擎（google / bing / brave / baidu）
- docker-compose：挂载的配置目录需通过 `PRISMSEARCH_CONFIG` 显式加载；Redis profile 现在会真正启用，
  且不再向宿主机暴露无密码的 6379 端口
- 搜狗微信搜索：反爬重试用尽后明确报「被拦截」；页面不是搜索结果页时报解析错误而不是返回空；
  客户端取消与超时分别给出准确提示，取消不计入引擎失败
- ts-worker：`waitForSelector` 等不到元素时返回当前已渲染的内容，而不是整页报错
- SSRF 拦截是终止性结论，`fetch_page` 不再换下一个抓取器重试
- 代理池：网络错误与超时才计为代理故障，HTTP 状态错误、取消、SSRF 拦截不再误伤代理
- 指定引擎失败、降级到其他引擎时，结果不再按指定引擎写入缓存（此前一个 TTL 内指定该引擎的请求都会拿到别家的缓存结果），图片搜索同理
- Google Custom Search API：`count` 大于 10 时翻页偏移按 `count` 计算，修复第 2 页与第 1 页结果重叠、position 错误的问题
- 去掉百度 / Bing / Google 图片子引擎里与父引擎重复的统计，图片熔断只由父引擎记录
- 主进程读取 Worker 返回的 `truncated` 标记
- Worker（ts/py）抓取超过 maxBytes 时改为截断并返回 truncated 标记，不再整页返回 413；截断处的半个多字节字符会被丢弃
- ts-worker 在浏览器不可用或方法不支持时返回 `UNSUPPORTED_METHOD`，主进程可摘掉该能力并换 Worker
- py-worker DNS 解析失败或无结果时直接拒绝请求，确保每一跳都钉住已校验的 IP，消除 DNS 重绑定窗口
- 搜狗：结果中的加密跳转链接（`/link?url=…`）现在会解包为真实地址（优先读取页面 `data-url`，否则不跟随重定向请求跳转页提取目标；限并发、限时，失败时保留原链接），修复去重失效与 fetch_page 抓到搜狗跳转页的问题
- 百度、搜狗：输入编码参数 `ie` 固定为 UTF-8，不再随 language 变化（这两个引擎不支持 language）
- 修复浏览器池关闭期间正在启动的浏览器被写回并泄漏的问题，`close()` 现在会等待在途启动
- `fetch_page` 改为整次调用共用一个总超时，降级时只用剩余时间，不会再出现约 2 倍 timeout 的耗时
- `fetch_page` 遇到内容类型不支持、响应体超限这类确定性错误时不再换抓取器重试
- 浏览器抓取会检查主文档 Content-Type 和魔数，PDF、图片、二进制流与 http 一样被拒绝
- 内容过滤关键词改为预先小写并缓存，正文每次只小写一次
- Bing：翻页偏移按实际返回条数推进，`count` 超过单页条数时自动请求多页拼接，修复结果不足与跨页重叠
- SQLite 缓存：多进程共用库文件时，淘汰前 / 清理时 / 统计时用 `COUNT(*)` 校准条目计数，避免误删或少删

### 安全

- Worker 未配置 token 时强制只监听回环地址，拒绝在 `0.0.0.0` 上裸奔启动
- Worker 端 SSRF 校验覆盖 IPv4 映射、6to4、Teredo、NAT64 内嵌地址，并在连接时再次校验以挡住 DNS 重绑定
- Worker 重定向由自身逐跳跟随，每一跳重新校验地址
- HTTP 传输按客户端分桶限流（凭证指纹或 IP），修复旧实现按工具名全局计数导致配额被单个客户端耗尽的问题
- 非回环地址监听必须开启鉴权，否则拒绝启动
- 浏览器抓取器的日志补齐 URL 脱敏，不再把查询串写入日志
- 管理接口不再把内部错误信息（可能含配置文件绝对路径）返回给客户端
- Docker 构建上下文排除 `.env` 与本地配置文件，避免密钥被打进镜像层

### 工程

- CI 覆盖 Node 22 / 24 × Linux / Windows / macOS，并新增 TS Worker 与 Python Worker 的独立流水线
- 新增 CodeQL、Dependency Review、OpenSSF Scorecard、失效链接检查、Stale、Labeler 工作流
- 新增定时联网冒烟测试，失败时自动汇总为一个 issue；可通过 `LIVE_TEST_ENGINES` 选择要测的引擎
- 发布流水线校验 tag 与版本号一致、CHANGELOG 含对应条目，并构建 amd64 + arm64 多架构镜像
- 新增 MCP Registry 元数据（`server.json`），发布时校验主包、Registry 元数据与两个 Worker 的版本号一致
- Issue 模板改为结构化表单，新增 CODEOWNERS；NOTICE 补充第三方设计思路归属
- `npm run selfcheck` 补全为真实自检：产物 shebang、`--version`、必需文件、经 stdio 握手并列出 5 个工具
- 开发验证脚本移到 `scripts/dev/`；新增 `.gitattributes`、`.nvmrc`、`.env.example`、`.github/SUPPORT.md`
- 单元测试从 110 个增加到 250 余个，覆盖率门槛上调到行 66% / 函数 62% / 分支 53%

## 0.2.0 - 2026-09-15（内部预览版，未公开发布）

仅在内部使用的预览版本，没有对应的 git tag、npm 包或 GitHub Release；其内容已全部包含在 0.3.0 / 0.3.1 中。

### 新增

- 多引擎网页搜索 MCP 服务器，支持 8 个搜索引擎：Google、Bing、百度、360、搜狗、DuckDuckGo、Yandex、Brave
- 工具 `web_search`：多引擎搜索 + 跨源降级 + 缓存 + 结果去重
- 工具 `image_search`：多引擎图片搜索（Google / Bing / 百度 / Brave），支持尺寸、类型过滤与 base64 缩略图
- 工具 `fetch_page`：网页内容抓取并转换为 HTML / 纯文本 / Markdown
- 工具 `wechat_search`：基于搜狗微信的公众号文章搜索，内置 Cookie 轮换与重试退避
- 工具 `list_engines`：列出所有已注册引擎及其状态
- Google 引擎三策略编排：Custom Search API → 浏览器渲染 → 纯 HTTP，自动降级并记忆成功策略
- 基于 Playwright 的浏览器抓取（`fetch_page` 的 `method: browser`）
- 双传输模式：stdio（本地）与 Streamable HTTP（远程），HTTP 模式支持 Bearer Token 鉴权
- 配置系统：YAML / JSON / TOML 加载，`PRISMSEARCH_` 前缀环境变量覆盖
- 引擎注册中心与自动选择策略（可用性 / 延迟 / 成功率 / 语言匹配），内置三态熔断器
- SQLite 缓存层：TTL 过期 + LRU 淘汰，可选 Redis 后端
- 安全：SSRF 防护（协议 / 内网 IP / DNS 重绑定检测、白黑名单）、滑动窗口速率限制
- 代理池，支持轮询与失败冷却
- Docker 多阶段构建与 docker-compose 编排

[未发布]: https://github.com/xiaonerner0821/prismsearch/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/xiaonerner0821/prismsearch/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/xiaonerner0821/prismsearch/releases/tag/v0.3.1
