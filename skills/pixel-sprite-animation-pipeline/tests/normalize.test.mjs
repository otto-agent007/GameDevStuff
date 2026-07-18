import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { connectedComponents, extractPrimaryComponent } from '../scripts/lib/components.mjs';
import { readRgba } from '../scripts/lib/image.mjs';
import { normalizeFrames } from '../scripts/lib/normalize.mjs';

async function frame(file, left, top, width, height) {
  await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).composite([{
    input: {
      create: {
        width,
        height,
        channels: 4,
        background: '#1a203fff'
      }
    },
    left,
    top
  }]).png().toFile(file);
}

async function pngNames(dir) {
  try {
    return (await fs.readdir(dir)).filter((name) => name.endsWith('.png'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function pixelAt(image, x, y) {
  return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
}

test('normalization preserves one scale and plants every frame on the shared baseline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-'));
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  await frame(a, 5, 8, 15, 30);
  await frame(b, 20, 20, 28, 18);

  const result = await normalizeFrames({
    inputs: [a, b],
    outputDir: path.join(dir, 'out'),
    config: DEFAULT_CONFIG,
    scaleFactor: 1
  });

  assert.equal(result.frames.length, 2);
  assert.deepEqual(result.canonicalPivot, { x: 64, y: 112 });
  assert.deepEqual(result.measurements.map((item) => item.bottom), [111, 111]);
  assert.deepEqual(result.measurements.map((item) => item.scaleFactor), [1, 1]);
  assert.deepEqual(result.measurements.map(({ width, height }) => ({ width, height })), [
    { width: 15, height: 30 },
    { width: 28, height: 18 }
  ]);
});

test('component recovery uses four-neighbor connectivity and largest mode masks secondary foreground', async () => {
  const diagonalImage = { width: 2, height: 2 };
  const diagonal = connectedComponents(diagonalImage, (x, y) => x === y);
  assert.deepEqual(diagonal.map((component) => component.length), [1, 1]);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-components-'));
  const input = path.join(dir, 'components.png');
  const data = Buffer.alloc(7 * 7 * 4);
  for (let y = 1; y <= 5; y += 1) for (let x = 1; x <= 5; x += 1) {
    if (x === 1 || x === 5 || y === 1 || y === 5) {
      data.set([26, 32, 63, 255], (y * 7 + x) * 4);
    }
  }
  data.set([255, 0, 0, 255], (3 * 7 + 3) * 4);
  data.set([255, 0, 0, 255], 6 * 4);
  await sharp(data, { raw: { width: 7, height: 7, channels: 4 } }).png().toFile(input);

  const recovered = await extractPrimaryComponent(input, { retentionPolicy: 'largest' });

  assert.equal(recovered.componentCount, 3);
  assert.equal(recovered.pixelCount, 16);
  assert.deepEqual(recovered.bounds, {
    left: 1,
    top: 1,
    right: 5,
    bottom: 5,
    width: 5,
    height: 5
  });
  assert.deepEqual(
    [...recovered.image.data.subarray((2 * recovered.image.width + 2) * 4, (2 * recovered.image.width + 2) * 4 + 4)],
    [0, 0, 0, 0]
  );

  const normalized = await normalizeFrames({
    inputs: [input],
    outputDir: path.join(dir, 'out'),
    config: DEFAULT_CONFIG,
    scaleFactor: 1,
    retentionPolicy: 'largest'
  });
  const output = await readRgba(normalized.frames[0]);
  assert.equal(normalized.measurements[0].componentCount, 3);
  assert.deepEqual(
    [...output.data.subarray((109 * output.width + 64) * 4, (109 * output.width + 64) * 4 + 4)],
    [0, 0, 0, 0]
  );
});

test('opaque dominant-border chroma is removed and output outside the subject is transparent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-chroma-'));
  const input = path.join(dir, 'green.png');
  const data = Buffer.alloc(9 * 7 * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([0, 250, 4, 255], offset);
  for (let y = 2; y <= 4; y += 1) for (let x = 3; x <= 5; x += 1) {
    data.set([26, 32, 63, 255], (y * 9 + x) * 4);
  }
  await sharp(data, { raw: { width: 9, height: 7, channels: 4 } }).png().toFile(input);

  const result = await normalizeFrames({
    inputs: [input],
    outputDir: path.join(dir, 'out'),
    config: { ...DEFAULT_CONFIG, background: { mode: 'border', color: null, tolerance: 5 } }
  });
  const output = await readRgba(result.frames[0]);

  assert.deepEqual(result.measurements[0], {
    ...result.measurements[0],
    width: 3,
    height: 3,
    componentCount: 1,
    retainedComponentCount: 1,
    retainedPixelCount: 9
  });
  assert.deepEqual(pixelAt(output, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(output, 63, 109), [26, 32, 63, 255]);
});

