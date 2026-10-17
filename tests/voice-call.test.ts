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

test('voice follow-ups retain bounded context within one call and across an explicit follow-up call only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-voice-follow-up-'));
  try {
    const store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'voice-context-alpha', email: 'voice-context-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'voice-context-beta', email: 'voice-context-beta@example.test', name: 'Beta' });
    const firstCall = store.createVoiceCall(alpha.tenant.id, alpha.user.id, '2026-10-17T00:00:00.000Z');
    const first = store.submitVoiceTurn({ tenantId: alpha.tenant.id, userId: alpha.user.id, callId: firstCall.id, turnId: 'context-turn-1', transcript: '请准备北交所规则会议资料', engine: 'pi' });
    store.updateTask(first.task.id, { status: 'done', result: '会议资料文档已创建，日程待确认。' }, alpha.tenant.id);
    const second = store.submitVoiceTurn({ tenantId: alpha.tenant.id, userId: alpha.user.id, callId: firstCall.id, turnId: 'context-turn-2', transcript: '把日程也安排上', engine: 'pi' });
    assert.match(second.task.instruction, /Earlier turns from this voice call/);
    assert.match(second.task.instruction, /User said: 请准备北交所规则会议资料/);
    assert.match(second.task.instruction, /会议资料文档已创建/);

    let previousTask = second.task;
    for (const [index, utterance] of [
      '把会议纪要写成钉钉文档',
      '把文档发到 cokeclaw 群',
      '再查一下交易规则的生效日期',
      '根据这条规则调整移动交易页面',
      '跑完测试并准备 PR',
    ].entries()) {
      store.updateTask(previousTask.id, { status: 'done', result: `第 ${index + 2} 项已处理。` }, alpha.tenant.id);
      previousTask = store.submitVoiceTurn({
        tenantId: alpha.tenant.id, userId: alpha.user.id, callId: firstCall.id,
        turnId: `context-turn-${index + 3}`, transcript: utterance, engine: 'pi',
      }).task;
    }
    assert.match(previousTask.instruction, /User said: 请准备北交所规则会议资料/,
      'A later voice turn in the same active call must retain the first user request');
    assert.match(previousTask.instruction, /User said: 再查一下交易规则的生效日期/,
      'Intermediate spoken turns must remain available throughout the same call');
    assert.match(previousTask.instruction, /第 6 项已处理/,
      'Context must include the most recent completed work outcome');
    const transcriptRows = store.db.prepare('SELECT transcript FROM voice_call_turns WHERE call_id=? ORDER BY created_at ASC')
      .all(firstCall.id) as { transcript: string }[];
    assert.deepEqual(transcriptRows.map(row => row.transcript), [
      '请准备北交所规则会议资料', '把日程也安排上', '把会议纪要写成钉钉文档', '把文档发到 cokeclaw 群',
      '再查一下交易规则的生效日期', '根据这条规则调整移动交易页面', '跑完测试并准备 PR',
    ], 'The database must preserve every utterance, not only the last few summarized tasks');

    store.endVoiceCall(alpha.tenant.id, alpha.user.id, firstCall.id, 30, '2026-10-17T00:01:00.000Z');
    const followUpCall = store.createVoiceCall(alpha.tenant.id, alpha.user.id, '2026-10-17T00:10:00.000Z');
    const followUp = store.submitVoiceTurn({ tenantId: alpha.tenant.id, userId: alpha.user.id, callId: followUpCall.id, turnId: 'context-turn-3', transcript: '那个会议准备资料处理好了吗？', engine: 'pi' });
    assert.match(followUp.task.instruction, /Earlier turns from this voice call/);
    assert.match(followUp.task.instruction, /会议资料文档已创建/);

    store.endVoiceCall(alpha.tenant.id, alpha.user.id, followUpCall.id, 20, '2026-10-17T00:11:00.000Z');
    const unrelatedCall = store.createVoiceCall(alpha.tenant.id, alpha.user.id, '2026-10-17T00:20:00.000Z');
    const unrelated = store.submitVoiceTurn({ tenantId: alpha.tenant.id, userId: alpha.user.id, callId: unrelatedCall.id, turnId: 'context-turn-4', transcript: '今天天气怎么样', engine: 'pi' });
    assert.doesNotMatch(unrelated.task.instruction, /Recent voice-task context/);

    const betaCall = store.createVoiceCall(beta.tenant.id, beta.user.id, '2026-10-17T00:30:00.000Z');
    const betaTask = store.submitVoiceTurn({ tenantId: beta.tenant.id, userId: beta.user.id, callId: betaCall.id, turnId: 'context-turn-5', transcript: '继续之前那个任务', engine: 'pi' });
    assert.doesNotMatch(betaTask.task.instruction, /会议资料文档已创建/);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a spoken progress question during an active task carries its live status, then later carries the completed result', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-voice-progress-'));
  try {
    const store = new Store(directory);
    const user = store.signInGoogle({ subject: 'voice-progress-user', email: 'voice-progress@example.test', name: 'Voice User' });
    const call = store.createVoiceCall(user.tenant.id, user.user.id, '2026-10-17T01:00:00.000Z');
    const original = store.submitVoiceTurn({
      tenantId: user.tenant.id, userId: user.user.id, callId: call.id, turnId: 'progress-turn-1',
      transcript: '查北交所公告，更新交易页面并跑完测试', engine: 'pi',
    }).task;
    store.updateTask(original.id, { status: 'working', nextRunAt: null }, user.tenant.id);

    const progressQuestion = store.submitVoiceTurn({
      tenantId: user.tenant.id, userId: user.user.id, callId: call.id, turnId: 'progress-turn-2',
      transcript: '刚才那件事做好了吗？', engine: 'pi',
    }).task;
    assert.match(progressQuestion.instruction, /User said: 查北交所公告，更新交易页面并跑完测试/,
      'A progress question during the same call must retain the original spoken goal');
    assert.match(progressQuestion.instruction, /Related task: 查北交所公告，更新交易页面并跑完测试/);
    assert.match(progressQuestion.instruction, /Task status: working/,
      'The follow-up prompt must report that the original Pi task is still working');
    assert.match(progressQuestion.instruction, /still in progress or no result yet/,
      'An unfinished task must not be presented as complete');

    store.updateTask(original.id, {
      status: 'done', nextRunAt: null, result: '规则影响已修复，移动页面回归测试通过，PR #12 已创建。',
    }, user.tenant.id);
    const completedQuestion = store.submitVoiceTurn({
      tenantId: user.tenant.id, userId: user.user.id, callId: call.id, turnId: 'progress-turn-3',
      transcript: '那修复和 PR 结果是什么？', engine: 'pi',
    }).task;
    assert.match(completedQuestion.instruction, /User said: 刚才那件事做好了吗？/,
      'Every spoken turn must remain in context, including progress checks');
    assert.match(completedQuestion.instruction, /Task status: done/);
    assert.match(completedQuestion.instruction, /移动页面回归测试通过，PR #12 已创建/,
      'A later reference must include the original task result after it completes');
    const savedTurns = store.db.prepare('SELECT COUNT(*) AS count FROM voice_call_turns WHERE call_id=?')
      .get(call.id) as { count: number };
    assert.equal(savedTurns.count, 3, 'The active call must durably retain the complete three-turn exchange');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
