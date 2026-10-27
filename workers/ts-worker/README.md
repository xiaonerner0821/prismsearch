# PrismSearch TS Worker

简体中文 | [English](./README.en.md)

Node + Playwright 实现的抓取 Worker，用于渲染需要 JavaScript 的页面。协议见 [`docs/worker-protocol.md`](../../docs/worker-protocol.md)。

能力：`["http", "browser"]`。请求未指定 `method` 时默认 `browser`。

## 快速开始

```bash
npm ci
npx playwright install chromium   # 首次需要下载浏览器
npm run build

# 只在本机使用（默认监听 127.0.0.1）
WORKER_PORT=8787 npm start

# 对外提供服务：必须显式设置 WORKER_HOST，并同时设置 token
PRISMSEARCH_WORKER_TOKEN=<随机长字符串> WORKER_HOST=0.0.0.0 npm start
```

开发时可用 `npm run dev`（Node 原生类型剥离 + 文件监听）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PRISMSEARCH_WORKER_TOKEN` | 无 | Bearer token。**未设置时只能监听回环地址**，否则拒绝启动 |
| `WORKER_HOST` | `127.0.0.1` | 监听地址。设置 token 不会自动对外监听，必须显式设置此变量；Docker 镜像内已设为 `0.0.0.0` |
| `WORKER_PORT` | `8787` | 监听端口 |
| `WORKER_MAX_CONCURRENCY` | `8` | 并发上限，超出返回 `429 BUSY` |
| `WORKER_ALLOW_PRIVATE_NETWORK` | `0` | 旧全局开关已移除；设为空或 `0` 以外的任何值（如 `1`、`true`）都会拒绝启动，不再允许全局内网访问 |

`/health` 返回的版本号运行时读取自本目录的 `package.json`。

## 在 PrismSearch 中启用

Worker 是可选抓取后端，不是 MCP Server。跨主机部署需把精确 origin（不带末尾斜杠）加入主服务 `workers.allowedOrigins`，设置 token 并使用 HTTPS；仅可信 Docker 内网可显式设置端点 `allowInsecureHttp: true`（默认 false），不要公开 Worker 端口。普通抓取目标仍受 SSRF 校验，不能用来源白名单放行内网目标。

```yaml
workers:
  enabled: true
  strategy: least-busy
  useFor: browser        # 只在需要浏览器渲染时才委派
  fallbackToLocal: true  # Worker 全挂时回落到本地抓取
  endpoints:
    # 不写 token 时回落到主服务的环境变量 PRISMSEARCH_WORKER_TOKEN
    - name: ts-1
      url: http://127.0.0.1:8787
      weight: 100
      maxConcurrency: 8
```

配置文件不展开 `${VAR}`，不要写 `token: ${PRISMSEARCH_WORKER_TOKEN}`（会被当成字面字符串）。

Docker 部署见 [`docker/docker-compose.yml`](../../docker/docker-compose.yml) 的 `with-workers` profile。

## 实现要点

- **SSRF**：URL 解析后按 DNS 结果逐个校验；undici 的自定义 `lookup` 在**连接时**再校验一次，挡住 DNS 重绑定。浏览器模式下每个子资源请求都过一次 `page.route` 校验，重定向后的最终地址还会再校验
- **响应大小**：流式读取并累计字节数，超过上限立即中断，不会把超大响应整个读进内存
- **浏览器复用**：共享一个 Chromium 实例，每次请求开新页面，页面在 `finally` 里关闭
- **头部过滤**：客户端传入的 `Host`、`Authorization`、`Content-Length` 等会被丢弃，避免破坏请求或被用来绕过鉴权
- **错误信息**：未预期的异常只向客户端返回通用的 `500 INTERNAL`，细节写入服务端日志

## 测试

```bash
npm run typecheck
npm test
```

覆盖 SSRF 地址判定、协议端点、鉴权失败路径、内网拒绝、监听地址策略等，不需要真实网络。

## 许可证

[Apache-2.0](./LICENSE)，与 PrismSearch 主仓库（见仓库根目录 [`LICENSE`](../../LICENSE)）一致。
