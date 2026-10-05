import { spawn } from 'node:child_process';

export type DesktopNotifier = (title: string, body: string) => void;

export function sendDesktopNotification(title: string, body: string) {
  if (process.platform !== 'darwin' || process.env.NODE_ENV === 'test') return;
  const executable = process.env.DOTS_NOTIFY_BIN || '/usr/bin/osascript';
  const command = `display notification ${appleScriptString(body.slice(0, 240))} with title ${appleScriptString(title.slice(0, 80))}`;
  const child = spawn(executable, ['-e', command], { stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

function appleScriptString(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"`;
}
