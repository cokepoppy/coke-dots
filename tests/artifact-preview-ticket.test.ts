import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArtifactPreviewTicket, verifyArtifactPreviewTicket } from '../src/server/artifact-preview-ticket.ts';

const taskId = 'd4d39c7e-5f39-4a40-a51c-07bb73bfa213';

test('artifact preview tickets are short-lived and bound to a tenant task', () => {
  const now = 1_000_000;
  const ticket = createArtifactPreviewTicket('tenant-alpha', taskId, now);
  assert.deepEqual(verifyArtifactPreviewTicket(ticket, now), {
    tenantId: 'tenant-alpha', taskId, expiresAt: now + 5 * 60_000,
  });
  assert.equal(verifyArtifactPreviewTicket(ticket, now + 5 * 60_000), null);
  const [payload, signature] = ticket.split('.');
  const changed = `${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(verifyArtifactPreviewTicket(changed, now), null);
});
