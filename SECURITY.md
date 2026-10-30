# 安全政策 / Security Policy

## 支持的版本 / Supported Versions

| 版本  | 支持状态            |
| ----- | ------------------- |
| 0.3.x | ✅ 当前支持          |

0.3.1 是首个公开发布的版本（0.3.0 未公开发布）；更早的内部预览版不提供安全更新。

## 报告漏洞 / Reporting a Vulnerability

PrismSearch 处理搜索引擎凭据并会抓取任意外部 URL，我们非常重视以下类别的安全问题：

- SSRF 防护绕过（内网探测、DNS 重绑定、重定向绕过）
- API Key / Token 泄露或日志打印
- 远程 HTTP 模式的鉴权绕过、Host / Origin 校验绕过
- 速率限制绕过导致配额耗尽
- 抓取 Worker 的鉴权绕过，或经由 Worker 重定向访问内网
- 缓存污染与注入
- 内容过滤被绕过（恶意内容未按配置拦截）

**请通过以下方式私下报告，不要在公开 Issue 中披露：**

- **GitHub 私密漏洞报告**：仓库页面的 Security → Advisories → Report a vulnerability
  （<https://github.com/xiaonerner0821/prismsearch/security/advisories/new>）
- **备用邮件**：<mailto:xiaonerner0821@gmail.com>（仅使用项目已公开的安全联络地址，不提供额外个人信息）

请在报告中尽量包含：受影响版本、复现步骤、影响范围与可能的修复建议。

### 响应流程与披露 / Response and Disclosure Process

1. 收到私下报告后，我们会在 **48 小时内**确认收件，并分配跟踪编号；请不要在公开 Issue、PR、日志或截图中披露漏洞细节、真实 URL、查询内容、API Key 或个人信息。
2. 我们会在 **7 个日历日内**完成初步分级（可利用性、影响范围、受影响版本）并与报告者确认复现方式；复杂问题会说明进度。
3. 确认后优先制定修复方案，必要时发布补丁版本和安全公告；修复前仅向必要的维护者共享细节。
4. 修复发布后，在报告者同意的前提下公开致谢；可选择匿名。我们不会公开个人联系方式或敏感证据。
5. 若问题不属于本项目、无法复现或需要上游处理，我们会说明理由并建议安全的转交路径；请勿把上游的私密细节复制到公共渠道。

报告者可以在确认后请求状态更新；若 7 日内没有收到回复，请在同一私密报告中跟进，并只引用跟踪编号。若私密入口暂不可用，请先开不含技术细节的 Issue 请求维护者恢复入口，不要公开漏洞证据。

### English summary

Report vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/xiaonerner0821/prismsearch/security/advisories/new), not public Issues or PRs. Include the affected version, a minimal redacted reproduction, impact, and suggested mitigation; never include live credentials, personal data, production URLs or sensitive logs. We aim to acknowledge within 48 hours and provide an initial assessment within 7 calendar days, then coordinate remediation and publication. Credit is optional and may be anonymous; private evidence and contact details will not be published. If there is no reply within 7 days, follow up in the same private report. If the private entry is unavailable, open a detail-free Issue asking maintainers to restore it; do not disclose vulnerability evidence publicly.

### 使用者安全建议

- 永远不要把真实 API Key 提交到配置文件或版本库；使用环境变量注入
  （`GOOGLE_API_KEY`、`GOOGLE_CSE_ID`、`BRAVE_API_KEY`）
- HTTP 模式绑定 `0.0.0.0` 对外服务时，务必启用鉴权：配置 `security.auth`
  或用 `PRISMSEARCH_AUTH_TOKENS` 注入令牌。未开启时服务会拒绝启动
- Worker 必须设置 `PRISMSEARCH_WORKER_TOKEN`。未设置令牌的 Worker 只会监听回环地址，
  这是有意的保护；不要为了「跑通」把令牌留空又把监听地址改成 `0.0.0.0`
- 保持 SSRF 防护（`security.ssrf.enabled`）开启，除非你知道自己在做什么
- 日志脱敏（`log.redact`）默认开启，会隐藏 URL 查询串与搜索词；排查问题时如临时关闭，
  注意日志里可能出现敏感查询内容

## 已实施的安全措施 / Implemented Controls

了解已有哪些防护有助于判断问题是配置问题还是代码缺陷：

- **SSRF**：协议白名单、内网与保留地址阻断、建连时二次校验（防 DNS 重绑定）、
  重定向逐跳校验；Worker 端独立实现同一套校验，并对最终地址再次验证
- **鉴权**：Bearer Token 或 `X-API-Key`，常量时间比较；监听非回环地址时强制要求
- **Host / Origin 校验**：防 DNS 重绑定与跨站请求
- **速率限制**：HTTP 模式按客户端分桶（凭证指纹或地址），stdio 模式在工具层限制
- **密钥处理**：API Key 支持多 Key 轮换，日志中不输出密钥内容
- **依赖与代码**：CI 运行 Gitleaks 密钥扫描、CodeQL 静态分析、依赖审查与 OpenSSF Scorecard
