/**
 * 浏览器抓取器相关错误定义
 */

export class BrowserNotInstalledError extends Error {
  readonly code = 'BROWSER_NOT_INSTALLED';

  constructor() {
    super(
      'Playwright 未安装。请运行以下命令安装：\n' +
      '  npm install playwright\n' +
      '  npx playwright install chromium\n' +
      '或在配置中设置 fetcher.browser.enabled = false 来禁用浏览器抓取。'
    );
    this.name = 'BrowserNotInstalledError';
  }
}
