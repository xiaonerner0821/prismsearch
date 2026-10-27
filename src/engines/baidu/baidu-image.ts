/**
 * 百度图片搜索引擎（JSON 接口方式）
 */

import type { ImageSearchRequest, ImageSearchResponse, ImageSearchResult } from '../engine-interface.js';
import { EngineBlockedError, EngineParseError } from '../engine-interface.js';
import type { EngineConfig } from '../../config/config-schema.js';
import { fetchSearchPage } from '../scraper-http.js';

/** 取第一个 http(s) 明文地址（跳过百度加密串与空值） */
function firstHttp(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
  }
  return undefined;
}

export class BaiduImageEngine {
  readonly name = 'baidu';
  private config: EngineConfig;
  private lastError?: string;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  async search(request: ImageSearchRequest): Promise<ImageSearchResponse> {
    const startTime = Date.now();
    const count = request.count ?? 10;
    const page = request.page ?? 1;

    // 百度图片 JSON 接口
    const url = new URL('https://image.baidu.com/search/acjson');
    url.searchParams.set('tn', 'resultjson_com');
    url.searchParams.set('word', request.query);
    url.searchParams.set('queryWord', request.query);
    url.searchParams.set('rn', String(count));
    url.searchParams.set('pn', String((page - 1) * count));
    url.searchParams.set('ie', 'utf-8');
    url.searchParams.set('oe', 'utf-8');
    url.searchParams.set('fp', 'result');
    url.searchParams.set('cl', '2'); // 图片类别

    // 图片尺寸过滤
    if (request.imageSize) {
      const sizeMap: Record<string, string> = { small: '1', medium: '2', large: '3' };
      url.searchParams.set('z', sizeMap[request.imageSize] ?? '0');
    }
    // 图片类型过滤
    if (request.imageType === 'gif') {
      url.searchParams.set('ic', '4'); // GIF类型
    }

    try {
      const { body: text } = await fetchSearchPage(url.toString(), {
        // Referer 取图片站首页，而非 searchJson 接口地址
        baseUrl: 'https://image.baidu.com/',
        timeoutMs: this.config.timeout,
        query: request.query,
        accept: 'application/json, text/javascript, */*; q=0.01',
        acceptLanguage: 'zh-CN,zh;q=0.9',
        signal: request.signal,
      });
      const results = this.parseResults(text, count);
      if (results.length === 0) {
        // 空数组且不是无结果页，说明接口返回了别的东西（风控 / 改版）
        throw new EngineParseError('百度图片接口未返回可用结果（疑似反爬或接口变更）');
      }
      const searchTime = Date.now() - startTime;

      this.lastError = undefined;

      return {
        results: results.map((r, i) => ({ ...r, position: i + 1, source: this.name })),
        engine: this.name,
        searchTime,
        cached: false,
        page,
        hasMore: results.length >= count,
      };
    } catch (error: unknown) {
      // 统计与熔断由父引擎（BaiduWebEngine 的 imageStats）统一记录，这里只留最近错误供排查
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  // 解析百度图片 JSON 结果
  private parseResults(text: string, maxResults: number): ImageSearchResult[] {
    const results: ImageSearchResult[] = [];

    try {
      // 百度返回的可能是 JSONP 或普通 JSON
      let jsonStr = text.trim();
      // 尝试去掉 JSONP 包装
      const jsonpMatch = jsonStr.match(/^\w+\(([\s\S]+)\)$/);
      if (jsonpMatch) {
        jsonStr = jsonpMatch[1];
      }

      const data = JSON.parse(jsonStr);
      const items = data.data ?? [];

      for (const item of items) {
        if (results.length >= maxResults) break;
        if (!item) continue;

        // 百度现在把 objURL / fromURL 返回为加密串（ippr_z2C$...），不能直接使用：
        // 明文原图与来源页在 replaceUrl[0] 里；没有时退回百度 CDN 的缩略/中图
        const replace = Array.isArray(item.replaceUrl) ? item.replaceUrl[0] : undefined;
        const imageUrl = firstHttp(replace?.ObjURL, replace?.ObjUrl, item.objURL, item.largeTnImageUrl, item.middleURL, item.hoverURL, item.thumbURL);
        if (!imageUrl) continue;
        const thumbnailUrl = firstHttp(item.thumbURL, item.middleURL, item.hoverURL) ?? imageUrl;
        const sourceUrl = firstHttp(replace?.FromURL, replace?.FromUrl, item.fromURL) ?? '';

        results.push({
          title: item.fromPageTitle ?? item.di ?? '无标题',
          imageUrl,
          thumbnailUrl,
          sourceUrl,
          sourceTitle: item.fromPageTitle ?? undefined,
          width: item.width ? Number(item.width) : undefined,
          height: item.height ? Number(item.height) : undefined,
          position: 0,
          source: this.name,
        });
      }
    } catch {
      // JSON 解析失败 — 可能是验证码页面
      if (text.includes('百度安全验证') || /id="captcha"|请输入验证码|安全验证/.test(text)) {
        throw new EngineBlockedError('百度返回验证码页面，触发反爬限制');
      }
      throw new EngineParseError('百度图片搜索结果解析失败');
    }

    return results;
  }

  getLastError() {
    return this.lastError;
  }
}
