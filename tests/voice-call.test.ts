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
