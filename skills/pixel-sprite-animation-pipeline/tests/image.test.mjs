import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import * as imageTools from '../scripts/lib/image.mjs';

async function solid(file, rgba) {
  await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: rgba[0], g: rgba[1], b: rgba[2], alpha: rgba[3] / 255 } } }).png().toFile(file);
}

test('captured RGBA hash and pixels come from one immutable byte snapshot', async () => {
  assert.equal(typeof imageTools.captureRgba, 'function', 'captureRgba must bind hashing and decoding to one read');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rgba-capture-'));
  const selected = path.join(directory, 'selected.png');
  const replacement = path.join(directory, 'replacement.png');
  await solid(selected, [20, 30, 60, 255]);
  await solid(replacement, [220, 60, 40, 255]);
  const originalHash = await imageTools.sha256(selected);

  const captured = await imageTools.captureRgba(selected, {
    readFile: async (file) => {
      const bytes = await fs.readFile(file);
      await fs.rename(replacement, file);
      return bytes;
    }
  });

  assert.equal(captured.sha256, originalHash);
  assert.notEqual(await imageTools.sha256(selected), originalHash);
  assert.deepEqual([...captured.image.data.subarray(0, 4)], [20, 30, 60, 255]);
});

test('an expected hash mismatch is reported before untrusted bytes are decoded', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rgba-mismatch-'));
  const selected = path.join(directory, 'selected.png');
  await fs.writeFile(selected, 'not an image');
  const captured = await imageTools.captureRgba(selected, { expectedSha256: '0'.repeat(64) });
  assert.equal(captured.image, null);
  assert.match(captured.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(captured.sha256, '0'.repeat(64));
});
