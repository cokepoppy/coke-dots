import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import sharp from 'sharp';

const [sourceArgument, outputArgument, retainedStillArgument, activePlaybackRateArgument, pausePointsArgument, pauseDurationArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) throw new Error('Usage: node scripts/convert-demo-video-to-webp.mjs <input.webm> <output.webp> [readable-still-seconds] [active-playback-rate] [pause-points-seconds] [pause-duration-seconds]');
const retainedStillSeconds = retainedStillArgument === undefined ? 1.5 : Number(retainedStillArgument);
if (!Number.isFinite(retainedStillSeconds) || retainedStillSeconds <= 0 || retainedStillSeconds > 10) {
  throw new Error('readable-still-seconds must be greater than 0 and at most 10');
}
const activePlaybackRate = activePlaybackRateArgument === undefined ? 1 : Number(activePlaybackRateArgument);
if (!Number.isFinite(activePlaybackRate) || activePlaybackRate < 0.5 || activePlaybackRate > 1) {
  throw new Error('active-playback-rate must be between 0.5 and 1');
}
const pausePoints = pausePointsArgument
  ? pausePointsArgument.split(',').map(value => Number(value.trim()))
  : [];
const pauseDurationSeconds = pauseDurationArgument === undefined ? 0 : Number(pauseDurationArgument);
if (pausePoints.some(value => !Number.isFinite(value) || value < 0) || new Set(pausePoints).size !== pausePoints.length) {
  throw new Error('pause-points-seconds must contain unique non-negative timestamps');
}
if (!Number.isFinite(pauseDurationSeconds) || pauseDurationSeconds < 0 || pauseDurationSeconds > 10 || (pausePoints.length > 0 && pauseDurationSeconds === 0)) {
  throw new Error('pause-duration-seconds must be greater than 0 and at most 10 when pause points are provided');
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

function buildVisibleSegments(duration, freezes, retainedStillSeconds = 1.5) {
  const segments = [];
  let cursor = 0;
  let removedSeconds = 0;
  for (const freeze of freezes) {
    const length = freeze.end - freeze.start;
    // Keep the closing state long enough to read; it is the demo's end card.
    if (freeze.end >= duration - 0.05) continue;
    // Preserve both the state that starts a wait and the result state at its
    // end. Only remove the frozen middle, so long model waits do not make the
    // task's transition into its result disappear from the presentation.
    if (length <= retainedStillSeconds * 2 + 0.05) continue;
    const segmentEnd = Math.max(cursor, freeze.start + retainedStillSeconds);
    if (segmentEnd > cursor + 0.02) segments.push({ start: cursor, end: segmentEnd });
    cursor = Math.max(cursor, freeze.end - retainedStillSeconds);
    removedSeconds += Math.max(0, length - retainedStillSeconds * 2);
  }
  if (duration > cursor + 0.02) segments.push({ start: cursor, end: duration });
  if (!segments.length) segments.push({ start: 0, end: duration });
  return { segments, removedSeconds, visibleDuration: segments.reduce((sum, segment) => sum + segment.end - segment.start, 0) };
}

function addReadablePauses(segments, points, pauseDuration) {
  if (!points.length) return segments.map(segment => ({ ...segment, holdAfterSeconds: 0 }));
  const pending = new Set(points);
  const result = [];
  for (const segment of segments) {
    const inSegment = points.filter(point => point > segment.start && point < segment.end).sort((left, right) => left - right);
    let cursor = segment.start;
    for (const point of inSegment) {
      result.push({ start: cursor, end: point, holdAfterSeconds: pauseDuration });
      cursor = point;
      pending.delete(point);
    }
    result.push({ start: cursor, end: segment.end, holdAfterSeconds: 0 });
  }
  if (pending.size) throw new Error(`Readable pause points must fall inside visible source footage: ${[...pending].join(', ')}`);
  return result;
}

function buildFilterGraph(segments, fps, width, height, activeRate) {
  const trims = segments.map((segment, index) =>
    `[0:v]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=(PTS-STARTPTS)/${index === 0 ? 1 : activeRate}${segment.holdAfterSeconds > 0 ? `,tpad=stop_mode=clone:stop_duration=${segment.holdAfterSeconds.toFixed(3)}` : ''}[v${index}]`,
  );
  const concatInputs = segments.map((_, index) => `[v${index}]`).join('');
  const joined = segments.length === 1
    ? '[v0]'
    : `${concatInputs}concat=n=${segments.length}:v=1:a=0[vconcat];[vconcat]`;
  const source = segments.length === 1 ? '[v0]' : joined;
  return `${trims.join(';')};${source}fps=${fps},scale=${width}:${height}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3[webpout]`;
}

function parseFrameRate(value) {
  if (typeof value !== 'string') return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

try {
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,avg_frame_rate,r_frame_rate',
    '-show_entries', 'format=duration', '-of', 'json', source,
  ], { encoding: 'utf8' }));
  const stream = probe.streams?.[0];
  const sourceDuration = Number(probe.format?.duration);
  const sourceFrames = Number(stream?.nb_read_frames);
  const sourceFrameRate = parseFrameRate(stream?.avg_frame_rate) ?? parseFrameRate(stream?.r_frame_rate) ?? 25;
  if (!stream?.width || !stream?.height || !Number.isFinite(sourceDuration) || sourceDuration <= 0 || !Number.isFinite(sourceFrames) || sourceFrames < 2) throw new Error('Could not read the source video dimensions, duration, and complete frame count');

  const freezes = detectFrozenIntervals(source, sourceDuration);
  const visible = buildVisibleSegments(sourceDuration, freezes, retainedStillSeconds);
  const segments = addReadablePauses(visible.segments, pausePoints, pauseDurationSeconds);
  const expectedPlaybackDuration = segments.reduce((sum, segment, index) => sum + (segment.end - segment.start) / (index === 0 ? 1 : activePlaybackRate) + segment.holdAfterSeconds, 0);
  // Preserve the capture cadence so cursor movement and UI clicks don't jump between sparse frames.
  const fps = Math.max(1, Math.min(30, Math.round(sourceFrameRate)));
  // Keep long, slowed-down demos below Sharp's animation pixel guard without
  // reducing the resolution of ordinary clips. Include a small frame margin
  // for timestamp rounding at segment boundaries.
  // The GIF stage collapses identical frames into longer delays before Sharp
  // writes WebP. Allow enough headroom to keep 25 fps slowed demos at the
  // presentation width without increasing the actual decoded frame count.
  const animationPixelLimit = 900_000_000;
  const expectedFrames = Math.ceil(expectedPlaybackDuration * fps) + 10;
  const pixelsPerWidthSquared = stream.height / stream.width * expectedFrames;
  const maxWidthForAnimation = Math.floor(Math.sqrt(animationPixelLimit / pixelsPerWidthSquared));
  const outputWidth = Math.min(1152, stream.width, maxWidthForAnimation);
  if (outputWidth < 640) throw new Error(`The WebP would exceed the animation pixel limit even at 640px wide (${expectedPlaybackDuration.toFixed(1)}s at ${fps}fps).`);
  const outputHeight = Math.round(stream.height * outputWidth / stream.width);
  const graph = buildFilterGraph(segments, fps, outputWidth, outputHeight, activePlaybackRate);
  console.log(`Trimming ${freezes.filter(freeze => freeze.end - freeze.start > retainedStillSeconds * 2 + 0.05 && freeze.end < sourceDuration - 0.05).length} long stills: ${sourceDuration.toFixed(1)}s -> ${visible.visibleDuration.toFixed(1)}s visible (${expectedPlaybackDuration.toFixed(1)}s playback, active segments at ${activePlaybackRate}x; removed ${visible.removedSeconds.toFixed(1)}s), keeping up to ${retainedStillSeconds.toFixed(1)}s at each wait edge, ${pausePoints.length} action pauses of ${pauseDurationSeconds.toFixed(1)}s, source cadence ${fps} fps, output ${outputWidth}x${outputHeight}`);

  runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-filter_complex', graph, '-map', '[webpout]',
    '-loop', '0', '-f', 'gif', gif,
  ]);
  // The output dimensions above keep the complete animation under this limit.
  await sharp(gif, { animated: true, limitInputPixels: animationPixelLimit }).webp({ quality: 86, effort: 5, loop: 0 }).toFile(output);

  const image = sharp(output, { animated: true, limitInputPixels: animationPixelLimit });
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
    const retainedStart = isClosingHold ? 0 : Math.min(freeze.end - freeze.start, retainedStillSeconds);
    const retainedEnd = isClosingHold ? 0 : Math.min(Math.max(0, freeze.end - freeze.start - retainedStart), retainedStillSeconds);
    return {
      startSeconds: Number(freeze.start.toFixed(2)),
      endSeconds: Number(freeze.end.toFixed(2)),
      originalSeconds: Number((freeze.end - freeze.start).toFixed(2)),
      retainedStartSeconds: Number((isClosingHold ? retained : retainedStart).toFixed(2)),
      retainedEndSeconds: Number(retainedEnd.toFixed(2)),
      retainedSeconds: Number((isClosingHold ? retained : retainedStart + retainedEnd).toFixed(2)),
      removedSeconds: Number(Math.max(0, freeze.end - freeze.start - (isClosingHold ? retained : retainedStart + retainedEnd)).toFixed(2)),
      closingHoldKept: isClosingHold,
    };
  }).filter(freeze => freeze.removedSeconds > 0.05);
  const reportPath = output.replace(/\.webp$/i, '.video-check.json');
  await writeFile(reportPath, `${JSON.stringify({
    source: { file: basename(source), durationSeconds: Number(sourceDuration.toFixed(2)), width: stream.width, height: stream.height, decodedFrames: sourceFrames },
    freezeTrim: { detector: 'ffmpeg freezedetect, -45 dB, 2 second minimum', retainedSecondsAtEachEdgeOfLongStill: retainedStillSeconds, removedSeconds: Number(visible.removedSeconds.toFixed(2)), regions: removedFreezes },
    output: { file: basename(output), format: metadata.format, codec: decoded.streams?.[0]?.codec_name, width: metadata.width, height: metadata.pageHeight, decodedFrames, durationSeconds: Number(outputDuration.toFixed(2)), sourceFrameRate: Number(sourceFrameRate.toFixed(2)), frameRate: fps, openingSegmentPlaybackSpeed: 1, activePlaybackSpeed: activePlaybackRate, readablePausePointsSeconds: pausePoints, readablePauseDurationSeconds: pauseDurationSeconds, bytes: info.size, fullDecodeSucceeded: true },
  }, null, 2)}\n`);
  console.log(`Created and fully decoded ${output} (${metadata.width}x${metadata.pageHeight}, ${decodedFrames} frames, ${outputDuration.toFixed(1)}s, ${(info.size / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`Video completeness report: ${reportPath}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
