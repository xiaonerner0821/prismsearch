"""字符集嗅探与 IP 钉扎的单元测试（不依赖网络）。"""

from __future__ import annotations

import pytest
from curl_cffi.const import CurlOpt

from py_worker import fetcher as fetcher_mod
from py_worker.fetcher import (
    FetchRequest,
    FetchResult,
    TargetFetchError,
    _decode,
    _normalize_charset,
    _pin_resolve,
    read_limited,
    sniff_charset,
)
from py_worker.ssrf import DnsResolutionError


@pytest.mark.parametrize(
    ("raw", "content_type", "expected"),
    [
        (b"\xef\xbb\xbfabc", "text/html; charset=gbk", "utf-8-sig"),
        (b"\xff\xfe\x41\x00", None, "utf-16-le"),
        (b"\xfe\xff\x00\x41", None, "utf-16-be"),
        (b"abc", "text/html; charset=GB2312", "gb18030"),
        (b'<meta charset="gbk">', None, "gb18030"),
        (b'<?xml version="1.0" encoding="gbk"?>', None, "gb18030"),
        (b"abc", "text/html; charset=utf-8", "utf-8"),
        (b"abc", None, None),
    ],
)
def test_sniff_charset(raw: bytes, content_type: str | None, expected: str | None) -> None:
    assert sniff_charset(raw, content_type) == expected


def test_normalize_charset_strips_quotes_and_maps_gb_family() -> None:
    assert _normalize_charset('"GBK"') == "gb18030"
    assert _normalize_charset(" gb_2312-80 ") == "gb18030"
    assert _normalize_charset("") is None
    assert _normalize_charset(None) is None


def test_decode_falls_back_when_declared_charset_is_wrong() -> None:
    # 声明 utf-8 实际是 gbk：回退链里 gb18030 兜住
    assert _decode("中文".encode("gbk"), "text/html; charset=utf-8") == "中文"
    # 声明 gbk 实际是 utf-8：不抛错即可（按声明的字符集解码，内容会乱码但服务仍可用）
    assert isinstance(_decode("中文".encode(), "text/html; charset=gbk"), str)
    # 完全无法解码时用替换字符兜底而不是抛异常
    assert isinstance(_decode(b"\xff\xff\xff", "text/plain"), str)


def test_pin_resolve_builds_curl_entries() -> None:
    entries = _pin_resolve("https://example.com/path", ["93.184.216.34"])[CurlOpt.RESOLVE]
    assert entries == ["example.com:443:93.184.216.34"]

    # IPv6 加方括号；http 默认 80；显式端口优先
    v6 = _pin_resolve("http://example.com:8080/x", ["2606:4700::1"])[CurlOpt.RESOLVE]
    assert v6 == ["example.com:8080:[2606:4700::1]"]
    assert _pin_resolve("http://example.com/x", ["1.2.3.4"])[CurlOpt.RESOLVE] == ["example.com:80:1.2.3.4"]


def test_pin_resolve_skips_literals() -> None:
    assert _pin_resolve("https://1.2.3.4/x", ["1.2.3.4"]) == {}
    assert _pin_resolve("not a url", ["1.2.3.4"]) == {}


def test_pin_resolve_refuses_domain_without_addresses() -> None:
    # 不钉 IP 就会让 curl 自己重新解析，留下 DNS 重绑定窗口：必须拒绝
    with pytest.raises(TargetFetchError, match="DNS 解析失败"):
        _pin_resolve("https://example.com/x", [])


def test_pin_resolve_keeps_all_addresses() -> None:
    entries = _pin_resolve("https://example.com/", ["1.2.3.4", "5.6.7.8"])[CurlOpt.RESOLVE]
    assert len(entries) == 2


# ===== maxBytes 超限截断 =====


def test_read_limited_not_truncated() -> None:
    assert read_limited([b"abc", b"", b"def"], 6) == (b"abcdef", False)


def test_read_limited_stops_at_limit() -> None:
    pulled = 0

    def endless():
        nonlocal pulled
        while True:
            pulled += 1
            yield b"0123456789"

    raw, truncated = read_limited(endless(), 25)
    assert raw == b"0123456789012345678901234"
    assert truncated is True
    # 无限流也会停下
    assert pulled == 3


