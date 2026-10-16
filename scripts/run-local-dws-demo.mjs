import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  process.stderr.write('The local DWS demo launcher is macOS-only.\n');
  process.exit(1);
}

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localDataRoot = path.join(homedir(), 'Library', 'Application Support', 'Coke Dots DWS Local Demo');
const secretsPath = path.join(localDataRoot, '.gateway-secrets.json');

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('DWS_LOCAL_STORAGE_UNSAFE');
  await chmod(directory, 0o700);
}

async function readPrivateSecrets() {
  const info = await lstat(secretsPath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('DWS_LOCAL_SECRETS_UNSAFE');
  if (info.mode & 0o077) await chmod(secretsPath, 0o600);
  const value = JSON.parse(await readFile(secretsPath, 'utf8'));
  if (typeof value.serviceToken !== 'string' || value.serviceToken.length < 32
    || typeof value.ticketSecret !== 'string' || value.ticketSecret.length < 32
    || typeof value.encryptionKey !== 'string' || Buffer.from(value.encryptionKey, 'base64').length !== 32) {
    throw new Error('DWS_LOCAL_SECRETS_INVALID');
  }
  return value;
}

async function loadOrCreateSecrets() {
  try { return await readPrivateSecrets(); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const value = {
    serviceToken: randomBytes(32).toString('base64url'),
    ticketSecret: randomBytes(32).toString('base64url'),
    encryptionKey: randomBytes(32).toString('base64'),
  };
  let file;
  try {
    file = await open(secretsPath, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();
    return value;
  } catch (error) {
    await file?.close().catch(() => undefined);
    if (error.code === 'EEXIST') return readPrivateSecrets();
    await rm(secretsPath, { force: true });
    throw error;
  }
}

await ensurePrivateDirectory(localDataRoot);
const secrets = await loadOrCreateSecrets();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'coke-dots-dws-local-'));
const port = process.env.DINGTALK_CONNECTOR_PORT || '8789';
const gatewayPath = path.join(appRoot, 'deploy', 'dingtalk-connector', 'gateway.mjs');
const binary = path.join(homedir(), 'Library', 'Application Support', 'Coke Dots Demo', 'tools', 'dws', 'bin', 'dws');
const child = spawn(process.execPath, [gatewayPath], {
  cwd: appRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    DINGTALK_CONNECTOR_ALLOW_MACOS_RUNTIME: '1',
    DINGTALK_CONNECTOR_HOST: '127.0.0.1',
    DINGTALK_CONNECTOR_PORT: port,
    DINGTALK_CONNECTOR_DWS_BINARY: binary,
    DINGTALK_CONNECTOR_STORAGE_ROOT: path.join(localDataRoot, 'profiles'),
    DINGTALK_CONNECTOR_TMP_ROOT: temporaryRoot,
    DINGTALK_CONNECTOR_SERVICE_TOKEN: secrets.serviceToken,
    DINGTALK_CONNECTOR_TICKET_SECRET: secrets.ticketSecret,
    DINGTALK_CONNECTOR_ENCRYPTION_KEY: secrets.encryptionKey,
  },
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  });
}

try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
