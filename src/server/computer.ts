import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { computerWelcomePage } from './computer-home.mjs';

export interface ComputerState {
  ready: boolean;
  owner: 'agent' | 'user';
  url: string;
  title: string;
  backend: 'local' | 'linux-desktop';
  width: number;
  height: number;
}

export interface ComputerRuntime {
  state(): Promise<ComputerState>;
  open(dotName?: string): Promise<ComputerState>;
  takeOver(): Promise<void> | void;
  returnControl(): Promise<void> | void;
  navigate(url: string): Promise<ComputerState>;
  click(x: number, y: number): Promise<ComputerState>;
  type(text: string): Promise<ComputerState>;
  press(key: string): Promise<ComputerState>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
  novncTarget?(): Promise<URL | null>;
  runAgentTask?(input: { engine: string; taskId: string; executionId?: string; prompt: string; sessionId: string | null; signal?: AbortSignal }): Promise<{ status: string; message: string; nextMinutes?: number; sessionId?: string; pageAction?: unknown; delegations?: unknown[] }>;
}

export class ComputerManager implements ComputerRuntime {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private owner: 'agent' | 'user' = 'agent';
  private blockedNavigationUrl: string | null = null;

  constructor(private dataDirectory: string) {}

  async open(dotName = 'Dot'): Promise<ComputerState> {
    if (!this.context) {
      const browserPath = process.env.DOTS_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      if (!existsSync(browserPath)) throw new Error('未找到 Chrome。请设置 DOTS_CHROME_BIN。');
      const profile = join(this.dataDirectory, 'computer-chrome');
      mkdirSync(profile, { recursive: true });
      this.context = await chromium.launchPersistentContext(profile, {
        executablePath: browserPath, headless: true,
        viewport: { width: 1280, height: 820 },
        args: ['--disable-extensions'],
      });
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.page.on('close', () => { this.page = null; });
      if (process.env.NODE_ENV === 'test' && process.env.DOTS_E2E_AUTH === '1') {
        await this.page.route('https://www.amazon.com/**', route => route.abort('blockedbyclient'));
      }
      await this.page.setContent(computerWelcomePage(dotName), { waitUntil: 'domcontentloaded' });
    }
    return this.state();
  }

  async state(): Promise<ComputerState> {
    const page = this.page;
    return { ready: Boolean(page && !page.isClosed()), owner: this.owner, url: this.blockedNavigationUrl || page?.url() || '', title: page && !page.isClosed() ? await page.title().catch(() => '') : '', backend: 'local', width: 1280, height: 820 };
  }

  takeOver() { if (!this.page) throw new Error('电脑尚未打开'); this.owner = 'user'; }
  returnControl() { if (!this.page) throw new Error('电脑尚未打开'); this.owner = 'agent'; }

  async navigate(url: string) {
    this.assertUserControl();
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('只允许不含凭据的 HTTP 或 HTTPS 网址');
    this.blockedNavigationUrl = null;
    try {
      await this.page!.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) {
      if (!isChromiumClientBlocked(error)) throw error;
      this.blockedNavigationUrl = parsed.toString();
    }
    return this.state();
  }

  async click(x: number, y: number) {
    this.assertUserControl();
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1280 || y > 820) throw new Error('点击坐标超出画面');
    await this.page!.mouse.click(x, y);
    return this.state();
  }

  async type(text: string) {
    this.assertUserControl();
    if (text.length > 2000) throw new Error('输入内容过长');
    await this.page!.keyboard.insertText(text);
    return this.state();
  }

  async press(key: string) {
    this.assertUserControl();
    const allowed = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space']);
    if (!allowed.has(key)) throw new Error('不支持此电脑按键');
    await this.page!.keyboard.press(key);
    return this.state();
  }

  async screenshot(): Promise<Buffer> {
    if (!this.page || this.page.isClosed()) throw new Error('电脑尚未打开');
    return this.page.screenshot({ type: 'png' });
  }

  async close() { await this.context?.close(); this.context = null; this.page = null; this.owner = 'agent'; this.blockedNavigationUrl = null; }

  private assertUserControl() {
    if (!this.page || this.page.isClosed()) throw new Error('电脑尚未打开');
    if (this.owner !== 'user') throw new Error('请先选择“接管”以使用鼠标和键盘');
  }
}

function isChromiumClientBlocked(error: unknown) {
  return error instanceof Error && /net::ERR_BLOCKED_BY_CLIENT/.test(error.message);
}
