"""正文提取：trafilatura 为主，失败时回落到 BeautifulSoup 启发式。

trafilatura 在新闻/博客类页面上效果好，但对纯列表页、文档页常常返回空；
这时用基于文本密度的简单启发式兜底，避免整页内容丢失。
"""

from __future__ import annotations

import re
from typing import Literal
from urllib.parse import urljoin

import trafilatura
from bs4 import BeautifulSoup

OutputFormat = Literal["markdown", "text", "html"]

_NOISE_TAGS = [
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "svg",
    "canvas",
    "nav",
    "footer",
    "aside",
    "form",
]
_CONTENT_SELECTORS = ["article", "main", "[role=main]", "#content", ".content", ".post", ".article"]


def extract_content(html: str, fmt: OutputFormat, base_url: str | None = None) -> tuple[str | None, str]:
    """返回 (标题, 正文)。"""
    if fmt == "html":
        return _title_of(html), html

    title = _title_of(html)

    if fmt == "markdown":
        extracted = trafilatura.extract(
            html,
            url=base_url,
            output_format="markdown",
            include_links=True,
            include_formatting=True,
            include_comments=False,
            include_tables=True,
            favor_recall=True,
        )
    else:
        extracted = trafilatura.extract(
            html,
            url=base_url,
            output_format="txt",
            include_comments=False,
            include_tables=True,
            favor_recall=True,
        )

    if extracted and extracted.strip():
        return title, _tidy(extracted)

    # 兜底：trafilatura 判定不出正文时，用文本密度挑容器
    return title, _tidy(_fallback_extract(html, fmt, base_url))


def _title_of(html: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")
    og = soup.find("meta", attrs={"property": "og:title"})
    if og and og.get("content"):
        return str(og["content"]).strip() or None
    if soup.title and soup.title.string:
        return soup.title.string.strip() or None
    return None


def _fallback_extract(html: str, fmt: OutputFormat, base_url: str | None) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(_NOISE_TAGS):
        tag.decompose()

    if base_url:
        for tag, attr in ((soup.find_all("a"), "href"), (soup.find_all("img"), "src")):
            for node in tag:
                value = node.get(attr)
                if value and not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", value):
                    node[attr] = _join(base_url, value)

    container = soup.body
    for selector in _CONTENT_SELECTORS:
        candidate = soup.select_one(selector)
        # 正文容器至少要有一定长度，避免选中空的 <main>
        if candidate is not None and len(candidate.get_text(strip=True)) >= 200:
            container = candidate
            break

    if container is None:
        return ""

    if fmt == "text":
        return container.get_text("\n", strip=True)

    # markdown 兜底：只保留结构，不做完整转换
    lines: list[str] = []
    for node in container.find_all(["h1", "h2", "h3", "h4", "p", "li", "blockquote", "pre"]):
        text = node.get_text(" ", strip=True)
        if not text:
            continue
        if node.name in {"h1", "h2", "h3", "h4"}:
            lines.append(f"{'#' * int(node.name[1])} {text}")
        elif node.name == "li":
            lines.append(f"- {text}")
        elif node.name == "blockquote":
            lines.append(f"> {text}")
        else:
            lines.append(text)
    return "\n\n".join(lines)


def _join(base: str, rel: str) -> str:
    try:
        return urljoin(base, rel)
    except ValueError:
        return rel


def _tidy(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", text).strip()
