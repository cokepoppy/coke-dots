import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

export interface ComputerState { ready: boolean; owner: 'agent' | 'user'; url: string; title: string }

export class ComputerManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private owner: 'agent' | 'user' = 'agent';

  constructor(private dataDirectory: string) {}

  async open(): Promise<ComputerState> {
    if (!this.context) {
      const browserPath = process.env.DOTS_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      if (!existsSync(browserPath)) throw new Error('未找到 Chrome。请设置 DOTS_CHROME_BIN。');
      const profile = join(this.dataDirectory, 'computer-chrome');
      mkdirSync(profile, { recursive: true });
      this.context = await chromium.launchPersistentContext(profile, {
        executablePath: browserPath, headless: true,
        viewport: { width: 1280, height: 720 },
        args: ['--disable-extensions'],
      });
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.page.on('close', () => { this.page = null; });
    }
    return this.state();
  }

  async state(): Promise<ComputerState> {
    const page = this.page;
    return { ready: Boolean(page && !page.isClosed()), owner: this.owner, url: page?.url() || '', title: page && !page.isClosed() ? await page.title().catch(() => '') : '' };
  }

  takeOver() { if (!this.page) throw new Error('电脑尚未打开'); this.owner = 'user'; }
  returnControl() { if (!this.page) throw new Error('电脑尚未打开'); this.owner = 'agent'; }

  async navigate(url: string) {
    this.assertUserControl();
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('只允许不含凭据的 HTTP 或 HTTPS 网址');
    await this.page!.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return this.state();
  }

  async click(x: number, y: number) {
    this.assertUserControl();
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1280 || y > 720) throw new Error('点击坐标超出画面');
    await this.page!.mouse.click(x, y);
    return this.state();
  }

  async type(text: string) {
    this.assertUserControl();
    if (text.length > 2000) throw new Error('输入内容过长');
    await this.page!.keyboard.insertText(text);
    return this.state();
  }

  async screenshot(): Promise<Buffer> {
    if (!this.page || this.page.isClosed()) throw new Error('电脑尚未打开');
    return this.page.screenshot({ type: 'png' });
  }

  async close() { await this.context?.close(); this.context = null; this.page = null; this.owner = 'agent'; }

  private assertUserControl() {
    if (!this.page || this.page.isClosed()) throw new Error('电脑尚未打开');
    if (this.owner !== 'user') throw new Error('请先选择“接管”以使用鼠标和键盘');
  }
}
