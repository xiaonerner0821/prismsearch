/**
 * PrismSearch 配置加载器
 *
 * 合并顺序（后者覆盖前者）：内置默认值 → 配置文件 → 环境变量，最后整体交给 zod 校验。
 *
 * 相比旧实现的改进：
 * - 运行时校验：字段类型错误、拼写错误的枚举值会在启动时给出带路径的明确报错，
 *   不再 `as unknown as` 强转后带病运行
 * - 引擎按 name 逐字段合并：用户只写 `- name: bing\n  enabled: false` 也安全，
 *   未写的 timeout 等字段沿用内置默认值
 * - 环境变量：支持双下划线分隔路径、大小写不敏感匹配驼峰字段
 *   （PRISMSEARCH_SECURITY__RATE_LIMIT__MAX_REQUESTS / PRISMSEARCH_SECURITY__RATELIMIT__MAXREQUESTS 均可），
 *   兼容旧的单下划线写法（PRISMSEARCH_SERVER_PORT）；无法解析的变量给出警告而不是静默写入垃圾 key
 * - 引擎可按名称覆盖：PRISMSEARCH_ENGINES__BING__ENABLED=false
 * - 记住配置文件路径，供热重载复用
 */

import { readFile, access } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import type { z } from 'zod';
import {
  BUILTIN_ENGINES,
  DEFAULT_CONFIG,
  PrismSearchConfigSchema,
  type PrismSearchConfig,
} from './config-schema.js';

type PlainObject = Record<string, unknown>;

export interface LoadedConfig {
  config: PrismSearchConfig;
  /** 实际加载的配置文件；未找到任何文件时为 null（纯默认值 + 环境变量） */
  path: string | null;
  /** 非致命问题（如无法识别的环境变量） */
  warnings: string[];
}

