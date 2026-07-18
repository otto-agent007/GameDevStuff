import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { makeAnchor } from './helpers/fixtures.mjs';
import { inspectImage } from '../scripts/lib/inspect.mjs';

test('inspection finds exact border background and foreground bounds', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-inspect-'));
  const file = path.join(dir, 'anchor.png');
  await makeAnchor(file);
  const report = await inspectImage(file, { tolerance: 0 });
  assert.deepEqual(report.background, { r: 0, g: 255, b: 0, a: 255 });
  assert.deepEqual(report.bounds, { left: 5, top: 3, width: 3, height: 9, right: 7, bottom: 11 });
  assert.equal(report.palette.length, 2);
  assert.deepEqual(report.alpha, { opaque: 182, transparent: 0, partial: 0 });
  assert.equal(report.components.count, 1);
  assert.deepEqual(report.components.sizes, [27]);
  assert.deepEqual(report.margins, { left: 5, top: 3, right: 5, bottom: 2 });
  assert.equal(typeof report.pixelGrid.confidence, 'number');
  assert.ok(Array.isArray(report.pixelGrid.evidence.runLengths));
  assert.equal(report.limitations.length > 0, true);
  assert.equal(report.pixelGrid.mixedBlockSizes, false);
});

test('inspection reports mixed blocks, alpha, clipping, and smoothing suspicion without certainty', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-inspect-diagnostics-'));
  const file = path.join(dir, 'mixed.png');
  const { default: sharp } = await import('sharp');
  const data = Buffer.alloc(8 * 8 * 4);
  for (let i = 0; i < 64; i += 1) data.set([0, 255, 0, 255], i * 4);
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 3; x += 1) data.set([20 + x, 30, 60, x === 1 ? 128 : 255], (y * 8 + x) * 4);
  await sharp(data, { raw: { width: 8, height: 8, channels: 4 } }).png().toFile(file);
  const report = await inspectImage(file);
  assert.equal(report.alpha.partial, 4);
  assert.equal(report.clipping.any, true);
  assert.ok(report.diagnostics.some(({ code }) => code === 'EDGE_CLIPPING'));
  assert.ok(report.diagnostics.some(({ code }) => code === 'SMOOTHING_SUSPECTED'));
  assert.equal(report.smoothing.suspected, true);
  assert.ok(report.smoothing.confidence < 1);
  assert.equal(report.pixelGrid.mixedBlockSizes, false);
});

test('inspection conservatively flags two statistically repeated horizontal block modes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-inspect-mixed-grid-'));
  const file = path.join(dir, 'mixed-grid.png');
  const { default: sharp } = await import('sharp');
  const width = 40, height = 12;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([0, 255, 0, 255], i * 4);
  for (let y = 1; y < 11; y += 1) {
    for (let x = 1; x < 17; x += 4) for (let dx = 0; dx < 2; dx += 1) data.set([20, 30, 60, 255], (y * width + x + dx) * 4);
    for (let x = 21; x < 39; x += 6) for (let dx = 0; dx < 3; dx += 1) data.set([20, 30, 60, 255], (y * width + x + dx) * 4);
  }
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
  const report = await inspectImage(file);
  assert.equal(report.pixelGrid.mixedBlockSizes, true);
  assert.ok(report.pixelGrid.evidence.repeatedIncompatibleModes.some(({ axis, modes }) => axis === 'horizontal' && modes.some(({ length }) => length === 2) && modes.some(({ length }) => length === 3)));
  assert.ok(report.diagnostics.some(({ code }) => code === 'MIXED_PIXEL_BLOCKS'));
});
