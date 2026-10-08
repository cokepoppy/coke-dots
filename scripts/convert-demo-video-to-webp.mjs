import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import sharp from 'sharp';

const [sourceArgument, outputArgument, retainedStillArgument, activePlaybackRateArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) throw new Error('Usage: node scripts/convert-demo-video-to-webp.mjs <input.webm> <output.webp> [readable-still-seconds] [active-playback-rate]');
const retainedStillSeconds = retainedStillArgument === undefined ? 1.5 : Number(retainedStillArgument);
if (!Number.isFinite(retainedStillSeconds) || retainedStillSeconds <= 0 || retainedStillSeconds > 10) {
  throw new Error('readable-still-seconds must be greater than 0 and at most 10');
}
const activePlaybackRate = activePlaybackRateArgument === undefined ? 1 : Number(activePlaybackRateArgument);
if (!Number.isFinite(activePlaybackRate) || activePlaybackRate < 0.5 || activePlaybackRate > 1) {
  throw new Error('active-playback-rate must be between 0.5 and 1');
}
const source = resolve(sourceArgument);
const output = resolve(outputArgument);
const scratch = await mkdtemp(`${tmpdir()}/coke-dots-webp-`);
const gif = resolve(scratch, `${basename(output, '.webp')}.gif`);

function runFfmpeg(args, { capture = false } = {}) {
  const result = spawnSync('ffmpeg', args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited with ${result.status ?? result.signal}: ${(result.stderr || result.stdout || '').slice(-1200)}`);
  return result.stderr || '';
}

function detectFrozenIntervals(input, duration) {
  const output = runFfmpeg([
    '-hide_banner', '-nostats', '-loglevel', 'info', '-i', input,
    '-vf', 'freezedetect=n=-45dB:d=2', '-an', '-f', 'null', '-',
  ], { capture: true });
  const intervals = [];
  let active = null;
  for (const line of output.split(/\r?\n/)) {
    const event = line.match(/lavfi\.freezedetect\.(freeze_start|freeze_end|freeze_duration):\s*([0-9.]+)/);
    if (!event) continue;
    const [, kind, rawValue] = event;
    const value = Number(rawValue);
    if (kind === 'freeze_start') active = { start: value, end: null, detectedDuration: null };
    else if (active && kind === 'freeze_duration') active.detectedDuration = value;
    else if (active && kind === 'freeze_end') {
      active.end = value;
      intervals.push(active);
      active = null;
    }
  }
  if (active) {
    active.end = Math.min(duration, active.start + (active.detectedDuration ?? duration - active.start));
    intervals.push(active);
  }
  return intervals.filter(interval => interval.end > interval.start);
}

function buildVisibleSegments(duration, freezes, retainedStillSeconds = 1.5, activeRate = 1) {
  const segments = [];
  let cursor = 0;
  let removedSeconds = 0;
  for (const freeze of freezes) {
    const length = freeze.end - freeze.start;
    // Keep the closing state long enough to read; it is the demo's end card.
    const isClosingHold = freeze.end >= duration - 0.05;
    if (!isClosingHold && length <= retainedStillSeconds + 0.05) continue;
    if (freeze.start > cursor + 0.02) segments.push({ start: cursor, end: freeze.start, playbackRate: activeRate });
    const visibleUntil = isClosingHold ? freeze.end : Math.min(freeze.end, freeze.start + retainedStillSeconds);
    if (visibleUntil > freeze.start + 0.02) segments.push({ start: freeze.start, end: visibleUntil, playbackRate: 1 });
    cursor = Math.max(cursor, freeze.end);
    if (!isClosingHold) removedSeconds += Math.max(0, length - retainedStillSeconds);
  }
  if (duration > cursor + 0.02) segments.push({ start: cursor, end: duration, playbackRate: activeRate });
  if (!segments.length) segments.push({ start: 0, end: duration, playbackRate: 1 });
  return { segments, removedSeconds, visibleDuration: segments.reduce((sum, segment) => sum + segment.end - segment.start, 0) };
}

function buildFilterGraph(segments, fps, width, height) {
  const trims = segments.map((segment, index) =>
    `[0:v]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=(PTS-STARTPTS)/${segment.playbackRate}[v${index}]`,
  );
  const concatInputs = segments.map((_, index) => `[v${index}]`).join('');
  const joined = segments.length === 1
    ? '[v0]'
    : `${concatInputs}concat=n=${segments.length}:v=1:a=0[vconcat];[vconcat]`;
  const source = segments.length === 1 ? '[v0]' : joined;
  return `${trims.join(';')};${source}fps=${fps},scale=${width}:${height}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3[webpout]`;
}

try {
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames',
    '-show_entries', 'format=duration', '-of', 'json', source,
  ], { encoding: 'utf8' }));
  const stream = probe.streams?.[0];
  const sourceDuration = Number(probe.format?.duration);
  const sourceFrames = Number(stream?.nb_read_frames);
  if (!stream?.width || !stream?.height || !Number.isFinite(sourceDuration) || sourceDuration <= 0 || !Number.isFinite(sourceFrames) || sourceFrames < 2) throw new Error('Could not read the source video dimensions, duration, and complete frame count');

  const freezes = detectFrozenIntervals(source, sourceDuration);
  const { segments, removedSeconds, visibleDuration } = buildVisibleSegments(sourceDuration, freezes, retainedStillSeconds, activePlaybackRate);
  const expectedPlaybackDuration = segments.reduce((sum, segment) => sum + (segment.end - segment.start) / segment.playbackRate, 0);
  const outputWidth = Math.min(1152, stream.width);
  const outputHeight = Math.round(stream.height * outputWidth / stream.width);
  // Keep short frozen states at 1x and slow visible UI actions without changing frame order.
  const fps = Math.max(1, Math.min(12, Math.floor(220_000_000 / (outputWidth * outputHeight * expectedPlaybackDuration))));
  const graph = buildFilterGraph(segments, fps, outputWidth, outputHeight);
  console.log(`Trimming ${freezes.filter(freeze => freeze.end - freeze.start > retainedStillSeconds + 0.05 && freeze.end < sourceDuration - 0.05).length} long stills: ${sourceDuration.toFixed(1)}s -> ${visibleDuration.toFixed(1)}s visible (${expectedPlaybackDuration.toFixed(1)}s playback, action segments at ${activePlaybackRate}x, holds at 1x; removed ${removedSeconds.toFixed(1)}s), ${retainedStillSeconds.toFixed(1)}s readable holds, ${fps} fps`);

  runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-filter_complex', graph, '-map', '[webpout]',
    '-loop', '0', '-f', 'gif', gif,
  ]);
  await sharp(gif, { animated: true }).webp({ quality: 86, effort: 5, loop: 0 }).toFile(output);

  const image = sharp(output, { animated: true });
  const metadata = await image.metadata();
  const info = await stat(output);
  const decoded = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', output,
  ], { encoding: 'utf8' }));
  const decodedFrames = Number(decoded.streams?.[0]?.nb_read_frames);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', output, '-f', 'null', '-',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (
    metadata.format !== 'webp' ||
    (metadata.pages || 0) < 16 ||
    decoded.streams?.[0]?.codec_name !== 'webp_anim' ||
    decodedFrames !== metadata.pages ||
    !metadata.width || !metadata.pageHeight ||
    info.size < 10_000
  ) {
    throw new Error(`WebP output failed completeness checks: ${JSON.stringify({ format: metadata.format, codec: decoded.streams?.[0]?.codec_name, pages: metadata.pages, decodedFrames, width: metadata.width, height: metadata.pageHeight, bytes: info.size })}`);
  }
  const outputDuration = (metadata.delay || []).reduce((sum, delay) => sum + delay, 0) / 1000;
  if (!Number.isFinite(outputDuration) || Math.abs(outputDuration - expectedPlaybackDuration) > 0.2) {
    throw new Error(`WebP timing must preserve expected visible playback: expected ${expectedPlaybackDuration.toFixed(2)}s, got ${outputDuration.toFixed(2)}s`);
  }
  const removedFreezes = freezes.map(freeze => {
    const isClosingHold = freeze.end >= sourceDuration - 0.05;
    const retained = isClosingHold ? freeze.end - freeze.start : Math.min(freeze.end - freeze.start, retainedStillSeconds);
    return {
      startSeconds: Number(freeze.start.toFixed(2)),
      endSeconds: Number(freeze.end.toFixed(2)),
      originalSeconds: Number((freeze.end - freeze.start).toFixed(2)),
      retainedSeconds: Number(retained.toFixed(2)),
      removedSeconds: Number(Math.max(0, freeze.end - freeze.start - retained).toFixed(2)),
      closingHoldKept: isClosingHold,
    };
  }).filter(freeze => freeze.removedSeconds > 0.05);
  const reportPath = output.replace(/\.webp$/i, '.video-check.json');
  await writeFile(reportPath, `${JSON.stringify({
    source: { file: basename(source), durationSeconds: Number(sourceDuration.toFixed(2)), width: stream.width, height: stream.height, decodedFrames: sourceFrames },
    freezeTrim: { detector: 'ffmpeg freezedetect, -45 dB, 2 second minimum', retainedSecondsPerLongStill: retainedStillSeconds, removedSeconds: Number(removedSeconds.toFixed(2)), regions: removedFreezes },
    output: { file: basename(output), format: metadata.format, codec: decoded.streams?.[0]?.codec_name, width: metadata.width, height: metadata.pageHeight, decodedFrames, durationSeconds: Number(outputDuration.toFixed(2)), sampledFramesPerSecond: fps, actionPlaybackSpeed: activePlaybackRate, retainedStillPlaybackSpeed: 1, bytes: info.size, fullDecodeSucceeded: true },
  }, null, 2)}\n`);
  console.log(`Created and fully decoded ${output} (${metadata.width}x${metadata.pageHeight}, ${decodedFrames} frames, ${outputDuration.toFixed(1)}s, ${(info.size / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`Video completeness report: ${reportPath}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