test('configured background color takes precedence over border detection and honors tolerance', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-configured-chroma-'));
  const input = path.join(dir, 'configured.png');
  const data = Buffer.alloc(5 * 5 * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([5, 245, 7, 255], offset);
  for (let x = 0; x < 5; x += 1) data.set([26, 32, 63, 255], x * 4);
  for (let y = 1; y < 4; y += 1) data.set([26, 32, 63, 255], (y * 5) * 4);
  for (let x = 0; x < 4; x += 1) data.set([26, 32, 63, 255], (4 * 5 + x) * 4);
  data.set([26, 32, 63, 255], (2 * 5 + 2) * 4);
  await sharp(data, { raw: { width: 5, height: 5, channels: 4 } }).png().toFile(input);

  const result = await normalizeFrames({
    inputs: [input],
    outputDir: path.join(dir, 'out'),
    config: {
      ...DEFAULT_CONFIG,
      background: { mode: 'border', color: { r: 0, g: 250, b: 4, a: 255 }, tolerance: 7 }
    }
  });

  assert.equal(result.measurements[0].componentCount, 2);
  assert.equal(result.measurements[0].retainedPixelCount, 13);
});

test('default all policy retains detached foreground and uses union bounds', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-detached-'));
  const input = path.join(dir, 'detached.png');
  const data = Buffer.alloc(12 * 5 * 4);
  for (let y = 1; y <= 2; y += 1) for (let x = 1; x <= 2; x += 1) {
    data.set([26, 32, 63, 255], (y * 12 + x) * 4);
  }
  for (let y = 1; y <= 2; y += 1) for (let x = 9; x <= 10; x += 1) {
    data.set([220, 60, 40, 255], (y * 12 + x) * 4);
  }
  await sharp(data, { raw: { width: 12, height: 5, channels: 4 } }).png().toFile(input);

  const result = await normalizeFrames({
    inputs: [input], outputDir: path.join(dir, 'out'), config: DEFAULT_CONFIG
  });
  const output = await readRgba(result.frames[0]);
  const measurement = result.measurements[0];

  assert.deepEqual({
    width: measurement.width,
    height: measurement.height,
    componentCount: measurement.componentCount,
    retainedComponentCount: measurement.retainedComponentCount,
    retainedPixelCount: measurement.retainedPixelCount
  }, { width: 10, height: 2, componentCount: 2, retainedComponentCount: 2, retainedPixelCount: 8 });
  assert.deepEqual(pixelAt(output, measurement.left, measurement.top), [26, 32, 63, 255]);
  assert.deepEqual(pixelAt(output, measurement.left + 9, measurement.top), [220, 60, 40, 255]);
  assert.deepEqual(pixelAt(output, measurement.left + 4, measurement.top), [0, 0, 0, 0]);
});

test('detached foreground union drives overflow while largest remains opt-in', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-union-overflow-'));
  const input = path.join(dir, 'detached.png');
  const allOutput = path.join(dir, 'all');
  const data = Buffer.alloc(10 * 3 * 4);
  for (const x of [0, 1, 8]) data.set([26, 32, 63, 255], (1 * 10 + x) * 4);
  await sharp(data, { raw: { width: 10, height: 3, channels: 4 } }).png().toFile(input);
  const config = { ...DEFAULT_CONFIG, canonical: { width: 6, height: 6 }, pivot: { x: 3, y: 5 } };

  await assert.rejects(
    normalizeFrames({ inputs: [input], outputDir: allOutput, config }),
    /exceeds canonical cell/
  );
  assert.deepEqual(await pngNames(allOutput), []);

  const largest = await normalizeFrames({
    inputs: [input], outputDir: path.join(dir, 'largest'), config, retentionPolicy: 'largest'
  });
  assert.deepEqual({
    width: largest.measurements[0].width,
    componentCount: largest.measurements[0].componentCount,
    retainedComponentCount: largest.measurements[0].retainedComponentCount,
    retainedPixelCount: largest.measurements[0].retainedPixelCount
  }, { width: 2, componentCount: 2, retainedComponentCount: 1, retainedPixelCount: 2 });
});

