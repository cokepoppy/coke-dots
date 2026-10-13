export interface Pcm16Wave {
  sampleRate: number;
  channels: number;
  samples: Float32Array;
}

export function parsePcm16Wave(wav: Buffer): Pcm16Wave {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Acoustic capture is not a RIFF/WAVE file.');
  }
  let format: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const chunk = wav.toString('ascii', offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + length > wav.length) throw new Error('Acoustic capture has a truncated WAV chunk.');
    if (chunk === 'fmt ' && length >= 16) {
      format = wav.readUInt16LE(body);
      channels = wav.readUInt16LE(body + 2);
      sampleRate = wav.readUInt32LE(body + 4);
      bitsPerSample = wav.readUInt16LE(body + 14);
    } else if (chunk === 'data') {
      dataOffset = body;
      dataLength = length;
    }
    offset = body + length + (length & 1);
  }
  if (format !== 1 || channels !== 1 || bitsPerSample !== 16 || !sampleRate || dataOffset < 0 || dataLength % 2 !== 0) {
    throw new Error('Acoustic capture must be mono 16-bit PCM with a valid sample rate.');
  }
  const samples = new Float32Array(dataLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = wav.readInt16LE(dataOffset + index * 2) / 32768;
  return { sampleRate, channels, samples };
}

export function pcmWaveStats(wave: Pcm16Wave) {
  if (!wave.samples.length) throw new Error('Acoustic capture contains no samples.');
  let sumSquares = 0;
  let peak = 0;
  for (const sample of wave.samples) {
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return { durationSeconds: wave.samples.length / wave.sampleRate, rms: Math.sqrt(sumSquares / wave.samples.length), peak };
}

function rmsEnvelope(wave: Pcm16Wave, windowMs: number): Float64Array {
  const windowSize = Math.max(1, Math.round(wave.sampleRate * windowMs / 1000));
  const count = Math.floor(wave.samples.length / windowSize);
  const envelope = new Float64Array(count);
  for (let window = 0; window < count; window += 1) {
    let sumSquares = 0;
    const start = window * windowSize;
    for (let index = start; index < start + windowSize; index += 1) sumSquares += wave.samples[index] * wave.samples[index];
    envelope[window] = Math.sqrt(sumSquares / windowSize);
  }
  return envelope;
}

/** Match 20 ms loudness contours while allowing the microphone and speaker a bounded startup delay. */
export function bestRmsEnvelopeCorrelation(reference: Pcm16Wave, captured: Pcm16Wave, maxLagMs = 2000, windowMs = 20): number {
  const expected = rmsEnvelope(reference, windowMs);
  const actual = rmsEnvelope(captured, windowMs);
  const maxLag = Math.min(Math.floor(maxLagMs / windowMs), Math.max(0, actual.length - 25));
  let best = -1;
  for (let lag = 0; lag <= maxLag; lag += 1) {
    const count = Math.min(expected.length, actual.length - lag);
    if (count < 25) continue;
    let meanExpected = 0;
    let meanActual = 0;
    for (let index = 0; index < count; index += 1) {
      meanExpected += expected[index];
      meanActual += actual[index + lag];
    }
    meanExpected /= count;
    meanActual /= count;
    let covariance = 0;
    let varianceExpected = 0;
    let varianceActual = 0;
    for (let index = 0; index < count; index += 1) {
      const left = expected[index] - meanExpected;
      const right = actual[index + lag] - meanActual;
      covariance += left * right;
      varianceExpected += left * left;
      varianceActual += right * right;
    }
    const denominator = Math.sqrt(varianceExpected * varianceActual);
    if (denominator > 0) best = Math.max(best, covariance / denominator);
  }
  return best;
}
