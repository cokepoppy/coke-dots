import assert from 'node:assert/strict';
import test from 'node:test';
import { insertDictation, transcriptFromResults } from '../src/shared/dictation.ts';

test('dictation joins final and interim speech segments in order', () => {
  const results = [
    Object.assign([{ transcript: 'Please prepare' }], { isFinal: true }),
    Object.assign([{ transcript: ' the review notes' }], { isFinal: false }),
  ];
  assert.equal(transcriptFromResults(results), 'Please prepare the review notes');
  assert.equal(transcriptFromResults([{ 0: { transcript: '你好' }, length: 1 }, { 0: { transcript: '世界' }, length: 1 }]), '你好世界');
});

test('dictation appends to an existing draft and preserves its spacing', () => {
  assert.equal(insertDictation('Prepare a short agenda', 'for Friday'), 'Prepare a short agenda for Friday');
  assert.equal(insertDictation('Prepare a short agenda ', 'for Friday'), 'Prepare a short agenda for Friday');
  assert.equal(insertDictation('', '  for Friday  '), 'for Friday');
  assert.equal(insertDictation('创建', '文档'), '创建文档');
  assert.equal(insertDictation('Draft today', 'tomorrow', 6, 11), 'Draft tomorrow');
  assert.equal(insertDictation('hello world', 'carefully', 5, 5), 'hello carefully world');
  assert.equal(insertDictation('Hello,', 'world'), 'Hello, world');
  assert.equal(insertDictation('你好，', '世界'), '你好，世界');
});

test('empty recognition does not erase or extend the draft', () => {
  assert.equal(insertDictation('Keep this draft', '   '), 'Keep this draft');
});
