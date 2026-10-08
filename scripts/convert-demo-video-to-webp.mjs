import { execFileSync } from 'node:child_process';
import { readFile, rm, stat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const [sourceArgument, outputArgument, markerArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) throw new Error('Usage: node scripts/convert-demo-video-to-webp.mjs <input.webm> <output.webp> [recording-marks.json]');
const source = resolve(sourceArgument);
const output = resolve(outputArgument);
const scratch = await mkdtemp(`${tmpdir()}/coke-dots-webp-`);
const gif = resolve(scratch, `${basename(output, '.webp')}.gif`);

function selectSegments(events, sourceDuration) {
  const marks = new Map(events.map(event => [event.name, Number(event.atSeconds)]));
  const get = name => {
    const time = marks.get(name);
    if (!Number.isFinite(time)) throw new Error(`Recording marker is missing: ${name}`);
    return time;
  };
  const segments = [
    { name: '提交每小时任务', start: get('demo-start'), end: get('task-working') + 1.25 },
    { name: '云电脑打开活动页', start: get('cloud-page-visible') - 0.35, end: get('cloud-page-visible') + 1.15 },
    { name: '点击查看活动详情', start: get('details-visible') - 1.2, end: get('details-visible') + 1.5 },
    { name: 'Activity 结果与计划', start: get('activity-result') - 0.75, end: get('scheduled-confirmed') + 2 },
  ].map(segment => ({
    ...segment,
    start: Math.max(0, segment.start),
    end: Math.min(sourceDuration, segment.end),
  })).filter(segment => segment.end - segment.start >= 0.35);

  if (segments.length !== 4) throw new Error(`Expected four useful video segments, got ${segments.length}`);
  const merged = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && segment.start <= previous.end + 0.05) {
      previous.end = Math.max(previous.end, segment.end);
      previous.name += ` + ${segment.name}`;
    } else merged.push({ ...segment });
  }
  const editedDuration = merged.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  if (editedDuration < 5 || editedDuration > 30) throw new Error(`The edited demo duration is outside the 5–30 second target: ${editedDuration.toFixed(2)}s`);
  return { segments: merged, editedDuration };
}

try {
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-show_entries', 'format=duration', '-of', 'json', source,
  ], { encoding: 'utf8' }));
  const stream = probe.streams?.[0];
  const sourceDuration = Number(probe.format?.duration);
  if (!stream?.width || !stream?.height || !Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error('Could not read the source video dimensions and duration');

  let segments = [{ name: 'full recording', start: 0, end: sourceDuration }];
  let editedDuration = sourceDuration;
  if (markerArgument) {
    const recording = JSON.parse(await readFile(resolve(markerArgument), 'utf8'));
    ({ segments, editedDuration } = selectSegments(recording.events || [], sourceDuration));
  }
  const outputWidth = Math.min(1152, stream.width);
  const outputHeight = Math.round(stream.height * outputWidth / stream.width);
  const cropBottom = Math.round(outputHeight * 0.0875);
  const croppedSourceHeight = Math.floor((stream.height * (outputHeight - cropBottom) / outputHeight) / 2) * 2;
  const fps = Math.max(1, Math.min(12, Math.floor(220_000_000 / (outputWidth * outputHeight * editedDuration))));
  console.log(`Editing ${sourceDuration.toFixed(1)}s source into ${editedDuration.toFixed(1)}s at ${fps} fps; removing the fixed ${cropBottom}px bottom capture strip`);
  for (const segment of segments) console.log(`  ${segment.name}: ${segment.start.toFixed(2)}–${segment.end.toFixed(2)}s`);

  const filters = segments.map((segment, index) =>
    `[0:v]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`);
  const inputLabels = segments.map((_, index) => `[v${index}]`).join('');
  const graph = [
    ...filters,
    `${inputLabels}concat=n=${segments.length}:v=1:a=0,crop=${stream.width}:${croppedSourceHeight}:0:0,fps=${fps},scale=${outputWidth}:-1:flags=lanczos[base]`,
    '[base]split[s0][s1]',
    '[s0]palettegen=max_colors=256:stats_mode=diff[p]',
    '[s1][p]paletteuse=dither=bayer:bayer_scale=3[out]',
  ].join(';');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-filter_complex', graph, '-map', '[out]', '-loop', '0', '-f', 'gif', gif,
  ], { stdio: 'inherit' });

  await sharp(gif, { animated: true }).webp({ quality: 82, effort: 5, loop: 0 }).toFile(output);
  execFileSync(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), 'clean-demo-webp-frames.mjs'), output], { stdio: 'inherit' });
  const image = sharp(output, { animated: true });
  const metadata = await image.metadata();
  const info = await stat(output);
  if (metadata.format !== 'webp' || (metadata.pages || 0) < 30 || !metadata.width || !metadata.height || info.size < 10_000) {
    throw new Error(`WebP output is not a complete animation: ${JSON.stringify({ format: metadata.format, pages: metadata.pages, width: metadata.width, height: metadata.height, bytes: info.size })}`);
  }

  const checksums = execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'framemd5', '-'], { encoding: 'utf8' });
  const frameHashes = checksums.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)?.trim()).filter(Boolean);
  const uniqueFrames = new Set(frameHashes).size;
  if (frameHashes.length < 30 || uniqueFrames < 12) throw new Error(`WebP playback would be too sparse: ${frameHashes.length} decoded frames, ${uniqueFrames} distinct frames`);
  console.log(`Created and decoded ${output} (${outputWidth}x${outputHeight - cropBottom} per frame, ${frameHashes.length} frames, ${uniqueFrames} distinct frames, ${(info.size / 1024).toFixed(0)} KiB)`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
