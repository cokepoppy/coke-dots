import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import { parse, serialize } from 'parse5';

const maxHtmlBytes = 3 * 1024 * 1024;
const maxRedirects = 5;
const maxPageText = 12_000;
const removableTags = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template', 'noscript', 'svg', 'math']);
const safeAttributes = new Set(['class', 'id', 'title', 'alt', 'role', 'lang', 'dir', 'width', 'height']);

export function isE2EBrowserResearchFixture(value, environment = process.env) {
  if (environment.NODE_ENV !== 'test' || environment.DOTS_E2E_AUTH !== '1') return false;
  const configured = environment.DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL?.trim();
  if (!configured) return false;
  try { return new URL(value).href === new URL(configured).href; }
  catch { return false; }
}

export function isE2EComputerUiFixture(value, environment = process.env) {
  if (environment.NODE_ENV !== 'test' || environment.DOTS_E2E_AUTH !== '1') return false;
  const configured = environment.DOTS_E2E_COMPUTER_UI_FIXTURE_URL?.trim();
  if (!configured) return false;
  try { return new URL(value).href === new URL(configured).href; }
  catch { return false; }
}

export function isE2EWebsiteSignInFixture(value, environment = process.env) {
  if (environment.NODE_ENV !== 'test' || environment.DOTS_E2E_AUTH !== '1') return false;
  const configured = environment.DOTS_E2E_COMPUTER_SIGNIN_FIXTURE_URL?.trim();
  if (!configured) return false;
  try { return new URL(value).href === new URL(configured).href; }
  catch { return false; }
}

export async function validatePublicHttpsUrl(value, options = {}) {
  return (await resolvePublicHttpsUrl(value, options)).url.href;
}

/** Resolve and validate every address before a request; callers connect to this pinned address. */
export async function resolvePublicHttpsUrl(value, options = {}) {
  if (options.signal?.aborted) throw options.signal.reason || new Error('电脑研究已取消');
  let url;
  try { url = new URL(value); }
  catch { throw new Error('电脑研究只允许公开的 HTTPS 网页'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.port) {
    throw new Error('电脑研究只允许不含凭据或锚点的标准 HTTPS 网址');
  }
  if (isE2EBrowserResearchFixture(url.href, options.environment || process.env)) {
    return { url, hostname: url.hostname, address: null, family: 0, fixture: true };
  }
  if (isE2EComputerUiFixture(url.href, options.environment || process.env)) {
    return { url, hostname: url.hostname, address: null, family: 0, fixture: true };
  }
  if (isE2EWebsiteSignInFixture(url.href, options.environment || process.env)) {
    return { url, hostname: url.hostname, address: null, family: 0, fixture: true };
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || ['localhost', 'metadata.google.internal'].includes(hostname) ||
    /\.(?:localhost|local|internal|lan|home|test|example|invalid|onion)$/.test(hostname)) {
    throw new Error('电脑研究不能访问本机或保留域名');
  }
  const family = isIP(hostname);
  if (family) {
    if (!isPublicIpAddress(hostname)) throw new Error('电脑研究不能访问私有或保留 IP 地址');
    return { url, hostname, address: hostname, family };
  }

  let addresses;
  try {
    const resolver = options.lookup || lookup;
    addresses = await lookupWithDeadline(resolver, hostname, options.signal, options.dnsTimeoutMs || 5_000);
  } catch {
    throw new Error('电脑研究无法验证该网站的公网地址');
  }
  if (!addresses.length || addresses.some(row => !isPublicIpAddress(row.address))) {
    throw new Error('电脑研究不能访问解析到私有或保留地址的网站');
  }
  const selected = addresses[0];
  return { url, hostname, address: selected.address, family: selected.family || isIP(selected.address) };
}

function lookupWithDeadline(resolver, hostname, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('电脑研究已取消')); return; }
    let timer;
    let settled = false;
    const finish = (complete, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      complete(value);
    };
    const onAbort = () => finish(reject, signal.reason || new Error('电脑研究已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(reject, new Error('DNS validation timed out')), timeoutMs);
    Promise.resolve().then(() => resolver(hostname, { all: true, verbatim: true }))
      .then(value => finish(resolve, value), error => finish(reject, error));
  });
}

