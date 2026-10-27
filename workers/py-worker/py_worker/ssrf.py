"""Worker 端 SSRF 防护。

与 TS Worker 保持同一套判定标准：回环、私网、链路本地（含云元数据）、
组播、保留段一律拒绝，IPv4 映射的 IPv6 形式同样拒绝。
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit


class SsrfBlockedError(Exception):
    """目标地址不安全，对应协议里的 SSRF_BLOCKED。"""


class DnsResolutionError(Exception):
    """域名解析失败或无结果。

    不能放行：拿不到已校验的 IP 就没法钉住连接，curl 会自己重新解析，
    留下 DNS 重绑定窗口。由抓取器转成 FETCH_FAILED。
    """


@dataclass
class SsrfOptions:
    # 允许访问内网地址。仅用于明确的自建内网抓取场景。
    allow_private_network: bool = False


_OPTIONS = SsrfOptions()

# 运营商级 NAT 段，ipaddress 的 is_private 不覆盖
_CGNAT = ipaddress.ip_network("100.64.0.0/10")


def configure(options: SsrfOptions) -> None:
    global _OPTIONS
    if options.allow_private_network:
        raise ValueError("全局 allow_private_network 已禁用")
    _OPTIONS = options


def is_blocked_ip(raw: str) -> bool:
    """判断 IP 字面量是否属于禁止访问的范围。

    无法解析的输入按不安全处理，宁可误拒绝。
    """
    try:
        ip = ipaddress.ip_address(raw.strip().strip("[]"))
    except ValueError:
        return True

    # IPv4 映射 / 6to4 / Teredo：解开内层 IPv4 再判一次
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped or ip.sixtofour
        if mapped is not None:
            return is_blocked_ip(str(mapped))
        if ip.teredo is not None:
            server, client = ip.teredo
            return is_blocked_ip(str(server)) or is_blocked_ip(str(client))
        embedded = _nat64_embedded(ip)
        if embedded is not None:
            return is_blocked_ip(str(embedded))

    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return True
    # 100.64.0.0/10 运营商级 NAT 不在 is_private 里
    if isinstance(ip, ipaddress.IPv4Address):
        return ip in _CGNAT
    return False


def _nat64_embedded(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """取出 NAT64 前缀 64:ff9b::/96 里内嵌的 IPv4。"""
    nat64 = ipaddress.ip_network("64:ff9b::/96")
    if ip not in nat64:
        return None
    return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)


def resolve_and_check(host: str) -> list[str]:
    """解析域名并校验所有地址，返回可用的 IP 列表。

    校验全部结果而不是第一个：只要有一个解析到内网就拒绝，
    避免攻击者靠多条 A 记录赌解析顺序。
    """
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError) as exc:
        # 解析失败直接拒绝：放行会让 curl 自己再解析一次，绕过 IP 钉扎
        raise DnsResolutionError(f"DNS 解析失败：{host}（{exc}）") from exc

    addresses: list[str] = []
    for info in infos:
        address = str(info[4][0])
        if address not in addresses:
            addresses.append(address)

    if not addresses:
        raise DnsResolutionError(f"DNS 解析失败：{host} 没有可用地址")

    for address in addresses:
        if is_blocked_ip(address):
            raise SsrfBlockedError(f"{host} 解析到内网或保留地址：{address}")
    return addresses


def assert_url_allowed(raw_url: str) -> tuple[str, list[str]]:
    """校验 URL，返回 (规范化 URL, 已校验的 IP 列表)。

    返回的 IP 列表一定非空；域名解析失败抛 DnsResolutionError。
    """
    parts = urlsplit(raw_url)
    if parts.scheme not in ("http", "https"):
        raise SsrfBlockedError(f"只允许 http/https 协议，收到 {parts.scheme or '(空)'}")
    if parts.username or parts.password:
        raise SsrfBlockedError("URL 中不允许携带用户名或密码")

    host = parts.hostname
    if not host:
        raise SsrfBlockedError(f"无效的 URL：{raw_url[:200]}")

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        addresses = resolve_and_check(host)
    else:
        if is_blocked_ip(str(literal)):
            raise SsrfBlockedError(f"目标地址指向内网或保留地址：{host}")
        addresses = [str(literal)]

    return raw_url, addresses