def test_decode_truncated_drops_partial_multibyte_char() -> None:
    # “中文”UTF-8 共 6 字节，截到 4 字节：剩“中”+ 半个“文”
    assert _decode("中文".encode()[:4], "text/html; charset=utf-8", truncated=True) == "中"
    assert _decode("中文".encode()[:4], None, truncated=True) == "中"
    assert _decode("中文".encode("gbk")[:3], "text/html; charset=gbk", truncated=True) == "中"


class _FakeResponse:
    def __init__(self, status_code: int = 200, headers: dict | None = None, chunks: list | None = None):
        self.status_code = status_code
        self.headers = headers or {}
        self._chunks = chunks or []
        self.closed = False

    def iter_content(self, chunk_size: int = 0):
        yield from self._chunks

    def close(self) -> None:
        self.closed = True


def test_build_result_truncates_and_marks() -> None:
    body = ("<html><head><title>T</title></head><body><p>" + "中" * 100 + "</p></body></html>").encode()
    response = _FakeResponse(
        headers={"content-type": "text/html; charset=utf-8", "content-length": str(len(body))},
        chunks=[body[:40], body[40:]],
    )
    req = FetchRequest(url="https://example.com/", format="html", max_bytes=101)
    result = fetcher_mod._build_result(req, "https://example.com/", response, 0.0)
    assert result.truncated is True
    assert result.content_length == 101
    assert response.closed is True
    assert "\ufffd" not in (result.raw_html or "")
    assert result.to_dict()["truncated"] is True


def test_to_dict_omits_truncated_when_false() -> None:
    assert "truncated" not in FetchResult(url="u", content="c", status_code=200).to_dict()


# ===== DNS 解析失败必须拒绝（每一跳都钉 IP） =====


class _FakeSession:
    instances: list[_FakeSession] = []

    def __init__(self, responses: list[_FakeResponse], **_kwargs) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict | None]] = []
        self.headers: dict[str, str] = {}
        _FakeSession.instances.append(self)

    def get(self, url: str, **kwargs):
        self.calls.append((url, kwargs.get("curl_options")))
        return self.responses.pop(0)

    def close(self) -> None:
        pass


def _install_fakes(monkeypatch, responses: list[_FakeResponse], resolved: dict[str, list[str]]):
    _FakeSession.instances.clear()
    monkeypatch.setattr(fetcher_mod.cffi_requests, "Session", lambda **kw: _FakeSession(responses, **kw))

    def fake_assert(url: str):
        from urllib.parse import urlsplit

        host = urlsplit(url).hostname or ""
        if host not in resolved:
            raise DnsResolutionError(f"DNS 解析失败：{host}")
        return url, resolved[host]

    monkeypatch.setattr(fetcher_mod, "assert_url_allowed", fake_assert)


def test_fetch_rejects_when_dns_fails(monkeypatch) -> None:
    _install_fakes(monkeypatch, [], {})
    with pytest.raises(TargetFetchError, match="DNS 解析失败"):
        fetcher_mod.fetch(FetchRequest(url="https://nx.example/"))
    # 一个请求都没发出去
    assert all(not s.calls for s in _FakeSession.instances)


def test_fetch_rejects_redirect_to_unresolvable_host(monkeypatch) -> None:
    redirect = _FakeResponse(302, {"location": "https://nx.example/next"})
    _install_fakes(monkeypatch, [redirect], {"example.com": ["93.184.216.34"]})
    with pytest.raises(TargetFetchError, match="DNS 解析失败"):
        fetcher_mod.fetch(FetchRequest(url="https://example.com/"))
    calls = _FakeSession.instances[0].calls
    # 只有第一跳发出，且钉住了已校验的 IP
    assert len(calls) == 1
    assert calls[0][1] == {CurlOpt.RESOLVE: ["example.com:443:93.184.216.34"]}


def test_fetch_pins_every_redirect_hop(monkeypatch) -> None:
    redirect = _FakeResponse(301, {"location": "https://b.example/"})
    final = _FakeResponse(200, {"content-type": "text/html"}, [b"<html><body>ok</body></html>"])
    _install_fakes(monkeypatch, [redirect, final], {"a.example": ["1.1.1.1"], "b.example": ["8.8.8.8"]})
    result = fetcher_mod.fetch(FetchRequest(url="https://a.example/"))
    assert result.url == "https://b.example/"
    calls = _FakeSession.instances[0].calls
    assert [c[1] for c in calls] == [
        {CurlOpt.RESOLVE: ["a.example:443:1.1.1.1"]},
        {CurlOpt.RESOLVE: ["b.example:443:8.8.8.8"]},
    ]