/** Fetch public HTML with DNS pinning and manually revalidated redirects. */
export async function fetchPublicPageHtml(value, options = {}) {
  let current = value;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (options.signal?.aborted) throw options.signal.reason || new Error('电脑研究已取消');
    const resolved = await resolvePublicHttpsUrl(current, options);
    if (resolved.fixture) throw new Error('测试网页必须由受控浏览器 fixture 提供');
    const requestPage = options.request || requestPinned;
    const response = await requestPage(resolved, options.signal, options.timeoutMs || 12_000);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) throw new Error('电脑研究遇到没有目标地址的网页跳转');
      if (redirectCount === maxRedirects) throw new Error('电脑研究网页跳转次数过多');
      current = new URL(location, resolved.url).href;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`电脑研究网页返回 HTTP ${response.status}`);
    if (response.body.length > maxHtmlBytes) throw new Error('电脑研究网页超过 3 MB 限制');
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (!/^text\/(?:html|plain)(?:\s*;|$)|^application\/xhtml\+xml(?:\s*;|$)/.test(contentType)) {
      throw new Error('电脑研究当前只读取 HTML 或纯文本网页');
    }
    const html = contentType.startsWith('text/plain')
      ? `<pre>${escapeHtml(response.body.toString('utf8'))}</pre>`
      : response.body.toString('utf8');
    return { url: resolved.url.href, html: sanitizePublicHtml(html) };
  }
  throw new Error('电脑研究无法打开该网页');
}

/** Keep readable markup while removing active content and all network-capable attributes. */
export function sanitizePublicHtml(html) {
  const document = parse(String(html).slice(0, maxHtmlBytes));
  const strip = node => {
    if (!Array.isArray(node.childNodes)) return;
    node.childNodes = node.childNodes.filter(child => !removableTags.has(child.tagName));
    for (const child of node.childNodes) {
      if (Array.isArray(child.attrs)) {
        child.attrs = child.attrs.filter(attribute => safeAttributes.has(attribute.name) || attribute.name.startsWith('aria-'));
      }
      strip(child);
    }
  };
  strip(document);
  return serialize(document);
}

export function isPublicIpAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    const blocked = a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224;
    return !blocked;
  }
  if (family !== 6) return false;
  const groups = expandIpv6(address);
  if (!groups) return false;
  const mapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    const high = groups[6] >> 8; const low = groups[6] & 255;
    const high2 = groups[7] >> 8; const low2 = groups[7] & 255;
    return isPublicIpAddress(`${high}.${low}.${high2}.${low2}`);
  }
  const globallyRoutableUnicast = (groups[0] & 0xe000) === 0x2000;
  const special2001Block = groups[0] === 0x2001 && (groups[1] < 0x0200 || groups[1] === 0x0db8);
  const sixToFour = groups[0] === 0x2002;
  return globallyRoutableUnicast && !special2001Block && !sixToFour;
}

function requestPinned(resolved, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const hostname = resolved.hostname;
    const options = {
      protocol: 'https:', hostname: resolved.address, family: resolved.family, port: 443,
      path: `${resolved.url.pathname}${resolved.url.search}`,
      method: 'GET', agent: false,
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'accept-encoding': 'identity', host: resolved.url.host, 'user-agent': 'Coke-Dots-public-research/1.0' },
      ...(isIP(hostname) ? {} : { servername: hostname }),
    };
    const request = https.request(options, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        resolve({ status, headers: response.headers, body: Buffer.alloc(0) });
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxHtmlBytes) {
          request.destroy(new Error('电脑研究网页超过 3 MB 限制'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('电脑研究网页响应超时')));
    const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error('电脑研究已取消'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    request.once('error', reject);
    request.once('close', () => signal?.removeEventListener('abort', abort));
    request.end();
  });
}

function normalizeHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function expandIpv6(value) {
  let address = value.toLowerCase().split('%')[0];
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const ipv4 = address.slice(lastColon + 1).split('.').map(Number);
    if (ipv4.length !== 4 || ipv4.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    address = `${address.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map(group => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}
