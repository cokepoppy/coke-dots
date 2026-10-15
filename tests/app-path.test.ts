import assert from 'node:assert/strict';
import test from 'node:test';
import { originRelativePathForBase, pathForBase } from '../src/web/api.ts';

test('app paths preserve a public mount prefix', () => {
  assert.equal(pathForBase('/dots-demo/', '/api/computer'), '/dots-demo/api/computer');
  assert.equal(pathForBase('/', '/api/computer'), '/api/computer');
});

test('noVNC origin-relative paths include the public mount prefix', () => {
  assert.equal(originRelativePathForBase('/dots-demo/', '/api/computer/novnc/websockify'), 'dots-demo/api/computer/novnc/websockify');
  assert.equal(originRelativePathForBase('/', '/api/computer/novnc/websockify'), 'api/computer/novnc/websockify');
});
