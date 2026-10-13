import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { PNG } from 'pngjs';

const projectRoot = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const outputDirectory = join(projectRoot, 'research', 'frames', 'v3-openai-launch-film');
const videoUrl = 'https://www.youtube.com/watch?v=uXspbC2srEQ';
const sampleSeconds = [
  2,
  ...halfSecondRange(54, 70),
  ...halfSecondRange(86, 90),
  ...halfSecondRange(124, 141),
  147,
];
const executablePath = process.env.DOTS_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch({ executablePath, headless: process.env.DOTS_REFERENCE_HEADFUL !== '1' });
let page: Page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await mkdir(outputDirectory, { recursive: true });
  const firstUrl = new URL(videoUrl);
  firstUrl.searchParams.set('t', `${sampleSeconds[0]}s`);
  await openVideoAt(firstUrl.toString());
  const metadata = await readMetadata();
  assert(metadata.durationSeconds >= sampleSeconds.at(-1)!, 'The video duration must cover every requested sample.');

  const frames = [];
  for (let sampleIndex = 0; sampleIndex < sampleSeconds.length; sampleIndex += 1) {
    const requestedSeconds = sampleSeconds[sampleIndex]!;
    if (sampleIndex === 1 || requestedSeconds === 124) {
      const sampleUrl = new URL(videoUrl);
      sampleUrl.searchParams.set('t', `${requestedSeconds}s`);
      await openVideoAt(sampleUrl.toString());
    }
    await playVideo();
    const targetSeconds = Math.min(requestedSeconds, metadata.durationSeconds - 0.1);
    const decodedFrame = await waitForPresentedFrame(targetSeconds);
    assert(Math.abs(decodedFrame.mediaTime - requestedSeconds) < 0.35, `Decoded frame time ${decodedFrame.mediaTime} does not match ${requestedSeconds}s.`);
    const filename = frameFilename(requestedSeconds);
    const path = join(outputDirectory, filename);
    const bytes = await page.locator('video').first().screenshot({ path, animations: 'disabled', timeout: 15_000 });
    const imageStats = summarizePng(bytes);
    assert(Math.abs(imageStats.width / imageStats.height - metadata.width / metadata.height) < 0.01,
      `Unexpected screenshot aspect ratio at ${requestedSeconds}s.`);
    assert(bytes.byteLength >= 12_000 && imageStats.lumaStdDev >= 8 && imageStats.quantizedColors >= 30,
      `The screenshot at ${requestedSeconds}s appears blank or undecoded (bytes=${bytes.byteLength}, lumaStdDev=${imageStats.lumaStdDev}, colors=${imageStats.quantizedColors}).`);
    frames.push({
      requestedSeconds,
      actualSeconds: Number(decodedFrame.mediaTime.toFixed(3)),
      presentedFrames: decodedFrame.presentedFrames,
      filename,
      byteLength: bytes.byteLength,
      ...imageStats,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    console.log(`Captured ${frameFilename(requestedSeconds)} at ${decodedFrame.mediaTime.toFixed(3)}s (${bytes.byteLength} bytes).`);
  }

  const manifest = { source: videoUrl, captureDate: new Date().toISOString(), metadata, frames };
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ ...manifest, frames: `${frames.length} verified decoded frames` }, null, 2));
} finally {
  await browser.close();
}

async function openVideoAt(url: string) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  assert.equal(response?.status(), 200, 'YouTube must return the official launch film.');
  await page.locator('video').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const element = document.querySelector('video');
    return Boolean(element && element.readyState >= 2 && element.videoWidth > 0 && element.duration > 0);
  }, undefined, { timeout: 45_000 });
  await page.locator('video').first().evaluate(element => { element.muted = true; element.pause(); });
}

async function readMetadata() {
  return page.locator('video').first().evaluate(element => ({
    width: element.videoWidth,
    height: element.videoHeight,
    durationSeconds: element.duration,
  }));
}

async function playVideo() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await page.locator('video').first().evaluate(async element => {
      element.muted = true;
      try {
        await element.play();
        return 'playing';
      } catch (error) {
        return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
    });
    if (result === 'playing') return;
    if (!result.startsWith('AbortError:')) throw new Error(`YouTube playback failed: ${result}`);
    await page.waitForFunction(() => {
      const element = document.querySelector('video');
      return Boolean(element && element.readyState >= 2 && element.videoWidth > 0);
    }, undefined, { timeout: 20_000 });
    await page.waitForTimeout(300);
  }
  throw new Error('YouTube playback kept aborting after the video source loaded.');
}

async function waitForPresentedFrame(targetSeconds: number) {
  const frame = await page.evaluate(`(() => {
    const target = ${targetSeconds};
    return new Promise((resolveFrame, rejectFrame) => {
      const element = document.querySelector('video');
      if (!element) { rejectFrame(new Error('YouTube video element disappeared.')); return; }
      const timeout = window.setTimeout(() => rejectFrame(new Error('No decoded frame was presented at ' + target + 's.')), 30000);
      const waitForTargetFrame = (_now, info) => {
        if (info.mediaTime + 0.025 >= target) {
          window.clearTimeout(timeout);
          element.pause();
          resolveFrame({ mediaTime: info.mediaTime, presentedFrames: info.presentedFrames, width: element.videoWidth, height: element.videoHeight, readyState: element.readyState });
        } else element.requestVideoFrameCallback(waitForTargetFrame);
      };
      element.requestVideoFrameCallback(waitForTargetFrame);
    });
  })()`) as { mediaTime: number; presentedFrames: number; width: number; height: number; readyState: number };
  assert(frame.mediaTime >= targetSeconds - 0.35, `Decoded frame time ${frame.mediaTime} is too early for ${targetSeconds}s.`);
  assert(frame.mediaTime < targetSeconds + 0.75, `Decoded frame time ${frame.mediaTime} skipped ${targetSeconds}s.`);
  return frame;
}

function halfSecondRange(start: number, end: number) {
  const result = [];
  for (let seconds = start; seconds <= end + 0.001; seconds += 0.5) result.push(Number(seconds.toFixed(1)));
  return result;
}

function frameFilename(seconds: number) {
  const whole = Math.floor(seconds);
  const fraction = Math.round((seconds - whole) * 1000);
  const minutes = String(Math.floor(whole / 60)).padStart(2, '0');
  const remainder = String(whole % 60).padStart(2, '0');
  const millis = String(fraction).padStart(3, '0');
  return `openai-v3-${minutes}-${remainder}-${millis}.png`;
}

function summarizePng(bytes: Buffer) {
  const image = PNG.sync.read(bytes);
  let sum = 0;
  let squareSum = 0;
  let samples = 0;
  const colors = new Set<number>();
  const stride = Math.max(1, Math.floor((image.width * image.height) / 6000));
  for (let pixel = 0; pixel < image.width * image.height; pixel += stride) {
    const offset = pixel * 4;
    const red = image.data[offset] || 0;
    const green = image.data[offset + 1] || 0;
    const blue = image.data[offset + 2] || 0;
    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    sum += luma;
    squareSum += luma * luma;
    samples += 1;
    colors.add(((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4));
  }
  const mean = sum / samples;
  return {
    width: image.width,
    height: image.height,
    lumaMean: Number(mean.toFixed(2)),
    lumaStdDev: Number(Math.sqrt(Math.max(0, squareSum / samples - mean * mean)).toFixed(2)),
    quantizedColors: colors.size,
  };
}
