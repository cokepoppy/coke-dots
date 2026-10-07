import { Entry } from '@napi-rs/keyring';
import { stdin, stdout } from 'node:process';

if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
  console.error('Run `npm run teams:configure` in an interactive terminal so the bot password can be entered without echo.');
  process.exitCode = 1;
} else {
  const service = process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';
  const entry = new Entry(service, 'teams-bot-app-secret');
  stdout.write('Microsoft Teams bot app password (input hidden): ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let secret = '';
  const onData = (chunk: string) => {
    for (const character of chunk) {
      if (character === '\u0003') {
        stdout.write('\nCancelled.\n');
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.exitCode = 130;
        return;
      }
      if (character === '\r' || character === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        if (!secret.trim() || secret.length > 4096) {
          stdout.write('\nA non-empty app password of at most 4096 characters is required.\n');
          process.exitCode = 1;
          return;
        }
        try {
          entry.setPassword(secret);
          const saved = entry.getPassword();
          if (saved !== secret) throw new Error('Keychain verification failed');
          stdout.write('\nMicrosoft Teams bot app password saved and verified in the system keychain.\n');
        } catch (error) {
          stdout.write(`\nCould not save Microsoft Teams bot app password: ${error instanceof Error ? error.message : 'Keychain unavailable'}\n`);
          process.exitCode = 1;
        } finally { secret = ''; }
        return;
      }
      if (character === '\u007f' || character === '\b') secret = secret.slice(0, -1);
      else if (character >= ' ') secret += character;
    }
  };
  stdin.on('data', onData);
}
