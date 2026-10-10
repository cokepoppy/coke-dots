import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiErrorResponse, LinuxDesktopWorkerError } from '../src/server/computer-errors.ts';

test('recoverable cloud-computer worker failures keep their status and stable code at the API boundary', () => {
  const failure = apiErrorResponse(new LinuxDesktopWorkerError(
    '云电脑中的 Chromium 浏览器上下文暂不可用，正在重新连接',
    503,
    'DOTS_BROWSER_CONTEXT_UNAVAILABLE',
  ));
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, {
    error: '云电脑中的 Chromium 浏览器上下文暂不可用，正在重新连接',
    code: 'DOTS_BROWSER_CONTEXT_UNAVAILABLE',
  });
});

test('worker authentication and unexpected upstream errors map to gateway errors', () => {
  assert.equal(new LinuxDesktopWorkerError('worker auth failed', 401).statusCode, 502);
  assert.equal(new LinuxDesktopWorkerError('worker exploded', 500).statusCode, 502);
});

test('untrusted upstream error codes are omitted from public payloads', () => {
  const failure = apiErrorResponse(new LinuxDesktopWorkerError('worker error', 503, 'BAD CODE\nsecret'));
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, { error: 'worker error' });
});
