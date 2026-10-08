import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import sharp from 'sharp';

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) throw new Error('Usage: node scripts/convert-demo-video-to-webp.mjs <input.webm> <output.webp>');
const source = resolve(sourceArgument);
const output = resolve(outputArgument);
const scratch = await mkdtemp(`${tmpdir()}/coke-dots-webp-`);
const gif = resolve(scratch, `${basename(output, '.webp')}.gif`);

try {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-vf', 'fps=8,scale=1152:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0', '-f', 'gif', gif,
  ], { stdio: 'inherit' });
  await sharp(gif, { animated: true }).webp({ quality: 82, effort: 5, loop: 0 }).toFile(output);
  const image = sharp(output, { animated: true });
  const metadata = await image.metadata();
  const info = await stat(output);
  if (metadata.format !== 'webp' || (metadata.pages || 0) < 2 || !metadata.width || !metadata.height || info.size < 10_000) {
    throw new Error(`WebP output is not a valid animation: ${JSON.stringify({ format: metadata.format, pages: metadata.pages, width: metadata.width, height: metadata.height, bytes: info.size })}`);
  }
  console.log(`Created ${output} (${metadata.width}x${metadata.height}, ${metadata.pages} frames, ${(info.size / 1024 / 1024).toFixed(2)} MiB)`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
