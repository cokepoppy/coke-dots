import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapters, parseDecision } from '../src/server/adapters.ts';
import { Store } from '../src/server/store.ts';

test('agent output must specify a real task state', () => {
  assert.equal(parseDecision('{"status":"waiting","message":"Need access"}').status, 'waiting');
  assert.throws(() => parseDecision('I probably finished the work'));
  assert.throws(() => parseDecision('{"status":"done","message":""}'));
});

test('selected engine is durable per task', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-engines-'));
  try {
    let store = new Store(directory);
    const task = store.createTask('Review code', null, 'claude');
    store.close();
    store = new Store(directory);
    assert.equal(store.getTask(task.id)?.engine, 'claude');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Claude adapter uses restricted tools and records a resumable session ID', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-claude-'));
  const script = join(directory, 'mock-claude.js');
  const argsFile = join(directory, 'args.json');
  writeFileSync(script, 'const fs=require("fs");fs.writeFileSync(process.env.DOTS_TEST_ARGS,JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({status:"done",message:"Reviewed supplied text"}));');
  process.env.DOTS_CLAUDE_BIN = script;
  process.env.DOTS_TEST_ARGS = argsFile;
  try {
    assert.equal(adapters.claude.available(), true);
    const result = await adapters.claude.run({ prompt: 'Review supplied text', priorResult: null, sessionId: null, workspace: directory, onEvent: () => {} });
    assert.equal(result.message, 'Reviewed supplied text');
    assert.ok(result.sessionId);
    const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    assert.ok(args.includes('--session-id'));
    assert.ok(args.includes('Read,Glob,Grep,WebSearch,WebFetch'));
    assert.ok(args.includes('mcp__*'));
    assert.equal(args.includes('--dangerously-skip-permissions'), false);
  } finally { delete process.env.DOTS_CLAUDE_BIN; delete process.env.DOTS_TEST_ARGS; rmSync(directory, { recursive: true, force: true }); }
});