export class ConfigValidationError extends Error {
  constructor(
    readonly issues: string[],
    readonly source: string | null,
  ) {
    super(`配置校验失败${source ? `（${source}）` : ''}:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/** 已加载配置单例 */
let cached: LoadedConfig | null = null;

/** 用户主目录下的 PrismSearch 数据目录 */
export function getDataDir(): string {
  return process.env.PRISMSEARCH_HOME?.trim() || join(homedir(), '.prismsearch');
}

/** 展开 ~ 开头的路径；相对路径保持相对配置文件所在目录不变（交由调用方决定） */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

function isPlainObject(v: unknown): v is PlainObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * 深度合并：对象递归合并，数组与原始值整体替换。
 * undefined 与 null 都视为「未设置」而跳过：YAML 里只写了注释的空节点（如 `sqlite:`）
 * 会被解析成 null，不应把默认值整段抹掉；schema 中也没有任何字段接受 null。
 */
export function deepMerge(target: PlainObject, source: PlainObject): PlainObject {
  const result: PlainObject = { ...target };
  for (const [key, sourceVal] of Object.entries(source)) {
    if (sourceVal === undefined || sourceVal === null) continue;
    const targetVal = result[key];
    result[key] = isPlainObject(sourceVal) && isPlainObject(targetVal)
      ? deepMerge(targetVal, sourceVal)
      : sourceVal;
  }
  return result;
}

/**
 * 引擎列表按 name 合并：
 * - 用户条目与同名内置条目逐字段深度合并
 * - 用户新增的未知引擎名原样保留（交给 schema 校验必填字段）
 * - 用户未列出的内置引擎保持内置的 enabled 状态
 */
export function mergeEngines(builtin: readonly PlainObject[], user: unknown): PlainObject[] {
  const merged = new Map<string, PlainObject>();
  for (const e of builtin) merged.set(String(e.name), clone(e));
  if (user === undefined || user === null) return [...merged.values()];
  if (!Array.isArray(user)) {
    throw new ConfigValidationError(['engines: 必须是数组'], null);
  }
  for (const [i, entry] of user.entries()) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new ConfigValidationError([`engines[${i}]: 每个引擎条目必须包含 name 字段`], null);
    }
    const name = entry.name.trim();
    const base = merged.get(name);
    merged.set(name, base ? deepMerge(base, entry) : clone(entry));
  }
  return [...merged.values()];
}

// ===== 环境变量覆盖 =====

const ENV_PREFIX = 'PRISMSEARCH_';

/** 由加载器单独处理、不走通用路径解析的环境变量 */
const RESERVED_ENV = new Set([
  'PRISMSEARCH_HOME',
  'PRISMSEARCH_CONFIG',
  'PRISMSEARCH_AUTH_TOKENS',
  'PRISMSEARCH_WORKER_TOKEN',
]);

/**
 * schema 中可选、默认配置里可能不存在的叶子字段。
 * 环境变量只能写入已存在或在此登记的字段，防止拼写错误静默生成垃圾 key。
 */
const OPTIONAL_LEAVES: Record<string, readonly string[]> = {
  '': [],
  'engines.*': ['apiKey', 'searchEngineId', 'displayName'],
  'cache.sqlite': ['path'],
  'cache.redis': ['password'],
  fetcher: ['userAgent'],
  'fetcher.browser': ['userAgent'],
  log: ['file'],
};

/** 规范化名称用于大小写 / 分隔符不敏感比较：maxRequests ≈ MAX_REQUESTS ≈ maxrequests */
function normalizeKey(s: string): string {
  return s.replace(/[_-]/g, '').toLowerCase();
}

function coerceValue(value: string, current: unknown): unknown {
  const trimmed = value.trim();
  if (Array.isArray(current)) {
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // 回落到逗号分隔
      }
    }
    return trimmed ? trimmed.split(',').map(s => s.trim()).filter(Boolean) : [];
  }
  if (typeof current === 'string') return value;
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

interface ResolvedTarget {
  parent: PlainObject;
  key: string;
}

/**
 * 沿 segments 在 obj 中定位目标字段。每段做大小写 / 下划线不敏感匹配；
 * 允许单下划线写法中一段对应多个原始片段（如 rate_limit → rateLimit）。
 * 数组 engines 下用引擎名定位条目。
 */
function resolvePath(
  obj: PlainObject,
  rawSegments: string[],
  schemaPath: string,
): ResolvedTarget | null {
  if (rawSegments.length === 0) return null;

  // 贪心尝试：先用尽量少的片段拼成一个 key，失败再多拼
  for (let take = 1; take <= rawSegments.length; take++) {
    const candidate = normalizeKey(rawSegments.slice(0, take).join(''));
    const rest = rawSegments.slice(take);

    let matchKey = Object.keys(obj).find(k => normalizeKey(k) === candidate);
    if (!matchKey && rest.length === 0) {
      const optional = OPTIONAL_LEAVES[schemaPath] ?? [];
      matchKey = optional.find(k => normalizeKey(k) === candidate);
    }
    if (!matchKey) continue;

    if (rest.length === 0) return { parent: obj, key: matchKey };

    const next = obj[matchKey];
    const childPath = schemaPath ? `${schemaPath}.${matchKey}` : matchKey;

    if (Array.isArray(next) && matchKey === 'engines') {
      // engines 下一段（或多段）是引擎名
      for (let nameTake = 1; nameTake < rest.length; nameTake++) {
        const engineName = rest.slice(0, nameTake).join('_').toLowerCase();
        const engine = next.find(
          e => isPlainObject(e) && String(e.name).toLowerCase() === engineName,
        );
        if (isPlainObject(engine)) {
          const found = resolvePath(engine, rest.slice(nameTake), 'engines.*');
          if (found) return found;
        }
      }
      continue;
    }

    if (isPlainObject(next)) {
      const found = resolvePath(next, rest, childPath);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 应用 PRISMSEARCH_* 环境变量覆盖，返回无法识别的变量警告。
 * 路径分隔：优先双下划线；不含双下划线时按单下划线拆分并做贪心匹配。
 */
export function applyEnvOverrides(config: PlainObject, env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];

  for (const [envKey, envValue] of Object.entries(env)) {
    if (!envKey.startsWith(ENV_PREFIX) || envValue === undefined) continue;
    if (RESERVED_ENV.has(envKey)) continue;

    const body = envKey.slice(ENV_PREFIX.length);
    let target: ResolvedTarget | null = null;

    if (body.includes('__')) {
      // 双下划线分段，段内的单下划线视为词分隔
      const groups = body.split('__').filter(Boolean);
      target = resolveGroups(config, groups, '');
    } else {
      target = resolvePath(config, body.split('_').filter(Boolean), '');
    }

    if (!target) {
      warnings.push(`无法识别的环境变量 ${envKey}，已忽略`);
      continue;
    }
    target.parent[target.key] = coerceValue(envValue, target.parent[target.key]);
  }

  // 便捷变量：鉴权令牌。提供了非空令牌即视为要开启鉴权——
  // 文档与 Docker 都只要求设置这一个变量，只写 tokens 不开 enabled 会导致非回环监听拒绝启动
  const tokens = env.PRISMSEARCH_AUTH_TOKENS;
  if (tokens !== undefined) {
    const security = (config.security ??= {}) as PlainObject;
    const auth = (security.auth ??= {}) as PlainObject;
    const list = tokens.split(',').map(t => t.trim()).filter(Boolean);
    auth.tokens = list;
    if (list.length > 0) auth.enabled = true;
  }

  return warnings;
}

/** 双下划线写法：每组是一个完整字段名（组内下划线忽略） */
function resolveGroups(obj: PlainObject, groups: string[], schemaPath: string): ResolvedTarget | null {
  const [head, ...rest] = groups;
  const wanted = normalizeKey(head);
  let key = Object.keys(obj).find(k => normalizeKey(k) === wanted);
  if (!key && rest.length === 0) {
    key = (OPTIONAL_LEAVES[schemaPath] ?? []).find(k => normalizeKey(k) === wanted);
  }
  if (!key) return null;
  if (rest.length === 0) return { parent: obj, key };

  const next = obj[key];
  if (Array.isArray(next) && key === 'engines') {
    const engineName = rest[0].toLowerCase();
    const engine = next.find(e => isPlainObject(e) && String(e.name).toLowerCase() === engineName);
    if (!isPlainObject(engine) || rest.length < 2) return null;
    return resolveGroups(engine, rest.slice(1), 'engines.*');
  }
  if (isPlainObject(next)) {
    return resolveGroups(next, rest, schemaPath ? `${schemaPath}.${key}` : key);
  }
  return null;
}

// ===== 文件 =====

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function parseConfigFile(filePath: string): Promise<PlainObject> {
  const content = await readFile(filePath, 'utf-8');
  const ext = extname(filePath).toLowerCase();
  let parsed: unknown;
  try {
    if (ext === '.json') parsed = JSON.parse(content);
    else if (ext === '.toml') parsed = parseToml(content);
    else parsed = parseYaml(content) ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([`无法解析配置文件: ${message}`], filePath);
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigValidationError(['配置文件顶层必须是对象'], filePath);
  }
  return parsed;
}

/** 候选配置文件（按优先级） */
export function configCandidates(cwd: string = process.cwd()): string[] {
  const exts = ['yaml', 'yml', 'json', 'toml'];
  return [
    ...exts.map(e => resolve(cwd, `prismsearch.${e}`)),
    ...exts.map(e => join(getDataDir(), `config.${e}`)),
  ];
}

/**
 * 确定配置文件路径。优先级：
 * 1. 显式参数（命令行 / --config）
 * 2. PRISMSEARCH_CONFIG 环境变量
 * 3. ./prismsearch.{yaml,yml,json,toml}
 * 4. ~/.prismsearch/config.{yaml,yml,json,toml}
 *
 * 注意：不再自动读取 ./config/default.yaml —— 它是随包分发的示例文件，
 * 旧实现把它当真实配置加载，导致其中的 apiKey: "" 屏蔽环境变量。
 */
export async function resolveConfigFile(configPath?: string): Promise<string | null> {
  const explicit = configPath ?? process.env.PRISMSEARCH_CONFIG?.trim();
  if (explicit) {
    const resolved = resolve(expandHome(explicit));
    if (await fileExists(resolved)) return resolved;
    throw new Error(`指定的配置文件不存在: ${resolved}`);
  }
  for (const candidate of configCandidates()) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const path = issue.path.length ? issue.path.join('.') : '(根)';
    return `${path}: ${issue.message}`;
  });
}

/** 由原始对象构建并校验配置（不读文件，便于测试与热重载复用） */
export function buildConfig(
  fileConfig: PlainObject,
  env: NodeJS.ProcessEnv = process.env,
  source: string | null = null,
): { config: PrismSearchConfig; warnings: string[] } {
  const { engines: userEngines, ...rest } = fileConfig;

  // 以完整默认值为底，保证环境变量能定位到每个字段
  const { engines: _defaultEngines, ...defaultsWithoutEngines } = clone(DEFAULT_CONFIG) as unknown as PlainObject;
  void _defaultEngines;
  const raw = deepMerge(defaultsWithoutEngines, rest);
  raw.engines = mergeEngines(BUILTIN_ENGINES as unknown as PlainObject[], userEngines);

  const warnings = applyEnvOverrides(raw, env);

  const result = PrismSearchConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigValidationError(formatIssues(result.error), source);
  }

  const config = result.data;

  // 引擎名唯一性
  const seen = new Set<string>();
  for (const e of config.engines) {
    if (seen.has(e.name)) throw new ConfigValidationError([`engines: 引擎名重复 "${e.name}"`], source);
    seen.add(e.name);
  }

  // 路径展开：缓存默认放到用户主目录，避免被 MCP 客户端以 / 或 System32 为 cwd 启动时写失败
  config.cache.sqlite.path = config.cache.sqlite.path
    ? resolve(expandHome(config.cache.sqlite.path))
    : join(getDataDir(), 'cache.db');
  if (config.log.file) config.log.file = resolve(expandHome(config.log.file));

  return { config, warnings };
}

/** 加载、合并并校验配置 */
export async function loadConfig(configPath?: string): Promise<LoadedConfig> {
  const path = await resolveConfigFile(configPath);
  const fileConfig = path ? await parseConfigFile(path) : {};
  const { config, warnings } = buildConfig(fileConfig, process.env, path);
  cached = { config, path, warnings };
  return cached;
}

/** 按上次加载使用的同一个文件重新加载（热重载用） */
export async function reloadConfig(): Promise<LoadedConfig> {
  const path = cached?.path ?? undefined;
  const fileConfig = path ? await parseConfigFile(path) : {};
  const { config, warnings } = buildConfig(fileConfig, process.env, path ?? null);
  cached = { config, path: path ?? null, warnings };
  return cached;
}

/** 获取已加载的配置（必须先调用 loadConfig） */
export function getConfig(): PrismSearchConfig {
  if (!cached) throw new Error('配置尚未加载，请先调用 loadConfig() 初始化配置');
  return cached.config;
}

export function getLoadedConfig(): LoadedConfig | null {
  return cached;
}
