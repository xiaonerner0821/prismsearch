"""抓取器：curl_cffi 指纹伪装 + trafilatura 正文提取。

重定向由我们自己逐跳跟随，每一跳都重新校验地址——curl_cffi 的自动跳转
会绕过 SSRF 校验，等于把防线拆掉。
"""

from __future__ import annotations

import codecs
import ipaddress
import re
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urljoin, urlsplit

from curl_cffi import requests as cffi_requests
from curl_cffi.const import CurlOpt

from .extract import extract_content
from .ssrf import DnsResolutionError, SsrfBlockedError, assert_url_allowed

OutputFormat = Literal["markdown", "text", "html"]

DEFAULT_TIMEOUT_MS = 30_000
DEFAULT_MAX_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 5

# 按 URL 稳定选一个指纹，同一站点多次抓取保持一致，避免指纹跳变触发风控
_IMPERSONATE_POOL = ["chrome131", "chrome124", "safari18_0", "chrome120"]


class TargetFetchError(Exception):
    """目标站点取不到，对应协议里的 FETCH_FAILED。"""

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass
class FetchRequest:
    url: str
    format: OutputFormat = "markdown"
    method: str = "http"
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    max_bytes: int = DEFAULT_MAX_BYTES
    wait_for_selector: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    user_agent: str | None = None


@dataclass
class FetchResult:
    url: str
    content: str
    status_code: int
    raw_html: str | None = None
    title: str | None = None
    content_type: str | None = None
    content_length: int | None = None
    fetch_time: int = 0
    # 响应体因 max_bytes 被截断（与主进程 FetchResult.truncated 一致，未截断时不出现在响应里）
    truncated: bool = False

    def to_dict(self) -> dict:
        payload: dict[str, object] = {
            "url": self.url,
            "content": self.content,
            "statusCode": self.status_code,
            "fetchTime": self.fetch_time,
        }
        if self.raw_html is not None:
            payload["rawHtml"] = self.raw_html
        if self.title is not None:
            payload["title"] = self.title
        if self.content_type is not None:
            payload["contentType"] = self.content_type
        if self.content_length is not None:
            payload["contentLength"] = self.content_length
        if self.truncated:
            payload["truncated"] = True
        return payload


def _pick_impersonate(seed: str) -> str:
    total = 0
    for char in seed:
        total = (total * 31 + ord(char)) & 0xFFFFFFFF
    return _IMPERSONATE_POOL[total % len(_IMPERSONATE_POOL)]


# 不允许客户端覆盖的头部：由 Worker 自己掌握，避免破坏请求或绕过鉴权
_BLOCKED_HEADERS = {"host", "content-length", "connection", "transfer-encoding", "authorization"}


def _sanitize_headers(headers: dict[str, str] | None) -> dict[str, str]:
    if not headers:
        return {}
    return {
        key: value
        for key, value in headers.items()
        if key.lower() not in _BLOCKED_HEADERS and isinstance(value, str)
    }


