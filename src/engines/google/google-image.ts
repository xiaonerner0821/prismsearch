/**
 * Google 图片搜索引擎（爬虫方式）
 */

import * as cheerio from 'cheerio';
import type { ImageSearchRequest, ImageSearchResponse, ImageSearchResult } from '../engine-interface.js';
import { EngineBlockedError, EngineParseError } from '../engine-interface.js';
import type { EngineConfig } from '../../config/config-schema.js';

import { fetchSearchPage } from '../scraper-http.js';

export class GoogleImageEngine {
  readonly name = 'google';
  private config: EngineConfig;
  private lastError?: string;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  async search(request: ImageSearchRequest): Promise<ImageSearchResponse> {
    const startTime = Date.now();
    const count = request.count ?? 10;
    const page = request.page ?? 1;

    // Google 图片搜索与网页搜索共用 /search 路径（tbm=isch 区分），
    // 因此直接沿用引擎配置的 baseUrl，配置镜像站时一并生效
    const url = new URL(this.config.baseUrl || 'https://www.google.com/search');
    url.searchParams.set('q', request.query);
    url.searchParams.set('tbm', 'isch'); // 图片搜索标记
    url.searchParams.set('num', String(count));
    if (page > 1) {
      url.searchParams.set('start', String((page - 1) * count));
    }
    if (request.region) {
      url.searchParams.set('gl', request.region);
    }
    if (request.language) {
      url.searchParams.set('hl', request.language);
    }
    if (request.safeSearch) {
      url.searchParams.set('safe', 'active');
    }
    // 图片尺寸过滤
    if (request.imageSize) {
      const sizeMap: Record<string, string> = { small: 's', medium: 'm', large: 'l' };
      url.searchParams.set('tbs', `isz:${sizeMap[request.imageSize]}`);
    }
    // 图片类型过滤
    if (request.imageType) {
      const typeMap: Record<string, string> = {
        photo: 'photo', clipart: 'clipart', gif: 'animated', transparent: 'trans',
      };
      const existingTbs = url.searchParams.get('tbs') ?? '';
      const sep = existingTbs ? ',' : '';
      url.searchParams.set('tbs', `${existingTbs}${sep}itp:${typeMap[request.imageType]}`);
    }

    try {
      const { body: html, url: finalUrl } = await fetchSearchPage(url.toString(), {
        baseUrl: this.config.baseUrl,
        timeoutMs: this.config.timeout,
        query: request.query,
        acceptLanguage: request.language ?? 'zh-CN,zh;q=0.9,en;q=0.8',
        signal: request.signal,
      });
      if (finalUrl.includes('/sorry/')) {
        throw new EngineBlockedError('Google 图片搜索触发反爬验证（/sorry/ 验证码页）');
      }
      const results = this.parseResults(html, count);
      if (results.length === 0) {
        // Google 强制 JS 渲染，解析不到结果说明拿到的是 enablejs 提示页，不能当成功返回
        throw new EngineParseError('Google 图片页面中未解析到结果（页面结构可能已变化或需要 JS 渲染）');
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
      // 统计与熔断由父引擎（GoogleWebEngine 的 imageStats）统一记录，这里只留最近错误供排查
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  // 解析 Google 图片搜索结果
  private parseResults(html: string, maxResults: number): ImageSearchResult[] {
    const results: ImageSearchResult[] = [];

    // 方式1：从内嵌 script 中提取 JSON 数据（Google 图片页面将数据嵌入 JS 中）
    const scriptResults = this.parseFromScripts(html, maxResults);
    if (scriptResults.length > 0) {
      return scriptResults;
    }

    // 方式2：Cheerio DOM 解析作为后备
    const $ = cheerio.load(html);

    // 尝试 div[data-ri] 选择器（Google 图片搜索结果项）
    $('div[data-ri]').each((_, el) => {
      if (results.length >= maxResults) return false;

      const $el = $(el);
      const img = $el.find('img[data-src], img[src^="http"]').first();
      const link = $el.find('a[href^="http"]').first();

      const thumbnailUrl = img.attr('data-src') ?? img.attr('src') ?? '';
      const title = img.attr('alt') ?? '';
      const sourceUrl = link.attr('href') ?? '';

      if (thumbnailUrl && thumbnailUrl.startsWith('http')) {
        results.push({
          title: title || '无标题',
          imageUrl: thumbnailUrl, // 缩略图作为主图（完整URL在script数据中）
          thumbnailUrl,
          sourceUrl,
          position: 0,
          source: this.name,
        });
      }
    });

    // 方式3：最宽松的后备 — 搜索所有带图片的链接
    if (results.length === 0) {
      $('a[href*="/imgres"]').each((_, el) => {
        if (results.length >= maxResults) return false;

        const $el = $(el);
        const href = $el.attr('href') ?? '';
        const img = $el.find('img').first();
        const title = img.attr('alt') ?? '';
        const thumbnailUrl = img.attr('src') ?? img.attr('data-src') ?? '';

        // 从 imgres URL 中提取原图URL
        const imgrefUrl = this.extractImgrefUrl(href);

        if (thumbnailUrl) {
          results.push({
            title: title || '无标题',
            imageUrl: imgrefUrl || thumbnailUrl,
            thumbnailUrl: thumbnailUrl.startsWith('http') ? thumbnailUrl : '',
            sourceUrl: imgrefUrl || '',
            position: 0,
            source: this.name,
          });
        }
      });
    }

    return results;
  }

  // 从 script 标签中提取图片数据
  private parseFromScripts(html: string, maxResults: number): ImageSearchResult[] {
    const results: ImageSearchResult[] = [];

    // Google 将图片数据嵌入在 AF_initDataCallback 中
    // 匹配包含图片URL的JSON片段
    const urlPattern = /\["(https?:\/\/[^"]+\.(jpg|jpeg|png|gif|webp|bmp|svg)[^"]*)"/gi;
    const matches = html.matchAll(urlPattern);
    const imageUrls = new Set<string>();

    for (const match of matches) {
      if (results.length >= maxResults) break;
      const imageUrl = match[1];

      // 排除 Google 自己的资源
      if (imageUrl.includes('gstatic.com') || imageUrl.includes('google.com') || imageUrl.includes('googleapis.com')) {
        continue;
      }
      if (imageUrls.has(imageUrl)) continue;
      imageUrls.add(imageUrl);

      results.push({
        title: '',
        imageUrl,
        thumbnailUrl: imageUrl,
        sourceUrl: '',
        position: 0,
        source: this.name,
      });
    }

    return results;
  }

  // 从 /imgres URL 中提取原图 URL
  private extractImgrefUrl(href: string): string {
    try {
      const url = new URL(href, 'https://www.google.com');
      return url.searchParams.get('imgurl') ?? '';
    } catch {
      return '';
    }
  }

  getLastError() {
    return this.lastError;
  }
}
