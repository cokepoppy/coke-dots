import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { compareRasters, cropRaster, differenceRaster, overlayRasters, resizeRaster, type ImageRect } from '../src/shared/reference-visual.ts';

interface ComparisonConfig {
  id: string;
  source?: { videoUrl: string; title?: string; timecode: string };
  reference: string;
  referenceRect: ImageRect;
  implementationRect: ImageRect;
  output: string;
  threshold?: number;
  note: string;
}

const [configArgument, implementationArgument] = process.argv.slice(2);
if (!configArgument || !implementationArgument) {
  console.error('Usage: npm run compare:reference -- <comparison.json> <implementation.png>');
  process.exitCode = 2;
} else {
  await run(resolve(configArgument), resolve(implementationArgument));
}

async function run(configPath: string, implementationPath: string) {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as ComparisonConfig;
  if (!config.id || !config.note || !config.reference || !config.output) throw new Error(`Incomplete comparison config: ${configPath}`);
  const configDirectory = dirname(configPath);
  const referencePath = fromConfig(configDirectory, config.reference);
  const outputPath = fromConfig(configDirectory, config.output);
  const referenceImage = decode(await readFile(referencePath), referencePath);
  const implementationImage = decode(await readFile(implementationPath), implementationPath);
  const referenceCrop = cropRaster(referenceImage, config.referenceRect);
  const implementationCrop = cropRaster(implementationImage, config.implementationRect);
  const alignedReference = resizeRaster(referenceCrop, implementationCrop.width, implementationCrop.height);
  const statistics = compareRasters(alignedReference, implementationCrop, config.threshold ?? 32);

  await mkdir(outputPath, { recursive: true });
  await Promise.all([
    writePng(join(outputPath, 'reference-crop.png'), alignedReference),
    writePng(join(outputPath, 'implementation-crop.png'), implementationCrop),
    writePng(join(outputPath, 'overlay.png'), overlayRasters(alignedReference, implementationCrop)),
    writePng(join(outputPath, 'difference.png'), differenceRaster(alignedReference, implementationCrop)),
    writeFile(join(outputPath, 'metrics.json'), `${JSON.stringify({
      id: config.id,
      source: config.source,
      reference: referencePath,
      implementation: implementationPath,
      referenceRect: config.referenceRect,
      implementationRect: config.implementationRect,
      alignedSize: { width: implementationCrop.width, height: implementationCrop.height },
      statistics,
      note: config.note,
    }, null, 2)}\n`),
  ]);
  console.log(`Reference comparison written to ${outputPath}`);
  console.log(JSON.stringify(statistics, null, 2));
}

function fromConfig(directory: string, value: string) {
  if (isAbsolute(value)) return value;
  return resolve(directory, value);
}

function decode(bytes: Buffer, source: string) {
  try { return PNG.sync.read(bytes); }
  catch (error) { throw new Error(`Could not decode PNG ${source}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function writePng(path: string, image: ReturnType<typeof cropRaster>) {
  await writeFile(path, PNG.sync.write({ width: image.width, height: image.height, data: image.data }));
}
