import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { test } from 'node:test';
import { LocalDesktopProxyBridge, resolveDesktopProxyConfig } from '../src/server/local-desktop-proxy-bridge.ts';

test('Mac desktop proxy bridge is opt-in and accepts only the fixed loopback route', () => {
  assert.equal(resolveDesktopProxyConfig({}), null);
  const env = {
    DOTS_LINUX_DESKTOP_PROXY_BRIDGE: '1',
    DOTS_LINUX_DESKTOP_PROXY_UPSTREAM_HOST: '127.0.0.1',
    DOTS_LINUX_DESKTOP_PROXY_UPSTREAM_PORT: '7890',
    COKE_DESKTOP_PROXY_SERVER: 'http://host.docker.internal:17891',
  };
  assert.deepEqual(resolveDesktopProxyConfig(env), {
    serverUrl: 'http://host.docker.internal:17891', upstreamHost: '127.0.0.1', upstreamPort: 7890,
  });
  assert.throws(() => resolveDesktopProxyConfig({ ...env, COKE_DESKTOP_PROXY_SERVER: 'http://0.0.0.0:7890' }), /fixed|must be/i);
  assert.throws(() => resolveDesktopProxyConfig({ ...env, DOTS_LINUX_DESKTOP_PROXY_UPSTREAM_HOST: '192.168.1.10' }), /loopback/i);
});

test('Mac desktop proxy bridge relays bytes without exposing a non-loopback listener', async () => {
  const upstream = createServer(socket => socket.pipe(socket));
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const address = upstream.address();
  assert(address && typeof address !== 'string');
  const bridge = new LocalDesktopProxyBridge(() => ({
    serverUrl: 'http://host.docker.internal:17891', upstreamHost: '127.0.0.1', upstreamPort: address.port,
  }), 0);
  try {
    await bridge.start();
    assert(bridge.port && bridge.port > 0);
    const response = await new Promise<string>((resolve, reject) => {
      const client = connect(bridge.port!, '127.0.0.1');
      client.setTimeout(2000);
      let received = '';
      client.on('connect', () => client.write('CONNECT example.test:443\r\n\r\n'));
      client.on('data', chunk => {
        received += chunk.toString();
        if (received.includes('\r\n\r\n')) { client.end(); resolve(received); }
      });
      client.once('timeout', () => { client.destroy(); reject(new Error('proxy bridge echo timed out')); });
      client.once('error', reject);
    });
    assert.equal(response, 'CONNECT example.test:443\r\n\r\n');
  } finally {
    await bridge.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
