import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { detectPixelSnapper, writeSnapperHandoff } from '../scripts/lib/snapper.mjs';

test('missing Pixel Snapper produces a resumable manifest', async () => {
  const config = { snapper: { executable: 'definitely-not-installed-pixel-snapper', args: ['16'] } };
  assert.equal(detectPixelSnapper(config).available, false);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-handoff-'));
  const result = await writeSnapperHandoff({ inputs: ['frame-00.png'], outputDir, config });

  assert.equal(result.status, 'manual-handoff');
  const handoff = JSON.parse(await fs.readFile(result.handoffPath, 'utf8'));
  assert.deepEqual(handoff.expectedOutputs, ['frame-00-snapped.png']);
  assert.deepEqual(handoff.commandTemplate, ['definitely-not-installed-pixel-snapper', '<INPUT>', '<OUTPUT>', '16']);
  assert.deepEqual(handoff.sourceInputs, ['frame-00.png']);
  assert.equal(handoff.resumeCommand, `pixel-sprite-pipeline normalize --frames ${outputDir}`);
});

test('executable-only Snapper config retains the default grid-size argument', async () => {
  const config = { snapper: { executable: 'custom-pixel-snapper' } };
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-executable-only-'));
  const result = await writeSnapperHandoff({ inputs: ['frame-00.png'], outputDir, config });
  const handoff = JSON.parse(await fs.readFile(result.handoffPath, 'utf8'));

  assert.equal(handoff.executable, 'custom-pixel-snapper');
  assert.deepEqual(handoff.commandTemplate, ['custom-pixel-snapper', '<INPUT>', '<OUTPUT>', '16']);
});

test('args-only Snapper config retains the default executable and command ordering', async () => {
  const config = { snapper: { args: ['--palette', 'limited'] } };
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-args-only-'));
  const result = await writeSnapperHandoff({ inputs: ['frame-00.png'], outputDir, config });
  const handoff = JSON.parse(await fs.readFile(result.handoffPath, 'utf8'));

  assert.equal(handoff.executable, 'spritefusion-pixel-snapper');
  assert.deepEqual(handoff.commandTemplate, [
    'spritefusion-pixel-snapper', '<INPUT>', '<OUTPUT>', '16', '--palette', 'limited'
  ]);
});

test('PIXEL_SNAPPER_BIN overrides a configured executable', async () => {
  const config = { snapper: { executable: 'configured-pixel-snapper', args: ['--palette', 'limited'] } };
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-env-override-'));
  const originalExecutable = process.env.PIXEL_SNAPPER_BIN;
  process.env.PIXEL_SNAPPER_BIN = 'environment-pixel-snapper';
  try {
    const result = await writeSnapperHandoff({ inputs: ['frame-00.png'], outputDir, config });
    const handoff = JSON.parse(await fs.readFile(result.handoffPath, 'utf8'));

    assert.deepEqual(handoff.commandTemplate, [
      'environment-pixel-snapper', '<INPUT>', '<OUTPUT>', '16', '--palette', 'limited'
    ]);
  } finally {
    if (originalExecutable === undefined) delete process.env.PIXEL_SNAPPER_BIN;
    else process.env.PIXEL_SNAPPER_BIN = originalExecutable;
  }
});
