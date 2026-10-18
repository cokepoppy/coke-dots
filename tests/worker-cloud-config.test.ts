import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Worker } from '../src/server/worker.ts';
import type { ComputerRuntime } from '../src/server/computer.ts';
import { ComputerControlOwnedByUserError } from '../src/server/computer-errors.ts';
import { DingTalkService } from '../src/server/dingtalk.ts';

async function runCloudConfigPreflight(secretMode: 'missing' | 'unavailable') {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-cloud-model-config-'));
  const unavailableFile = join(directory, 'kubectl-unavailable');
  const envKeys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY', 'DOTS_COMPUTER_BACKEND', 'DOTS_AGENT_KERNELS_JSON', 'DOTS_KEYCHAIN_SERVICE', 'DOTS_TEST_MODEL_SECRET_DIR', 'DOTS_TEST_MODEL_SECRET_SCOPE', 'DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE'] as const;
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  for (const key of ['DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY'] as const) delete process.env[key];
  process.env.NODE_ENV = 'test';
  process.env.DOTS_E2E_AUTH = '0';
  process.env.DOTS_COMPUTER_BACKEND = 'linux-desktop';
  process.env.DOTS_AGENT_KERNELS_JSON = JSON.stringify({ pi: { command: '/bin/false', args: [] } });
  process.env.DOTS_KEYCHAIN_SERVICE = `com.cokepoppy.coke-dots.test.${randomUUID()}`;
  process.env.DOTS_TEST_MODEL_SECRET_DIR = join(directory, 'secrets');
  process.env.DOTS_TEST_MODEL_SECRET_SCOPE = randomUUID();
  if (secretMode === 'unavailable') {
    writeFileSync(unavailableFile, 'simulate unavailable K3D API');
    process.env.DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE = unavailableFile;
  } else {
    delete process.env.DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE;
  }

  const store = new Store(directory);
  const account = store.signInGoogle({ subject: `cloud-config-${randomUUID()}`, email: 'cloud-config@example.test', name: 'Test Dot' });
  store.setAppSetting('modelBaseUrl', 'https://api.deepseek.com/v1');
  store.setAppSetting('modelName', 'deepseek-test-model');
  const task = store.createTask('Cloud Pi config preflight', null, 'pi', account.tenant.id);
  let remoteDispatches = 0;
  const computer = {
    async runAgentTask() {
      remoteDispatches += 1;
      throw new Error('The cloud Agent runtime must not be contacted without modelConfig');
    },
  } as unknown as ComputerRuntime;
  const worker = new Worker(store, () => {}, join(directory, 'workspaces'), async () => {}, () => computer);

  try {
    await worker.tick();
    return { task: store.getTask(task.id, account.tenant.id), remoteDispatches };
  } finally {
    worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('cloud Agent tasks fail before dispatch when the shared Model API key is missing', async () => {
  const result = await runCloudConfigPreflight('missing');
  assert.equal(result.task?.status, 'failed');
  assert.match(result.task?.error || '', /实例尚未配置共享模型 API/);
  assert.equal(result.remoteDispatches, 0, 'The Agent pod must not receive a request without shared credentials');
});

test('cloud Agent tasks explain an unavailable K3D Secret before dispatch', async () => {
  const result = await runCloudConfigPreflight('unavailable');
  assert.equal(result.task?.status, 'failed');
  assert.match(result.task?.error || '', /无法读取 Coke Dots 实例共享 API 密钥/);
  assert.match(result.task?.error || '', /K3D 集群连接及 coke-dots-system\/shared-model-api Secret 权限/);
  assert.equal(result.remoteDispatches, 0, 'The Agent pod must not receive a request when the K3D Secret cannot be read');
});

test('worker dispatches Pi to the cloud kernel when Pi is enabled by the default runtime configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-cloud-default-pi-'));
  const envKeys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY', 'DOTS_COMPUTER_BACKEND', 'DOTS_PI_ENABLED', 'DOTS_AGENT_KERNELS_JSON', 'DOTS_KEYCHAIN_SERVICE', 'DOTS_TEST_MODEL_SECRET_DIR', 'DOTS_TEST_MODEL_SECRET_SCOPE', 'DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE'] as const;
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_MODEL_BASE_URL: 'https://api.example.test/v1', DOTS_MODEL: 'cloud-default-pi-model',
    DOTS_MODEL_API_KEY: 'cloud-default-pi-fixture-key', DOTS_COMPUTER_BACKEND: 'linux-desktop', DOTS_PI_ENABLED: '1',
    DOTS_KEYCHAIN_SERVICE: `com.cokepoppy.coke-dots.default-pi.${randomUUID()}`,
    DOTS_TEST_MODEL_SECRET_DIR: join(directory, 'secrets'), DOTS_TEST_MODEL_SECRET_SCOPE: randomUUID(),
  });
  delete process.env.DOTS_AGENT_KERNELS_JSON;
  delete process.env.DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE;
  const store = new Store(directory);
  const account = store.signInGoogle({ subject: `cloud-default-pi-${randomUUID()}`, email: 'cloud-default-pi@example.test', name: 'Test Dot' });
  store.setAppSetting('modelBaseUrl', 'https://api.example.test/v1');
  store.setAppSetting('modelName', 'cloud-default-pi-model');
  const task = store.createTask('Use the default cloud Pi kernel', null, 'pi', account.tenant.id);
  let receivedModel = '';
  let dispatches = 0;
  const computer = {
    async runAgentTask(input: { modelConfig?: { model: string } }) {
      dispatches += 1;
      receivedModel = input.modelConfig?.model || '';
      return { status: 'done', message: 'Cloud Pi task completed.' };
    },
  } as unknown as ComputerRuntime;
  const worker = new Worker(store, () => {}, join(directory, 'workspaces'), async () => {}, () => computer);

  try {
    await worker.tick();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && store.getTask(task.id, account.tenant.id)?.status === 'working') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(dispatches, 1, 'The enabled default Pi runtime must receive the task once');
    assert.equal(receivedModel, 'cloud-default-pi-model', 'The configured shared model profile must be sent to the cloud Pi runtime');
    assert.equal(store.getTask(task.id, account.tenant.id)?.status, 'done');
    assert.equal(store.getTask(task.id, account.tenant.id)?.result, 'Cloud Pi task completed.');
  } finally {
    worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('worker enables the Git credential broker only for an exact profiled DingTalk incident task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-worker-incident-profile-'));
  const keys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY', 'DOTS_COMPUTER_BACKEND', 'DOTS_PI_ENABLED', 'DOTS_AGENT_KERNELS_JSON', 'DOTS_KEYCHAIN_SERVICE', 'DOTS_TEST_MODEL_SECRET_DIR', 'DOTS_TEST_MODEL_SECRET_SCOPE', 'DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE'] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_MODEL_BASE_URL: 'https://api.example.test/v1', DOTS_MODEL: 'incident-profile-model',
    DOTS_MODEL_API_KEY: 'incident-profile-model-key', DOTS_COMPUTER_BACKEND: 'linux-desktop', DOTS_PI_ENABLED: '1',
    DOTS_AGENT_KERNELS_JSON: JSON.stringify({ pi: { command: '/bin/false', args: [] } }),
    DOTS_KEYCHAIN_SERVICE: `com.cokepoppy.coke-dots.incident-profile.${randomUUID()}`,
    DOTS_TEST_MODEL_SECRET_DIR: join(directory, 'secrets'), DOTS_TEST_MODEL_SECRET_SCOPE: randomUUID(),
  });
  delete process.env.DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE;
  const store = new Store(directory);
  const account = store.signInGoogle({ subject: `incident-profile-${randomUUID()}`, email: 'incident-profile@example.test', name: 'Incident owner' });
  store.setAppSetting('modelBaseUrl', 'https://api.example.test/v1');
  store.setAppSetting('modelName', 'incident-profile-model');
  store.replaceDingtalkGroupSelections(account.tenant.id, account.user.id, [{ conversationId: 'cokeclaw-id', name: 'cokeclaw' }], 'corp-one');
  store.setDingtalkGroupMonitor(account.tenant.id, account.user.id, 'cokeclaw-id', true, 'corp-one', ['故障', 'Trace ID']);
  const exact = store.ingestDingtalkMessage({
    corpId: 'corp-one', conversationId: 'cokeclaw-id', messageId: 'worker-profiled-alert', senderId: 'alert-bot',
    senderName: 'Alert Bot', text: 'service: coke-agent-web\nenvironment: production\nTrace ID: c7e2a195-4f93-4c60-8a27-b1d6e0f5a94c',
  });
  const nearMiss = store.ingestDingtalkMessage({
    corpId: 'corp-one', conversationId: 'cokeclaw-id', messageId: 'worker-unprofiled-alert', senderId: 'alert-bot',
    senderName: 'Alert Bot', text: 'service: coke-agent-web\nenvironment: production\nTrace ID: another-trace',
  });
  const received: Array<boolean | undefined> = [];
  const computer = {
    async runAgentTask(input: { incidentRemediation?: boolean }) {
      received.push(input.incidentRemediation);
      return { status: 'done', message: 'Alert analyzed.' };
    },
  } as unknown as ComputerRuntime;
  const worker = new Worker(store, () => {}, join(directory, 'workspaces'), async () => {}, () => computer);
  try {
    assert.equal(exact.tasks.length, 1);
    assert.equal(nearMiss.tasks.length, 1);
    await worker.tick();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && received.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(received, [true, undefined], 'Only the fixed service, environment, group, and Trace ID may receive the broker flag');
  } finally {
    worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('cloud Pi dispatch enables direct file and browser tools without a separate permission grant', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-cloud-write-access-'));
  const envKeys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY', 'DOTS_COMPUTER_BACKEND', 'DOTS_AGENT_KERNELS_JSON', 'DOTS_KEYCHAIN_SERVICE', 'DOTS_TEST_MODEL_SECRET_DIR', 'DOTS_TEST_MODEL_SECRET_SCOPE', 'DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE'] as const;
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_MODEL_BASE_URL: 'https://api.example.test/v1', DOTS_MODEL: 'cloud-write-test-model',
    DOTS_MODEL_API_KEY: 'cloud-write-fixture-key', DOTS_COMPUTER_BACKEND: 'linux-desktop',
    DOTS_AGENT_KERNELS_JSON: JSON.stringify({ pi: { command: '/bin/false', args: [] } }), DOTS_KEYCHAIN_SERVICE: `com.cokepoppy.coke-dots.write.${randomUUID()}`,
  });
  delete process.env.DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE;
  const store = new Store(directory);
  const account = store.signInGoogle({ subject: `computer-write-${randomUUID()}`, email: 'computer-write@example.test', name: 'Test Dot' });
  store.setAppSetting('modelBaseUrl', 'https://api.example.test/v1');
  store.setAppSetting('modelName', 'cloud-write-test-model');
  const task = store.createTask('Create a Minesweeper game in the cloud computer', null, 'pi', account.tenant.id);
  let receivedPrompt = '';
  let receivedEngine = '';
  const computer = {
    async runAgentTask(input: { engine: string; prompt: string }) {
      receivedPrompt = input.prompt;
      receivedEngine = input.engine;
      return { status: 'done', message: 'Created minesweeper.html in this task directory.' };
    },
  } as unknown as ComputerRuntime;
  const worker = new Worker(store, () => {}, join(directory, 'workspaces'), async () => {}, () => computer);

  try {
    await worker.tick();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && store.getTask(task.id, account.tenant.id)?.status === 'working') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(store.getTask(task.id, account.tenant.id)?.status, 'done');
    assert.equal(receivedEngine, 'pi');
    assert.match(receivedPrompt, /standard coding tools available: read, grep, find, ls, write, edit, and bash/);
    assert.match(receivedPrompt, /Browser Use for the visible Chromium browser/);
    assert.match(receivedPrompt, /without asking for another permission prompt/);
  } finally {
    worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('cloud Agent receives a tenant/user/task-scoped DingTalk bridge only for an owned explicit document task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-cloud-dingtalk-bridge-'));
  const envKeys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_E2E_DINGTALK', 'DOTS_PUBLIC_ORIGIN', 'DOTS_BASE_PATH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY', 'DOTS_COMPUTER_BACKEND', 'DOTS_AGENT_KERNELS_JSON', 'DOTS_KEYCHAIN_SERVICE', 'DOTS_TEST_MODEL_SECRET_DIR', 'DOTS_TEST_MODEL_SECRET_SCOPE', 'DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE'] as const;
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_DINGTALK: '1', DOTS_PUBLIC_ORIGIN: 'https://dots.example.test', DOTS_BASE_PATH: '/dots-demo',
    DOTS_MODEL_BASE_URL: 'https://api.example.test/v1', DOTS_MODEL: 'dingtalk-bridge-test-model', DOTS_MODEL_API_KEY: 'dingtalk-bridge-model-test-key',
    DOTS_COMPUTER_BACKEND: 'linux-desktop', DOTS_AGENT_KERNELS_JSON: JSON.stringify({ pi: { command: '/bin/false', args: [] } }),
    DOTS_KEYCHAIN_SERVICE: `com.cokepoppy.coke-dots.dingtalk.${randomUUID()}`,
    DOTS_TEST_MODEL_SECRET_DIR: join(directory, 'secrets'), DOTS_TEST_MODEL_SECRET_SCOPE: randomUUID(),
  });
  delete process.env.DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE;
  const store = new Store(directory);
  const account = store.signInGoogle({ subject: `cloud-dingtalk-${randomUUID()}`, email: 'cloud-dingtalk@example.test', name: 'Test Dot' });
  store.setAppSetting('modelBaseUrl', 'https://api.example.test/v1');
  store.setAppSetting('modelName', 'dingtalk-bridge-test-model');
  const task = store.createTask('请把这次排障报告写入钉钉文档', null, 'pi', account.tenant.id, null, null, [], account.user.id);
  let receivedBridge: { url: string; token: string; actions: Array<'search' | 'fetch' | 'create'> } | undefined;
  let receivedCalendarBridge: { url: string; token: string; actions: Array<'list' | 'create'> } | undefined;
  let receivedMinutesBridge: { url: string; token: string; actions: Array<'search' | 'detail'> } | undefined;
  let receivedSecretaryBridge: { url: string; token: string; actions: Array<'todo-list' | 'todo-create' | 'cokeclaw-send'> } | undefined;
  let receivedPrompt = '';
  const computer = {
    async runAgentTask(input: { prompt: string; dingtalkDocumentsBridge?: typeof receivedBridge; dingtalkCalendarBridge?: typeof receivedCalendarBridge; dingtalkMinutesBridge?: typeof receivedMinutesBridge; dingtalkSecretaryBridge?: typeof receivedSecretaryBridge }) {
      receivedPrompt = input.prompt;
      receivedBridge = input.dingtalkDocumentsBridge;
      receivedCalendarBridge = input.dingtalkCalendarBridge;
      receivedMinutesBridge = input.dingtalkMinutesBridge;
      receivedSecretaryBridge = input.dingtalkSecretaryBridge;
      return { status: 'done', message: 'Task completed.' };
    },
  } as unknown as ComputerRuntime;
  const service = new DingTalkService();
  const worker = new Worker(store, () => {}, join(directory, 'workspaces'), async () => {}, () => computer, service);

  try {
    await worker.tick();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && store.getTask(task.id, account.tenant.id)?.status === 'working') await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.getTask(task.id, account.tenant.id)?.status, 'done');
    assert.equal(store.taskOwnerUserId(task.id, account.tenant.id), account.user.id);
    assert(receivedBridge);
    assert.equal(receivedBridge.url, 'https://dots.example.test/dots-demo/api/agent/dingtalk/documents');
    assert.deepEqual(receivedBridge.actions, ['create']);
    const grant = service.verifyAgentDocumentGrant(receivedBridge.token);
    assert.equal(grant?.tenantId, account.tenant.id);
    assert.equal(grant?.userId, account.user.id);
    assert.equal(grant?.taskId, task.id);

    const readOnly = service.agentDocumentBridge(account.tenant.id, account.user.id, randomUUID(), '搜索钉钉文档');
    assert(readOnly);
    assert.deepEqual(readOnly.actions, ['search', 'fetch']);

    const calendarCall = store.createVoiceCall(account.tenant.id, account.user.id);
    const calendarTask = store.submitVoiceTurn({
      tenantId: account.tenant.id, userId: account.user.id, callId: calendarCall.id,
      turnId: 'voice-read-schedule-minutes-todos-0001', transcript: '我下周一有哪些北交所规则评审相关的日程、AI听记和待办？', engine: 'pi',
    }).task;
    await worker.tick();
    const calendarDeadline = Date.now() + 2_000;
    while (Date.now() < calendarDeadline && store.getTask(calendarTask.id, account.tenant.id)?.status === 'working') await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.getTask(calendarTask.id, account.tenant.id)?.status, 'done');
    assert(receivedCalendarBridge);
    assert.equal(receivedCalendarBridge.url, 'https://dots.example.test/dots-demo/api/agent/dingtalk/calendar');
    assert.deepEqual(receivedCalendarBridge.actions, ['list']);
    assert(receivedMinutesBridge, 'A spoken request to read meeting minutes must receive the task-bound read-only minutes bridge');
    assert.equal(receivedMinutesBridge.url, 'https://dots.example.test/dots-demo/api/agent/dingtalk/minutes');
    assert.deepEqual(receivedMinutesBridge.actions, ['search', 'detail']);
    const minutesGrant = service.verifyAgentMinutesGrant(receivedMinutesBridge.token);
    assert.equal(minutesGrant?.tenantId, account.tenant.id);
    assert.equal(minutesGrant?.userId, account.user.id);
    assert.equal(minutesGrant?.taskId, calendarTask.id);
    const calendarGrant = service.verifyAgentCalendarGrant(receivedCalendarBridge.token);
    assert.equal(calendarGrant?.tenantId, account.tenant.id);
    assert.equal(calendarGrant?.userId, account.user.id);
    assert.equal(calendarGrant?.taskId, calendarTask.id);
    assert(receivedSecretaryBridge, 'A spoken request for both events and todos must receive its scoped todo read capability');
    assert.deepEqual(receivedSecretaryBridge.actions, ['todo-list']);
    const todoReadGrant = service.verifyAgentSecretaryGrant(receivedSecretaryBridge.token);
    assert.equal(todoReadGrant?.tenantId, account.tenant.id);
    assert.equal(todoReadGrant?.userId, account.user.id);
    assert.equal(todoReadGrant?.taskId, calendarTask.id);

    const secretaryTask = store.createTask('读取日程与个人待办、安排准备会、创建个人待办，并把最终排障报告发送到 cokeclaw 群', null, 'pi', account.tenant.id, null, null, [], account.user.id);
    await worker.tick();
    const secretaryDeadline = Date.now() + 2_000;
    while (Date.now() < secretaryDeadline && store.getTask(secretaryTask.id, account.tenant.id)?.status === 'working') await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.getTask(secretaryTask.id, account.tenant.id)?.status, 'done');
    assert(receivedCalendarBridge);
    assert.deepEqual(receivedCalendarBridge.actions, ['list', 'create']);
    assert(receivedSecretaryBridge);
    assert.equal(receivedSecretaryBridge.url, 'https://dots.example.test/dots-demo/api/agent/dingtalk/secretary');
    assert.deepEqual(receivedSecretaryBridge.actions, ['todo-list', 'todo-create', 'cokeclaw-send']);
    const secretaryGrant = service.verifyAgentSecretaryGrant(receivedSecretaryBridge.token);
    assert.equal(secretaryGrant?.tenantId, account.tenant.id);
    assert.equal(secretaryGrant?.userId, account.user.id);
    assert.equal(secretaryGrant?.taskId, secretaryTask.id);

    const voiceCall = store.createVoiceCall(account.tenant.id, account.user.id);
    const initialVoiceTask = store.submitVoiceTurn({
      tenantId: account.tenant.id, userId: account.user.id, callId: voiceCall.id, turnId: 'voice-write-turn-0001',
      transcript: '请创建钉钉日历会议、创建个人待办，并把报告发送到 cokeclaw 群。', engine: 'pi',
    }).task;
    await worker.tick();
    const initialVoiceDeadline = Date.now() + 2_000;
    while (Date.now() < initialVoiceDeadline && store.getTask(initialVoiceTask.id, account.tenant.id)?.status === 'working') await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.getTask(initialVoiceTask.id, account.tenant.id)?.status, 'done');
    assert.deepEqual(receivedCalendarBridge?.actions, ['create']);
    assert.deepEqual(receivedSecretaryBridge?.actions, ['todo-create', 'cokeclaw-send']);
    assert.equal(receivedMinutesBridge, undefined, 'A write request without a minutes read must not receive the minutes capability');
    store.updateTask(initialVoiceTask.id, { status: 'done', result: '会议准备任务已记录。' }, account.tenant.id);

    const readFollowUp = store.submitVoiceTurn({
      tenantId: account.tenant.id, userId: account.user.id, callId: voiceCall.id, turnId: 'voice-read-turn-0002',
      transcript: '告诉我刚才那个会议的时间。', engine: 'pi',
    }).task;
    assert.match(readFollowUp.instruction, /Earlier turns from this voice call/);
    assert.match(readFollowUp.instruction, /请创建钉钉日历会议、创建个人待办，并把报告发送到 cokeclaw 群/,
      'The model still receives the complete prior-call context needed to resolve “that meeting”');
    await worker.tick();
    const readFollowUpDeadline = Date.now() + 2_000;
    while (Date.now() < readFollowUpDeadline && store.getTask(readFollowUp.id, account.tenant.id)?.status === 'working') await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.getTask(readFollowUp.id, account.tenant.id)?.status, 'done');
    assert.deepEqual(receivedCalendarBridge?.actions, ['list'], 'A read-only follow-up gets calendar read access, not the previous create grant');
    assert.equal(receivedSecretaryBridge, undefined, 'A read-only follow-up must not inherit the earlier todo-create or group-send grant');
    assert.match(receivedPrompt, /Earlier turns from this voice call/,
      'Restricting tool grants must not remove call history from the Agent prompt');

    const explicitWriteFollowUp = store.submitVoiceTurn({
      tenantId: account.tenant.id, userId: account.user.id, callId: voiceCall.id, turnId: 'voice-write-turn-0003',
      transcript: '请再创建一个钉钉日历会议。', engine: 'pi',
    }).task;
    await worker.tick();
    const explicitWriteDeadline = Date.now() + 2_000;
    while (Date.now() < explicitWriteDeadline && store.getTask(explicitWriteFollowUp.id, account.tenant.id)?.status === 'working') await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.getTask(explicitWriteFollowUp.id, account.tenant.id)?.status, 'done');
    assert.deepEqual(receivedCalendarBridge?.actions, ['create'], 'An explicit current-turn create request still receives the required write action');
    assert.equal(receivedSecretaryBridge, undefined, 'Unrelated earlier secretary actions do not leak into a new calendar write turn');

    const clarificationTask = store.createTask('请为北交所规则评审创建一个钉钉日历会议。', null, 'pi', account.tenant.id, null, null, [], account.user.id);
    store.updateTask(clarificationTask.id, { status: 'waiting', nextRunAt: null }, account.tenant.id);
    const clarificationCall = store.createVoiceCall(account.tenant.id, account.user.id);
    const clarifiedTask = store.submitVoiceTurn({
      tenantId: account.tenant.id, userId: account.user.id, callId: clarificationCall.id, turnId: 'voice-clarify-turn-0001',
      transcript: '安排在10月19日上午10点。', engine: 'pi', waitingTaskId: clarificationTask.id,
    }).task;
    await worker.tick();
    const clarificationDeadline = Date.now() + 2_000;
    while (Date.now() < clarificationDeadline && store.getTask(clarifiedTask.id, account.tenant.id)?.status === 'working') await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.getTask(clarifiedTask.id, account.tenant.id)?.status, 'done');
    assert.deepEqual(receivedCalendarBridge?.actions, ['create'], 'A reply that answers an Agent clarification keeps the explicit write request in that same task');
  } finally {
    worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('a cloud Agent task interrupted by computer takeover is persisted as paused and can be resumed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-computer-takeover-pause-'));
  const envKeys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY', 'DOTS_COMPUTER_BACKEND', 'DOTS_AGENT_KERNELS_JSON', 'DOTS_KEYCHAIN_SERVICE', 'DOTS_TEST_MODEL_SECRET_DIR', 'DOTS_TEST_MODEL_SECRET_SCOPE', 'DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE'] as const;
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_MODEL_BASE_URL: 'https://api.example.test/v1', DOTS_MODEL: 'cloud-pause-test-model',
    DOTS_MODEL_API_KEY: 'cloud-pause-fixture-key', DOTS_COMPUTER_BACKEND: 'linux-desktop',
    DOTS_AGENT_KERNELS_JSON: JSON.stringify({ pi: { command: '/bin/false', args: [] } }), DOTS_KEYCHAIN_SERVICE: `com.cokepoppy.coke-dots.pause.${randomUUID()}`,
  });
  delete process.env.DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE;
  const store = new Store(directory);
  const account = store.signInGoogle({ subject: `computer-pause-${randomUUID()}`, email: 'computer-pause@example.test', name: 'Test Dot' });
  store.setAppSetting('modelBaseUrl', 'https://api.example.test/v1');
  store.setAppSetting('modelName', 'cloud-pause-test-model');
  const task = store.createTask('Pause when computer is taken over', null, 'pi', account.tenant.id);
  let dispatches = 0;
  const computer = {
    async runAgentTask() {
      dispatches += 1;
      if (dispatches === 1) throw new ComputerControlOwnedByUserError();
      return { status: 'done', message: 'Task resumed after computer control returned.' };
    },
  } as unknown as ComputerRuntime;
  const worker = new Worker(store, () => {}, join(directory, 'workspaces'), async () => {}, () => computer);

  try {
    await worker.tick();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && store.getTask(task.id, account.tenant.id)?.status === 'working') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const paused = store.getTask(task.id, account.tenant.id);
    assert.equal(dispatches, 1);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.nextRunAt, null);
    assert.equal(paused?.result, null);
    assert.match(paused?.error || '', /用户正在接管云电脑.*点击“继续”/);
    assert.equal(store.activityPage(account.tenant.id).entries.some(entry => entry.taskId === task.id && entry.body === paused?.error), true);

    store.updateTask(task.id, { status: 'queued', nextRunAt: new Date().toISOString(), error: null }, account.tenant.id);
    await worker.tick();
    const resumeDeadline = Date.now() + 2_000;
    while (Date.now() < resumeDeadline && store.getTask(task.id, account.tenant.id)?.status === 'working') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(dispatches, 2, 'Resuming after the user returns control should dispatch the task again');
    assert.equal(store.getTask(task.id, account.tenant.id)?.status, 'done');
    assert.equal(store.getTask(task.id, account.tenant.id)?.result, 'Task resumed after computer control returned.');
  } finally {
    worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
