"""HTTP 协议端点测试：真实起一个 server，用 urllib 打过去。"""

from __future__ import annotations

import json
import socket
import threading
import urllib.error
import urllib.request

import pytest

from py_worker import server as server_module
from py_worker.server import Config, ConfigError, make_server

TOKEN = "test-token-456"


@pytest.fixture(scope="module")
def server_url():
    config = Config()
    config.host = "127.0.0.1"
    config.port = 0
    config.token = TOKEN
    config.max_concurrency = 2
    config.allow_private_network = False

    server = make_server(config)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _post(base: str, body, token: str | None = TOKEN):
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(
        f"{base}/v1/fetch",
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def _get(base: str, path: str):
    try:
        with urllib.request.urlopen(f"{base}{path}", timeout=10) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def test_health_needs_no_auth(server_url: str) -> None:
    status, body = _get(server_url, "/health")
    assert status == 200
    assert body["status"] == "ok"
    assert body["capabilities"] == ["http"]
    assert body["maxConcurrency"] == 2


def test_unknown_path_404(server_url: str) -> None:
    status, body = _get(server_url, "/nope")
    assert status == 404
    assert body["error"]["code"] == "NOT_FOUND"


def test_missing_and_wrong_token(server_url: str) -> None:
    status, body = _post(server_url, {"url": "https://example.com"}, token=None)
    assert status == 401
    assert body["error"]["code"] == "UNAUTHORIZED"

    status, _ = _post(server_url, {"url": "https://example.com"}, token="wrong")
    assert status == 401


def test_bad_body(server_url: str) -> None:
    status, body = _post(server_url, b"{not json")
    assert status == 400
    assert body["error"]["code"] == "BAD_REQUEST"
    assert body["error"]["message"] == "请求体无法解析"

    status, body = _post(server_url, b'{"secret":"private-token",\xff}')
    assert status == 400
    assert "private-token" not in json.dumps(body)
    assert body["error"]["message"] == "请求体无法解析"

    status, body = _post(server_url, {"format": "markdown"})
    assert status == 400
    assert "url" in body["error"]["message"]


def test_browser_method_is_rejected(server_url: str) -> None:
    status, body = _post(server_url, {"url": "https://example.com", "method": "browser"})
    assert status == 400
    # 与 ts-worker 一致：主进程靠这个错误码摘掉 browser 能力并换 Worker
    assert body["error"]["code"] == "UNSUPPORTED_METHOD"
    assert "method=http" in body["error"]["message"]


def test_private_target_blocked(server_url: str) -> None:
    status, body = _post(server_url, {"url": "http://127.0.0.1:1/", "method": "http"})
    assert status == 403
    assert body["error"]["code"] == "SSRF_BLOCKED"


def test_cloud_metadata_blocked(server_url: str) -> None:
    status, body = _post(server_url, {"url": "http://169.254.169.254/latest/meta-data"})
    assert status == 403
    assert body["error"]["code"] == "SSRF_BLOCKED"


def test_non_http_scheme_blocked(server_url: str) -> None:
    status, body = _post(server_url, {"url": "file:///etc/passwd"})
    assert status == 403


def test_internal_error_hides_details(server_url: str, monkeypatch, capsys) -> None:
    secret = "ENOENT /opt/internal/secret-path.so"

    def boom(_req):
        raise RuntimeError(secret)

    monkeypatch.setattr(server_module.fetcher, "fetch", boom)
    status, body = _post(server_url, {"url": "https://example.com", "method": "http"})
    assert status == 500
    assert body["error"]["code"] == "INTERNAL"
    assert secret not in body["error"]["message"]
    # 细节写进日志
    assert secret in capsys.readouterr().err


def test_slow_header_and_body_expire(monkeypatch) -> None:
    monkeypatch.setattr(server_module, "HEADERS_TIMEOUT_SECONDS", 0.15)
    config = Config({})
    config.port = 0
    config.max_concurrency = 1
    server = make_server(config)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    address = server.server_address
    try:
        with socket.create_connection(address, timeout=2) as conn:
            conn.sendall(b"POST /v1/fetch HTTP/1.1\r\nHost: localhost\r\n")
            assert conn.recv(4096) == b""
        with socket.create_connection(address, timeout=2) as conn:
            conn.sendall(b"POST /v1/fetch HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{")
            received = b""
            while chunk := conn.recv(4096):
                received += chunk
            assert not received or b" 408 " in received
        status, health = _get(f"http://127.0.0.1:{address[1]}", "/health")
        assert status == 200
        assert health["inFlight"] == 0
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


# ===== 配置：监听地址 =====


def test_default_host_is_loopback_even_with_token() -> None:
    assert Config().host == "127.0.0.1"
    config = Config({"PRISMSEARCH_WORKER_TOKEN": "tok"})
    assert config.host == "127.0.0.1"
    config.check()


def test_explicit_host_with_token() -> None:
    config = Config({"PRISMSEARCH_WORKER_TOKEN": "tok", "WORKER_HOST": "0.0.0.0"})
    assert config.host == "0.0.0.0"
    config.check()


def test_non_loopback_without_token_rejected() -> None:
    with pytest.raises(ConfigError):
        Config({"WORKER_HOST": "0.0.0.0"}).check()
    with pytest.raises(ConfigError):
        Config({"WORKER_HOST": "0.0.0.0", "PRISMSEARCH_WORKER_TOKEN": "   "}).check()


def test_loopback_without_token_allowed() -> None:
    Config({"WORKER_HOST": "::1"}).check()
    Config({"WORKER_HOST": "localhost"}).check()


@pytest.mark.parametrize("value", ["", "0"])
def test_legacy_private_network_unset_values_allowed(value: str) -> None:
    Config({"WORKER_ALLOW_PRIVATE_NETWORK": value}).check()


@pytest.mark.parametrize("value", ["1", "true", "yes", " 1 "])
def test_legacy_private_network_rejected(value: str) -> None:
    with pytest.raises(ConfigError, match="已废弃"):
        Config({"WORKER_ALLOW_PRIVATE_NETWORK": value}).check()


def test_version_from_metadata() -> None:
    from importlib import metadata

    try:
        expected = metadata.version("prismsearch-py-worker")
    except metadata.PackageNotFoundError:
        expected = "0.0.0-dev"
    assert expected == server_module.VERSION
