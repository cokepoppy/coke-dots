import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';

test('voice call history is durable and scoped to its workspace and owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-voice-call-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'voice-alpha', email: 'voice-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'voice-beta', email: 'voice-beta@example.test', name: 'Beta' });
    const startedAt = '2026-10-06T03:00:00.000Z';
    const call = store.createVoiceCall(alpha.tenant.id, alpha.user.id, startedAt);

    assert.equal(call.tenantId, alpha.tenant.id);
    assert.equal(call.startedAt, startedAt);
    assert.equal(call.endedAt, null);
    assert.deepEqual(store.getVoiceCall(alpha.tenant.id, alpha.user.id, call.id), call);
    assert.equal(store.getVoiceCall(beta.tenant.id, beta.user.id, call.id), null, 'A different tenant and owner must not inspect this call');
    assert.deepEqual(store.voiceCalls(beta.tenant.id, beta.user.id), []);
    assert.equal(store.endVoiceCall(beta.tenant.id, beta.user.id, call.id, 12), null, 'A different tenant must not end this call');
    assert.deepEqual(store.voiceCalls(alpha.tenant.id, alpha.user.id), [call]);

    const ended = store.endVoiceCall(alpha.tenant.id, alpha.user.id, call.id, 12, '2026-10-06T03:00:12.000Z');
    assert.deepEqual(ended, { ...call, endedAt: '2026-10-06T03:00:12.000Z', durationSeconds: 12 });
    store.close();

    store = new Store(directory);
    assert.deepEqual(store.voiceCalls(alpha.tenant.id, alpha.user.id), [ended]);
    assert.deepEqual(store.voiceCalls(beta.tenant.id, beta.user.id), []);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('voice turn dispatch is durable, owner-scoped, and idempotent across task creation and call retries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-voice-turn-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'voice-turn-alpha', email: 'voice-turn-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'voice-turn-beta', email: 'voice-turn-beta@example.test', name: 'Beta' });
    const call = store.createVoiceCall(alpha.tenant.id, alpha.user.id);
    const request = {
      tenantId: alpha.tenant.id, userId: alpha.user.id, callId: call.id,
      turnId: 'item-qwen-turn-1', transcript: '整理今天的工作进展', engine: 'pi' as const,
    };

    const first = store.submitVoiceTurn(request);
    const duplicate = store.submitVoiceTurn({ ...request, transcript: '重复送达的同一轮语音' });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.task.id, first.task.id);
    assert.equal(duplicate.task.instruction, '整理今天的工作进展');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM voice_call_turns WHERE call_id=?').get(call.id) as { count: number }).count, 1);
    assert.equal(store.getTask(first.task.id, beta.tenant.id), null);
    assert.throws(() => store.submitVoiceTurn({ ...request, tenantId: beta.tenant.id, userId: beta.user.id }), /语音通话不存在/);

    store.endVoiceCall(alpha.tenant.id, alpha.user.id, call.id, 10);
    store.close();
    store = new Store(directory);
    const retryAfterHangup = store.submitVoiceTurn(request);
    assert.equal(retryAfterHangup.duplicate, true, 'A retry may recover the already-created task after hangup');
    assert.equal(retryAfterHangup.task.id, first.task.id);
    assert.throws(() => store.submitVoiceTurn({ ...request, turnId: 'item-qwen-turn-2' }), /语音通话已结束/);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a repeated voice reply resumes a waiting task exactly once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-voice-reply-'));
  try {
    const store = new Store(directory);
    const user = store.signInGoogle({ subject: 'voice-reply-user', email: 'voice-reply@example.test', name: 'Voice User' });
    const call = store.createVoiceCall(user.tenant.id, user.user.id);
    const waiting = store.createTask('请告诉我会议日期', null, 'pi', user.tenant.id);
    store.updateTask(waiting.id, { status: 'waiting', nextRunAt: null }, user.tenant.id);
    const request = {
      tenantId: user.tenant.id, userId: user.user.id, callId: call.id,
      turnId: 'item-qwen-reply-1', transcript: '周五', engine: 'pi' as const, waitingTaskId: waiting.id,
    };

    const first = store.submitVoiceTurn(request);
    const duplicate = store.submitVoiceTurn(request);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.task.id, waiting.id);
    assert.equal(duplicate.task.status, 'queued');
    assert.equal(duplicate.task.instruction.match(/User reply: 周五/g)?.length, 1);
    const replies = store.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE tenant_id=? AND task_id=? AND kind='user' AND body=?")
      .get(user.tenant.id, waiting.id, '周五') as { count: number };
    assert.equal(replies.count, 1);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
