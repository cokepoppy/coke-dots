import { chmod, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const socketPath = String(process.env.DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET || '');
const tokenPath = String(process.env.DOTS_INCIDENT_GITHUB_TOKEN_FILE || '');
if (!path.isAbsolute(socketPath) || !path.isAbsolute(tokenPath)) throw new Error('Incident Git credential socket and token paths must be absolute');

const token = (await readFile(tokenPath, 'utf8')).trim();
if (!token || /\s/.test(token)) throw new Error('Incident GitHub token file is empty or malformed');

await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
try {
  const existing = await lstat(socketPath);
  if (!existing.isSocket()) throw new Error('Refusing to replace a non-socket incident credential path');
  await unlink(socketPath);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  let size = 0;
  try {
    if (req.method !== 'POST' || req.url !== '/credential') return reply(res, 404, { error: 'not found' });
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2048) return reply(res, 413, { error: 'request too large' });
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input.action !== 'get' || input.protocol !== 'https' || input.host !== 'github.com' || input.path !== 'cokepoppy/coke-agent-test.git') {
      return reply(res, 404, { error: 'credential unavailable' });
    }
    return reply(res, 200, { username: 'x-access-token', password: token });
  } catch {
    return reply(res, 400, { error: 'invalid credential request' });
  }
});

function reply(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

server.on('error', () => process.exitCode = 1);
server.listen(socketPath, async () => {
  await chmod(socketPath, 0);
});

const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
