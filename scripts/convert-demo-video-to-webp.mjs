import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import sharp from 'sharp';

const [sourceArgument, outputArgument, waitsArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) throw new Error('Usage: node scripts/convert-demo-video-to-webp.mjs <input.webm> <output.webp>');
const source = resolve(sourceArgument);
const output = resolve(outputArgument);
const scratch = await mkdtemp(`${tmpdir()}/coke-dots-webp-`);
const gif = resolve(scratch, `${basename(output, '.webp')}.gif`);

function probe(path, requireDuration = true) {
  const raw = execFileSync('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,duration,nb_read_frames:format=format_name,duration',
    '-of', 'json', path,
  ], { encoding: 'utf8' });
  const data = JSON.parse(raw);
  const stream = data.streams?.[0];
  const duration = Number(stream?.duration || data.format?.duration);
  const frames = Number(stream?.nb_read_frames);
  if (!stream || (requireDuration && !Number.isFinite(duration)) || !Number.isFinite(frames)) throw new Error(`Could not inspect video: ${path}`);
  return { codec: stream.codec_name, width: stream.width, height: stream.height, duration: Number.isFinite(duration) ? duration : null, frames };
}

async function longWaitCuts(duration) {
  if (!waitsArgument) return [];
  const value = JSON.parse(await readFile(resolve(waitsArgument), 'utf8'));
  if (!Array.isArray(value)) throw new Error('Wait markers must be a JSON array');
  const intervals = value.map(interval => {
    const start = Number(interval?.startMs) / 1000;
    const end = Number(interval?.endMs) / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('A recorded wait interval is invalid');
    return { start: Math.min(start, duration), end: Math.min(end, duration) };
  }).filter(interval => interval.end > interval.start).sort((left, right) => left.start - right.start);
  const merged = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && interval.start <= prior.end + 0.1) prior.end = Math.max(prior.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged.flatMap(interval => {
    const holdAtStart = 1.5;
    const holdAtEnd = 1.25;
    const start = interval.start + holdAtStart;
    const end = interval.end - holdAtEnd;
    return end - start >= 2 ? [{ start, end }] : [];
  });
}

function buildVideoFilter(duration, cuts) {
  let cursor = 0;
  const ranges = [];
  for (const cut of cuts) {
    if (cut.start > cursor) ranges.push([cursor, cut.start]);
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < duration) ranges.push([cursor, duration]);
  if (!ranges.length) ranges.push([0, duration]);
  const inputs = ranges.map(([start, end], index) => `[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`);
  const joined = ranges.length === 1 ? '[v0]' : `${ranges.map((_, index) => `[v${index}]`).join('')}concat=n=${ranges.length}:v=1:a=0[joined]`;
  const prefix = ranges.length === 1 ? inputs[0] : `${inputs.join(';')};${joined}`;
  return `${prefix};${ranges.length === 1 ? '[v0]' : '[joined]'}fps=10,scale=1152:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3[out]`;
}

try {
  const input = probe(source);
  if (input.duration < 5 || input.frames < 30) throw new Error(`Source is not a complete UI recording: ${JSON.stringify(input)}`);
  const cuts = await longWaitCuts(input.duration || 0);
  const removedDuration = cuts.reduce((total, cut) => total + cut.end - cut.start, 0);
  const expectedDuration = input.duration - removedDuration;
  const filter = buildVideoFilter(input.duration || 0, cuts);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-filter_complex', filter, '-map', '[out]', '-loop', '0', '-f', 'gif', gif,
  ], { stdio: 'inherit' });
  await sharp(gif, { animated: true }).webp({ quality: 84, effort: 5, loop: 0 }).toFile(output);

  const metadata = await sharp(output, { animated: true }).metadata();
  const converted = probe(output, false);
  const file = await stat(output);
  const playbackDuration = (metadata.delay || []).reduce((total, delay) => total + delay, 0) / 1000;
  if (metadata.format !== 'webp' || (metadata.pages || 0) < 30 || converted.frames < 30 ||
      (metadata.delay || []).length !== metadata.pages || Math.abs(playbackDuration - expectedDuration) > 0.75 || file.size < 10_000) {
    throw new Error(`WebP output is incomplete or playback timing changed: ${JSON.stringify({ input, converted, playbackDuration, format: metadata.format, pages: metadata.pages, bytes: file.size })}`);
  }
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output, '-f', 'null', '-'], { stdio: 'ignore' });
  console.log(`Created ${output} (${converted.width}x${converted.height}, ${converted.frames} frames, ${playbackDuration.toFixed(1)}s at source speed, removed ${removedDuration.toFixed(1)}s of long waits, ${(file.size / 1024 / 1024).toFixed(2)} MiB)`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
