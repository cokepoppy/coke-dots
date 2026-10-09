import { createHmac, createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { ComputerRuntime, ComputerState } from './computer.ts';
import { validatePublicHttpsUrl } from '../shared/public-web-policy.mjs';

const workerPort = 8082;
const vncPort = 6080;

export interface DesktopConnection {
  workerUrl: URL;
  novncUrl: URL;
  agentUrl: URL;
  workerToken: string;
  agentToken: string;
}

const supportedAgentEngines = new Set(['pi', 'dsh']);

/** The cloud desktop image ships these kernels unless an operator narrows the list. */
export function configuredDesktopAgentEngines(): ('pi' | 'dsh')[] {
  if (process.env.DOTS_COMPUTER_BACKEND !== 'linux-desktop') return [];
  let names = process.env.DOTS_DESKTOP_AGENT_ADAPTERS?.trim();
  if (!names && process.env.DOTS_AGENT_KERNELS_JSON?.trim()) {
    try { names = Object.keys(JSON.parse(process.env.DOTS_AGENT_KERNELS_JSON) as Record<string, unknown>).join(','); }
    catch { return []; }
  }
  return [...new Set((names || 'pi,dsh').split(',').map(name => name.trim()).filter((name): name is 'pi' | 'dsh' => supportedAgentEngines.has(name)))];
}

export interface DesktopConnector {
  connect(tenantId: string): Promise<DesktopConnection>;
  close?(): Promise<void>;
  reset?(tenantId: string): Promise<void>;
}

/**
 * K3D/Kubernetes backed desktop. Each workspace receives its own namespace,
 * Secret, Deployment, Service and PVC. Browser and agent commands stay behind
 * the authenticated Coke Dots API; only the browser view is proxied to users.
 */
export class LinuxDesktopComputer implements ComputerRuntime {
  private connection: DesktopConnection | null = null;
  private connecting: Promise<DesktopConnection> | null = null;
  private resetting: Promise<void> | null = null;
  private owner: 'agent' | 'user' = 'agent';

  constructor(private readonly tenantId: string, private readonly connector: DesktopConnector = defaultDesktopConnector()) {}

  async open(dotName = 'Dot') {
    await this.ensureConnection();
    await this.command({ action: 'open', dotName });
    this.owner = 'agent';
    await this.setRemoteOwner('agent');
    return this.state();
  }

  async state(): Promise<ComputerState> {
    await this.ensureConnection();
    const response = await this.request('/v1/state');
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(failure.error || `Linux 云电脑状态查询失败（HTTP ${response.status}）`);
    }
    const remote = await response.json() as { ready?: boolean; url?: string; title?: string; owner?: 'agent' | 'user' };
    return { ready: remote.ready === true, owner: remote.owner === 'user' ? 'user' : this.owner, url: remote.url || '', title: remote.title || '', backend: 'linux-desktop', width: 1440, height: 1080 };
  }

  async takeOver() {
    this.assertOpen();
    await this.setRemoteOwner('user');
    this.owner = 'user';
  }

  async returnControl() {
    this.assertOpen();
    await this.setRemoteOwner('agent');
    this.owner = 'agent';
  }

  async fillWebsiteSignIn(value: string, identifier: string, password: string) {
    this.assertOpen();
    const url = await validatePublicHttpsUrl(value);
    const parsed = new URL(url);
    if (parsed.search || parsed.hash) throw new Error('登录地址包含查询参数或锚点，请接管电脑并手动登录');
    if (!identifier.trim() || identifier.length > 320 || /[\u0000-\u001f\u007f]/.test(identifier)) throw new Error('账号或邮箱格式无效');
    if (!password || password.length > 4096 || password.includes('\0')) throw new Error('密码格式无效');
    const response = await this.request('/v1/commands/private-sign-in', {
      method: 'POST', body: JSON.stringify({ url, identifier: identifier.trim(), password }),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(result.error || `Linux 云电脑私密登录失败（HTTP ${response.status}）`);
    this.owner = 'user';
    return this.state();
  }

  async navigate(url: string) {
    this.assertUserControl();
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('只允许不含凭据的 HTTP 或 HTTPS 网址');
    await this.command({ action: 'navigate', url: parsed.toString(), actor: 'user' });
    return this.state();
  }

  async click(x: number, y: number) {
    this.assertUserControl();
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1440 || y > 1080) throw new Error('点击坐标超出画面');
    await this.command({ action: 'click', x, y, actor: 'user' });
    return this.state();
  }

  async type(text: string) {
    this.assertUserControl();
    if (text.length > 2000) throw new Error('输入内容过长');
    await this.command({ action: 'type', text, actor: 'user' });
    return this.state();
  }

  async press(key: string) {
    this.assertUserControl();
    const allowed = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space']);
    if (!allowed.has(key)) throw new Error('不支持此电脑按键');
    await this.command({ action: 'press', key, actor: 'user' });
    return this.state();
  }

  async screenshot(): Promise<Buffer> {
    this.assertOpen();
    const response = await this.request('/v1/screenshot');
    if (!response.ok) throw new Error(`Linux 云电脑截图失败（HTTP ${response.status}）`);
    return Buffer.from(await response.arrayBuffer());
  }

  async openPublicPageForAgent(value: string, signal?: AbortSignal) {
    this.assertOpen();
    const control = await this.request('/v1/control');
    if (!control.ok || (await control.json() as { owner?: string }).owner !== 'agent') throw new Error('电脑目前由你控制；交还电脑后，Agent 才能继续浏览。');
    const url = await validatePublicHttpsUrl(value, { signal });
    const response = await this.request('/v1/research/open-public-page', {
      method: 'POST', body: JSON.stringify({ url }), ...(signal ? { signal } : {}),
    });
    const result = await response.json().catch(() => ({})) as { error?: string; url?: string; title?: string; text?: string };
    if (!response.ok) throw new Error(result.error || `Linux 云电脑网页研究失败（HTTP ${response.status}）`);
    if (typeof result.url !== 'string' || typeof result.title !== 'string' || typeof result.text !== 'string') throw new Error('Linux 云电脑返回了无效网页研究结果');
    return { url: result.url.slice(0, 2048), title: result.title.slice(0, 300), text: result.text.slice(0, 12_000) };
  }

  async novncTarget(): Promise<URL | null> {
    return this.connection ? this.connection.novncUrl : null;
  }

  async runAgentTask(input: { engine: string; taskId: string; executionId?: string; prompt: string; sessionId: string | null; modelConfig?: { apiKey: string; baseUrl: string; model: string }; signal?: AbortSignal }) {
    await this.ensureConnection();
    const owner = await this.request('/v1/control');
    if (!owner.ok || (await owner.json() as { owner?: string }).owner !== 'agent') throw new Error('用户正在接管这台电脑，Agent 已暂停');
    if (input.signal?.aborted) throw input.signal.reason || new Error('Agent task was cancelled');
    const url = endpointUrl(this.connection!.agentUrl, 'v1/tasks/run');
    const requestAbort = new AbortController();
    let cancelRequested = false;
    const cancelRemoteTask = async () => {
      if (cancelRequested) return;
      cancelRequested = true;
      const reason = String((input.signal?.reason as Error | undefined)?.message || input.signal?.reason || '');
      const action = /paus/i.test(reason) ? 'pause' : 'stop';
      await fetch(endpointUrl(this.connection!.agentUrl, `v1/tasks/${action}`), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.connection!.agentToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: input.taskId }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
      requestAbort.abort(input.signal?.reason);
    };
    const onAbort = () => { void cancelRemoteTask(); };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.connection!.agentToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ engine: input.engine, taskId: input.taskId, executionId: input.executionId || input.taskId, prompt: input.prompt, sessionId: input.sessionId, cwd: `tasks/${input.taskId}`, ...(input.modelConfig ? { modelConfig: input.modelConfig } : {}) }),
        signal: AbortSignal.any([AbortSignal.timeout(15 * 60_000), requestAbort.signal]),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; status?: string; message?: string; nextMinutes?: number; sessionId?: string; pageAction?: unknown; delegations?: unknown[]; websiteSignInRequest?: { url: string; reason: string } };
      if (!response.ok) throw new Error(result.error || `Linux Agent 运行时返回 HTTP ${response.status}`);
      if (typeof result.status !== 'string' || typeof result.message !== 'string') throw new Error('Linux Agent 运行时返回了无效结果');
      return { status: result.status, message: result.message, ...(result.nextMinutes === undefined ? {} : { nextMinutes: result.nextMinutes }), ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }), ...(result.pageAction === undefined ? {} : { pageAction: result.pageAction }), ...(result.delegations === undefined ? {} : { delegations: result.delegations }), ...(result.websiteSignInRequest === undefined ? {} : { websiteSignInRequest: result.websiteSignInRequest }) };
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  async close() {
    this.owner = 'agent';
    await this.connecting?.catch(() => undefined);
    await this.resetting?.catch(() => undefined);
    this.connection = null;
    await this.connector.close?.();
  }

  async reset() {
    await this.close();
    await this.connector.reset?.(this.tenantId);
  }

  private async setRemoteOwner(owner: 'agent' | 'user') {
    const response = await this.request('/v1/control', { method: 'POST', body: JSON.stringify({ owner }) });
    if (!response.ok) throw new Error(`Linux 云电脑交接失败（HTTP ${response.status}）`);
  }

  private async command(body: Record<string, unknown>) {
    const response = await this.request('/v1/commands', { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(error.error || `Linux 云电脑命令失败（HTTP ${response.status}）`);
    }
  }

  private async request(path: string, init: RequestInit = {}) {
    const connection = this.connection;
    if (!connection) throw new Error('电脑尚未打开');
    const method = (init.method || 'GET').toUpperCase();
    const send = (target: DesktopConnection) => {
      const timeout = AbortSignal.timeout(30_000);
      return fetch(endpointUrl(target.workerUrl, path), {
        ...init,
        headers: { authorization: `Bearer ${target.workerToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
        signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
      });
    };

    try {
      return await send(connection);
    } catch (error) {
      if (!isDesktopTransportFailure(error)) throw error;
      await this.invalidateConnection(connection);
      // Reads are safe to retry after rebuilding a dead kubectl port-forward.
      // Commands and private sign-in may already have reached the desktop, so
      // surface their transport failure without replaying them.
      if (method !== 'GET') throw error;

      const reconnected = await this.ensureConnection();
      try {
        return await send(reconnected);
      } catch (retryError) {
        if (isDesktopTransportFailure(retryError)) await this.invalidateConnection(reconnected);
        throw retryError;
      }
    }
  }

  private assertOpen() { if (!this.connection) throw new Error('电脑尚未打开'); }
  private assertUserControl() { this.assertOpen(); if (this.owner !== 'user') throw new Error('请先选择“接管”以使用鼠标和键盘'); }

  private async ensureConnection() {
    if (this.connection) return this.connection;
    await this.resetting?.catch(() => undefined);
    if (this.connection) return this.connection;
    if (!this.connecting) {
      const connecting = this.connector.connect(this.tenantId).then(connection => {
        this.connection = connection;
        return connection;
      }).finally(() => {
        if (this.connecting === connecting) this.connecting = null;
      });
      this.connecting = connecting;
    }
    return this.connecting;
  }

  private async invalidateConnection(connection: DesktopConnection) {
    if (this.connection !== connection) return;
    this.connection = null;
    const resetting = Promise.resolve(this.connector.close?.()).then(() => undefined, () => undefined);
    this.resetting = resetting;
    try {
      await resetting;
    } finally {
      if (this.resetting === resetting) this.resetting = null;
    }
  }
}

function isDesktopTransportFailure(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'fetch failed';
}

function endpointUrl(baseValue: URL, path: string) {
  const base = new URL(baseValue);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL(path.replace(/^\/+/, ''), base);
}

function defaultDesktopConnector(): DesktopConnector {
  if (process.env.NODE_ENV === 'test' && process.env.DOTS_LINUX_DESKTOP_TEST_WORKER_URL && process.env.DOTS_LINUX_DESKTOP_TEST_NOVNC_URL && process.env.DOTS_LINUX_DESKTOP_TEST_AGENT_URL) {
    const signingKey = process.env.DOTS_LINUX_DESKTOP_TOKEN_SECRET || 'coke-dots-test-desktop-signing-key';
    return {
      async connect(tenantId) {
        const workerToken = createHmac('sha256', signingKey).update(`worker:${tenantId}`).digest('base64url');
        const workerUrl = new URL(process.env.DOTS_LINUX_DESKTOP_TEST_WORKER_URL!.replaceAll('{tenantHash}', desktopResourceIdentity(tenantId).tenantHash));
        const novncUrl = new URL(process.env.DOTS_LINUX_DESKTOP_TEST_NOVNC_URL!.replaceAll('{tenantHash}', desktopResourceIdentity(tenantId).tenantHash));
        if (!workerUrl.pathname.endsWith('/')) workerUrl.pathname += '/';
        if (!novncUrl.pathname.endsWith('/')) novncUrl.pathname += '/';
        const agentUrl = new URL(process.env.DOTS_LINUX_DESKTOP_TEST_AGENT_URL!.replaceAll('{tenantHash}', desktopResourceIdentity(tenantId).tenantHash));
        if (!agentUrl.pathname.endsWith('/')) agentUrl.pathname += '/';
        const agentToken = createHmac('sha256', signingKey).update(`agent:${tenantId}`).digest('base64url');
        return { workerUrl, novncUrl, agentUrl, workerToken, agentToken };
      },
    };
  }
  return new KubectlDesktopConnector();
}

export function desktopResourceIdentity(tenantId: string) {
  const suffix = createHash('sha256').update(tenantId).digest('hex').slice(0, 10);
  const tenantHash = createHash('sha256').update(tenantId).digest('hex').slice(0, 32);
  const slug = tenantId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'workspace';
  const namespace = `dots-coke-dots-${slug}-${suffix}`.slice(0, 63).replace(/-+$/g, '');
  return { namespace, tenantHash };
}

export function isPinnedDesktopImageReference(reference: string) {
  const value = reference.trim();
  if (!value || /\s/.test(value)) return false;
  const digestSeparator = value.lastIndexOf('@');
  if (digestSeparator >= 0) {
    const imageName = value.slice(0, digestSeparator);
    return Boolean(imageName) && /^sha256:[a-f0-9]{64}$/i.test(value.slice(digestSeparator + 1));
  }
  const lastSlash = value.lastIndexOf('/');
  const lastColon = value.lastIndexOf(':');
  const tag = lastColon > lastSlash ? value.slice(lastColon + 1) : '';
  return /^sha-[a-f0-9]{40}$/i.test(tag);
}

export function configuredDesktopImage(environment = process.env.NODE_ENV, configured = process.env.DOTS_LINUX_DESKTOP_IMAGE) {
  const image = configured?.trim() || 'coke-dots-linux-desktop:dev';
  if (environment === 'production' && !isPinnedDesktopImageReference(image)) {
    throw new Error('生产环境的 Linux 云电脑必须配置固定镜像摘要，或使用 coke-dots-linux-desktop:sha-<40位Git提交>');
  }
  return image;
}

export function desktopResources(tenantId: string, workerToken: string, agentToken: string) {
  const identity = desktopResourceIdentity(tenantId);
  const namespace = identity.namespace;
  const name = 'desktop';
  const image = configuredDesktopImage();
  const pullPolicy = process.env.DOTS_LINUX_DESKTOP_IMAGE_PULL_POLICY || 'IfNotPresent';
  const imageAnnotations = { 'coke-dots.io/desktop-image': image };
  const volumeSize = process.env.DOTS_LINUX_DESKTOP_VOLUME_SIZE || '10Gi';
  const controlNamespace = process.env.DOTS_LINUX_DESKTOP_CONTROL_NAMESPACE || 'coke-dots';
  let kernels: Record<string, { command: string; args: string[] }> = {};
  let kernelNames: string[] = [];
  try {
    const value = JSON.parse(process.env.DOTS_AGENT_KERNELS_JSON || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DOTS_AGENT_KERNELS_JSON must be an object');
    kernels = value;
    kernelNames = Object.keys(kernels);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'DOTS_AGENT_KERNELS_JSON is invalid');
  }
  const requestedAgentEngines = (process.env.DOTS_DESKTOP_AGENT_ADAPTERS || kernelNames.join(',') || 'pi,dsh')
    .split(',').map(value => value.trim()).filter(Boolean);
  const unsupportedAgentEngine = [...kernelNames, ...requestedAgentEngines].find(engine => !supportedAgentEngines.has(engine));
  if (unsupportedAgentEngine) throw new Error(`Linux 云端 Agent 暂只支持 Pi 和 DeepSeek Harness；不支持内核：${unsupportedAgentEngine}`);
  const agentEngines = [...new Set(requestedAgentEngines)].join(',');
  const builtInAdapter = { command: 'node', args: ['/opt/coke-dots/cloud-kernel-adapter.mjs'] };
  const kernelAdapters = Object.fromEntries(agentEngines.split(',').filter(Boolean).map(engine => [engine, kernels[engine] || builtInAdapter]));
  const objects: Record<string, unknown>[] = [
    {
      apiVersion: 'v1', kind: 'Secret', metadata: { name: 'desktop-runtime', namespace }, type: 'Opaque',
      stringData: { LINUX_DESKTOP_WORKER_TOKEN: workerToken, DOTS_AGENT_RUNTIME_TOKEN: agentToken },
    },
    {
      apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'desktop-data', namespace },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: volumeSize } }, ...(process.env.DOTS_LINUX_DESKTOP_STORAGE_CLASS ? { storageClassName: process.env.DOTS_LINUX_DESKTOP_STORAGE_CLASS } : {}) },
    },
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'desktop-isolation', namespace },
      spec: {
        podSelector: { matchLabels: { app: name } }, policyTypes: ['Ingress', 'Egress'],
        ingress: [{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': controlNamespace } } }], ports: [{ protocol: 'TCP', port: 6080 }, { protocol: 'TCP', port: 8082 }, { protocol: 'TCP', port: 8083 }] }],
        egress: [
          { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
          { ports: [{ protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 443 }] },
        ],
      },
    },
    {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace, labels: { app: name, 'coke-dots.io/tenant-hash': identity.tenantHash }, annotations: imageAnnotations },
      spec: {
        replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name, 'coke-dots.io/tenant-hash': identity.tenantHash }, annotations: imageAnnotations },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name, image, imagePullPolicy: pullPolicy,
                env: [
                  { name: 'LINUX_DESKTOP_WORKER_TOKEN', valueFrom: { secretKeyRef: { name: 'desktop-runtime', key: 'LINUX_DESKTOP_WORKER_TOKEN' } } },
                  ...(process.env.NODE_ENV === 'test' && process.env.DOTS_E2E_AUTH === '1' && process.env.DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL ? [
                    { name: 'NODE_ENV', value: 'test' },
                    { name: 'DOTS_E2E_AUTH', value: '1' },
                    { name: 'DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL', value: process.env.DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL },
                  ] : []),
                  { name: 'COKE_DESKTOP_RESOLUTION', value: '1440x1080' },
                  { name: 'COKE_DESKTOP_VNC_AUTH_MODE', value: 'gateway' },
                  { name: 'COKE_DESKTOP_CHROME_NO_SANDBOX', value: process.env.DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX === '1' ? '1' : '0' },
                ],
                ports: [{ name: 'novnc', containerPort: 6080 }, { name: 'worker', containerPort: 8082 }, { name: 'cdp', containerPort: 9222 }],
                startupProbe: { httpGet: { path: '/healthz', port: 'worker' }, periodSeconds: 5, timeoutSeconds: 5, failureThreshold: 36 },
                readinessProbe: { httpGet: { path: '/readyz', port: 'worker' }, periodSeconds: 5, timeoutSeconds: 5, failureThreshold: 2 },
                livenessProbe: { httpGet: { path: '/healthz', port: 'worker' }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 3 },
                resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '4Gi' } },
                securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, allowPrivilegeEscalation: false, readOnlyRootFilesystem: false, capabilities: { drop: ['ALL'] } },
                volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }, { name: 'shm', mountPath: '/dev/shm' }, { name: 'tmp', mountPath: '/tmp' }],
              },
              {
                name: 'agent-runtime', image, imagePullPolicy: pullPolicy,
                command: ['/usr/bin/tini', '--', 'node', '/opt/coke-dots/agent-runtime.mjs'],
                env: [
                  { name: 'DOTS_AGENT_RUNTIME_TOKEN', valueFrom: { secretKeyRef: { name: 'desktop-runtime', key: 'DOTS_AGENT_RUNTIME_TOKEN' } } },
                  { name: 'LINUX_DESKTOP_WORKER_TOKEN', valueFrom: { secretKeyRef: { name: 'desktop-runtime', key: 'LINUX_DESKTOP_WORKER_TOKEN' } } },
                  { name: 'DOTS_AGENT_RUNTIME_PORT', value: '8083' },
                  { name: 'LINUX_DESKTOP_WORKER_PORT', value: '8082' },
                  { name: 'DOTS_AGENT_WORKSPACE', value: '/workspace' },
                  { name: 'TMPDIR', value: '/tmp' },
                  { name: 'HOME', value: '/tmp' },
                  { name: 'XDG_CONFIG_HOME', value: '/tmp/.config' },
                  { name: 'XDG_CACHE_HOME', value: '/tmp/.cache' },
                  { name: 'XDG_DATA_HOME', value: '/tmp/.local/share' },
                  { name: 'DOTS_DESKTOP_AGENT_ADAPTERS', value: agentEngines },
                  { name: 'DOTS_AGENT_KERNELS_JSON', value: JSON.stringify(kernelAdapters) },
                  { name: 'DOTS_DSH_BIN', value: process.env.DOTS_CLOUD_DSH_BIN || '/usr/local/bin/dsh' },
                  { name: 'DOTS_DSH_PROFILE', value: process.env.DOTS_CLOUD_DSH_PROFILE || 'sdk' },
                  ...(process.env.NODE_ENV === 'test' && process.env.DOTS_E2E_AUTH === '1' && process.env.DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL ? [
                    { name: 'NODE_ENV', value: 'test' },
                    { name: 'DOTS_E2E_AUTH', value: '1' },
                    { name: 'DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL', value: process.env.DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL },
                  ] : []),
                ],
                ports: [{ name: 'agent', containerPort: 8083 }],
                readinessProbe: { httpGet: { path: '/healthz', port: 'agent' }, initialDelaySeconds: 5, periodSeconds: 5, failureThreshold: 36 },
                livenessProbe: { httpGet: { path: '/healthz', port: 'agent' }, initialDelaySeconds: 15, periodSeconds: 10 },
                resources: { requests: { cpu: '250m', memory: '384Mi' }, limits: { cpu: '2', memory: '2Gi' } },
                securityContext: { runAsNonRoot: true, runAsUser: 1001, runAsGroup: 1000, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
                volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }, { name: 'agent-tmp', mountPath: '/tmp' }],
              },
            ],
            volumes: [
              { name: 'workspace', persistentVolumeClaim: { claimName: 'desktop-data' } },
              { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
              { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
              { name: 'agent-tmp', emptyDir: { sizeLimit: '512Mi' } },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1', kind: 'Service', metadata: { name, namespace },
      spec: { type: 'ClusterIP', selector: { app: name }, ports: [{ name: 'novnc', port: 6080, targetPort: 'novnc' }, { name: 'worker', port: workerPort, targetPort: 'worker' }, { name: 'agent', port: 8083, targetPort: 'agent' }] },
    },
  ];
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { 'coke-dots.io/managed-by': 'coke-dots', 'coke-dots.io/tenant-hash': identity.tenantHash } } },
    { apiVersion: 'v1', kind: 'List', items: objects },
  ];
}

class KubectlDesktopConnector implements DesktopConnector {
  private portForward: ChildProcess | null = null;
  private current: DesktopConnection | null = null;

  async connect(tenantId: string): Promise<DesktopConnection> {
    if (this.current) return this.current;
    const signingKey = process.env.DOTS_LINUX_DESKTOP_TOKEN_SECRET;
    if (!signingKey || signingKey.length < 32) throw new Error('Linux 云电脑需要配置至少 32 字符的 DOTS_LINUX_DESKTOP_TOKEN_SECRET');
    const identity = desktopResourceIdentity(tenantId);
    const workerToken = createHmac('sha256', signingKey).update(`worker:${tenantId}`).digest('base64url');
    const agentToken = createHmac('sha256', signingKey).update(`agent:${tenantId}`).digest('base64url');
    const resources = desktopResources(tenantId, workerToken, agentToken);
    await kubectl(['apply', '-f', '-'], JSON.stringify(resources[0]));
    await kubectl(['apply', '-f', '-'], JSON.stringify(resources[1]));
    await kubectl(['-n', identity.namespace, 'rollout', 'status', 'deployment/desktop', '--timeout=180s']);

    if (process.env.KUBERNETES_SERVICE_HOST && process.env.DOTS_LINUX_DESKTOP_FORCE_PORT_FORWARD !== '1') {
      const serviceHost = `desktop.${identity.namespace}.svc.cluster.local`;
      this.current = { workerUrl: new URL(`http://${serviceHost}:${workerPort}`), novncUrl: new URL(`http://${serviceHost}:${vncPort}`), agentUrl: new URL(`http://${serviceHost}:8083`), workerToken, agentToken };
      return this.current;
    }

    const ports = await reservePorts(3);
    this.portForward = spawn('kubectl', ['-n', identity.namespace, 'port-forward', '--address', '127.0.0.1', `svc/desktop`, `${ports[0]}:${workerPort}`, `${ports[1]}:${vncPort}`, `${ports[2]}:8083`], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await waitForPortForward(this.portForward, ports[0], ports[1], ports[2]);
      this.current = { workerUrl: new URL(`http://127.0.0.1:${ports[0]}`), novncUrl: new URL(`http://127.0.0.1:${ports[1]}`), agentUrl: new URL(`http://127.0.0.1:${ports[2]}`), workerToken, agentToken };
      return this.current;
    } catch (error) {
      this.portForward.kill('SIGTERM'); this.portForward = null;
      throw error;
    }
  }

  async close() {
    this.portForward?.kill('SIGTERM');
    this.portForward = null;
    this.current = null;
  }

  async reset(tenantId: string) {
    await this.close();
    const identity = desktopResourceIdentity(tenantId);
    const rawNamespace = await kubectl(['get', 'namespace', identity.namespace, '-o', 'json', '--ignore-not-found=true']);
    if (!rawNamespace.trim()) return;
    let namespace: { metadata?: { labels?: Record<string, string> } };
    try { namespace = JSON.parse(rawNamespace); }
    catch { throw new Error('无法验证 Linux 云电脑工作区归属，已停止重置'); }
    if (namespace.metadata?.labels?.['coke-dots.io/managed-by'] !== 'coke-dots' || namespace.metadata.labels['coke-dots.io/tenant-hash'] !== identity.tenantHash) {
      throw new Error('Linux 云电脑工作区标记与当前租户不匹配，已停止重置');
    }
    await kubectl(['delete', 'namespace', identity.namespace, '--wait=true', '--timeout=120s']);
  }
}

async function kubectl(args: string[], input?: string) {
  const child = spawn(process.env.DOTS_KUBECTL_BIN || 'kubectl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-1_000_000); });
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-1000); });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', value => resolve(value ?? 1));
  });
  if (code !== 0) {
    // kubectl diagnostics can include serialized Secret fields. Keep them out
    // of application responses and logs; the command and exit status suffice.
    void stderr;
    throw new Error(`kubectl ${args[0]} failed (exit ${code})`);
  }
  return stdout;
}

async function reservePorts(count: number) {
  const ports: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Could not reserve a local port for kubectl port-forward');
    ports.push(address.port);
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
  return ports;
}

async function waitForPortForward(child: ChildProcess, ...ports: number[]) {
  const deadline = Date.now() + 15_000;
  let output = '';
  if (!child.stdout) throw new Error('kubectl port-forward output is unavailable');
  let fail: ((error: Error) => void) | undefined;
  const exited = new Promise<never>((_, reject) => { fail = reject; });
  const onExit = (code: number | null) => fail?.(new Error(`kubectl port-forward exited (code ${code ?? 'unknown'})`));
  const onError = () => fail?.(new Error('kubectl port-forward failed to start'));
  child.once('exit', onExit);
  child.once('error', onError);
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  try {
    while (Date.now() < deadline) {
      if (ports.every(port => output.includes(`127.0.0.1:${port}`))) return;
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 50))]);
    }
    throw new Error('kubectl port-forward did not become ready');
  } finally {
    child.off('exit', onExit);
    child.off('error', onError);
  }
}
