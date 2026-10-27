/**
 * 搜索结果去广告：解析层（页面广告标记）与工具层（落地链接特征）
 * 页面结构取自各引擎真实结果页（商业类关键词）的精简版
 */
import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { isAdElement, isAdUrl } from '../../src/engines/ad-filter.js';
import { stripAds } from '../../src/tools/web-search.js';

function check(html: string, selector: string): boolean[] {
  const $ = cheerio.load(html);
  return $(selector).map((_, el) => isAdElement($, $(el))).get();
}

describe('isAdElement', () => {
  it('百度凤巢推广卡片（data-lp / ec-pc- 类名 / 广告标签）判为广告，自然结果不误伤', () => {
    const html = `
      <div class="_3rqxpq2 ec-pc-huanxin-grid" data-lp="https%3A%2F%2Fa.com"><h3><a href="#">推广</a></h3></div>
      <div class="c-container x"><h3><a href="#">另一种推广</a></h3><a><span class="ec-tuiguang">广告</span></a></div>
      <div class="result c-container" mu="https://b.com"><h3><a href="#">正常结果：广告法解读</a></h3><p>关于广告的文章</p></div>`;
    expect(check(html, 'div.c-container, div._3rqxpq2')).toEqual([true, true, false]);
  });

  it('DuckDuckGo 带 badge--ad 的结果判为广告', () => {
    const html = `
      <div class="result"><h2><div class="result__badge-wrap"><button class="badge--ad">Ad</button></div><a class="result__a">x</a></h2></div>
      <div class="result"><h2><a class="result__a">y</a></h2></div>`;
    expect(check(html, 'div.result')).toEqual([true, false]);
  });

  it('处于广告区块内（360 推广区、Google #tads、Bing b_ad）的结果判为广告', () => {
    const html = `
      <div id="m-spread-left" class="e-buss"><ul><li class="res-list">a</li></ul></div>
      <div id="tads"><div class="g">b</div></div>
      <ol><li class="b_ad"><ul><li class="b_algo">c</li></ul></li><li class="b_algo">d</li></ol>
      <ul><li class="res-list">e</li></ul>`;
    const $ = cheerio.load(html);
    const flags = $('li.res-list, div.g, li.b_algo').map((_, el) => [[$(el).text(), isAdElement($, $(el))]]).get();
    expect(Object.fromEntries(flags)).toEqual({ a: true, b: true, c: true, d: false, e: false });
  });

  it('独立的「Sponsored / 广告」小标签判为广告，正文里出现这些词不算', () => {
    const html = `
      <div class="r"><span>Sponsored</span><h3>x</h3></div>
      <div class="r"><p>This post is not sponsored by anyone.</p></div>
      <div class="r"><p>广告</p></div>`;
    // 第三个：整段文字恰好是「广告」的 p 不在候选标签里，不应命中
    expect(check(html, 'div.r')).toEqual([true, false, false]);
  });
});

describe('isAdUrl', () => {
  it('广告点击跳转域名', () => {
    expect(isAdUrl('https://duckduckgo.com/y.js?ad_domain=asics.com')).toBe(true);
    expect(isAdUrl('https://www.bing.com/aclk?ld=xxx')).toBe(true);
    expect(isAdUrl('https://www.googleadservices.com/pagead/aclk?sa=L')).toBe(true);
    expect(isAdUrl('https://redirect.simba.taobao.com/rd?c=un')).toBe(true);
  });

  it('付费投放追踪参数', () => {
    expect(isAdUrl('http://www.hmzs.net/?sdclkid=A52D15A')).toBe(true);
    expect(isAdUrl('https://shop.example/?gclid=abc')).toBe(true);
    expect(isAdUrl('https://bj.xhd.cn/?utm_source=baiduppc&utm_medium=ppc')).toBe(true);
    expect(isAdUrl('https://www.volcengine.com/activity?utm_medium=sem_baidu')).toBe(true);
  });

  it('自然结果不误伤', () => {
    expect(isAdUrl('https://modelcontextprotocol.io/docs')).toBe(false);
    expect(isAdUrl('https://blog.example/?utm_source=newsletter&utm_medium=email')).toBe(false);
    expect(isAdUrl('https://duckduckgo.com/about')).toBe(false);
    expect(isAdUrl('not a url')).toBe(false);
  });
});

describe('stripAds', () => {
  const results = [
    { title: 'a', url: 'https://a.com/', snippet: '', source: 'x', position: 1 },
    { title: 'b', url: 'https://b.com/?gclid=1', snippet: '', source: 'x', position: 2 },
  ];
  it('默认去掉广告链接', () => {
    expect(stripAds(results).map(r => r.title)).toEqual(['a']);
  });
  it('关闭开关时原样返回', () => {
    expect(stripAds(results, false)).toHaveLength(2);
  });
});
