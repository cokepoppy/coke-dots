import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiErrorResponse, LinuxDesktopWorkerError } from '../src/server/computer-errors.ts';

test('recoverable cloud-computer worker failures keep their status and stable code at the API boundary', () => {
  const failure = apiErrorResponse(new LinuxDesktopWorkerError(
    '云电脑浏览器上下文尚未就绪，系统正在自动恢复',
    503,
    'DOTS_BROWSER_CONTEXT_UNAVAILABLE',
  ));
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, {
    error: '云电脑浏览器上下文尚未就绪，系统正在自动恢复',
    code: 'DOTS_BROWSER_CONTEXT_UNAVAILABLE',
  });
});

test('worker authentication failures are surfaced as gateway errors', () => {
  assert.equal(new LinuxDesktopWorkerError('worker auth failed', 401).statusCode, 502);
});

test('untrusted upstream error codes are omitted from the public payload', () => {
  const failure = apiErrorResponse(new LinuxDesktopWorkerError('worker error', 503, 'bad code\nsecret'));
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, { error: 'worker error' });
});
