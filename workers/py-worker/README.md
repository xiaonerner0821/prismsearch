# PrismSearch Python Worker

简体中文 | [English](./README.en.md)

Python 抓取 Worker，能力：`["http"]`。请求未指定 `method` 时默认 `http`。主打两件事：

- **TLS 指纹伪装**：用 `curl_cffi` 复刻 Chrome / Safari 的握手特征，对指纹识别型反爬比普通 HTTP 客户端存活率高
- **正文提取质量**：用 `trafilatura` 抽取正文，对新闻、博客、文档类页面比纯选择器方案干净

不提供浏览器渲染，需要渲染的请求请交给 [`ts-worker`](../ts-worker/)。协议见 [`docs/worker-protocol.md`](../../docs/worker-protocol.md)。

## 快速开始

```bash
pip install -e ".[dev]"

# 只在本机使用（默认监听 127.0.0.1）
python -m py_worker.server

# 对外提供服务：必须显式设置 WORKER_HOST，并同时设置 token
PRISMSEARCH_WORKER_TOKEN=<随机长字符串> WORKER_HOST=0.0.0.0 python -m py_worker.server
```

默认端口 `8788`，与 ts-worker 的 `8787` 错开，两个可以同时跑。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PRISMSEARCH_WORKER_TOKEN` | 无 | Bearer token。**未设置时只能监听回环地址**，否则拒绝启动 |
| `WORKER_HOST` | `127.0.0.1` | 监听地址。设置 token 不会自动对外监听，必须显式设置此变量；Docker 镜像内已设为 `0.0.0.0` |
| `WORKER_PORT` | `8788` | 监听端口 |
| `WORKER_MAX_CONCURRENCY` | `8` | 并发上限，超出返回 `429 BUSY` |
| `WORKER_ALLOW_PRIVATE_NETWORK` | `0` | 旧全局开关已移除；设为空或 `0` 以外的任何值（如 `1`、`true`）都会拒绝启动，不再允许全局内网访问 |

`/health` 返回的版本号运行时读取自已安装包的元数据（`prismsearch-py-worker`），直接从源码运行、未安装时显示 `0.0.0-dev`。

## 在 PrismSearch 中启用

Worker 是可选抓取后端，不是 MCP Server。跨主机部署需把精确 origin（不带末尾斜杠）加入主服务 `workers.allowedOrigins`，设置 token 并使用 HTTPS；仅可信 Docker 内网可显式设置端点 `allowInsecureHttp: true`（默认 false），不要公开 Worker 端口。普通抓取目标仍受 SSRF 校验，不能用来源白名单放行内网目标。

```yaml
workers:
  enabled: true
  strategy: round-robin
  useFor: always        # 纯 HTTP 抓取优先用 Python Worker 的指纹能力
  fallbackToLocal: true
  endpoints:
    # 不写 token 时回落到主服务的环境变量 PRISMSEARCH_WORKER_TOKEN
    - name: py-1
      url: http://127.0.0.1:8788
      weight: 50
      maxConcurrency: 4
```

配置文件不展开 `${VAR}`，不要写 `token: ${PRISMSEARCH_WORKER_TOKEN}`（会被当成字面字符串）。

Docker 部署见 [`docker/docker-compose.yml`](../../docker/docker-compose.yml) 的 `with-workers` profile。

## 依赖锁定

Docker 镜像按 `requirements.lock`（带 hash，针对 Linux / 最低支持版本 CPython 3.10）安装依赖。锁文件必须按 `requires-python` 的下限解析，否则在低版本上装不上（例如按 3.12 解析会引入要求 3.11+ 的包）。修改 `pyproject.toml` 的依赖后重新生成：

```bash
uv pip compile pyproject.toml --generate-hashes --python-version 3.10 --python-platform linux -o requirements.lock
```

## 实现要点

- **重定向**：关闭 curl_cffi 的自动跳转，自己逐跳跟随并在每跳重新校验地址。自动跳转会绕过 SSRF 校验
- **SSRF**：域名解析出的**所有**地址都要校验，只要有一个落进内网就整体拒绝，避免靠多条 A 记录赌解析顺序；IPv4 映射、6to4、Teredo、NAT64 的内嵌 IPv4 都会解开再判一次
- **指纹选择**：按 URL 稳定哈希挑一个 `impersonate` 档位，同一站点多次抓取保持一致，避免指纹跳变触发风控
- **大小限制**：流式读取并累计字节数，超过上限立即中断
- **正文兜底**：`trafilatura` 返回空时，回落到基于文本密度的容器选择与结构化输出，避免列表页、文档页整页丢失
- **错误信息**：未预期的异常只向客户端返回通用的 `500 INTERNAL`，细节写入服务端日志

## 测试

```bash
pytest -q     # 77 个用例，全部离线，不需要真实网络
```

在仓库根目录也可以运行 `node scripts/py-worker-task.mjs test` / `node scripts/py-worker-task.mjs lint`。

覆盖地址判定（含各类 IPv6 内嵌形式）、协议端点、鉴权失败路径、监听地址策略、正文提取与噪声剥离。

## 许可证

[Apache-2.0](./LICENSE)，与 PrismSearch 主仓库（见仓库根目录 [`LICENSE`](../../LICENSE)）一致。
