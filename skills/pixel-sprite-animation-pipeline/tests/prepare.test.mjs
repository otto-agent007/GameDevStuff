import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { makeAnchor } from './helpers/fixtures.mjs';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { readRgba } from '../scripts/lib/image.mjs';
import { createPixelMatrix, prepareAnchor } from '../scripts/lib/prepare.mjs';

const dimensions = async (file) => {
  const { width, height } = await sharp(file).metadata();
  return { width, height };
};

const pixelAt = (image, x, y) => {
  const i = (y * image.width + x) * 4;
  return [...image.data.subarray(i, i + 4)];
};

test('prepare pads without changing foreground pixels and exports exact sizes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-prepare-'));
  const input = path.join(dir, 'input.png');
  await makeAnchor(input);

  const result = await prepareAnchor({ input, outputDir: path.join(dir, 'out'), config: DEFAULT_CONFIG });

  assert.deepEqual(await dimensions(result.canonicalChroma), { width: 128, height: 128 });
  assert.deepEqual(await dimensions(result.generationPlate), { width: 1024, height: 1024 });
  assert.deepEqual(await dimensions(result.runtimeAnchor), { width: 256, height: 256 });
  assert.deepEqual(result.canonicalPivot, { x: 64, y: 112 });
  assert.deepEqual(result.runtimePivot, { x: 128, y: 224 });
  assert.equal(result.hashes.input.length, 64);

  const source = await readRgba(input);
  const canonical = await readRgba(result.canonicalChroma);
  const generation = await readRgba(result.generationPlate);
  const runtime = await readRgba(result.runtimeAnchor);
  for (let y = 3; y <= 11; y += 1) {
    for (let x = 5; x <= 7; x += 1) {
      const canonicalX = 63 + x - 5;
      const canonicalY = 103 + y - 3;
      const sourcePixel = pixelAt(source, x, y);
      assert.deepEqual(pixelAt(canonical, canonicalX, canonicalY), sourcePixel);
      for (let scaleY = 0; scaleY < 8; scaleY += 1) for (let scaleX = 0; scaleX < 8; scaleX += 1) {
        assert.deepEqual(pixelAt(generation, canonicalX * 8 + scaleX, canonicalY * 8 + scaleY), sourcePixel);
      }
      for (let scaleY = 0; scaleY < 2; scaleY += 1) for (let scaleX = 0; scaleX < 2; scaleX += 1) {
        assert.deepEqual(pixelAt(runtime, canonicalX * 2 + scaleX, canonicalY * 2 + scaleY), sourcePixel);
      }
    }
  }
});

test('prepare keys every matching background pixel including enclosed spaces', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-prepare-key-'));
  const input = path.join(dir, 'ring.png');
  const data = Buffer.alloc(7 * 7 * 4);
  for (let i = 0; i < 49; i += 1) data.set([0, 255, 0, 255], i * 4);
  for (let y = 1; y <= 5; y += 1) for (let x = 1; x <= 5; x += 1) {
    if (x === 1 || x === 5 || y === 1 || y === 5) data.set([20, 30, 60, 255], (y * 7 + x) * 4);
  }
  await sharp(data, { raw: { width: 7, height: 7, channels: 4 } }).png().toFile(input);

  const result = await prepareAnchor({ input, outputDir: path.join(dir, 'out'), config: DEFAULT_CONFIG });
  const transparent = await readRgba(result.canonicalTransparent);
  const chroma = await readRgba(result.canonicalChroma);
  const source = await readRgba(input);
  const left = 62, top = 107;

  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) {
    const sourcePixel = pixelAt(source, x + 1, y + 1);
    assert.deepEqual(pixelAt(chroma, left + x, top + y), sourcePixel);
    assert.equal(pixelAt(transparent, left + x, top + y)[3], sourcePixel[0] === 0 && sourcePixel[1] === 255 && sourcePixel[2] === 0 ? 0 : 255);
  }
});

test('prepare gives a transparent black anchor an opaque fallback chroma background', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-prepare-transparent-'));
  const input = path.join(dir, 'ring.png');
  const data = Buffer.alloc(7 * 7 * 4);
  const foreground = [20, 30, 60, 128];
  for (let y = 1; y <= 5; y += 1) for (let x = 1; x <= 5; x += 1) {
    if (x === 1 || x === 5 || y === 1 || y === 5) data.set(foreground, (y * 7 + x) * 4);
  }
  await sharp(data, { raw: { width: 7, height: 7, channels: 4 } }).png().toFile(input);

  const result = await prepareAnchor({ input, outputDir: path.join(dir, 'out'), config: DEFAULT_CONFIG });
  const chroma = await readRgba(result.canonicalChroma);
  const transparent = await readRgba(result.canonicalTransparent);
  const generation = await readRgba(result.generationPlate);
  const left = 62, top = 107;
  const fallbackChroma = [0, 255, 0, 255];

  for (const [x, y] of [[0, 0], [127, 0], [0, 127], [127, 127]]) {
    assert.deepEqual(pixelAt(chroma, x, y), fallbackChroma);
    assert.deepEqual(pixelAt(transparent, x, y), [0, 0, 0, 0]);
  }
  for (let y = 1; y <= 3; y += 1) for (let x = 1; x <= 3; x += 1) {
    assert.deepEqual(pixelAt(chroma, left + x, top + y), fallbackChroma);
    assert.deepEqual(pixelAt(transparent, left + x, top + y), [0, 0, 0, 0]);
    assert.deepEqual(pixelAt(generation, (left + x) * 8, (top + y) * 8), fallbackChroma);
  }
  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) {
    if (x === 0 || x === 4 || y === 0 || y === 4) {
      assert.deepEqual(pixelAt(chroma, left + x, top + y), foreground);
      assert.deepEqual(pixelAt(transparent, left + x, top + y), foreground);
    }
  }
});

