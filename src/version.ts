/**
 * 版本号唯一来源 —— 运行时从 package.json 读取，避免多处硬编码导致版本漂移
 *
 * 路径说明：本文件源码位于 src/version.ts，编译后位于 dist/version.js，
 * 两者相对包根目录的深度一致，因此 ../package.json 在两种形态下都成立
 * （npm 发布时 package.json 始终包含在包内）。
 */
import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);

const pkg = localRequire('../package.json') as { name: string; version: string };

/** 包名（用于 MCP 握手标识） */
export const PKG_NAME: string = pkg.name;

/** 版本号（MCP 握手、/health 端点等对外暴露处统一使用） */
export const PKG_VERSION: string = pkg.version;
