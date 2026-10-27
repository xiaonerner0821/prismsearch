/**
 * Bing 图片搜索引擎（爬虫方式）
 */

import * as cheerio from 'cheerio';
import type { ImageSearchRequest, ImageSearchResponse, ImageSearchResult } from '../engine-interface.js';
import { EngineBlockedError } from '../engine-interface.js';
import type { EngineConfig } from '../../config/config-schema.js';

import { assertParsed, fetchSearchPage } from '../scraper-http.js';

export class BingImageEngine {
  readonly name = 'bing';
  private config: EngineConfig;
  private lastError?: string;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  async search(request: ImageSearchRequest): Promise<ImageSearchResponse> {
    const startTime = Date.now();
    const count = request.count ?? 10;
    const page = request.page ?? 1;

    // 构建 Bing 图片搜索 URL：沿用引擎 baseUrl 的源站（配置镜像 / cn.bing.com 时一并生效），
    // 图片搜索固定在 /images/search 路径
    const origin = (() => {
      try {
        return new URL(this.config.baseUrl).origin;
      } catch {
        return 'https://www.bing.com';
      }
    })();
    const url = new URL('/images/search', origin);
    url.searchParams.set('q', request.query);
    url.searchParams.set('count', String(count));
    if (page > 1) {
      url.searchParams.set('first', String((page - 1) * count + 1));
    }
    if (request.language) {
      url.searchParams.set('setlang', request.language);
    }
    if (request.safeSearch) {
      url.searchParams.set('safesearch', 'strict');
    }
    // 图片尺寸过滤
    if (request.imageSize) {
      const sizeMap: Record<string, string> = { small: 'small', medium: 'medium', large: 'large' };
      url.searchParams.set('qft', `+filterui:imagesize-${sizeMap[request.imageSize]}`);
    }
    // 图片类型过滤
    if (request.imageType) {
      const typeMap: Record<string, string> = {
        photo: 'photo', clipart: 'clipart', gif: 'animatedgif', transparent: 'transparent',
      };
      const existingQft = url.searchParams.get('qft') ?? '';
      url.searchParams.set('qft', `${existingQft}+filterui:photo-${typeMap[request.imageType]}`);
    }

    try {
      const { body: html } = await fetchSearchPage(url.toString(), {
        baseUrl: this.config.baseUrl,
        timeoutMs: this.config.timeout,
        query: request.query,
        acceptLanguage: request.language ?? 'zh-CN,zh;q=0.9,en;q=0.8',
        signal: request.signal,
      });
      if (BingImageEngine.isBlockedPage(html)) {
        throw new EngineBlockedError('Bing 图片搜索返回验证码 / 反爬页面，触发风控限制');
      }
      const results = assertParsed(this.parseResults(html, count), html, 'Bing 图片');
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
      // 统计与熔断由父引擎（BingWebEngine 的 imageStats）统一记录，这里只留最近错误供排查
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  // 解析 Bing 图片搜索结果
  private parseResults(html: string, maxResults: number): ImageSearchResult[] {    const $ = cheerio.load(html);
    const results: ImageSearchResult[] = [];

    // Bing 图片结果在 a.iusc 中，m 属性包含 JSON 元数据
    $('a.iusc').each((_, el) => {
      if (results.length >= maxResults) return false;

      const $el = $(el);
      const mAttr = $el.attr('m');
      if (!mAttr) return;

      try {
        const meta = JSON.parse(mAttr);
        const imageUrl = meta.murl || '';
        const thumbnailUrl = meta.turl || '';
        const title = meta.t || '';
        const sourceUrl = meta.purl || '';
        const width = meta.w ? Number(meta.w) : undefined;
        const height = meta.h ? Number(meta.h) : undefined;

        if (imageUrl) {
          results.push({
            title: title || '无标题',
            imageUrl,
            thumbnailUrl: thumbnailUrl || imageUrl,
            sourceUrl: sourceUrl || '',
            width,
            height,
            position: 0, // 后续填充
            source: this.name,
          });
        }
      } catch {
        // JSON解析失败，跳过
      }
    });

    // 备用选择器：如果 a.iusc 未找到，尝试 .imgpt 容器
    if (results.length === 0) {
      $('.imgpt a').each((_, el) => {
        if (results.length >= maxResults) return false;

        const $el = $(el);
        const href = $el.attr('href') ?? '';
        const img = $el.find('img').first();
        const src = img.attr('src') ?? img.attr('data-src') ?? '';
        const title = img.attr('alt') ?? '';

        if (src) {
          results.push({
            title: title || '无标题',
            imageUrl: src.startsWith('http') ? src : '',
            thumbnailUrl: src,
            sourceUrl: href.startsWith('http') ? href : '',
            position: 0,
            source: this.name,
          });
        }
      });
    }

    return results;
  }

  /** 识别 Bing 图片搜索的验证码 / 反爬页 */
  static isBlockedPage(html: string): boolean {
    return /id="b_captcha"|\/challenge\/verify|Please solve the challenge|unusual traffic/i.test(html);
  }

  getLastError() {
    return this.lastError;
  }
}
