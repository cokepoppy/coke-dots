import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/server/store.ts';

test('Slack OAuth state is tenant and user scoped, expires, and can only be consumed once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-slack-state-'));
  try {
    const store = new Store(directory);
    const owner = store.signInGoogle({ subject: 'slack-flow-owner', email: 'slack-owner@example.test', name: 'Slack Owner' });
    const stateHash = 'state-hash-alpha';
    store.createSlackOAuthFlow({ stateHash, tenantId: owner.tenant.id, userId: owner.user.id, expiresAt: '2099-01-01T00:00:00.000Z', returnTo: 'https://dots.example.test' });
    assert.deepEqual(store.consumeSlackOAuthFlow(stateHash, '2026-10-08T00:00:00.000Z'), {
      tenantId: owner.tenant.id, userId: owner.user.id, expiresAt: '2099-01-01T00:00:00.000Z', returnTo: 'https://dots.example.test',
    });
    assert.equal(store.consumeSlackOAuthFlow(stateHash), null, 'OAuth state must be single use');
    store.createSlackOAuthFlow({ stateHash: 'expired-state', tenantId: owner.tenant.id, userId: owner.user.id, expiresAt: '2025-01-01T00:00:00.000Z', returnTo: 'https://dots.example.test' });
    assert.equal(store.consumeSlackOAuthFlow('expired-state', '2026-10-08T00:00:00.000Z'), null, 'An expired flow must not be consumable');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Slack installations and selected contact workspace stay isolated between Coke Dots tenants', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-slack-tenant-'));
  try {
    const store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'slack-alpha', email: 'slack-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'slack-beta', email: 'slack-beta@example.test', name: 'Beta' });
    const installation = (tenantId: string, teamName: string) => ({
      tenantId, teamId: 'TASPI', teamName, scopes: ['chat:write'], installedAt: '2026-10-08T00:00:00.000Z',
    });
    store.installSlackWorkspace(installation(alpha.tenant.id, 'Alpha Slack'));
    store.installSlackWorkspace(installation(beta.tenant.id, 'Beta Slack'));
    assert.equal(store.setSlackContactWorkspace(alpha.tenant.id, 'TASPI'), true);
    assert.equal(store.setSlackContactWorkspace(beta.tenant.id, 'TASPI'), true);
    assert.equal(store.setSlackContactWorkspace(alpha.tenant.id, 'TOTHER'), false, 'A tenant cannot select a Slack workspace installed in another tenant');
    assert.equal(store.slackInstallations(alpha.tenant.id)[0]?.teamName, 'Alpha Slack');
    assert.equal(store.slackInstallations(alpha.tenant.id)[0]?.contactEnabled, true);
    assert.equal(store.slackInstallations(beta.tenant.id)[0]?.teamName, 'Beta Slack');
    assert.equal(store.slackInstallations(beta.tenant.id)[0]?.contactEnabled, true);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
