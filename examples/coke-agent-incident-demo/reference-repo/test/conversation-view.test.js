import test from 'node:test';
import assert from 'node:assert/strict';
import { getConversationState, renderConversation } from '../src/conversation-view.js';

test('an existing conversation keeps its messages', () => {
  const messages = [{ role: 'user', text: '你好' }];
  assert.deepEqual(getConversationState({ messages }), { status: 'ready', messages });
});

test('a new conversation with no API session renders the empty state', () => {
  assert.deepEqual(getConversationState(null), { status: 'empty', messages: [] });
});
