/**
 * pickMeaningfulError：多地址 / 多策略都失败时挑出最能说明问题的错误
 */

import { describe, it, expect } from 'vitest';
import { EngineBlockedError, EngineParseError, pickMeaningfulError } from '../../src/engines/engine-interface.js';
import { HttpError } from '../../src/utils/http-client.js';

describe('pickMeaningfulError', () => {
  it('解析失败（JS 墙）优先于后面的网络错误', () => {
    const parse = new EngineParseError('需要 JS 渲染');
    const network = new HttpError('fetch failed', undefined, 'NETWORK');
    expect(pickMeaningfulError([parse, network, network])).toBe(parse);
  });

  it('验证码优先于解析失败和 HTTP 状态码', () => {
    const blocked = new EngineBlockedError('验证码');
    const http = new HttpError('HTTP 500', 500, 'HTTP');
    expect(pickMeaningfulError([http, new EngineParseError('x'), blocked])).toBe(blocked);
  });

  it('同级取最早出现的', () => {
    const a = new HttpError('超时 a', undefined, 'TIMEOUT');
    const b = new HttpError('超时 b', undefined, 'TIMEOUT');
    expect(pickMeaningfulError([a, b])).toBe(a);
  });

  it('主动取消优先级最高，空列表返回 undefined', () => {
    const aborted = new HttpError('请求已取消', undefined, 'ABORTED');
    expect(pickMeaningfulError([new EngineBlockedError('x'), aborted])).toBe(aborted);
    expect(pickMeaningfulError([])).toBeUndefined();
  });
});
