/**
 * 配置文件监听器（热重载）
 *
 * 相比旧实现：
 * - 监听文件所在**目录**并按文件名过滤：很多编辑器以「写临时文件再 rename」方式保存，
 *   直接 watch 文件会在第一次保存后失效，且旧实现只处理 change、忽略 rename
 * - 重载串行化：上一次重载未完成时再次变更只会排队一次，不会并发重建运行时
 * - 内容未变化（如仅 touch）时跳过
 * - 回调支持 async，错误写日志而不是 console
 */

import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { getLogger } from '../utils/logger.js';

export type ConfigChangeCallback = () => Promise<void> | void;

export class ConfigWatcher {
  private readonly filePath: string;
  private readonly fileName: string;
  private readonly onChange: ConfigChangeCallback;
  private readonly debounceMs: number;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private pending = false;
  private lastHash: string | null = null;

  constructor(filePath: string, onChange: ConfigChangeCallback, debounceMs = 300) {
    this.filePath = filePath;
    this.fileName = basename(filePath);
    this.onChange = onChange;
    this.debounceMs = debounceMs;
  }

  async start(): Promise<void> {
    this.stop();
    this.lastHash = await this.hashFile();
    this.watcher = watch(dirname(this.filePath), { persistent: false }, (_event, name) => {
      // 部分平台 name 可能为空，此时保守地触发检查
      if (name && name.toString() !== this.fileName) return;
      this.schedule();
    });
    this.watcher.on('error', error => {
      getLogger().warn('配置文件监听出错', { file: this.filePath, error });
    });
    getLogger().info('已开启配置热重载', { file: this.filePath });
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.trigger();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  private async trigger(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = (async () => {
      try {
        const hash = await this.hashFile();
        if (hash === null || hash === this.lastHash) return; // 文件暂不可读（保存中）或内容未变
        this.lastHash = hash;
        await this.onChange();
      } catch (error) {
        getLogger().error('配置热重载失败，继续使用旧配置', { file: this.filePath, error });
      }
    })();
    await this.running;
    this.running = null;
    if (this.pending) {
      this.pending = false;
      await this.trigger();
    }
  }

  private async hashFile(): Promise<string | null> {
    try {
      const content = await readFile(this.filePath);
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }
}
