/**
 * tool-schemas 单元测试：引擎枚举与参数边界
 */

import { describe, it, expect } from 'vitest';
import { IMAGE_ENGINE_NAMES, imageSearchInput, webSearchInput } from '../../src/tools/tool-schemas.js';
import { BUILTIN_ENGINE_NAMES } from '../../src/config/config-schema.js';

describe('tool-schemas', () => {
  it('web_search 接受全部内置引擎', () => {
    for (const engine of BUILTIN_ENGINE_NAMES) {
      expect(webSearchInput.safeParse({ query: 'x', engine }).success).toBe(true);
    }
  });

  it('image_search 只接受支持图片搜索的引擎', () => {
    for (const engine of IMAGE_ENGINE_NAMES) {
      expect(imageSearchInput.safeParse({ query: 'x', engine }).success).toBe(true);
    }
    for (const engine of ['duckduckgo', 'yandex', 'so', 'sogou']) {
      expect(imageSearchInput.safeParse({ query: 'x', engine }).success).toBe(false);
    }
  });

  it('图片引擎都是内置引擎', () => {
    for (const engine of IMAGE_ENGINE_NAMES) {
      expect(BUILTIN_ENGINE_NAMES).toContain(engine);
    }
  });

  it('count / page 越界被拒绝', () => {
    expect(webSearchInput.safeParse({ query: 'x', count: 0 }).success).toBe(false);
    expect(webSearchInput.safeParse({ query: 'x', count: 51 }).success).toBe(false);
    expect(webSearchInput.safeParse({ query: 'x', page: 11 }).success).toBe(false);
    expect(webSearchInput.safeParse({ query: 'x', count: 1.5 }).success).toBe(false);
  });
});
