import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { isAllowedOrigin, isLocalRequest, type RequestBoundaryConfig } from '../src/server/request-boundary.ts';

const config: RequestBoundaryConfig = {
  port: 4317,
  publicOrigin: 'https://codex.cokeagent.com',
  publicHost: 'codex.cokeagent.com',
  trustedProxyToken: 'proxy-secret-for-test-only',
};

function request({
  remoteAddress = '127.0.0.1',
  host = '127.0.0.1:4317',
  origin,
  proxyToken,
  method = 'GET',
  url = '/',
}: {
  remoteAddress?: string;
  host?: string;
  origin?: string;
  proxyToken?: string;
  method?: string;
  url?: string;
} = {}) {
  const headers: Record<string, string> = { host };
  if (origin !== undefined) headers.origin = origin;
  if (proxyToken !== undefined) headers['x-dots-proxy-token'] = proxyToken;
  return {
    socket: { remoteAddress },
    headers,
    method,
    url,
  } as unknown as IncomingMessage;
}

test('allows direct loopback requests and local browser origins', () => {
  assert.equal(isLocalRequest(request(), '/', config), true);
  assert.equal(isLocalRequest(request({ host: 'localhost:5173', origin: 'http://localhost:5173' }), '/', config), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:4317', config), true);
});

test('allows the configured public domain only through loopback with the proxy token', () => {
  const publicRequest = request({
    host: 'codex.cokeagent.com',
    origin: 'https://codex.cokeagent.com',
    proxyToken: config.trustedProxyToken,
  });
  assert.equal(isLocalRequest(publicRequest, '/', config), true);
  assert.equal(isAllowedOrigin('https://codex.cokeagent.com', config), true);
});

test('rejects public-host requests with a missing or incorrect proxy token', () => {
  assert.equal(isLocalRequest(request({ host: 'codex.cokeagent.com' }), '/', config), false);
  assert.equal(isLocalRequest(request({ host: 'codex.cokeagent.com', proxyToken: 'wrong' }), '/', config), false);
});

test('does not trust the proxy header from non-loopback peers or on another host', () => {
  assert.equal(isLocalRequest(request({ remoteAddress: '203.0.113.8', host: 'codex.cokeagent.com', proxyToken: config.trustedProxyToken }), '/', config), false);
  assert.equal(isLocalRequest(request({ host: 'evil.example', proxyToken: config.trustedProxyToken }), '/', config), false);
});

test('restricts browser origins to the configured public origin and local dev ports', () => {
  assert.equal(isAllowedOrigin('https://evil.example', config), false);
  assert.equal(isAllowedOrigin('https://codex.cokeagent.com.attacker.example', config), false);
  assert.equal(isAllowedOrigin('https://codex.cokeagent.com/path', config), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:9999', config), false);
  assert.equal(isLocalRequest(request({ host: 'codex.cokeagent.com', proxyToken: config.trustedProxyToken, origin: 'https://evil.example' }), '/', config), false);
});

test('keeps OAuth callback exceptions behind the trusted public proxy boundary', () => {
  assert.equal(isLocalRequest(request({
    host: 'codex.cokeagent.com',
    proxyToken: config.trustedProxyToken,
    origin: 'https://accounts.google.com',
    method: 'GET',
    url: '/auth/google/callback',
  }), '/auth/google/callback', config), true);
  assert.equal(isLocalRequest(request({
    host: 'codex.cokeagent.com',
    origin: 'https://accounts.google.com',
    method: 'GET',
    url: '/auth/google/callback',
  }), '/auth/google/callback', config), false);
});
