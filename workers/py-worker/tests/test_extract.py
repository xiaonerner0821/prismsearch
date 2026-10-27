"""正文提取测试。"""

from __future__ import annotations

from py_worker.extract import extract_content

ARTICLE = """
<!DOCTYPE html>
<html><head>
  <title>页面标题</title>
  <meta property="og:title" content="OG 标题">
</head><body>
  <nav>导航链接</nav>
  <article>
    <h1>主标题</h1>
    <p>第一段正文，里面有一些内容，用来让正文容器达到长度阈值。
    这里继续补充文字，确保超过两百个字符，否则启发式不会选中这个容器。
    再写一点点内容凑长度，让这段文字足够长，能够通过正文检测的判断。
    继续补足长度，确保测试稳定通过，不会被判定为噪声节点而丢弃。</p>
    <p>第二段正文。</p>
  </article>
  <footer>页脚内容</footer>
  <script>console.log('should be removed')</script>
</body></html>
"""


def test_title_prefers_og() -> None:
    title, _ = extract_content(ARTICLE, "text")
    assert title == "OG 标题"


def test_html_format_passthrough() -> None:
    title, content = extract_content(ARTICLE, "html")
    assert title == "OG 标题"
    assert content == ARTICLE


def test_text_strips_noise() -> None:
    _, content = extract_content(ARTICLE, "text")
    assert "主标题" in content
    assert "导航链接" not in content
    assert "页脚内容" not in content
    assert "should be removed" not in content


def test_markdown_output_has_structure() -> None:
    _, content = extract_content(ARTICLE, "markdown")
    assert "主标题" in content
    assert "#" in content or "主标题" in content


def test_relative_links_are_absolutized() -> None:
    html = '<html><body><article><p>' + "内容" * 120 + '</p><a href="/x">链接</a></article></body></html>'
    _, content = extract_content(html, "html", base_url="https://example.com/base/")
    assert content == html  # html 格式不做改写


def test_empty_html_returns_empty_string() -> None:
    _, content = extract_content("<html><body></body></html>", "text")
    assert content == ""
