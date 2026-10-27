"""SSRF 判定的单元测试（不依赖网络）。"""

from __future__ import annotations

import pytest

from py_worker.ssrf import (
    DnsResolutionError,
    SsrfBlockedError,
    SsrfOptions,
    assert_url_allowed,
    configure,
    is_blocked_ip,
)


@pytest.fixture(autouse=True)
def _reset_options():
    configure(SsrfOptions())
    yield
    configure(SsrfOptions())


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "64:ff9b::10.0.0.1",
        "2002:7f00:1::",
        "2001:0:808:808:0:0:80ff:fffe",
    ],
)
def test_blocks_private_and_reserved(ip: str) -> None:
    assert is_blocked_ip(ip) is True


@pytest.mark.parametrize("ip", ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])
def test_allows_public(ip: str) -> None:
    assert is_blocked_ip(ip) is False


def test_unparseable_is_blocked() -> None:
    assert is_blocked_ip("not-an-ip") is True


@pytest.mark.parametrize("url", ["file:///etc/passwd", "gopher://example.com", "ftp://example.com"])
def test_rejects_non_http_schemes(url: str) -> None:
    with pytest.raises(SsrfBlockedError):
        assert_url_allowed(url)


def test_rejects_credentials_in_url() -> None:
    with pytest.raises(SsrfBlockedError, match="用户名或密码"):
        assert_url_allowed("http://user:pass@example.com/")


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8080/",
        "http://[::1]/",
        "http://169.254.169.254/latest/meta-data",
    ],
)
def test_rejects_private_ip_literal(url: str) -> None:
    with pytest.raises(SsrfBlockedError):
        assert_url_allowed(url)


def test_allows_public_ip_literal() -> None:
    _, addresses = assert_url_allowed("https://1.1.1.1/")
    assert addresses == ["1.1.1.1"]


def test_dns_failure_is_rejected(monkeypatch) -> None:
    import socket

    def boom(*_args, **_kwargs):
        raise socket.gaierror(socket.EAI_NONAME, "Name or service not known")

    monkeypatch.setattr(socket, "getaddrinfo", boom)
    with pytest.raises(DnsResolutionError, match="DNS 解析失败"):
        assert_url_allowed("https://nx.example/")


def test_empty_dns_result_is_rejected(monkeypatch) -> None:
    import socket

    monkeypatch.setattr(socket, "getaddrinfo", lambda *_a, **_k: [])
    with pytest.raises(DnsResolutionError):
        assert_url_allowed("https://empty.example/")


def test_resolved_addresses_returned_for_pinning(monkeypatch) -> None:
    import socket

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_a, **_k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))],
    )
    _, addresses = assert_url_allowed("https://example.com/")
    assert addresses == ["93.184.216.34"]


def test_allow_private_network_is_rejected() -> None:
    with pytest.raises(ValueError, match="全局"):
        configure(SsrfOptions(allow_private_network=True))
    with pytest.raises(SsrfBlockedError):
        assert_url_allowed("http://127.0.0.1/")
