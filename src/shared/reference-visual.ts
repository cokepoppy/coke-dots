export interface RasterImage {
  width: number;
  height: number;
  data: Buffer;
}

export interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageDifference {
  comparedPixels: number;
  meanAbsoluteError: number;
  changedPixelRatio: number;
  threshold: number;
  maximumChannelDelta: number;
}

export function cropRaster(image: RasterImage, rect: ImageRect): RasterImage {
  assertRect(image, rect);
  const data = Buffer.alloc(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row++) {
    const sourceStart = ((rect.y + row) * image.width + rect.x) * 4;
    const targetStart = row * rect.width * 4;
    image.data.copy(data, targetStart, sourceStart, sourceStart + rect.width * 4);
  }
  return { width: rect.width, height: rect.height, data };
}

export function resizeRaster(image: RasterImage, width: number, height: number): RasterImage {
  assertImage(image);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Resize dimensions must be positive integers');
  }
  if (image.width === width && image.height === height) return { ...image, data: Buffer.from(image.data) };

  const output = Buffer.alloc(width * height * 4);
  const xScale = image.width / width;
  const yScale = image.height / height;
  for (let y = 0; y < height; y++) {
    const sourceY = Math.max(0, (y + 0.5) * yScale - 0.5);
    const top = Math.floor(sourceY);
    const bottom = Math.min(image.height - 1, top + 1);
    const yMix = sourceY - top;
    for (let x = 0; x < width; x++) {
      const sourceX = Math.max(0, (x + 0.5) * xScale - 0.5);
      const left = Math.floor(sourceX);
      const right = Math.min(image.width - 1, left + 1);
      const xMix = sourceX - left;
      const targetOffset = (y * width + x) * 4;
      const topLeft = (top * image.width + left) * 4;
      const topRight = (top * image.width + right) * 4;
      const bottomLeft = (bottom * image.width + left) * 4;
      const bottomRight = (bottom * image.width + right) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const topValue = image.data[topLeft + channel] * (1 - xMix) + image.data[topRight + channel] * xMix;
        const bottomValue = image.data[bottomLeft + channel] * (1 - xMix) + image.data[bottomRight + channel] * xMix;
        output[targetOffset + channel] = Math.round(topValue * (1 - yMix) + bottomValue * yMix);
      }
    }
  }
  return { width, height, data: output };
}

export function overlayRasters(reference: RasterImage, implementation: RasterImage, opacity = 0.5): RasterImage {
  assertSameSize(reference, implementation);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Overlay opacity must be between 0 and 1');
  const data = Buffer.alloc(reference.data.length);
  for (let offset = 0; offset < data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) {
      data[offset + channel] = Math.round(reference.data[offset + channel] * (1 - opacity) + implementation.data[offset + channel] * opacity);
    }
    data[offset + 3] = 255;
  }
  return { width: reference.width, height: reference.height, data };
}

export function differenceRaster(reference: RasterImage, implementation: RasterImage, gain = 3): RasterImage {
  assertSameSize(reference, implementation);
  if (!Number.isFinite(gain) || gain <= 0) throw new Error('Difference gain must be positive');
  const data = Buffer.alloc(reference.data.length);
  for (let offset = 0; offset < data.length; offset += 4) {
    const delta = Math.max(
      Math.abs(reference.data[offset] - implementation.data[offset]),
      Math.abs(reference.data[offset + 1] - implementation.data[offset + 1]),
      Math.abs(reference.data[offset + 2] - implementation.data[offset + 2]),
    );
    const visibleDelta = Math.min(255, Math.round(delta * gain));
    data[offset] = visibleDelta;
    data[offset + 1] = Math.round(visibleDelta * 0.18);
    data[offset + 2] = Math.round(visibleDelta * 0.18);
    data[offset + 3] = 255;
  }
  return { width: reference.width, height: reference.height, data };
}

export function compareRasters(reference: RasterImage, implementation: RasterImage, threshold = 32): ImageDifference {
  assertSameSize(reference, implementation);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) throw new Error('Pixel threshold must be between 0 and 255');
  let absoluteDelta = 0;
  let changedPixels = 0;
  let maximumChannelDelta = 0;
  const pixelCount = reference.width * reference.height;
  for (let offset = 0; offset < reference.data.length; offset += 4) {
    const red = Math.abs(reference.data[offset] - implementation.data[offset]);
    const green = Math.abs(reference.data[offset + 1] - implementation.data[offset + 1]);
    const blue = Math.abs(reference.data[offset + 2] - implementation.data[offset + 2]);
    const pixelDelta = Math.max(red, green, blue);
    absoluteDelta += red + green + blue;
    maximumChannelDelta = Math.max(maximumChannelDelta, pixelDelta);
    if (pixelDelta > threshold) changedPixels++;
  }
  return {
    comparedPixels: pixelCount,
    meanAbsoluteError: absoluteDelta / (pixelCount * 3),
    changedPixelRatio: changedPixels / pixelCount,
    threshold,
    maximumChannelDelta,
  };
}

function assertRect(image: RasterImage, rect: ImageRect) {
  assertImage(image);
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (values.some(value => !Number.isInteger(value)) || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1) {
    throw new Error('Crop coordinates must be non-negative integers with positive dimensions');
  }
  if (rect.x + rect.width > image.width || rect.y + rect.height > image.height) {
    throw new Error(`Crop ${rect.x},${rect.y},${rect.width},${rect.height} exceeds image bounds ${image.width}x${image.height}`);
  }
}

function assertImage(image: RasterImage) {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) {
    throw new Error('Raster must contain one RGBA pixel per image coordinate');
  }
}

function assertSameSize(reference: RasterImage, implementation: RasterImage) {
  assertImage(reference);
  assertImage(implementation);
  if (reference.width !== implementation.width || reference.height !== implementation.height) {
    throw new Error(`Image sizes differ: ${reference.width}x${reference.height} and ${implementation.width}x${implementation.height}`);
  }
}
