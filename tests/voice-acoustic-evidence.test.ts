import assert from 'node:assert/strict';
import test from 'node:test';
import { bestRmsEnvelopeCorrelation, parsePcm16Wave, pcmWaveStats, type Pcm16Wave } from './e2e/voice-acoustic-evidence.ts';

function makeWave(sampleRate: number, durationSeconds: number, envelope: (time: number) => number, delaySeconds = 0): Pcm16Wave {
  const samples = new Float32Array(Math.round(sampleRate * (durationSeconds + delaySeconds)));
  for (let index = 0; index < sampleRate * durationSeconds; index += 1) {
    const time = index / sampleRate;
    const modulation = envelope(Math.floor(time / 0.02));
    samples[Math.round(delaySeconds * sampleRate) + index] = modulation * Math.sin(2 * Math.PI * 440 * time);
  }
  return { sampleRate, channels: 1, samples };
}

function toPcm16Wav(wave: Pcm16Wave) {
  const pcm = Buffer.alloc(wave.samples.length * 2);
  for (let index = 0; index < wave.samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, wave.samples[index]));
    pcm.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(wave.sampleRate, 24); header.writeUInt32LE(wave.sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

test('physical speaker evidence parses mono PCM WAV and reports level', () => {
  const original = makeWave(8000, 1, () => 0.2);
  const parsed = parsePcm16Wave(toPcm16Wav(original));
  const stats = pcmWaveStats(parsed);
  assert.equal(parsed.sampleRate, 8000);
  assert.equal(parsed.samples.length, 8000);
  assert(stats.rms > 0.13 && stats.rms < 0.15);
  assert(stats.peak > 0.19 && stats.peak <= 0.201);
  assert.throws(() => parsePcm16Wave(Buffer.from('not-a-wave')),/RIFF\/WAVE/);
});

test('speaker capture correlates with the returned speech envelope despite startup delay', () => {
  const envelope = (frame: number) => 0.08 + (((frame * 17 + 13) % 23) / 23) * 0.55;
  const expected = makeWave(24_000, 5, envelope);
  const captured = makeWave(48_000, 5, frame => envelope(frame) * 0.22 + 0.01, 0.42);
  const correlation = bestRmsEnvelopeCorrelation(expected, captured);
  assert(correlation > 0.95, `Expected matching speech envelope, got ${correlation}`);

  const unrelated = makeWave(48_000, 5, frame => 0.09 + (((frame * 7 + 4) % 29) / 29) * 0.45, 0.42);
  assert(bestRmsEnvelopeCorrelation(expected, unrelated) < 0.25, 'Unrelated ambient sound must not count as speaker playback');
});
