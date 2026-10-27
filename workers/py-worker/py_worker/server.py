"""PrismSearch 抓取 Worker（Python）

实现 docs/worker-protocol.md 定义的协议：
  GET  /health   健康与能力声明
  POST /v1/fetch 抓取（仅 http 方法）

安全默认值：
- 默认只监听 127.0.0.1，显式设置 WORKER_HOST 才对外监听；未配置 token 时拒绝绑定非回环地址
- 目标地址做 SSRF 校验；并发上限
- 500 响应只返回通用文案，异常细节只写日志
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import signal
import sys
import threading
import traceback
from collections.abc import Mapping
from contextlib import suppress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import metadata

from . import fetcher
from .fetcher import FetchRequest, TargetFetchError
from .ssrf import SsrfBlockedError, SsrfOptions, configure

PACKAGE_NAME = "prismsearch-py-worker"
FALLBACK_VERSION = "0.0.0-dev"


def _read_version() -> str:
    """从已安装包的元数据读取版本（与 pyproject.toml 保持单一来源）。"""
    try:
        return metadata.version(PACKAGE_NAME)
    except Exception:  # noqa: BLE001 - 未安装（直接从源码运行）等情况一律回退
        return FALLBACK_VERSION


VERSION = _read_version()
FALLBACK_HOST = "127.0.0.1"
LOOPBACK_HOSTS = frozenset({FALLBACK_HOST, "localhost", "::1"})
DEFAULT_PORT = 8788
DEFAULT_MAX_CONCURRENCY = 8
MAX_BODY_BYTES = 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 120
HEADERS_TIMEOUT_SECONDS = 15


class ConfigError(Exception):
    """配置不安全或无效，拒绝启动。"""


class Config:
    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        env = os.environ if env is None else env
        self.token = (env.get("PRISMSEARCH_WORKER_TOKEN") or "").strip() or None
        # 默认始终监听回环；必须显式设置 WORKER_HOST 才对外监听
        self.host = (env.get("WORKER_HOST") or "").strip() or FALLBACK_HOST
        try:
            self.port = int(env.get("WORKER_PORT", DEFAULT_PORT))
        except ValueError:
            self.port = DEFAULT_PORT
        try:
            self.max_concurrency = int(env.get("WORKER_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY))
        except ValueError:
            self.max_concurrency = DEFAULT_MAX_CONCURRENCY
        if self.max_concurrency <= 0:
            self.max_concurrency = DEFAULT_MAX_CONCURRENCY
        # 旧版全局放行开关：留空或 0 视为未设置，其余任何值都在 check() 中拒绝启动
        legacy_private = (env.get("WORKER_ALLOW_PRIVATE_NETWORK") or "").strip()
        self.allow_private_network = legacy_private not in ("", "0")

    def check(self) -> None:
        """不安全的配置抛 ConfigError。"""
        if self.allow_private_network:
            raise ConfigError("拒绝启动：WORKER_ALLOW_PRIVATE_NETWORK 已废弃；禁止全局放行私网。")
        if self.token is None and self.host not in LOOPBACK_HOSTS:
            raise ConfigError(
                "拒绝启动：未设置 PRISMSEARCH_WORKER_TOKEN 时只能监听回环地址。\n"
                "          Worker 能访问内网，暴露在网络上必须配置 token。"
            )

    def validate(self) -> None:
        try:
            self.check()
        except ConfigError as exc:
            print(f"[worker] {exc}", file=sys.stderr)
            sys.exit(1)


class State:
    """进程级共享状态。"""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.in_flight = 0
        self.lock = threading.Lock()

    def try_acquire(self) -> bool:
        with self.lock:
            if self.in_flight >= self.config.max_concurrency:
                return False
            self.in_flight += 1
            return True

    def release(self) -> None:
        with self.lock:
            self.in_flight = max(0, self.in_flight - 1)

    @property
    def current(self) -> int:
        with self.lock:
            return self.in_flight


def _authorized(header: str | None, token: str) -> bool:
    if not header:
        return False
    parts = header.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    # 先各自摘要再定长比较：长度不同也不提前返回，避免泄露 token 长度
    given = hashlib.sha256(parts[1].encode()).digest()
    expected = hashlib.sha256(token.encode()).digest()
    return hmac.compare_digest(given, expected)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"prismsearch-worker/{VERSION}"

    state: State  # 由 make_server 注入

    def _expire_connection(self) -> None:
        with suppress(OSError):
            self.connection.shutdown(2)

    def handle_one_request(self) -> None:
        # 绝对期限，而不仅是每次 recv 的空闲超时；持续滴送字节也不能续期。
        self._header_timer = threading.Timer(HEADERS_TIMEOUT_SECONDS, self._expire_connection)
        self._header_timer.daemon = True
        self._header_timer.start()
        try:
            super().handle_one_request()
        finally:
            self._header_timer.cancel()

    def parse_request(self) -> bool:
        try:
            return super().parse_request()
        finally:
            self._header_timer.cancel()


    # 默认实现会往 stderr 打日志，这里收与 logger 统一格式
    def log_message(self, fmt: str, *args) -> None:
        print(f"[worker] {self.address_string()} {fmt % args}", file=sys.stderr)

    # ===== 发送响应 =====

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, code: str, message: str) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}})

    # ===== 路由 =====

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 约定
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self.close_connection = True
            self._send_json(
                200,
                {
                    "status": "ok",
                    "version": VERSION,
                    "capabilities": ["http"],
                    "inFlight": self.state.current,
                    "maxConcurrency": self.state.config.max_concurrency,
                },
            )
            return
        if path == "/v1/fetch":
            self._error(405, "NOT_FOUND", "只支持 POST")
            return
        self._error(404, "NOT_FOUND", f"未知路径 {path}")

    def do_POST(self) -> None:  # noqa: N802
        # 读取请求体之前占槽，慢上传也计入并发上限。
        self.close_connection = True
        if not self.state.try_acquire():
            self._error(429, "BUSY", "并发已达上限")
            return
        self.connection.settimeout(HEADERS_TIMEOUT_SECONDS)
        try:
            self._do_POST()
        except (TimeoutError, OSError):
            # deadline 可能已关闭套接字，响应失败不再向线程外传播。
            with suppress(OSError):
                self._error(408, "REQUEST_TIMEOUT", "请求体读取超时")
        finally:
            self.connection.settimeout(REQUEST_TIMEOUT_SECONDS)
            self.state.release()

    def _do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path != "/v1/fetch":
            self._error(404, "NOT_FOUND", f"未知路径 {path}")
            return

        token = self.state.config.token
        if token is not None and not _authorized(self.headers.get("Authorization"), token):
            self._error(401, "UNAUTHORIZED", "鉴权失败：Authorization: Bearer <token>")
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._error(400, "BAD_REQUEST", "Content-Length 无效")
            return
        if length <= 0:
            self._error(400, "BAD_REQUEST", "缺少请求体")
            return
        if length > MAX_BODY_BYTES:
            self._error(400, "BAD_REQUEST", f"请求体超过上限 {MAX_BODY_BYTES} 字节")
            return

        timer = threading.Timer(HEADERS_TIMEOUT_SECONDS, self._expire_connection)
        timer.daemon = True
        timer.start()
        try:
            raw = self.rfile.read(length)
        finally:
            timer.cancel()
        if len(raw) != length:
            self._error(400, "BAD_REQUEST", "请求体不完整")
            return
        self.connection.settimeout(REQUEST_TIMEOUT_SECONDS)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "BAD_REQUEST", "请求体无法解析")
            return
        if not isinstance(payload, dict):
            self._error(400, "BAD_REQUEST", "请求体必须是 JSON 对象")
            return

        url = payload.get("url")
        if not isinstance(url, str) or not url.strip():
            self._error(400, "BAD_REQUEST", "缺少 url 字段")
            return

        headers = payload.get("headers")
        if headers is not None and not isinstance(headers, dict):
            self._error(400, "BAD_REQUEST", "headers 必须是对象")
            return

        method = payload.get("method") or "http"
        if method != "http":
            # 本 Worker 不提供浏览器渲染，让主进程回落到其他 Worker
            self._error(400, "UNSUPPORTED_METHOD", f"本 Worker 只支持 method=http，收到 {method}")
            return

        try:
            req = FetchRequest(
                url=url,
                format=payload.get("format") or "markdown",
                method="http",
                timeout_ms=int(payload.get("timeoutMs") or fetcher.DEFAULT_TIMEOUT_MS),
                max_bytes=int(payload.get("maxBytes") or fetcher.DEFAULT_MAX_BYTES),
                wait_for_selector=payload.get("waitForSelector"),
                headers={str(k): str(v) for k, v in (headers or {}).items()},
                user_agent=payload.get("userAgent"),
            )
            result = fetcher.fetch(req)
            self._send_json(200, result.to_dict())
        except SsrfBlockedError as exc:
            self._error(403, "SSRF_BLOCKED", str(exc))
        except TargetFetchError as exc:
            # 413 与 501 属于请求本身不合适，换 Worker 也没用
            if exc.status_code in (413, 501):
                self._error(400, "BAD_REQUEST", str(exc))
            else:
                self._error(502, "FETCH_FAILED", str(exc))
        except Exception as exc:  # noqa: BLE001 - 兜底，避免线程崩掉把连接挂死
            # 细节只进日志：原始异常信息可能带内部路径、依赖版本等，不回传给客户端
            print(f"[worker] 抓取异常：{exc!r}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            self._error(500, "INTERNAL", "内部错误")


class BoundedHTTPServer(ThreadingHTTPServer):
    """在线程创建之前限制连接数，包含尚未发完请求头的连接。"""

    def __init__(self, address, handler, max_connections: int) -> None:
        self._connections = threading.BoundedSemaphore(max_connections)
        super().__init__(address, handler)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(HEADERS_TIMEOUT_SECONDS)
        return request, address

    def process_request(self, request, client_address) -> None:
        if not self._connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._connections.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connections.release()


def make_server(config: Config) -> ThreadingHTTPServer:
    state = State(config)
    handler = type("BoundHandler", (Handler,), {"state": state})
    server = BoundedHTTPServer((config.host, config.port), handler, max(16, config.max_concurrency * 2))
    server.daemon_threads = True
    server.timeout = REQUEST_TIMEOUT_SECONDS
    return server


def main() -> None:
    config = Config()
    config.validate()
    # validate() 已拒绝旧版全局放行开关，这里始终使用默认的私网拦截
    configure(SsrfOptions())

    server = make_server(config)
    auth = "已启用" if config.token else "未启用"
    print(
        f"[worker] 已启动 http://{config.host}:{config.port}"
        f"（并发上限 {config.max_concurrency}，鉴权 {auth}）"
    )

    def shutdown(signum, _frame) -> None:
        print(f"[worker] 收到信号 {signum}，开始关闭…", file=sys.stderr)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
