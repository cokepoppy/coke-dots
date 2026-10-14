import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return address.port;
}

test('cloud computer exposes task files safely through its authenticated worker', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dots-artifact-workspace-'));
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'dots-artifact-runtime-'));
  const taskId = 'd4d39c7e-5f39-4a40-a51c-07bb73bfa213';
  const symlinkTaskId = 'c3d39c7e-5f39-4a40-a51c-07bb73bfa213';
  const taskDirectory = join(workspace, 'tasks', taskId);
  const outside = join(workspace, 'private.html');
  const outsideTask = join(workspace, 'outside-task');
  const html = '<main id="game">俄罗斯方块</main>';
  const css = 'body { color: purple; }';
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(join(taskDirectory, 'tetris.html'), html);
  await mkdir(join(taskDirectory, 'assets'));
  await writeFile(join(taskDirectory, 'assets', 'game.css'), css);
  await writeFile(outside, '<p>private</p>');
  await mkdir(outsideTask);
  await writeFile(join(outsideTask, 'secret.html'), '<p>private task</p>');
  await symlink(outside, join(taskDirectory, 'escape.html'));
  await symlink(outsideTask, join(workspace, 'tasks', symlinkTaskId));
  // Match the runtime image layout: the worker and its two local modules are
  // installed together in /opt/coke-dots, while this test launches the source
  // worker directly from a temporary directory.
  await copyFile(join(projectRoot, 'deploy/linux-desktop/computer-worker.mjs'), join(runtimeDirectory, 'computer-worker.mjs'));
  await copyFile(join(projectRoot, 'src/server/computer-home.mjs'), join(runtimeDirectory, 'computer-home.mjs'));
  await copyFile(join(projectRoot, 'src/shared/public-web-policy.mjs'), join(runtimeDirectory, 'public-web-policy.mjs'));
  await symlink(join(projectRoot, 'node_modules'), join(runtimeDirectory, 'node_modules'), 'dir');

  const port = await freePort();
  const token = 'artifact-worker-test-token';
  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, [join(runtimeDirectory, 'computer-worker.mjs')], {
      cwd: projectRoot,
      env: { ...process.env, DOTS_AGENT_WORKSPACE: workspace, LINUX_DESKTOP_WORKER_TOKEN: token, COKE_DESKTOP_WORKER_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`worker exited before listening: ${stderr}`);
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* wait for listen */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }

    const unauthorized = await fetch(`${base}/v1/artifacts?taskId=${taskId}`);
    assert.equal(unauthorized.status, 401, 'Artifact metadata requires the tenant worker token');
    const headers = { authorization: `Bearer ${token}` };
    const listed = await fetch(`${base}/v1/artifacts?taskId=${taskId}`, { headers });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as { artifacts: { path: string; mediaType: string; previewable: boolean }[] }).artifacts, [
      { path: 'assets/game.css', name: 'game.css', mediaType: 'text/css', size: Buffer.byteLength(css), previewable: true },
      { path: 'tetris.html', name: 'tetris.html', mediaType: 'text/html', size: Buffer.byteLength(html), previewable: true },
    ]);

    const query = new URLSearchParams({ taskId, path: 'tetris.html' });
    const file = await fetch(`${base}/v1/artifact?${query}`, { headers });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(file.headers.get('x-dots-artifact-previewable'), 'true');
    assert.match(await file.text(), /俄罗斯方块/);

    const traversal = await fetch(`${base}/v1/artifact?${new URLSearchParams({ taskId, path: '../private.html' })}`, { headers });
    assert.equal(traversal.status, 400, 'A task cannot read a sibling or parent path');
    const symlinkEscape = await fetch(`${base}/v1/artifact?${new URLSearchParams({ taskId, path: 'escape.html' })}`, { headers });
    assert.equal(symlinkEscape.status, 400, 'A task cannot serve a symlink outside its own directory');
    const missingTask = await fetch(`${base}/v1/artifacts?${new URLSearchParams({ taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })}`, { headers });
    assert.deepEqual(await missingTask.json(), { artifacts: [] });
    const symlinkTask = await fetch(`${base}/v1/artifacts?${new URLSearchParams({ taskId: symlinkTaskId })}`, { headers });
    assert.equal(symlinkTask.status, 400, 'A task id cannot alias another directory through a symlink');
  } finally {
    child?.kill('SIGTERM');
    if (child && child.exitCode === null) await new Promise<void>(resolveExit => child!.once('exit', () => resolveExit()));
    await rm(workspace, { recursive: true, force: true });
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
