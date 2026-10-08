import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const file = resolve(process.argv[2] || '');
assert(process.argv[2], 'Usage: node scripts/verify-demo-webp.mjs <animated.webp>');
const metadata = await sharp(file, { animated: true }).metadata();
assert.equal(metadata.format, 'webp', 'The output file must be WebP.');
assert(metadata.pages && metadata.pages >= 30, `Expected at least 30 animation frames, got ${metadata.pages || 0}.`);

const frameMd5 = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8' });
const frameHashes = frameMd5.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)?.trim()).filter(Boolean);
const uniqueFrames = new Set(frameHashes).size;
assert(frameHashes.length >= 30 && uniqueFrames >= 12, `Sparse animation: ${frameHashes.length} decoded frames, ${uniqueFrames} distinct frames.`);

const frameProbe = JSON.parse(execFileSync('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,width,height', '-of', 'json', file,
], { encoding: 'utf8' }));
const timestamps = (frameProbe.frames || []).map(frame => Number(frame.best_effort_timestamp_time)).filter(Number.isFinite);
assert(timestamps.length === frameHashes.length, 'The frame decoder and timestamp probe disagree on the frame count.');
const frameSize = frameProbe.frames?.find(frame => Number.isInteger(frame.width) && Number.isInteger(frame.height));
assert(frameSize, 'ffprobe did not report the decoded WebP frame dimensions.');
const gaps = timestamps.slice(1).map((time, index) => time - timestamps[index]).filter(gap => gap > 0);
const sortedGaps = [...gaps].sort((a, b) => a - b);
const frameInterval = sortedGaps[Math.floor(sortedGaps.length / 2)] || 0;
const durationSeconds = Number((timestamps.at(-1) + frameInterval).toFixed(2));
assert(durationSeconds >= 5 && durationSeconds <= 30, `Unexpected edited duration: ${durationSeconds}s.`);
assert(frameSize.width === 1152 && frameSize.height >= 600 && frameSize.height < 800, `Unexpected frame dimensions: ${frameSize.width}x${frameSize.height}.`);

const chromePath = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(path => path && existsSync(path));
assert(chromePath, 'Chrome is required to verify animated WebP playback.');
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const bytes = await readFile(file);
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'no-store' });
  response.end(bytes);
});
await new Promise((resolvePromise, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
try {
  const address = server.address();
  assert(address && typeof address !== 'string');
  const page = await browser.newPage({ viewport: { width: frameSize.width, height: frameSize.height } });
  await page.goto(`http://127.0.0.1:${address.port}/cloud-computer-proactive-activity.webp`);
  await page.waitForFunction(({ width, height }) => {
    const image = document.querySelector('img');
    return image?.complete && image.naturalWidth === width && image.naturalHeight === height;
  }, { width: frameSize.width, height: frameSize.height });
  const hashes = [];
  const playbackIntervalMs = Math.max(250, Math.min(500, durationSeconds * 1000 / 24));
  const deadline = Date.now() + durationSeconds * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(playbackIntervalMs);
    hashes.push(createHash('sha256').update(await page.screenshot()).digest('hex'));
  }
  const playback = { width: frameSize.width, height: frameSize.height, samples: hashes.length, distinctSamples: new Set(hashes).size };
  assert(playback.samples >= 12 && playback.distinctSamples >= 8, `Chrome playback did not show a complete changing animation: ${JSON.stringify(playback)}`);

  const audit = {
  format: metadata.format,
  width: frameSize.width,
  height: frameSize.height,
    decodedFrames: frameHashes.length,
    distinctDecodedFrames: uniqueFrames,
    durationSeconds,
    chromePlayback: playback,
    verified: true,
  };
  await writeFile(`${file}.audit.json`, JSON.stringify(audit, null, 2) + '\n');
  console.log(`Chrome verified animated WebP: ${durationSeconds}s, ${frameHashes.length} decoded frames, ${uniqueFrames} distinct frames, ${playback.distinctSamples} distinct playback samples.`);
} finally {
  await browser.close();
  await new Promise(resolvePromise => server.close(resolvePromise));
}
