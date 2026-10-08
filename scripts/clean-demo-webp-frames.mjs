import assert from 'node:assert/strict';
import { rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const file = resolve(process.argv[2] || '');
assert(process.argv[2], 'Usage: node scripts/clean-demo-webp-frames.mjs <animated.webp>');
const metadata = await sharp(file, { animated: true }).metadata();
assert(metadata.format === 'webp' && metadata.pages && metadata.pageHeight, 'Expected an animated WebP.');

const width = metadata.width;
const height = metadata.pageHeight;
const delays = metadata.delay || Array(metadata.pages).fill(80);
const retainedFrames = [];
const retainedDelays = [];
const removed = [];
const xStart = Math.floor(width * 0.26);
const xEnd = Math.floor(width * 0.96);
const yStart = Math.floor(height * 0.12);
const yEnd = Math.floor(height * 0.9);

for (let page = 0; page < metadata.pages; page++) {
  const { data, info } = await sharp(file, { page, pages: 1 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let darkPixels = 0;
  let brightnessTotal = 0;
  let pixels = 0;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const offset = (y * width + x) * info.channels;
      const brightness = (data[offset] * 299 + data[offset + 1] * 587 + data[offset + 2] * 114) / 1000;
      brightnessTotal += brightness;
      pixels++;
      if (brightness < 25) darkPixels++;
    }
  }
  const darkFraction = darkPixels / pixels;
  const averageBrightness = brightnessTotal / pixels;
  const isBlackCapture = darkFraction > 0.8 && averageBrightness < 80;
  if (isBlackCapture) {
    assert(page > 0 && retainedFrames.length > 0, 'The recording starts with a black cloud-computer frame; refusing to remove it silently.');
    removed.push(page);
    retainedDelays[retainedDelays.length - 1] += delays[page] || 80;
    continue;
  }
  retainedFrames.push(data);
  retainedDelays.push(delays[page] || 80);
}

assert(removed.length <= Math.max(1, Math.floor(metadata.pages * 0.05)), `Too many black capture frames were found (${removed.length}/${metadata.pages}).`);
if (removed.length) {
  const temporary = `${file}.cleaning.webp`;
  await sharp(Buffer.concat(retainedFrames), {
    raw: {
      width,
      height: height * retainedFrames.length,
      channels: 4,
      pageHeight: height,
    },
  }).webp({ quality: 82, effort: 5, loop: 0, delay: retainedDelays }).toFile(temporary);
  await rename(temporary, file);
}

console.log(removed.length
  ? `Removed ${removed.length} brief black cloud-computer frame(s) at frame ${removed.join(', ')}.`
  : 'No black cloud-computer frames found.');
