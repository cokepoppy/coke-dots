/** Decode SeedDuplex normalized little-endian float32 PCM to Web Audio samples. */
export function decodeVolcengineFloat32Pcm(bytes: ArrayBuffer): Float32Array | null {
  if (bytes.byteLength < 4 || bytes.byteLength % 4 !== 0) return null;
  const view = new DataView(bytes);
  const samples = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = view.getFloat32(index * 4, true);
    samples[index] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
  }
  return samples;
}
