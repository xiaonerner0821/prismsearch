/**
 * 单元测试共用的 fetch 响应构造器
 *
 * http-client 用流式读取 body，因此 mock 必须返回真正的 Response 实例；
 * 而原生 Response 的 url 恒为空串，无法模拟「跟随重定向后的最终 URL」，
 * 这里用 defineProperty 覆盖 url 字段。
 */

export interface MockResponseOptions {
  status?: number;
  statusText?: string;
  /** 最终 URL（默认取请求 URL） */
  url?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export function makeResponse(body: string, options: MockResponseOptions = {}): Response {
  const status = options.status ?? 200;
  const response = new Response(body, {
    status,
    statusText: options.statusText ?? (status === 200 ? 'OK' : 'Error'),
    headers: { 'content-type': options.contentType ?? 'text/html; charset=utf-8', ...options.headers },
  });
  if (options.url !== undefined) {
    Object.defineProperty(response, 'url', { value: options.url, configurable: true });
  }
  return response;
}

/** 构造返回固定 HTML 的 fetch mock（可指定状态码与最终 URL） */
export function mockHtmlFetch(html: string, options: MockResponseOptions = {}) {
  return async (input: unknown): Promise<Response> => {
    const requestUrl = String(input);
    return makeResponse(html, { url: requestUrl, ...options });
  };
}

/** 构造返回 JSON 的 fetch mock */
export function mockJsonFetch(body: unknown, options: MockResponseOptions = {}) {
  return async (input: unknown): Promise<Response> => {
    const requestUrl = String(input);
    return makeResponse(typeof body === 'string' ? body : JSON.stringify(body), {
      contentType: 'application/json',
      url: requestUrl,
      ...options,
    });
  };
}
