import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAgentPrompt, parseDecision, type AgentRequest } from '../src/server/adapters.ts';

const baseRequest: AgentRequest = {
  prompt: 'Create a Minesweeper game in the cloud computer.',
  priorResult: null,
  sessionId: null,
  workspace: '/private/workspace/task',
  onEvent: () => {},
};

test('cloud-computer Pi prompt allows coding and interactive Browser Use inside the tenant Debian computer', () => {
  const prompt = formatAgentPrompt({ ...baseRequest, engine: 'pi', cloudComputerTask: true });
  assert.match(prompt, /read, grep, find, ls, write, edit, and bash/);
  assert.match(prompt, /Browser Use for the visible Chromium browser/);
  assert.match(prompt, /without asking for another permission prompt/);
  assert.match(prompt, /clone repositories, install project dependencies, run tests, and use the browser/);
  assert.match(prompt, /do not attempt to access the Mac host, VPS, Kubernetes control plane, or another tenant/);
  assert.match(prompt, /send, publish, authorize, pay, delete, or change account data only when the task explicitly asks/);
});

test('non-Pi cloud kernels are not told they have Pi shell, write, or Browser Use tools', () => {
  const prompt = formatAgentPrompt({ ...baseRequest, engine: 'dsh', cloudComputerTask: true });
  assert.match(prompt, /does not have Pi’s shell, file-write, or interactive Browser Use tools/);
  assert.doesNotMatch(prompt, /standard coding tools available/);
});

test('non-cloud tasks are not told they can write files', () => {
  const prompt = formatAgentPrompt(baseRequest);
  assert.match(prompt, /no writable cloud-computer task directory/);
  assert.doesNotMatch(prompt, /without asking the user for another approval/);
});

test('private Dot memory updates are explicit, user scoped, and limited to durable non-sensitive notes', () => {
  const memoryId = '11111111-1111-4111-8111-111111111111';
  const prompt = formatAgentPrompt({
    ...baseRequest,
    dotMemories: [{ id: memoryId, note: 'Prefer concise Mandarin answers.' }],
    allowDotMemoryUpdates: true,
  });
  assert.match(prompt, /Private notes for this Dot and the initiating user only/);
  assert.match(prompt, new RegExp(`ID: ${memoryId}`));
  assert.match(prompt, /durable preference, decision, or ongoing responsibility/);
  assert.match(prompt, /Do not save one-off task details, incident payloads, copied source text, secrets, API keys, OAuth codes, passwords, access tokens, or sensitive personal data/i);

  const saved = parseDecision(JSON.stringify({ status: 'done', message: '已记住。', memoryAction: { action: 'save', note: 'Prefer concise Mandarin answers.' } }), undefined, { allowDotMemoryUpdates: true, dotMemoryIds: [] });
  assert.deepEqual(saved.memoryAction, { action: 'save', note: 'Prefer concise Mandarin answers.' });
  const updated = parseDecision(JSON.stringify({ status: 'done', message: '已更新。', memoryAction: { action: 'update', memoryId, note: 'Prefer concise Chinese answers.' } }), undefined, { allowDotMemoryUpdates: true, dotMemoryIds: [memoryId] });
  assert.deepEqual(updated.memoryAction, { action: 'update', memoryId, note: 'Prefer concise Chinese answers.' });
  assert.throws(() => parseDecision(JSON.stringify({ status: 'done', message: 'Saved.', memoryAction: { action: 'save', note: 'Cross-user write.' } })), /没有更新 Dot 私人记忆的权限/);
  assert.throws(() => parseDecision(JSON.stringify({ status: 'done', message: 'Saved.', memoryAction: { action: 'update', memoryId: '22222222-2222-4222-8222-222222222222', note: 'Cross-user write.' } }), undefined, { allowDotMemoryUpdates: true, dotMemoryIds: [memoryId] }), /不存在的 Dot 私人记忆/);
  assert.throws(() => parseDecision(JSON.stringify({ status: 'waiting', message: 'Need input.', memoryAction: { action: 'save', note: 'Never persist incomplete work.' } }), undefined, { allowDotMemoryUpdates: true, dotMemoryIds: [] }), /只能在任务完成时更新/);
});
