import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAgentPrompt, type AgentRequest } from '../src/server/adapters.ts';

const baseRequest: AgentRequest = {
  prompt: 'Create a Minesweeper game in the cloud computer.',
  priorResult: null,
  sessionId: null,
  workspace: '/private/workspace/task',
  onEvent: () => {},
};

test('cloud-computer tasks can write deliverables in their task directory without repeated approval', () => {
  const prompt = formatAgentPrompt({ ...baseRequest, cloudComputerTask: true });
  assert.match(prompt, /read, create, and edit files in the current working directory without asking the user for another approval/);
  assert.match(prompt, /Save requested deliverables there and report their relative paths/);
  assert.match(prompt, /Do not write outside the current task directory/);
  assert.doesNotMatch(prompt, /Do not .*edit files/);
});

test('non-cloud tasks are not told they can write files', () => {
  const prompt = formatAgentPrompt(baseRequest);
  assert.match(prompt, /no writable cloud-computer task directory/);
  assert.doesNotMatch(prompt, /without asking the user for another approval/);
});