test('reject-multiple errors before writing any frame in the batch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-reject-multiple-'));
  const valid = path.join(dir, 'valid.png');
  const detached = path.join(dir, 'detached.png');
  const outputDir = path.join(dir, 'out');
  await frame(valid, 4, 4, 3, 3);
  const data = Buffer.alloc(8 * 4 * 4);
  data.set([26, 32, 63, 255], (1 * 8 + 1) * 4);
  data.set([26, 32, 63, 255], (1 * 8 + 6) * 4);
  await sharp(data, { raw: { width: 8, height: 4, channels: 4 } }).png().toFile(detached);

  await assert.rejects(
    normalizeFrames({
      inputs: [valid, detached], outputDir, config: DEFAULT_CONFIG, retentionPolicy: 'reject-multiple'
    }),
    /contains 2 foreground components/
  );
  assert.deepEqual(await pngNames(outputDir), []);
});

test('minimum component size is configurable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-minimum-component-'));
  const input = path.join(dir, 'noise.png');
  const data = Buffer.alloc(8 * 4 * 4);
  data.set([26, 32, 63, 255], (1 * 8 + 1) * 4);
  data.set([26, 32, 63, 255], (1 * 8 + 5) * 4);
  data.set([26, 32, 63, 255], (1 * 8 + 6) * 4);
  await sharp(data, { raw: { width: 8, height: 4, channels: 4 } }).png().toFile(input);

  const result = await normalizeFrames({
    inputs: [input],
    outputDir: path.join(dir, 'out'),
    config: DEFAULT_CONFIG,
    minimumComponentPixels: 2
  });
  assert.deepEqual({
    componentCount: result.measurements[0].componentCount,
    retainedComponentCount: result.measurements[0].retainedComponentCount,
    retainedPixelCount: result.measurements[0].retainedPixelCount
  }, { componentCount: 2, retainedComponentCount: 1, retainedPixelCount: 2 });
});

test('normalization rejects a foreground-free frame before writing any outputs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-empty-'));
  const valid = path.join(dir, 'valid.png');
  const empty = path.join(dir, 'empty.png');
  const outputDir = path.join(dir, 'out');
  await frame(valid, 10, 10, 8, 12);
  await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).png().toFile(empty);

  await assert.rejects(
    normalizeFrames({
      inputs: [valid, empty],
      outputDir,
      config: DEFAULT_CONFIG,
      scaleFactor: 1
    }),
    /contains no foreground/
  );
  assert.deepEqual(await pngNames(outputDir), []);
});

test('one integer scale is applied unchanged to every pose on transparent canonical canvases', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-global-scale-'));
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  await frame(a, 4, 5, 3, 4);
  await frame(b, 30, 25, 5, 2);

  const result = await normalizeFrames({
    inputs: [a, b],
    outputDir: path.join(dir, 'out'),
    config: DEFAULT_CONFIG,
    scaleFactor: 2
  });

  assert.equal(result.scaleFactor, 2);
  assert.deepEqual(result.measurements.map(({ width, height, scaleFactor, bottom }) => ({
    width,
    height,
    scaleFactor,
    bottom
  })), [
    { width: 6, height: 8, scaleFactor: 2, bottom: 111 },
    { width: 10, height: 4, scaleFactor: 2, bottom: 111 }
  ]);
  for (const outputFile of result.frames) {
    const metadata = await sharp(outputFile).metadata();
    const output = await readRgba(outputFile);
    assert.deepEqual({ width: metadata.width, height: metadata.height }, DEFAULT_CONFIG.canonical);
    assert.equal(metadata.hasAlpha, true);
    assert.deepEqual([...output.data.subarray(0, 4)], [0, 0, 0, 0]);
  }
});

test('normalization rejects fractional global scale factors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-fractional-'));
  const input = path.join(dir, 'input.png');
  const outputDir = path.join(dir, 'out');
  await frame(input, 10, 10, 8, 12);

  await assert.rejects(
    normalizeFrames({
      inputs: [input],
      outputDir,
      config: DEFAULT_CONFIG,
      scaleFactor: 1.5
    }),
    /scaleFactor must be a positive integer/
  );
  assert.deepEqual(await pngNames(outputDir), []);
});

test('normalization rejects canonical-cell overflow before writing any outputs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-overflow-'));
  const valid = path.join(dir, 'valid.png');
  const overflow = path.join(dir, 'overflow.png');
  const outputDir = path.join(dir, 'out');
  await frame(valid, 10, 10, 4, 4);
  await frame(overflow, 20, 20, 7, 6);
  const config = {
    ...DEFAULT_CONFIG,
    canonical: { width: 12, height: 12 },
    pivot: { x: 6, y: 10 }
  };

  await assert.rejects(
    normalizeFrames({
      inputs: [valid, overflow],
      outputDir,
      config,
      scaleFactor: 2
    }),
    /exceeds canonical cell at global scale 2/
  );
  assert.deepEqual(await pngNames(outputDir), []);
});
