// 内容安全过滤器 — 检测恶意URL和可疑内容

export interface ContentFilterConfig {
  enabled: boolean;
  // 恶意域名黑名单
  maliciousDomains: string[];
  // 敏感关键词列表
  sensitiveKeywords: string[];
  // 是否检测可疑模式
  detectSuspiciousPatterns: boolean;
}

export interface FilterResult {
  safe: boolean;
  threats: string[];
}

const DEFAULT_CONFIG: ContentFilterConfig = {
  enabled: true,
  maliciousDomains: [],
  sensitiveKeywords: [],
  detectSuspiciousPatterns: true,
};

// 可疑域名模式
const SUSPICIOUS_DOMAIN_PATTERNS = [
  /.*-login\..+/i,
  /.*-secure\..+/i,
  /.*-verify\..+/i,
  /.*-account\..+/i,
  /.*\.tk$/i,
  /.*\.ml$/i,
  /.*\.ga$/i,
  /.*\.cf$/i,
];

export class ContentFilter {
  private config: ContentFilterConfig;
  /** 预先小写的关键词（原文用于报告），构造 / 规则更新时计算一次 */
  private loweredKeywords: Array<{ keyword: string; lowered: string }> = [];

  constructor(config?: Partial<ContentFilterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rebuildKeywordCache();
  }

  /** 更新过滤规则（热重载用），同时刷新关键词缓存 */
  updateConfig(config: Partial<ContentFilterConfig>): void {
    this.config = { ...this.config, ...config };
    this.rebuildKeywordCache();
  }

  private rebuildKeywordCache(): void {
    this.loweredKeywords = this.config.sensitiveKeywords
      .map(keyword => ({ keyword, lowered: keyword.toLowerCase() }));
  }

  // 检查URL安全性
  checkUrl(url: string): FilterResult {
    if (!this.config.enabled) return { safe: true, threats: [] };
    const threats: string[] = [];

    try {
      const parsed = new URL(url);

      // 检测不安全协议
      if (['javascript:', 'data:', 'vbscript:'].includes(parsed.protocol)) {
        threats.push(`不安全的协议: ${parsed.protocol}`);
      }

      // 超长URL检测
      if (url.length > 2000) {
        threats.push(`URL长度异常 (${url.length} 字符)`);
      }

      // IP直连检测
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname)) {
        threats.push(`URL使用IP直连: ${parsed.hostname}`);
      }

      // 多重编码检测
      try {
        const decoded = decodeURIComponent(url);
        if (decoded !== url && decoded.includes('%')) {
          threats.push('URL存在多重编码');
        }
      } catch {
        // 解码失败忽略
      }

      // 恶意域名匹配（配置列表）
      for (const domain of this.config.maliciousDomains) {
        if (parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)) {
          threats.push(`已知恶意域名: ${domain}`);
        }
      }

      // 可疑域名模式匹配
      if (this.config.detectSuspiciousPatterns) {
        for (const pattern of SUSPICIOUS_DOMAIN_PATTERNS) {
          if (pattern.test(parsed.hostname)) {
            threats.push(`可疑域名模式: ${parsed.hostname}`);
            break;
          }
        }
      }
    } catch {
      threats.push(`无效的URL格式: ${url}`);
    }

    return { safe: threats.length === 0, threats };
  }

  // 检查内容安全性
  checkContent(content: string): FilterResult {
    if (!this.config.enabled) return { safe: true, threats: [] };
    const threats: string[] = [];

    if (this.config.detectSuspiciousPatterns) {
      // base64编码的脚本内容
      if (/atob\s*\(|btoa\s*\(/i.test(content) && /<script/i.test(content)) {
        threats.push('检测到base64编码的脚本内容');
      }

      // 隐藏iframe
      if (/<iframe[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|width\s*=\s*["']?0|height\s*=\s*["']?0)/i.test(content)) {
        threats.push('检测到隐藏的iframe');
      }

      // document.cookie访问
      if (/document\s*\.\s*cookie/i.test(content)) {
        threats.push('检测到document.cookie访问');
      }

      // eval调用
      if (/\beval\s*\(/i.test(content)) {
        threats.push('检测到eval()调用');
      }

      // 可疑的外部表单提交
      if (/<form[^>]*action\s*=\s*["']https?:\/\//i.test(content)) {
        threats.push('检测到外部表单提交');
      }
    }

    // 敏感关键词检测（正文只小写一次；关键词已在构造 / 更新规则时预先小写）
    if (this.loweredKeywords.length > 0) {
      const lowered = content.toLowerCase();
      for (const { keyword, lowered: needle } of this.loweredKeywords) {
        if (lowered.includes(needle)) {
          threats.push(`检测到敏感关键词: ${keyword}`);
        }
      }
    }

    return { safe: threats.length === 0, threats };
  }

  // 综合检查（合并URL和内容检查结果）
  check(url: string, content: string): FilterResult {
    const urlResult = this.checkUrl(url);
    const contentResult = this.checkContent(content);
    const threats = [...urlResult.threats, ...contentResult.threats];
    return { safe: threats.length === 0, threats };
  }
}
