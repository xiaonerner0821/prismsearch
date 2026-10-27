# PrismSearch Worker 协议（v1）

主进程（MCP Server）可以把「抓取网页」这件重活委派给独立的 Worker 进程，用来：

- 用真实浏览器渲染 JS 站点（Playwright），绕开只返回骨架 HTML 的站点
- 用 Python 生态的强解析器提取正文（curl_cffi 指纹伪装 + trafilatura）
- 把内存占用大、可能崩溃的浏览器实例隔离在独立进程 / 独立容器里

协议刻意做得极简：**HTTP + JSON，无状态，可水平扩展**。任何语言只要按下面的约定实现两个端点即可接入。

---

## 1. 端点

### `GET /health`

健康探测，也要用来声明能力。

**响应 `200`**

```json
{
  "status": "ok",
  "version": "0.3.1",
  "capabilities": ["http", "browser"],
  "inFlight": 2,
  "maxConcurrency": 8
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `"ok"` | 必须是字面量 `ok`，其他值视为不健康 |
| `version` | string | Worker 自身版本，仅用于日志与排查 |
| `capabilities` | string[] | 支持的方法，取值见「抓取方法」。`http` 表示纯 HTTP，`browser` 表示浏览器渲染 |
| `inFlight` | number | 当前在途请求数（可选，仅展示） |
| `maxConcurrency` | number | 建议并发上限（可选，仅展示） |

`status` 不是 `ok`、返回非 2xx、或超时（客户端默认 5 秒）时，客户端会把该 Worker 标记为不健康，并暂停向它派发请求，直到下一轮探测成功。

### `POST /v1/fetch`

**请求体**

```json
{
  "url": "https://example.com/article",
  "format": "markdown",
  "method": "browser",
  "timeoutMs": 30000,
  "maxBytes": 5242880,
  "waitForSelector": "#content",
  "headers": { "Accept-Language": "zh-CN,zh;q=0.9" },
  "userAgent": "Mozilla/5.0 ..."
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | 目标地址，必须是 `http` / `https` |
| `format` | 否 | `markdown`（默认）/ `text` / `html` |
| `method` | 否 | `http` 或 `browser`。缺省值由各 Worker 自行决定：参考实现中 ts-worker 默认 `browser`，py-worker 默认 `http`。主进程委派时总会显式传入 |
| `timeoutMs` | 否 | Worker 端整体超时，客户端已按自身配置收敛 |
| `maxBytes` | 否 | 响应体上限；**超限时截断**并置 `truncated: true`，不要报错（与主进程本地抓取一致） |
| `waitForSelector` | 否 | 浏览器渲染时等待的 CSS 选择器 |
| `headers` | 否 | 附加请求头（不得覆盖鉴权头） |
| `userAgent` | 否 | 指定 UA；缺省时 Worker 自行从 UA 池挑选 |

`format: html` 表示原样返回 HTML，不做正文提取；其余格式需要 Worker 负责抽取正文。

**成功响应 `200`**

```json
{
  "url": "https://example.com/article",
  "content": "# 标题\n\n正文……",
  "rawHtml": "<!DOCTYPE html>...",
  "title": "标题",
  "statusCode": 200,
  "contentType": "text/html; charset=utf-8",
  "contentLength": 12345,
  "fetchTime": 1830
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | **跟随重定向后的最终 URL**。客户端会用它对 SSRF 再校验一次 |
| `content` | 是 | 抽取后的正文（或 `format: html` 时的原始 HTML） |
| `rawHtml` | 否 | 原始 HTML，供主进程做二次解析 |
| `title` | 否 | 页面标题 |
| `statusCode` | 是 | 目标站点的状态码，不是 Worker 自己的 |
| `contentType` | 否 | 目标响应的 Content-Type |
| `contentLength` | 否 | 正文字节数 |
| `fetchTime` | 否 | Worker 端耗时（毫秒） |
| `truncated` | 否 | 响应体超过 `maxBytes` 被截断；仅在截断时出现 |

**失败响应**

HTTP 状态码表示**这次调用**的状态，`error.code` 表示具体原因：

```json
{ "error": { "code": "SSRF_BLOCKED", "message": "目标地址指向内网，已拒绝" } }
```

| HTTP | `error.code` | 客户端行为 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 不重试，参数错误 |
| 400 | `UNSUPPORTED_METHOD` | 该 Worker 不支持这个方法（如未装 Playwright 却收到 `method: browser`）。摘掉这项能力后换下一个 Worker |
| 401 / 403 | `UNAUTHORIZED` | 标记 Worker 不健康，换下一个 Worker |
| 403 | `SSRF_BLOCKED` | 不重试。目标地址本身不安全，换 Worker 也没意义 |
| 404 / 405 | `NOT_FOUND` | 不重试，协议不匹配 |
| 429 | `BUSY` | 换下一个 Worker 重试 |
| 5xx | `INTERNAL` | 标记不健康并换下一个 Worker |
| 502 | `FETCH_FAILED` | **目标站点**取不到（DNS / 连接 / 超时 / 50x）。换 Worker 重试，但不标记 Worker 不健康 |

DNS 解析失败同样归入 `FETCH_FAILED`：Worker 必须先解析出地址、校验后再钉住该 IP 发起请求，
解析不出来就不能交给底层 HTTP 库自己再解析一次（会留下 DNS 重绑定窗口）。

`FETCH_FAILED` 与 `INTERNAL` 的区别很重要：前者是目标站的问题，Worker 本身是健康的；后者说明 Worker 自己有毛病。

---

## 2.1 Worker origin 与 HTTP 边界

主服务只应连接受信任的 Worker。`workers.allowedOrigins` 使用精确 origin（协议、主机、端口；不带末尾斜杠），不支持通配符；非回环 origin 必须配置 Worker token 并使用 HTTPS。`workers.endpoints[].allowInsecureHttp` 默认 `false`，仅可对受信任的本地/Docker 内网端点显式设置 `true`，不得作为公网部署方案。来源白名单只约束 Worker 连接，不会放宽目标 URL 的 SSRF 检查。

旧版 Worker 的全局 `WORKER_ALLOW_PRIVATE_NETWORK` 开关已废弃；设置为空或 `0` 以外任何值（如 `1`、`true`）的 Worker 都会拒绝启动。允许内网目标只能通过主服务的精确 `security.ssrf.allowedPrivateHosts` 配置，并且必须经过部署者审查；`security.ssrf.whitelist` 不绕过 IP 校验。


固定使用 Bearer Token：

```
Authorization: Bearer <token>
```

- 主进程从配置 `workers.endpoints[].token` 读取，缺省回退到环境变量 `PRISMSEARCH_WORKER_TOKEN`
- Worker 端从自己的环境变量读取同一个值
- **未配置 token 的 Worker 只应监听回环地址**。Worker 能访问内网，裸奔等于把内网打开
- 鉴权头不参与 SSRF 校验，也不允许被 `headers` 字段覆盖

---

## 3. 安全边界

Worker 比主进程更危险，因为它通常部署在内网：

1. **必须做 SSRF 校验**。校验点应在建立连接时（DNS 解析之后），而不是只校验字符串。拒绝回环、私网、链路本地、组播地址与云元数据端点
2. **跟随重定向后要重新校验**，并在响应里回报最终 URL，让主进程再校验一次
3. **默认只监听回环**。需要跨主机时显式绑定并务必配 token
4. **限制响应体大小**，不要整段读进内存
5. **并发与超时都要有上限**，Worker 被打爆会拖垮整条链路
6. Worker 不接收 Cookie 持久化写入，不落盘任何抓取内容

---

## 4. 主进程侧的调度行为

- **负载均衡**：`round-robin`（平滑加权轮询）或 `least-busy`（在途数 / 权重最小）；权重来自 `workers.endpoints[].weight`
- **并发控制**：单个 Worker 的在途请求不超过 `maxConcurrency`
- **故障转移**：可重试错误会换下一个健康 Worker，同一请求不会重复打同一个 Worker
- **降级**：所有 Worker 都不可用（或 `workers.useFor` 未覆盖该方法）时，按 `workers.fallbackToLocal` 决定是否回退到主进程本地抓取
- **健康恢复**：不健康 Worker 会在下一轮 `healthCheckIntervalMs` 探测成功后自动恢复，无需重启

---

## 5. 最小实现示例

```js
// 伪代码：任何语言按此结构即可
server.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '0.1.0', capabilities: ['http'], inFlight: current, maxConcurrency: limit });
});

