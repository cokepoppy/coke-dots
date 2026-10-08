import assert from 'node:assert/strict';
import test from 'node:test';
import { toPublicComputerActionRecord } from '../deploy/linux-desktop/computer-action-log.mjs';

test('computer action logging skips the blank welcome page and records public page hosts', () => {
  assert.equal(toPublicComputerActionRecord('inspect', 'about:blank'), null);
  assert.equal(toPublicComputerActionRecord('inspect', 'not a URL'), null);
  assert.deepEqual(toPublicComputerActionRecord('navigate', 'https://Research-Fixture.Dots.Test/launch'), {
    action: 'navigate',
    host: 'research-fixture.dots.test',
  });
  assert.deepEqual(toPublicComputerActionRecord('click', 'https://research-fixture.dots.test/launch'), {
    action: 'click',
    host: 'research-fixture.dots.test',
  });
  assert.equal(toPublicComputerActionRecord('type', 'https://research-fixture.dots.test/launch'), null);
});
