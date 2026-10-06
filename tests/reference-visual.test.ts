import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRasters, cropRaster, differenceRaster, overlayRasters, resizeRaster, type RasterImage } from '../src/shared/reference-visual.ts';

function image(width: number, height: number, pixels: number[][]): RasterImage {
  return { width, height, data: Buffer.from(pixels.flat()) };
}

test('cropRaster copies the requested rectangle without including adjacent pixels', () => {
  const source = image(2, 2, [
    [10, 0, 0, 255], [20, 0, 0, 255],
    [30, 0, 0, 255], [40, 0, 0, 255],
  ]);
  const crop = cropRaster(source, { x: 1, y: 0, width: 1, height: 2 });
  assert.equal(crop.width, 1);
  assert.equal(crop.height, 2);
  assert.deepEqual([...crop.data], [20, 0, 0, 255, 40, 0, 0, 255]);
  assert.throws(() => cropRaster(source, { x: 2, y: 0, width: 1, height: 1 }), /exceeds image bounds/);
});

test('comparison and overlay preserve identical pixels and expose changed pixels', () => {
  const reference = image(2, 1, [[0, 10, 20, 255], [255, 255, 255, 255]]);
  const implementation = image(2, 1, [[0, 10, 20, 255], [155, 255, 255, 255]]);
  const stats = compareRasters(reference, implementation, 32);
  assert.equal(stats.comparedPixels, 2);
  assert.equal(stats.changedPixelRatio, 0.5);
  assert.equal(stats.meanAbsoluteError, 100 / 6);
  assert.equal(stats.maximumChannelDelta, 100);
  assert.deepEqual([...overlayRasters(reference, implementation).data], [0, 10, 20, 255, 205, 255, 255, 255]);
  assert.equal(differenceRaster(reference, implementation).data[4], 255);
});

test('resizeRaster keeps dimensions and exact pixel values for a same-size alignment', () => {
  const source = image(1, 1, [[37, 88, 149, 255]]);
  const resized = resizeRaster(source, 1, 1);
  assert.equal(resized.width, 1);
  assert.equal(resized.height, 1);
  assert.deepEqual([...resized.data], [37, 88, 149, 255]);
  assert.notEqual(resized.data, source.data);
});