_META_CHARSET_RE = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)""", re.IGNORECASE)
_XML_ENCODING_RE = re.compile(rb"""<\?xml[^>]+encoding\s*=\s*["']([\w-]+)["']""", re.IGNORECASE)


def _normalize_charset(raw: str | None) -> str | None:
    if not raw:
        return None
    cs = raw.strip().strip("\"'").lower()
    if not cs:
        return None
    # GB2312 / GBK 统一按超集 GB18030 解码，避免生僻字乱码
    if cs in ("gb2312", "gbk", "x-gbk", "gb_2312-80"):
        return "gb18030"
    return cs


def sniff_charset(raw: bytes, content_type: str | None) -> str | None:
    """字符集嗅探：BOM > Content-Type > <meta charset> / <?xml encoding?>（与主进程一致）。"""
    if raw.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if raw.startswith(b"\xff\xfe"):
        return "utf-16-le"
    if raw.startswith(b"\xfe\xff"):
        return "utf-16-be"
    if content_type:
        for part in content_type.split(";"):
            part = part.strip()
            if part.lower().startswith("charset="):
                cs = _normalize_charset(part.split("=", 1)[1])
                if cs:
                    return cs
    head = raw[:4096]
    match = _META_CHARSET_RE.search(head) or _XML_ENCODING_RE.search(head)
    if match:
        return _normalize_charset(match.group(1).decode("ascii", errors="ignore"))
    return None


def _decode(raw: bytes, content_type: str | None, *, truncated: bool = False) -> str:
    """按嗅探出的字符集解码；truncated 时丢弃末尾被截断的不完整多字节字符。"""
    charset = sniff_charset(raw, content_type)
    for encoding in filter(None, [charset, "utf-8", "gb18030", "latin-1"]):
        try:
            if truncated:
                # 增量解码且不 final：末尾半个字符留在缓冲区里被丢弃，而不是报错 / 输出替换符
                return codecs.getincrementaldecoder(encoding)().decode(raw, final=False)
            return raw.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


def _pin_resolve(url: str, addresses: list[str]) -> dict:
    """把已校验的 IP 钉进 curl 的 RESOLVE 表，防 DNS 重绑定（校验与连接之间重新解析到内网）。

    域名没有已校验的 IP 时直接拒绝：不钉 IP 的请求会让 curl 自己重新解析。
    """
    parts = urlsplit(url)
    host = parts.hostname
    if not host:
        return {}
    try:
        ipaddress.ip_address(host)
        return {}  # IP 字面量无需解析
    except ValueError:
        pass
    if not addresses:
        raise TargetFetchError(f"DNS 解析失败：{host} 没有已校验的地址，拒绝发起请求")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    entries = []
    for addr in addresses:
        literal = f"[{addr}]" if ":" in addr else addr
        entries.append(f"{host}:{port}:{literal}")
    return {CurlOpt.RESOLVE: entries}


def _checked(url: str) -> tuple[str, list[str]]:
    """SSRF 校验；DNS 解析失败转成 FETCH_FAILED（不是安全问题，但也绝不放行）。"""
    try:
        return assert_url_allowed(url)
    except DnsResolutionError as exc:
        raise TargetFetchError(str(exc)) from exc


def fetch(req: FetchRequest) -> FetchResult:
    """抓取一个地址。method 只支持 http（本 Worker 不做浏览器渲染）。"""
    started = time.monotonic()
    timeout_s = max(req.timeout_ms, 1) / 1000.0

    current_url, addresses = _checked(req.url)
    impersonate = _pick_impersonate(req.url)
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        **_sanitize_headers(req.headers),
    }

    session = cffi_requests.Session(impersonate=impersonate)
    if req.user_agent:
        session.headers["User-Agent"] = req.user_agent

    try:
        for _ in range(MAX_REDIRECTS + 1):
            try:
                response = session.get(
                    current_url,
                    headers=headers,
                    timeout=timeout_s,
                    allow_redirects=False,
                    stream=True,
                    # 连接只能去往刚校验过的 IP，挡住 DNS 重绑定
                    curl_options=_pin_resolve(current_url, addresses) or None,
                )
            except SsrfBlockedError:
                raise
            except Exception as exc:  # noqa: BLE001 - 底层异常类型很杂，统一转成目标站失败
                raise TargetFetchError(f"抓取失败：{exc}") from exc

            location = response.headers.get("location")
            if response.status_code in (301, 302, 303, 307, 308) and location:
                response.close()
                next_url = urljoin(current_url, location)
                # 每一跳都重新校验并钉 IP，挡住「公网跳内网」这类重定向
                current_url, addresses = _checked(next_url)
                continue

            return _build_result(req, current_url, response, started)

        raise TargetFetchError(f"重定向次数超过 {MAX_REDIRECTS} 次")
    finally:
        session.close()


def _build_result(req: FetchRequest, final_url: str, response, started: float) -> FetchResult:
    content_type = response.headers.get("content-type")
    try:
        # 超大页面截断保留开头（与主进程 http-fetcher 一致），而不是整页失败
        raw, truncated = read_limited(response.iter_content(chunk_size=64 * 1024), req.max_bytes)
    finally:
        response.close()

    html = _decode(raw, content_type, truncated=truncated)
    title, content = extract_content(html, req.format, base_url=final_url)

    return FetchResult(
        url=final_url,
        content=content,
        status_code=response.status_code,
        # rawHtml 只在 format=html 时有值（与协议、主进程抓取器保持一致）
        raw_html=html if req.format == "html" else None,
        title=title,
        content_type=content_type,
        content_length=len(raw),
        fetch_time=int((time.monotonic() - started) * 1000),
        truncated=truncated,
    )


def read_limited(chunks: Iterable[bytes], max_bytes: int) -> tuple[bytes, bool]:
    """读到 max_bytes 即停止，返回 (内容, 是否截断)；剩余数据不再读取。"""
    parts: list[bytes] = []
    total = 0
    for chunk in chunks:
        if not chunk:
            continue
        if total + len(chunk) > max_bytes:
            remain = max_bytes - total
            if remain > 0:
                parts.append(chunk[:remain])
            return b"".join(parts), True
        total += len(chunk)
        parts.append(chunk)
    return b"".join(parts), False
