#!/usr/bin/env node
/**
 * PrismSearch — 多引擎网页搜索 MCP 服务器
 * 入口：加载配置 → 建日志 → 建运行时（缓存/引擎/抓取器/安全组件/Worker）→ 启动传输
 */

import { loadConfig, resolveConfigFile } from './config/config-loader.js';
import { ConfigWatcher } from './config/config-watcher.js';
import { initLogger, getLogger, flushLogger, errorMessage } from './utils/logger.js';
import { PrismSearchRuntime, RuntimeHolder, type RuntimeOptions } from './server/mcp-server.js';
import { startStdioTransport } from './server/stdio-transport.js';
import { startHttpTransport, type HttpTransportHandle } from './server/http-transport.js';
import { WorkerClient } from './workers/worker-client.js';
import { PKG_NAME, PKG_VERSION } from './version.js';

// 中英双语：每行英文在前、中文在后
const CLI_HELP = `
${PKG_NAME} ${PKG_VERSION} — multi-engine web search MCP server / 多引擎搜索 MCP 服务器

Usage / 用法:
  prismsearch [config-file]       Start the server, optionally with a config file / 启动服务，可指定配置文件
  prismsearch --help, -h          Show this help / 显示本帮助
  prismsearch --version, -v       Print the version / 输出版本号

Environment variables / 环境变量:
  PRISMSEARCH_CONFIG              Config file path (YAML/JSON/TOML) / 配置文件路径
  PRISMSEARCH_HOME                Data dir for cache DB and user config (default ~/.prismsearch) / 数据目录（缓存库与用户配置的默认位置）
  PRISMSEARCH_SERVER_TRANSPORT    stdio | http / 传输方式
  PRISMSEARCH_SERVER_PORT         HTTP port (default 3000) / HTTP 端口
  PRISMSEARCH_SERVER_HOST         HTTP bind address (default 127.0.0.1) / HTTP 监听地址
  PRISMSEARCH_AUTH_TOKENS         Comma-separated access tokens; non-empty enables HTTP auth / 逗号分隔的访问令牌，非空即启用 HTTP 鉴权
  PRISMSEARCH_WORKER_TOKEN        Shared token for fetch workers / 抓取 Worker 共享令牌
  PRISMSEARCH_LOG_LEVEL           error | warn | info | debug / 日志级别
  GOOGLE_API_KEY                  Google Custom Search API key(s), comma-separated / Google API Key，逗号分隔可轮换
  GOOGLE_CSE_ID                   Google Programmable Search Engine ID (cx) / Google 搜索引擎 ID
  BRAVE_API_KEY                   Brave Search API key(s), comma-separated / Brave API Key，逗号分隔可轮换
  Any other option: PRISMSEARCH_<PATH> with "__" between levels / 其余配置项用 PRISMSEARCH_<路径> 覆盖，层级用双下划线分隔
    e.g. PRISMSEARCH_SECURITY__RATE_LIMIT__MAX_REQUESTS=30
         PRISMSEARCH_ENGINES__BING__ENABLED=false
         PRISMSEARCH_SECURITY__SSRF__WHITELIST='["intranet.example.com"]'   (arrays: JSON or comma-separated / 数组：JSON 或逗号分隔)

Examples / 示例:
  npx ${PKG_NAME}                                      # stdio, for Claude Desktop etc. / stdio，供 Claude Desktop 等客户端使用
  npx ${PKG_NAME} ./prismsearch.yaml                   # with a config file / 指定配置文件
  PRISMSEARCH_SERVER_TRANSPORT=http npx ${PKG_NAME}    # HTTP mode, 127.0.0.1 only by default / HTTP 模式（默认仅监听 127.0.0.1）
`.trim();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${CLI_HELP}\n`);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${PKG_VERSION}\n`);
    return;
  }

  const explicitConfig = argv.find(a => !a.startsWith('-'));
  const loaded = await loadConfig(explicitConfig);

  initLogger({
    level: loaded.config.log.level,
    format: loaded.config.log.format,
    file: loaded.config.log.file,
    redact: loaded.config.log.redact,
  });
  const logger = getLogger();

  for (const warning of loaded.warnings) logger.warn(warning);
  logger.info(`${PKG_NAME} ${PKG_VERSION} 正在启动`, {
    config: loaded.path ?? '(内置默认值)',
    transport: loaded.config.server.transport,
    engines: loaded.config.engines.filter(e => e.enabled).map(e => e.name),
    node: process.version,
  });

  // Worker 客户端（可选）
  let remoteFetcher: RuntimeOptions['remoteFetcher'];
  if (loaded.config.workers.enabled && loaded.config.workers.endpoints.length > 0) {
    remoteFetcher = new WorkerClient(loaded.config.workers);
  }

  const runtimeOptions: RuntimeOptions = {
    // HTTP 模式的限流在传输层按客户端分桶；stdio 只有一个客户端，在工具层限流
    toolLevelRateLimit: loaded.config.server.transport === 'stdio',
    remoteFetcher,
  };

  const runtime = await PrismSearchRuntime.create(loaded.config, runtimeOptions);
  const holder = new RuntimeHolder(runtime);

  let handle: { close(): Promise<void> } | undefined;
  let watcher: ConfigWatcher | undefined;

  if (loaded.config.server.transport === 'stdio') {
    // stdio 模式下 stdout 属于协议，不能写任何非协议内容；日志已由 logger 输出到 stderr
    handle = await startStdioTransport(holder, () => void shutdown('stdio 关闭'));
  } else {
    const httpHandle: HttpTransportHandle = await startHttpTransport({
      holder,
      reload: async () => {
        const next = await loadConfig(explicitConfig);
        await holder.reload(next.config, runtimeOptions);
        return next.config;
      },
    });
    handle = httpHandle;

    // 文件监听只有在明确解析到配置文件时才启动
    const watchPath = loaded.path ?? (await resolveConfigFile(explicitConfig));
    if (watchPath) {
      watcher = new ConfigWatcher(watchPath, async () => {
        const next = await loadConfig(explicitConfig);
        if (next.config.server.transport !== loaded.config.server.transport ||
            next.config.server.port !== loaded.config.server.port ||
            next.config.server.host !== loaded.config.server.host) {
          logger.warn('server.transport / port / host 变更需要重启才能生效，本次仅重建其余组件');
        }
        await holder.reload(next.config, runtimeOptions);
        logger.info('配置已热重载', {
          engines: next.config.engines.filter(e => e.enabled).map(e => e.name),
        });
      });
      await watcher.start();
    }
  }

  // 优雅关闭：重复信号只执行一次
  let shuttingDown = false;
  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) {
      logger.warn('已在关闭中，忽略重复的关闭请求', { reason });
      return;
    }
    shuttingDown = true;
    logger.info('正在关闭', { reason });
    watcher?.stop();
    try {
      await handle?.close();
      await remoteFetcher?.close?.();
      await holder.close();
    } catch (error) {
      logger.error('关闭过程出错', { error });
    } finally {
      await flushLogger(3000);
      process.exit(0);
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { error: reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常，进程即将退出', { error });
    void shutdown('uncaughtException');
  });
}

main().catch(async (error: unknown) => {
  // 日志系统可能尚未初始化，同时写 stderr
  process.stderr.write(`${PKG_NAME} 启动失败: ${errorMessage(error)}\n`);
  try {
    await flushLogger(1000);
  } catch {
    // 忽略
  }
  process.exit(1);
});

// 本文件是命令行入口：被 import 就会执行 main() 启动服务器，因此不导出任何东西、
// 也不作为库入口发布（package.json 只保留 bin）。需要读取配置请直接用 config/config-loader。
