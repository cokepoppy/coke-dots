import assert from 'node:assert/strict';
import { test } from 'node:test';
import { e2eBlockedComputerPattern } from '../src/server/computer.ts';

test('computer browser failures are injected only by a validated authenticated E2E route', () => {
  const fixture = {
    NODE_ENV: 'test',
    DOTS_E2E_AUTH: '1',
    DOTS_E2E_COMPUTER_BLOCK_URL: 'https://www.amazon.com/**',
  };
  assert.equal(e2eBlockedComputerPattern(fixture), 'https://www.amazon.com/**');
  assert.equal(e2eBlockedComputerPattern({ ...fixture, NODE_ENV: 'production' }), null);
  assert.equal(e2eBlockedComputerPattern({ ...fixture, DOTS_E2E_AUTH: '0' }), null);
  assert.equal(e2eBlockedComputerPattern({ ...fixture, DOTS_E2E_COMPUTER_BLOCK_URL: 'https://www.amazon.com' }), null);
  assert.equal(e2eBlockedComputerPattern({ ...fixture, DOTS_E2E_COMPUTER_BLOCK_URL: 'https://user:secret@example.com/**' }), null);
});
