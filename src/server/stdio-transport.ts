/**
 * stdio 传输层（SDK v2）
 *
 * 使用 serveStdio(factory)：每个连接由工厂生成一个 McpServer，自动兼容 2025 版客户端。
 * 返回句柄供优雅关闭；stdin 关闭（客户端退出）时通过 onClose 通知入口退出进程，
 * 避免成为孤儿进程。
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer, type RuntimeHolder } from './mcp-server.js';
import { getLogger } from '../utils/logger.js';

export interface StdioTransportHandle {
  close(): Promise<void>;
}

export async function startStdioTransport(
  holder: RuntimeHolder,
  onClose?: () => void,
): Promise<StdioTransportHandle> {
  const logger = getLogger();

  const handle = await serveStdio(() => createMcpServer(holder), {
    onerror: (error: Error) => logger.warn('stdio 传输异常', { error }),
  });

  const removeListeners = () => {
    process.stdin.removeListener('end', notifyClose);
    process.stdin.removeListener('close', notifyClose);
  };
  const notifyClose = () => {
    removeListeners();
    onClose?.();
  };
  if (onClose) {
    process.stdin.once('end', notifyClose);
    process.stdin.once('close', notifyClose);
  }

  logger.info('PrismSearch MCP 服务器已启动（stdio 模式）');

  let closing: Promise<void> | undefined;
  return {
    close() {
      removeListeners();
      closing ??= Promise.resolve().then(() => handle.close()).then(() => undefined);
      return closing;
    },
  };
}
