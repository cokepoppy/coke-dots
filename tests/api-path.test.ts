import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appPath } from '../src/web/api.ts';

test('app API paths stay under the configured public base path', () => {
  assert.equal(appPath('/api/events', '/dots-demo/'), '/dots-demo/api/events');
  assert.equal(appPath('api/voice/provider', '/dots-demo/'), '/dots-demo/api/voice/provider');
  assert.equal(appPath('/api/events', '/'), '/api/events');
});
