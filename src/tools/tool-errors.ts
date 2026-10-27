/**
 * 工具层的业务错误：参数不合法、功能未启用、被限流等。
 * 这类错误的消息是写给调用方看的，mcp-server 会原样返回；
 * 其余未知异常只返回通用提示（旧实现按「消息里有没有中文」判断，第三方库的中文报错也会被透出）。
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}
