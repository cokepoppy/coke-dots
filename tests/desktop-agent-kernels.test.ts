import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopAgentEngineIds, desktopAgentKernels } from '../src/server/desktop-agent-kernels.ts';

test('Linux desktop gets the Pi cloud kernel by default when Pi is enabled', () => {
  const environment = { DOTS_COMPUTER_BACKEND: 'linux-desktop', DOTS_PI_ENABLED: '1' };
  assert.deepEqual(desktopAgentKernels(environment), {
    pi: { command: 'node', args: ['/opt/coke-dots/cloud-kernel-adapter.mjs'] },
  });
  assert.deepEqual(desktopAgentEngineIds(environment), ['pi']);
});

test('explicit kernel JSON overrides the Pi default and only enables supported valid adapters', () => {
  const environment = {
    DOTS_COMPUTER_BACKEND: 'linux-desktop',
    DOTS_PI_ENABLED: '1',
    DOTS_AGENT_KERNELS_JSON: JSON.stringify({
      dsh: { command: 'dsh', args: ['--profile', 'sdk'] },
      claude: { command: 'claude', args: [] },
      piBroken: { command: '', args: [] },
    }),
  };
  assert.deepEqual(desktopAgentKernels(environment), { dsh: { command: 'dsh', args: ['--profile', 'sdk'] } });
  assert.deepEqual(desktopAgentKernels({ ...environment, DOTS_AGENT_KERNELS_JSON: '{}' }), {});
});

test('Pi cloud kernel is not advertised outside Linux desktop mode or when explicitly disabled', () => {
  assert.deepEqual(desktopAgentKernels({ DOTS_PI_ENABLED: '1' }), {});
  assert.deepEqual(desktopAgentKernels({ DOTS_COMPUTER_BACKEND: 'linux-desktop', DOTS_PI_ENABLED: '0' }), {});
});