server.post('/v1/fetch', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'bad token' } });
  const { url, method = 'http' } = req.body;
  try {
    const page = await fetchPage(url);
    res.json({ url: page.finalUrl, content: page.text, statusCode: page.status });
  } catch (e) {
    if (e.isSsrf) return res.status(403).json({ error: { code: 'SSRF_BLOCKED', message: e.message } });
    if (e.isTargetFailure) return res.status(502).json({ error: { code: 'FETCH_FAILED', message: e.message } });
    log.error(e); // 细节只写日志，不把原始异常信息回传给客户端
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
  }
});
```

参考实现：

- `workers/ts-worker/` — Node + Playwright，`capabilities: ["http", "browser"]`
- `workers/py-worker/` — Python + curl_cffi + trafilatura，`capabilities: ["http"]`

---

## 6. 配置示例

```yaml
workers:
  enabled: true
  strategy: least-busy        # round-robin | least-busy
  timeoutMs: 45000
  healthCheckIntervalMs: 30000
  useFor: browser             # browser：只在需要渲染时用 Worker；always：全部走 Worker
  fallbackToLocal: true
  endpoints:
    # 不写 token 时回落到环境变量 PRISMSEARCH_WORKER_TOKEN
    - name: ts-1
      url: http://127.0.0.1:8787
      weight: 100
      maxConcurrency: 8
    - name: py-1
      url: http://127.0.0.1:8788
      weight: 50
      maxConcurrency: 4
```

配置文件不做 `${VAR}` 形式的环境变量展开，写成 `token: ${PRISMSEARCH_WORKER_TOKEN}` 会被当成字面字符串。
需要各 Worker 用不同 token 时，在对应端点写明 `token: <值>`；所有 Worker 共用一个 token 时省略该字段即可。

`useFor: browser` 时，纯 HTTP 抓取仍走主进程；只有需要浏览器渲染的请求才委派出去。这也是默认行为，配置成本最低。
