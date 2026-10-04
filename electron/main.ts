import { app, BrowserWindow, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..');
app.setName('Coke Dots');
const devUrl = process.env.DOTS_DEV_URL;
const healthUrl = 'http://127.0.0.1:4317/api/health';

async function healthy() {
  try { return (await fetch(healthUrl, { signal: AbortSignal.timeout(700) })).ok; }
  catch { return false; }
}

async function ensureService() {
  if (await healthy()) return;
  const builtServer = join(root, 'server-dist/index.js');
  const args = existsSync(builtServer) ? [builtServer] : ['--import', 'tsx', 'src/server/index.ts'];
  const child = spawn('node', args, {
    cwd: root,
    env: { ...process.env, DOTS_DATA_DIR: process.env.DOTS_DATA_DIR || join(app.getPath('userData'), 'data') },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 35; i++) {
    if (await healthy()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('本机后台服务没有启动。请确认 Node.js 24 已安装，或先运行 npm run start。');
}

async function createWindow() {
  await ensureService();
  const win = new BrowserWindow({
    width: 1190, height: 800, minWidth: 800, minHeight: 600,
    title: 'Coke Dots',
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const url = devUrl || 'http://127.0.0.1:4317';
  await win.loadURL(url);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const parsed = new URL(target);
      const googleAuth = parsed.protocol === 'https:' && parsed.hostname === 'accounts.google.com';
      const desktopAuthStart = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && ['4317', '5173'].includes(parsed.port) && parsed.pathname === '/api/auth/desktop/start';
      if (googleAuth || desktopAuthStart) void shell.openExternal(target);
    } catch { /* Block malformed or unexpected targets. */ }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault(); });
}

app.whenReady().then(createWindow).catch(error => {
  console.error(error);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
