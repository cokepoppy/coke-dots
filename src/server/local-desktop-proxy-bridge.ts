import { connect, createServer, type Server, type Socket } from 'node:net';

export interface DesktopProxyConfig {
  serverUrl: 'http://host.docker.internal:17891';
  upstreamHost: '127.0.0.1';
  upstreamPort: number;
}

/**
 * A loopback-only TCP relay from a tenant desktop to the Mac's existing local
 * HTTP proxy. Docker Desktop exposes the Mac loopback listener as
 * host.docker.internal; tenant NetworkPolicy further limits access to this
 * one host address and port.
 */
export class LocalDesktopProxyBridge {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly configProvider: () => DesktopProxyConfig | null = () => resolveDesktopProxyConfig(),
    private readonly listenPort = 17891,
  ) {}

  get port() {
    const address = this.server?.address();
    return address && typeof address !== 'string' ? address.port : null;
  }

  async start() {
    const config = this.configProvider();
    if (!config || this.server?.listening) return;
    if (this.starting) return this.starting;
    this.starting = this.listen(config).finally(() => { this.starting = null; });
    return this.starting;
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async listen(config: DesktopProxyConfig) {
    await assertTcpReachable(config.upstreamHost, config.upstreamPort);
    const server = createServer(client => {
      if (!isLoopbackAddress(client.remoteAddress)) { client.destroy(); return; }
      this.sockets.add(client);
      client.once('close', () => this.sockets.delete(client));
      const upstream = connect(config.upstreamPort, config.upstreamHost);
      this.sockets.add(upstream);
      upstream.once('close', () => this.sockets.delete(upstream));
      client.once('error', () => upstream.destroy());
      upstream.once('error', () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.listenPort, '127.0.0.1');
    });
    this.server = server;
  }
}

export function resolveDesktopProxyConfig(env: NodeJS.ProcessEnv = process.env): DesktopProxyConfig | null {
  if (env.DOTS_LINUX_DESKTOP_PROXY_BRIDGE !== '1') return null;
  const serverUrl = env.COKE_DESKTOP_PROXY_SERVER?.trim() || '';
  if (serverUrl !== 'http://host.docker.internal:17891') {
    throw new Error('COKE_DESKTOP_PROXY_SERVER must be http://host.docker.internal:17891 when the Mac desktop proxy bridge is enabled');
  }
  const upstreamHost = env.DOTS_LINUX_DESKTOP_PROXY_UPSTREAM_HOST?.trim() || '127.0.0.1';
  const upstreamPort = Number(env.DOTS_LINUX_DESKTOP_PROXY_UPSTREAM_PORT || '7890');
  if (upstreamHost !== '127.0.0.1' || !Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw new Error('The Mac desktop proxy bridge upstream must be a local loopback TCP endpoint');
  }
  return { serverUrl: 'http://host.docker.internal:17891', upstreamHost: '127.0.0.1', upstreamPort };
}

function isLoopbackAddress(address: string | undefined) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function assertTcpReachable(host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    const socket = connect(port, host);
    const timer = setTimeout(() => socket.destroy(new Error('timeout')), 1500);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(new Error(`Mac HTTP proxy ${host}:${port} is unavailable: ${error.message}`)); });
  });
}
