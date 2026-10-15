import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface RequestBoundaryConfig {
  port: number;
  publicOrigin?: string;
  publicHost?: string;
  trustedProxyToken?: string;
}

const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLocalRequest(req: IncomingMessage, path: string, config: RequestBoundaryConfig) {
  const remote = req.socket.remoteAddress || '';
  const hostname = requestHostname(req.headers.host);
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const localHost = hostname === '127.0.0.1' || hostname === 'localhost';
  const publicHost = configuredPublicHost(config);
  const presentedToken = req.headers['x-dots-proxy-token'];
  const trustedProxy = typeof presentedToken === 'string'
    && constantTimeEqual(presentedToken, config.trustedProxyToken || '');
  const forwardedPublicHost = Boolean(publicHost && trustedProxy && hostname === publicHost);
  const oauthCallback = req.method === 'GET' && path === '/auth/google/callback' && origin === 'https://accounts.google.com';
  const slackCallback = req.method === 'GET' && path === '/auth/slack/callback'
    && ['https://slack.com', 'https://slack-gov.com'].includes(origin);
  const sandboxArtifactPreview = req.method === 'GET' && path.startsWith('/api/artifact-preview/');
  const allowedOrigin = !origin || isAllowedOrigin(origin, config) || oauthCallback || slackCallback
    || (sandboxArtifactPreview && origin === 'null');

  return loopbackAddresses.has(remote) && (localHost || forwardedPublicHost) && allowedOrigin;
}

export function isAllowedOrigin(value: string, config: RequestBoundaryConfig) {
  try {
    const origin = new URL(value);
    if (origin.origin !== value) return false;
    const allowedPorts = new Set(['5173', String(config.port)]);
    const localOrigin = origin.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(origin.hostname)
      && allowedPorts.has(origin.port);
    const publicOrigin = canonicalPublicOrigin(config.publicOrigin);
    return localOrigin || Boolean(publicOrigin && origin.origin === publicOrigin);
  } catch {
    return false;
  }
}

function requestHostname(value: string | undefined) {
  if (!value) return '';
  try { return new URL(`http://${value}`).hostname.toLowerCase(); }
  catch { return ''; }
}

function configuredPublicHost(config: RequestBoundaryConfig) {
  const host = config.publicHost?.trim().toLowerCase();
  if (host) return host;
  try { return new URL(config.publicOrigin || '').hostname.toLowerCase(); }
  catch { return ''; }
}

function canonicalPublicOrigin(value: string | undefined) {
  if (!value) return '';
  try {
    const origin = new URL(value.trim());
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash) return '';
    return origin.origin;
  } catch {
    return '';
  }
}

function constantTimeEqual(left: string, right: string) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
