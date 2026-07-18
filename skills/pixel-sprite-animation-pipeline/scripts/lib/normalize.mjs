import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { extractPrimaryComponent, foregroundPredicate } from './components.mjs';
import { readRgba } from './image.mjs';

export async function normalizeFrames({
  inputs,
  outputDir,
  config,
  scaleFactor = 1,
  retentionPolicy = config.foreground?.retentionPolicy ?? 'all',
  minimumComponentPixels = config.foreground?.minimumComponentPixels ?? 1
}) {
  if (!Number.isInteger(scaleFactor) || scaleFactor < 1) {
    throw new Error('scaleFactor must be a positive integer');
  }
  const planned = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const image = await readRgba(input);
    const isForeground = foregroundPredicate(image, {
      color: config.background?.color,
      tolerance: config.background?.tolerance ?? 0
    });
    const recovered = await extractPrimaryComponent(input, {
      image,
      isForeground,
      retentionPolicy,
      minimumComponentPixels
    });
    const width = recovered.bounds.width * scaleFactor;
    const height = recovered.bounds.height * scaleFactor;
    const left = config.pivot.x - Math.floor(width / 2);
    const top = config.pivot.y - height;
    if (
      left < 0 || top < 0 ||
      left + width > config.canonical.width ||
      top + height > config.canonical.height
    ) {
      throw new Error(`frame ${input} exceeds canonical cell at global scale ${scaleFactor}`);
    }

    planned.push({
      input,
      output: path.join(outputDir, `frame-${String(index).padStart(2, '0')}.png`),
      recovered,
      left,
      top,
      width,
      height
    });
  }

  await fs.mkdir(outputDir, { recursive: true });
  const frames = [];
  const measurements = [];
  for (const plan of planned) {
    const crop = await sharp(plan.recovered.image.data, {
      raw: {
        width: plan.recovered.image.width,
        height: plan.recovered.image.height,
        channels: plan.recovered.image.channels
      }
    })
      .resize(plan.width, plan.height, { kernel: 'nearest' })
      .png()
      .toBuffer();
    await sharp({
      create: {
        width: config.canonical.width,
        height: config.canonical.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).composite([{ input: crop, left: plan.left, top: plan.top }]).png().toFile(plan.output);

    frames.push(plan.output);
    measurements.push({
      input: plan.input,
      output: plan.output,
      left: plan.left,
      top: plan.top,
      width: plan.width,
      height: plan.height,
      bottom: plan.top + plan.height - 1,
      scaleFactor,
      componentCount: plan.recovered.componentCount,
      retainedComponentCount: plan.recovered.retainedComponentCount,
      retainedPixelCount: plan.recovered.retainedPixelCount,
      retentionPolicy: plan.recovered.retentionPolicy,
      minimumComponentPixels: plan.recovered.minimumComponentPixels
    });
  }

  return {
    frames,
    canonicalPivot: { ...config.pivot },
    scaleFactor,
    measurements
  };
}
