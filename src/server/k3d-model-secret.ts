import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve, isAbsolute } from 'node:path';

export type ModelSecretStatus = 'configured' | 'missing' | 'unavailable';
export interface ModelSecretRead { value: string | null; status: ModelSecretStatus }

type KubectlRunner = (args: string[], input?: string) => string;

const kubectl = () => process.env.DOTS_KUBECTL?.trim() || 'kubectl';
const namespace = () => process.env.DOTS_MODEL_SECRET_NAMESPACE?.trim() || 'coke-dots-system';
const secretName = () => process.env.DOTS_MODEL_SECRET_NAME?.trim() || 'shared-model-api';
const secretKey = 'apiKey';
const cacheMs = 3_000;

/** Instance-wide model credential stored in a Kubernetes Secret, never a ConfigMap. */
export class K3dModelSecretStore {
  private cached: ModelSecretRead | null = null;
  private cacheExpiresAt = 0;

  constructor(private readonly runKubectl: KubectlRunner = executeKubectl) {}

  read(force = false): ModelSecretRead {
    if (process.env.NODE_ENV === 'test') {
      try { return this.readTestValue(this.testPath()!); }
      catch { return { value: null, status: 'unavailable' }; }
    }
    if (!force && this.cached && Date.now() < this.cacheExpiresAt) return this.cached;

    let result: ModelSecretRead;
    try {
      const encoded = this.runKubectl([
        '-n', namespace(), 'get', 'secret', secretName(),
        `-o=jsonpath={.data.${secretKey}}`,
      ]).trim();
      const value = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
      result = value ? { value, status: 'configured' } : { value: null, status: 'missing' };
    } catch (error) {
      result = isNotFound(error)
        ? { value: null, status: 'missing' }
        : { value: null, status: 'unavailable' };
    }
    this.cached = result;
    this.cacheExpiresAt = Date.now() + cacheMs;
    return result;
  }

  save(value: string): void {
    const clean = value.trim();
    if (!clean) throw new Error('密钥不能为空');
    if (clean.length > 5_000) throw new Error('模型 API 密钥过长');

    if (process.env.NODE_ENV === 'test') {
      try { this.writeTestValue(this.testPath()!, clean); }
      catch { throw new Error('测试模型 Secret 存储未启用；请使用隔离测试运行器'); }
      this.cached = { value: clean, status: 'configured' };
      this.cacheExpiresAt = Date.now() + cacheMs;
      return;
    }

    try {
      const createNamespace = this.runKubectl(['create', 'namespace', namespace(), '--dry-run=client', '-o', 'yaml']);
      this.runKubectl(['apply', '--server-side', '--field-manager=coke-dots-model-settings', '-f', '-'], createNamespace);
      const manifest = JSON.stringify({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: secretName(), namespace: namespace(), labels: { 'app.kubernetes.io/part-of': 'coke-dots' } },
        type: 'Opaque',
        data: { [secretKey]: Buffer.from(clean, 'utf8').toString('base64') },
      });
      this.runKubectl(['apply', '--server-side', '--field-manager=coke-dots-model-settings', '-f', '-'], manifest);
      this.cached = { value: clean, status: 'configured' };
      this.cacheExpiresAt = Date.now() + cacheMs;
    } catch {
      this.cached = { value: null, status: 'unavailable' };
      this.cacheExpiresAt = 0;
      throw new Error(`无法写入 K3D Secret（${namespace()}/${secretName()}）。请检查当前 kubectl 集群和权限。`);
    }
  }

  clearCache(): void {
    this.cached = null;
    this.cacheExpiresAt = 0;
  }

  /** Isolated test cleanup; production Secrets are never deleted by this method. */
  clearTestValue(): void {
    if (process.env.NODE_ENV !== 'test' || !process.env.DOTS_TEST_MODEL_SECRET_DIR?.trim()) return;
    const path = this.testPath()!;
    try { unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.clearCache();
  }

  private testPath(): string | null {
    if (process.env.NODE_ENV !== 'test') return null;
    const rootValue = process.env.DOTS_TEST_MODEL_SECRET_DIR?.trim();
    if (!rootValue) throw new Error('DOTS_TEST_MODEL_SECRET_DIR is required in tests');
    const root = resolve(rootValue);
    const fromTemp = relative(resolve(tmpdir()), root);
    if (!fromTemp || fromTemp === '.' || fromTemp.startsWith('..') || isAbsolute(fromTemp)) {
      throw new Error('DOTS_TEST_MODEL_SECRET_DIR must be a dedicated directory inside the operating-system temp directory');
    }
    const scope = process.env.DOTS_TEST_MODEL_SECRET_SCOPE?.trim() || process.env.DOTS_KEYCHAIN_SERVICE?.trim() || '';
    const id = createHash('sha256').update(namespace()).update('\0').update(secretName()).update('\0').update(scope).digest('hex');
    return resolve(root, `${id}.secret`);
  }

  private readTestValue(path: string): ModelSecretRead {
    try {
      const value = readFileSync(path, 'utf8');
      return value ? { value, status: 'configured' } : { value: null, status: 'missing' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: null, status: 'missing' };
      return { value: null, status: 'unavailable' };
    }
  }

  private writeTestValue(path: string, value: string): void {
    const directory = resolve(path, '..');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  }
}

function executeKubectl(args: string[], input?: string): string {
  return execFileSync(kubectl(), args, {
    encoding: 'utf8',
    input,
    timeout: 10_000,
    maxBuffer: 32 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('stderr' in error)) return false;
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
  return /notfound|not found/i.test(text);
}
