import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpeechTurnCollector } from '../src/shared/speech-turn.ts';

function result(transcript: string, isFinal = true) {
  return Object.assign([{ transcript }], { isFinal });
}

test('cumulative Web Speech final-result events produce one ordered utterance', () => {
  const turn = new SpeechTurnCollector();
  const first = result('请在云电脑里');
  const second = result('创建扫雷游戏');

  turn.accept(0, [first]);
  // Chrome can report the same final result again along with the next result.
  turn.accept(0, [first, second]);
  turn.accept(1, [first, second]);

  assert.equal(turn.finish(), '请在云电脑里 创建扫雷游戏');
  assert.equal(turn.finish(), '', 'A recognition turn must only be consumed once');
});

test('interim results are not sent if recognition ends before a final result', () => {
  const turn = new SpeechTurnCollector();
  turn.accept(0, [result('未完成的识别', false)]);
  assert.equal(turn.finish(), '');
});
