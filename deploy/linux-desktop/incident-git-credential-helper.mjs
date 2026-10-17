import http from 'node:http';

const action = process.argv[2] || '';
if (action !== 'get') process.exit(0);

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk.toString('utf8');
  if (raw.length > 4096) process.exit(0);
}
const fields = Object.fromEntries(raw.split(/\r?\n/).filter(Boolean).map(line => {
  const index = line.indexOf('=');
  return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
}));
if (fields.protocol !== 'https' || fields.host !== 'github.com' || fields.path !== 'cokepoppy/coke-agent-test.git') process.exit(0);

const socketPath = String(process.env.DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET || '');
if (!socketPath.startsWith('/run/incident-git-agent/') && process.env.NODE_ENV !== 'test') process.exit(0);
const requestBody = JSON.stringify({ action: 'get', protocol: fields.protocol, host: fields.host, path: fields.path });
const credential = await new Promise(resolve => {
  const request = http.request({ socketPath, path: '/credential', method: 'POST', timeout: 3000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(requestBody) } }, response => {
    const chunks = [];
    let size = 0;
    response.on('data', chunk => {
      size += chunk.length;
      if (size <= 2048) chunks.push(chunk);
      else request.destroy();
    });
    response.on('end', () => {
      if (response.statusCode !== 200 || size > 2048) return resolve(null);
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (value.username === 'x-access-token' && typeof value.password === 'string' && value.password.length > 0 && !/[\r\n]/.test(value.password)) return resolve(value);
      } catch { /* malformed broker response: return no credential */ }
      resolve(null);
    });
  });
  request.once('error', () => resolve(null));
  request.once('timeout', () => request.destroy());
  request.end(requestBody);
});

if (credential) process.stdout.write(`username=${credential.username}\npassword=${credential.password}\n\n`);
