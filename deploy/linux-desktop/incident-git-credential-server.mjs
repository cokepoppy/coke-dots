import { chmod, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const socketPath = String(process.env.DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET || '');
const tokenPath = String(process.env.DOTS_INCIDENT_GITHUB_TOKEN_FILE || '');
if (!path.isAbsolute(socketPath) || !path.isAbsolute(tokenPath)) throw new Error('Incident Git credential socket and token paths must be absolute');

const token = (await readFile(tokenPath, 'utf8')).trim();
if (!token || /\s/.test(token)) throw new Error('Incident GitHub token file is empty or malformed');
const repository = 'cokepoppy/coke-agent-test';
const incidentBranch = 'fix/coke-agent-empty-conversation-c7e2a195';
const pullRequestTitle = 'Handle missing conversation state in Coke Agent';
const pullRequestBody = '## Summary\nGuard conversation rendering when the current conversation is null so a new session can display correctly.\n\nIncident trace: `c7e2a195-4f93-4c60-8a27-b1d6e0f5a94c`';
const apiRoot = resolveGitHubApiRoot();

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
    if (req.method !== 'POST' || !['/credential', '/pull-request'].includes(req.url)) return reply(res, 404, { error: 'not found' });
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) return reply(res, 413, { error: 'request too large' });
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url === '/credential') {
      if (input.action !== 'get' || input.protocol !== 'https' || input.host !== 'github.com' || input.path !== `${repository}.git`) {
        return reply(res, 404, { error: 'credential unavailable' });
      }
      return reply(res, 200, { username: 'x-access-token', password: token });
    }
    return await createOrFindPullRequest(input, res);
  } catch {
    return reply(res, 400, { error: 'invalid credential request' });
  }
});

async function createOrFindPullRequest(input, res) {
  if (!input || Array.isArray(input) || Object.keys(input).length > 0) {
    return reply(res, 400, { error: 'invalid pull request request' });
  }

  const existing = await findOpenPullRequest();
  if (existing.error) return reply(res, 502, { error: existing.error });
  if (existing.value) return reply(res, 200, existing.value);

  const branch = await githubRequest(`${apiRoot}/repos/${repository}/branches/${encodeURIComponent(incidentBranch)}`);
  if (!branch.ok || branch.value?.name !== incidentBranch || !/^[a-f0-9]{40}$/i.test(branch.value?.commit?.sha || '')) {
    return reply(res, 409, { error: 'The incident fix branch is not available on GitHub yet' });
  }

  const created = await githubRequest(`${apiRoot}/repos/${repository}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: pullRequestTitle, body: pullRequestBody, head: incidentBranch, base: 'main' }),
  });
  if (!created.ok && created.status === 422) {
    const raced = await findOpenPullRequest();
    if (raced.value) return reply(res, 200, raced.value);
  }
  const value = created.ok ? normalizePullRequest(created.value) : null;
  if (!value) return reply(res, 502, { error: `GitHub pull request creation failed (HTTP ${created.status || 0})` });
  return reply(res, 201, value);
}

async function findOpenPullRequest() {
  const query = new URLSearchParams({ state: 'open', head: `${repository.split('/')[0]}:${incidentBranch}`, base: 'main', per_page: '10' });
  const response = await githubRequest(`${apiRoot}/repos/${repository}/pulls?${query}`);
  if (!response.ok || !Array.isArray(response.value)) return { error: `GitHub pull request lookup failed (HTTP ${response.status || 0})` };
  const match = response.value.find(item => item?.head?.ref === incidentBranch && item?.base?.ref === 'main' && item?.state === 'open');
  return { value: match ? normalizePullRequest(match) : null };
}

function normalizePullRequest(value) {
  const url = typeof value?.html_url === 'string' ? value.html_url : '';
  const number = Number(value?.number);
  if (!Number.isInteger(number) || number < 1 || value?.state !== 'open' || value?.merged === true
      || value?.head?.ref !== incidentBranch || value?.base?.ref !== 'main'
      || value?.head?.repo?.full_name !== repository || value?.base?.repo?.full_name !== repository
      || !/^https:\/\/github\.com\/cokepoppy\/coke-agent-test\/pull\/\d+$/.test(url)) return null;
  return { number, url, state: 'open', head: incidentBranch, base: 'main', merged: false };
}

async function githubRequest(url, { method = 'GET', body } = {}) {
  const config = [
    `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}`,
    'header = "Accept: application/vnd.github+json"',
    'header = "X-GitHub-Api-Version: 2022-11-28"',
  ].join('\n');
  const args = ['--silent', '--show-error', '--max-time', '20', '--max-filesize', '65536', '--write-out', '\n%{http_code}', '--config', '-', '--url', url];
  if (method !== 'GET') args.push('--request', method, '--header', 'Content-Type: application/json', '--data-raw', body || '{}');
  if (process.env.NODE_ENV === 'test' && new URL(apiRoot).hostname.match(/^(127\.0\.0\.1|localhost)$/)) args.push('--noproxy', '*');
  else {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
    if (!proxy || proxy !== 'http://host.docker.internal:17891') return { ok: false, status: 0, value: null };
    args.push('--proxy', proxy);
  }
  const result = await new Promise(resolve => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    let output = Buffer.alloc(0);
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length > 70_000) child.kill('SIGKILL');
      else output = Buffer.concat([output, chunk]);
    });
    child.once('error', () => resolve(null));
    child.once('close', code => resolve(code === 0 ? output.toString('utf8') : null));
    child.stdin.end(config);
  });
  if (typeof result !== 'string') return { ok: false, status: 0, value: null };
  const delimiter = result.lastIndexOf('\n');
  if (delimiter < 0) return { ok: false, status: 0, value: null };
  const status = Number(result.slice(delimiter + 1));
  let value = null;
  try { value = JSON.parse(result.slice(0, delimiter)); } catch { /* return a generic error to the task */ }
  return { ok: status >= 200 && status < 300, status, value };
}

function resolveGitHubApiRoot() {
  const configured = process.env.DOTS_INCIDENT_GITHUB_API_URL;
  if (!configured) return 'https://api.github.com';
  if (process.env.NODE_ENV !== 'test') throw new Error('Custom GitHub API endpoints are allowed only in tests');
  const url = new URL(configured);
  if (url.protocol !== 'http:' || !/^(127\.0\.0\.1|localhost)$/.test(url.hostname) || url.username || url.password || url.pathname !== '/') {
    throw new Error('Test GitHub API endpoint must use loopback HTTP');
  }
  return url.origin;
}

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
