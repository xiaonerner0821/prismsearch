import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { RuntimeHolder } from '../../src/server/mcp-server.js';

const { serve, close, createServer, warn } = vi.hoisted(() => ({ serve: vi.fn(), close: vi.fn(), createServer: vi.fn(), warn: vi.fn() }));
vi.mock('@modelcontextprotocol/server/stdio', () => ({ serveStdio: serve }));
vi.mock('../../src/server/mcp-server.js', () => ({ createMcpServer: createServer }));
vi.mock('../../src/utils/logger.js', () => ({ getLogger: () => ({ info: vi.fn(), warn }) }));
import { startStdioTransport } from '../../src/server/stdio-transport.js';

const holder = {} as RuntimeHolder;
describe('startStdioTransport', () => {
  let stdin: EventEmitter;
  let original: PropertyDescriptor | undefined;
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(process, 'stdin');
    stdin = new EventEmitter();
    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
    vi.clearAllMocks();
    close.mockResolvedValue(undefined);
    serve.mockResolvedValue({ close });
  });
  afterEach(() => { if (original) Object.defineProperty(process, 'stdin', original); });
  it.each(['end', 'close'])('stdin %s 只通知一次且移除两个监听', async event => {
    const onClose = vi.fn();
    await startStdioTransport(holder, onClose);
    stdin.emit(event); stdin.emit('end'); stdin.emit('close');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stdin.listenerCount('end')).toBe(0);
    expect(stdin.listenerCount('close')).toBe(0);
  });
  it('显式 close 清理监听、共享关闭 Promise 且不触发退出通知', async () => {
    const onClose = vi.fn();
    const handle = await startStdioTransport(holder, onClose);
    const first = handle.close();
    expect(handle.close()).toBe(first);
    await first;
    stdin.emit('end'); stdin.emit('close');
    expect(onClose).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('无退出回调时不注册监听，SDK 工厂和异常回调正确转发', async () => {
    await startStdioTransport(holder);
    expect(stdin.eventNames()).toEqual([]);
    const [factory, options] = serve.mock.calls[0];
    factory();
    expect(createServer).toHaveBeenCalledWith(holder);
    const error = new Error('broken');
    options.onerror(error);
    expect(warn).toHaveBeenCalledWith('stdio 传输异常', { error });
  });
  it('SDK 启动失败不注册监听', async () => {
    serve.mockRejectedValueOnce(new Error('start'));
    await expect(startStdioTransport(holder, vi.fn())).rejects.toThrow('start');
    expect(stdin.eventNames()).toEqual([]);
  });
  it('同步关闭异常转为可复用的拒绝 Promise', async () => {
    close.mockImplementationOnce(() => { throw new Error('close'); });
    const handle = await startStdioTransport(holder, vi.fn());
    const first = handle.close();
    await expect(first).rejects.toThrow('close');
    expect(handle.close()).toBe(first);
    expect(stdin.eventNames()).toEqual([]);
  });
});
