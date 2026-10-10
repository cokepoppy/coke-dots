import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { resolvePiSessionManager } from '../src/server/adapters.ts';

let piSdk: Parameters<typeof resolvePiSessionManager>[0] | null = null;
try {
  piSdk = await import('@mariozechner/pi-coding-agent') as unknown as Parameters<typeof resolvePiSessionManager>[0];
} catch {
  // Pi is optional; the persistence contract is exercised when its SDK is installed.
}

test('Pi session history persists inside one task workspace and cannot cross tenant workspaces', { skip: !piSdk }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-pi-session-'));
  const taskWorkspace = join(directory, 'tenant-a', 'task-1');
  const otherTenantWorkspace = join(directory, 'tenant-b', 'task-1');
  mkdirSync(taskWorkspace, { recursive: true });
  mkdirSync(otherTenantWorkspace, { recursive: true });
  try {
    const first = await resolvePiSessionManager(piSdk!, taskWorkspace, null);
    const sessionId = first.getSessionId();
    const sessionFile = first.getSessionFile();
    assert.ok(sessionFile);
    assert.equal(relative(realpathSync(taskWorkspace), sessionFile).startsWith('..'), false);

    first.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Remember this task-specific detail.' }], timestamp: Date.now() });
    first.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'I will remember that detail for this task.' }], timestamp: Date.now() });

    const resumed = await resolvePiSessionManager(piSdk!, taskWorkspace, sessionId);
    assert.equal(resumed.getSessionId(), sessionId);
    const entries = resumed.getEntries() as { type?: string; message?: { content?: { text?: string }[] } }[];
    assert.ok(entries.some(entry => entry.type === 'message' && entry.message?.content?.some(content => content.text === 'Remember this task-specific detail.')));

    const recoveredWithoutDatabaseId = await resolvePiSessionManager(piSdk!, taskWorkspace, null);
    assert.equal(recoveredWithoutDatabaseId.getSessionId(), sessionId);
    await assert.rejects(resolvePiSessionManager(piSdk!, otherTenantWorkspace, sessionId), /不存在或不唯一/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi refuses to guess when an ID-less task workspace contains multiple sessions', { skip: !piSdk }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'coke-dots-pi-ambiguous-'));
  try {
    const first = await resolvePiSessionManager(piSdk!, workspace, null);
    const sessionDir = join(workspace, '.coke-dots', 'pi-sessions');
    first.appendMessage({ role: 'user', content: [{ type: 'text', text: 'First task turn.' }], timestamp: Date.now() });
    first.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'First task response.' }], timestamp: Date.now() });
    const second = piSdk!.SessionManager.create(workspace, sessionDir);
    second.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Second task turn.' }], timestamp: Date.now() });
    second.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Second task response.' }], timestamp: Date.now() });
    await assert.rejects(resolvePiSessionManager(piSdk!, workspace, null), /多个会话/);
    assert.ok(first.getSessionFile());
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Pi rejects a task state directory symlink that points outside its workspace', { skip: !piSdk }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-pi-symlink-'));
  const workspace = join(directory, 'tenant-a', 'task-1');
  const otherTenantState = join(directory, 'tenant-b', 'state');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(otherTenantState, { recursive: true });
  const modeBefore = statSync(otherTenantState).mode & 0o777;
  symlinkSync(otherTenantState, join(workspace, '.coke-dots'), 'dir');
  try {
    await assert.rejects(resolvePiSessionManager(piSdk!, workspace, null), /状态目录超出当前任务工作区/);
    assert.equal(statSync(otherTenantState).mode & 0o777, modeBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
