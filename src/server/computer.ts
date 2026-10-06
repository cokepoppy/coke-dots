import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

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
  runAgentTask?(input: { engine: string; taskId: string; prompt: string; sessionId: string | null; signal?: AbortSignal }): Promise<{ status: string; message: string; nextMinutes?: number; sessionId?: string; pageAction?: unknown; delegations?: unknown[] }>;
}

export class ComputerManager implements ComputerRuntime {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private owner: 'agent' | 'user' = 'agent';

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
      await this.page.setContent(computerWelcomePage(dotName), { waitUntil: 'domcontentloaded' });
    }
    return this.state();
  }

  async state(): Promise<ComputerState> {
    const page = this.page;
    return { ready: Boolean(page && !page.isClosed()), owner: this.owner, url: page?.url() || '', title: page && !page.isClosed() ? await page.title().catch(() => '') : '', backend: 'local', width: 1280, height: 820 };
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

  async close() { await this.context?.close(); this.context = null; this.page = null; this.owner = 'agent'; }

  private assertUserControl() {
    if (!this.page || this.page.isClosed()) throw new Error('电脑尚未打开');
    if (this.owner !== 'user') throw new Error('请先选择“接管”以使用鼠标和键盘');
  }
}

function computerWelcomePage(dotName: string) {
  const safeName = dotName.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  const shortcuts = [
    { icon: '◉', label: '3D Slicer' }, { icon: '◉', label: 'Blender' }, { icon: '🎨', label: 'Draw' }, { icon: 'F', label: 'FreeCAD' }, { icon: '♨', label: 'GIMP' },
    { icon: '◉', label: 'Go' }, { icon: '✿', label: 'Godot' }, { icon: '◆', label: 'Inkscape' }, { icon: '➜', label: 'Kdenlive' }, { icon: 'Ki', label: 'KiCad' },
    { icon: '✦', label: '' }, { icon: '⌂', label: '' }, { icon: '●', label: '' }, { icon: '✧', label: '' }, { icon: '◈', label: '' },
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome back, ${safeName}</title>
  <style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:Arial,Helvetica,sans-serif;background:#fbfaf8;color:#222}
    .wallpaper{position:absolute;inset:0;background:#fbfaf8;overflow:hidden}.pattern{position:absolute;inset:0;display:grid;grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(3,1fr);place-items:center;color:#e8e5e1;font-size:31px;opacity:.78}.pattern span:nth-child(2n){transform:rotate(-18deg) scale(.8)}.pattern span:nth-child(3n){transform:rotate(21deg) scale(.72)}
    main{position:absolute;top:12%;left:50%;transform:translateX(-50%);width:min(620px,80%);text-align:center}.welcome-note{position:relative;display:grid;align-content:center;width:min(330px,60%);height:90px;margin:0 auto 12px;padding:14px 24px;border:1px solid #efedeb;border-radius:9px;background:#fff;box-shadow:0 2px 6px #0000000a}.welcome-note p{margin:0;color:#47444a;text-align:left;font-size:12px;line-height:1.2}.welcome-note b{position:absolute;right:11px;top:8px;color:#b9b5b7;font-size:10px;font-weight:400;line-height:1}.mascot{position:relative;width:110px;height:110px;margin:0 auto 2px;border-radius:48% 50% 44% 47%;background:#f27635;box-shadow:inset -7px -7px 0 #e96a2d;transform:rotate(-4deg)}.crown{position:absolute;top:-18px;left:30px;width:50px;height:30px;background:#f4c744;clip-path:polygon(0 100%,0 28%,25% 54%,39% 0,54% 55%,75% 7%,84% 59%,100% 32%,92% 100%)}.glasses{position:absolute;top:38px;left:15px;display:flex;gap:8px}.glasses i{display:block;width:34px;height:24px;border-radius:5px;background:#17191d;border:1px solid #35383b}.glasses b{width:7px;height:3px;background:#17191d;margin-top:10px}
    .remaining{position:relative;display:inline-block;font-size:80px;line-height:1.1;letter-spacing:-3px;font-weight:400;margin:0;color:#242329}.meridiem{position:absolute;right:-23px;bottom:7px;font-size:10px;line-height:1;letter-spacing:0;color:#77737a}.welcome{font-size:22px;color:#68666d;margin-top:12px}.shortcuts{display:grid;grid-template-columns:repeat(5,78px);justify-content:center;gap:22px 14px;margin:52px auto 0}.shortcut{height:105px;display:grid;justify-items:center;align-content:start;gap:10px;color:#6e6c73;font-size:10px;white-space:nowrap}.shortcut-icon{height:40px;width:40px;display:grid;place-items:center;border-radius:9px;background:#f0eeea;color:#7b7780;font-size:25px;font-weight:600}.shortcut:nth-child(5n+1) .shortcut-icon{color:#4285f4}.shortcut:nth-child(5n+2) .shortcut-icon{color:#e3ac29}.shortcut:nth-child(5n+3) .shortcut-icon{color:#39a77d}.shortcut:nth-child(5n+4) .shortcut-icon{color:#bc669e}.shortcut:nth-child(5n) .shortcut-icon{color:#69717e}.shortcut:nth-child(5n+5) .shortcut-icon{font-size:17px}
    @media(max-width:720px){main{top:8%;width:92%}.welcome-note{height:72px;margin-bottom:9px}.shortcuts{grid-template-columns:repeat(5,48px);gap:12px 6px;margin-top:35px}.remaining{font-size:68px}.mascot{width:94px;height:94px}}
  </style></head><body><div class="wallpaper"><div class="pattern" aria-hidden="true">${shortcuts.map(({ icon }) => `<span>${icon}</span>`).join('')}</div></div>
    <main><div class="welcome-note"><p>This is my computer. Watch me work, or take control when you need to.</p><b aria-hidden="true">×</b></div><div class="mascot" aria-hidden="true"><span class="crown"></span><span class="glasses"><i></i><b></b><i></i></span></div><div class="remaining">1:19<span class="meridiem">PM</span></div><div class="welcome">Welcome back, ${safeName}</div>
      <div class="shortcuts" aria-hidden="true">${shortcuts.map(({ icon, label }) => `<div class="shortcut"><span class="shortcut-icon">${icon}</span>${label ? `<span class="shortcut-label">${label}</span>` : ''}</div>`).join('')}</div>
    </main></body></html>`;
}
