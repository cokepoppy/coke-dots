import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecret } from '../src/shared/redact-secret.ts';

test('live model errors redact the submitted key and bearer tokens', () => {
  const apiKey = 'sk-private-smoke-key';
  assert.equal(
    redactSecret(`Provider echoed ${apiKey}; authorization was Bearer ${apiKey}`, apiKey),
    'Provider echoed [redacted]; authorization was Bearer [redacted]',
  );
});
