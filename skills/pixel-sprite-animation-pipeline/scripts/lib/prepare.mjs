import fs from 'node:fs/promises';
import path from 'node:path';
import { validateConfig } from './config.mjs';
import { colorAt, foregroundBounds, readRgba, sameColor, sha256, writeRgba } from './image.mjs';

const FALLBACK_CHROMA = Object.freeze({ r: 0, g: 255, b: 0, a: 255 });

function pixelOffset(image, x, y) {
  return (y * image.width + x) * 4;
}

function copyPixel(source, sourceX, sourceY, target, targetX, targetY) {
  source.data.copy(target.data, pixelOffset(target, targetX, targetY), pixelOffset(source, sourceX, sourceY), pixelOffset(source, sourceX, sourceY) + 4);
}

function createImage(width, height, color = { r: 0, g: 0, b: 0, a: 0 }) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([color.r, color.g, color.b, color.a], i);
  return { data, width, height, channels: 4 };
}

function resolveChroma(configuredColor, detectedBackground) {
  if (configuredColor) return { r: configuredColor.r, g: configuredColor.g, b: configuredColor.b, a: 255 };
  if (detectedBackground.r === 0 && detectedBackground.g === 0 && detectedBackground.b === 0 && detectedBackground.a === 0) {
    return { ...FALLBACK_CHROMA };
  }
  return { r: detectedBackground.r, g: detectedBackground.g, b: detectedBackground.b, a: 255 };
}

function scaleInteger(image, scaleX, scaleY) {
  const scaled = createImage(image.width * scaleX, image.height * scaleY);
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    for (let scaledY = 0; scaledY < scaleY; scaledY += 1) for (let scaledX = 0; scaledX < scaleX; scaledX += 1) {
      copyPixel(image, x, y, scaled, x * scaleX + scaledX, y * scaleY + scaledY);
    }
  }
  return scaled;
}

export async function createPixelMatrix({ output, width, height, blockSize }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(blockSize) || width <= 0 || height <= 0 || blockSize <= 0) {
    throw new Error('pixel matrix dimensions and blockSize must be positive integers');
  }
  const matrix = createImage(width, height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const value = (Math.floor(x / blockSize) + Math.floor(y / blockSize)) % 2 === 0 ? 255 : 0;
    matrix.data.set([value, value, value, 255], pixelOffset(matrix, x, y));
  }
  await writeRgba(output, matrix);
}

export async function prepareAnchor({ input, outputDir, config }) {
  const validatedConfig = validateConfig(config);
  await fs.mkdir(outputDir, { recursive: true });

  const image = await readRgba(input);
  const detectedBackground = colorAt(image, 0, 0);
  const background = validatedConfig.background.mode === 'configured'
    ? validatedConfig.background.color
    : detectedBackground;
  const chroma = resolveChroma(validatedConfig.background.color, detectedBackground);
  const bounds = foregroundBounds(image, background, validatedConfig.background.tolerance);
  if (!bounds) throw new Error('anchor contains no foreground');

  const left = validatedConfig.pivot.x - Math.floor(bounds.width / 2);
  const top = validatedConfig.pivot.y - bounds.height;
  if (left < 0 || top < 0 || left + bounds.width > validatedConfig.canonical.width || top + bounds.height > validatedConfig.canonical.height) {
    throw new Error('foreground does not fit canonical cell');
  }

  const canonicalChromaImage = createImage(validatedConfig.canonical.width, validatedConfig.canonical.height, chroma);
  const canonicalTransparentImage = createImage(validatedConfig.canonical.width, validatedConfig.canonical.height);
  for (let y = 0; y < bounds.height; y += 1) for (let x = 0; x < bounds.width; x += 1) {
    const sourceX = bounds.left + x;
    const sourceY = bounds.top + y;
    const chromaTargetOffset = pixelOffset(canonicalChromaImage, left + x, top + y);
    const sourceColor = colorAt(image, sourceX, sourceY);
    if (sameColor(sourceColor, background, validatedConfig.background.tolerance)) {
      canonicalChromaImage.data.set([chroma.r, chroma.g, chroma.b, chroma.a], chromaTargetOffset);
    } else {
      copyPixel(image, sourceX, sourceY, canonicalChromaImage, left + x, top + y);
      copyPixel(image, sourceX, sourceY, canonicalTransparentImage, left + x, top + y);
    }
  }

  const canonicalChroma = path.join(outputDir, 'anchor-canonical-chroma.png');
  const canonicalTransparent = path.join(outputDir, 'anchor-canonical-transparent.png');
  const generationPlate = path.join(outputDir, 'anchor-generation.png');
  const runtimeAnchor = path.join(outputDir, 'anchor-runtime.png');
  const pixelMatrix = path.join(outputDir, 'pixel-matrix.png');
  await writeRgba(canonicalChroma, canonicalChromaImage);
  await writeRgba(canonicalTransparent, canonicalTransparentImage);

  const generationScaleX = validatedConfig.generation.width / validatedConfig.canonical.width;
  const generationScaleY = validatedConfig.generation.height / validatedConfig.canonical.height;
  const runtimeScaleX = validatedConfig.runtime.width / validatedConfig.canonical.width;
  const runtimeScaleY = validatedConfig.runtime.height / validatedConfig.canonical.height;
  await writeRgba(generationPlate, scaleInteger(canonicalChromaImage, generationScaleX, generationScaleY));
  await writeRgba(runtimeAnchor, scaleInteger(canonicalTransparentImage, runtimeScaleX, runtimeScaleY));
  await createPixelMatrix({ output: pixelMatrix, width: validatedConfig.generation.width, height: validatedConfig.generation.height, blockSize: generationScaleX });

  const files = { input, canonicalChroma, canonicalTransparent, generationPlate, runtimeAnchor, pixelMatrix };
  const hashes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, await sha256(file)])));
  return {
    canonicalChroma,
    canonicalTransparent,
    generationPlate,
    runtimeAnchor,
    pixelMatrix,
    canonicalPivot: { ...validatedConfig.pivot },
    runtimePivot: { x: validatedConfig.pivot.x * runtimeScaleX, y: validatedConfig.pivot.y * runtimeScaleY },
    hashes
  };
}
