import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/server/store.ts';

test('DingTalk group selections are isolated by both Dots tenant and user', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-dingtalk-scope-'));
  try {
    const store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'dingtalk-alpha', email: 'dingtalk-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'dingtalk-beta', email: 'dingtalk-beta@example.test', name: 'Beta' });
    const groups = [{ conversationId: 'cid-alerts', name: '系统监控告警群' }];

    const saved = store.replaceDingtalkGroupSelections(alpha.tenant.id, alpha.user.id, groups);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.groupName, '系统监控告警群');
    assert.deepEqual(store.dingtalkGroupSelections(beta.tenant.id, beta.user.id), []);
    assert.equal(store.replaceDingtalkGroupSelections(beta.tenant.id, beta.user.id, groups).length, 1);
    assert.equal(store.dingtalkGroupSelections(alpha.tenant.id, alpha.user.id)[0]?.groupName, '系统监控告警群');
    assert.throws(() => store.replaceDingtalkGroupSelections(alpha.tenant.id, alpha.user.id,
      Array.from({ length: 21 }, (_, index) => ({ conversationId: `cid-${index}`, name: `群 ${index}` }))), /最多可以选择 20 个钉钉群/);
    assert.throws(() => store.replaceDingtalkGroupSelections(alpha.tenant.id, alpha.user.id, [groups[0]!, groups[0]!]), /不能重复选择/);

    store.clearDingtalkGroupSelections(alpha.tenant.id, alpha.user.id);
    assert.deepEqual(store.dingtalkGroupSelections(alpha.tenant.id, alpha.user.id), []);
    assert.equal(store.dingtalkGroupSelections(beta.tenant.id, beta.user.id).length, 1, 'Disconnecting one Dots identity must not clear another account');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