test('prepare forces detected or configured chroma backgrounds opaque', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-prepare-chroma-'));
  const input = path.join(dir, 'anchor.png');
  const data = Buffer.alloc(5 * 5 * 4);
  for (let i = 0; i < 25; i += 1) data.set([7, 8, 9, 0], i * 4);
  data.set([20, 30, 60, 128], (2 * 5 + 2) * 4);
  await sharp(data, { raw: { width: 5, height: 5, channels: 4 } }).png().toFile(input);

  const detected = await prepareAnchor({ input, outputDir: path.join(dir, 'detected'), config: DEFAULT_CONFIG });
  const configured = await prepareAnchor({
    input,
    outputDir: path.join(dir, 'configured'),
    config: { ...DEFAULT_CONFIG, background: { mode: 'configured', color: { r: 90, g: 80, b: 70, a: 0 }, tolerance: 0 } }
  });

  assert.deepEqual(pixelAt(await readRgba(detected.canonicalChroma), 0, 0), [7, 8, 9, 255]);
  assert.deepEqual(pixelAt(await readRgba(configured.canonicalChroma), 0, 0), [90, 80, 70, 255]);
});

test('configured keying removes only the configured color and honors tolerance', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-prepare-configured-'));
  const input = path.join(dir, 'anchor.png');
  const data = Buffer.alloc(7 * 7 * 4);
  for (let i = 0; i < 49; i += 1) data.set([240, 0, 240, 255], i * 4);
  for (let y = 2; y <= 4; y += 1) for (let x = 2; x <= 4; x += 1) data.set([10, 201, 9, 255], (y * 7 + x) * 4);
  data.set([240, 0, 240, 255], (3 * 7 + 3) * 4);
  await sharp(data, { raw: { width: 7, height: 7, channels: 4 } }).png().toFile(input);
  const config = structuredClone(DEFAULT_CONFIG);
  config.background = { mode: 'configured', color: { r: 10, g: 200, b: 10, a: 255 }, tolerance: 1 };

  const result = await prepareAnchor({ input, outputDir: path.join(dir, 'out'), config });
  const transparent = await readRgba(result.canonicalTransparent);
  const chroma = await readRgba(result.canonicalChroma);
  const left = 61, top = 105;
  assert.deepEqual(pixelAt(transparent, left + 2, top + 2), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(chroma, left + 2, top + 2), [10, 200, 10, 255]);
  assert.deepEqual(pixelAt(transparent, left, top), [240, 0, 240, 255]);
});

test('configured key absent does not key an unrelated corner color', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-prepare-configured-absent-'));
  const input = path.join(dir, 'anchor.png');
  const data = Buffer.alloc(5 * 5 * 4);
  for (let i = 0; i < 25; i += 1) data.set([240, 0, 240, 255], i * 4);
  data.set([20, 30, 60, 255], (2 * 5 + 2) * 4);
  await sharp(data, { raw: { width: 5, height: 5, channels: 4 } }).png().toFile(input);
  const config = structuredClone(DEFAULT_CONFIG);
  config.background = { mode: 'configured', color: { r: 0, g: 255, b: 0, a: 255 }, tolerance: 0 };
  const result = await prepareAnchor({ input, outputDir: path.join(dir, 'out'), config });
  const transparent = await readRgba(result.canonicalTransparent);
  assert.ok([...transparent.data].some((value, index) => index % 4 === 0 && value === 240));
});

test('pixel matrix contains exact alternating generation-scale blocks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-matrix-'));
  const output = path.join(dir, 'pixel-matrix.png');
  await createPixelMatrix({ output, width: 1024, height: 1024, blockSize: 8 });

  const matrix = await readRgba(output);
  assert.deepEqual({ width: matrix.width, height: matrix.height }, { width: 1024, height: 1024 });
  for (let y = 0; y < 1024; y += 1) for (let x = 0; x < 1024; x += 1) {
    const value = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 255 : 0;
    assert.deepEqual(pixelAt(matrix, x, y), [value, value, value, 255]);
  }
});
