import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { createProject, createRun } from '../scripts/lib/run-contract.mjs';
import { decodeMotionSource, registerSourceAdapter } from '../scripts/lib/source-adapter.mjs';
import { decodePngSequence } from '../scripts/lib/png-sequence.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectFixture = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');
const manifestFixture = path.join(packageDir, 'tests', 'fixtures', 'png-sequence', 'manifest.json');

async function png(file, rgba) {
  await sharp(Buffer.from(rgba), { raw: { width: 2, height: 2, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(file);
}

async function sequenceFixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-png-sequence-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const sourceRoot = path.join(parent, 'input');
  await fs.mkdir(sourceRoot);
  const manifest = JSON.parse(await fs.readFile(manifestFixture, 'utf8'));
  const manifestFile = path.join(sourceRoot, 'manifest.json');
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
  const red = [255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0];
  const blue = [0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0];
  await png(path.join(sourceRoot, 'frame-01.png'), red);
  await png(path.join(sourceRoot, 'frame-02.png'), blue);
  await png(path.join(sourceRoot, 'frame-03.png'), red);

  const projectRoot = path.join(parent, 'project');
  const project = await createProject({ root: projectRoot, contractFile: projectFixture });
  const run = await createRun({ projectRoot, project, sourceRequest: { actionId: 'idle', kind: 'png-sequence' } });
  return { manifestFile, run };
}

test('PNG intake preserves explicit order, alpha, duplicates, and nonuniform durations', async (t) => {
  const { manifestFile, run } = await sequenceFixture(t);
  registerSourceAdapter('png-sequence', ({ source, run: selectedRun }) => decodePngSequence({ manifest: source, run: selectedRun }));
  const result = await decodeMotionSource({ kind: 'png-sequence', source: manifestFile, run, options: {} });

  assert.deepEqual(result.frames.map((frame) => frame.durationMs), [80, 120, 200]);
  assert.deepEqual(result.frames.map((frame) => frame.id), ['step-contact', 'step-pass', 'step-contact-2']);
  assert.deepEqual(result.frames.map((frame) => frame.timestampMs), [0, 80, 200]);
  assert.equal(result.frames[2].duplicateOf, 'step-contact');
  assert.equal(result.alpha, true);
  assert.equal(result.diagnostics.some(({ code }) => code === 'DUPLICATE_FRAME'), true);
});

test('PNG intake rejects lexical guessing and omitted timing', async (t) => {
  const { run } = await sequenceFixture(t);
  await assert.rejects(decodePngSequence({ files: ['1.png', '2.png'], run }), /explicit sequence manifest/);

  const missingTiming = path.join(path.dirname(run.root), 'missing-timing.json');
  await fs.writeFile(missingTiming, JSON.stringify({ schemaVersion: 1, frames: [{ id: 'a', path: 'a.png' }] }));
  await assert.rejects(decodePngSequence({ manifest: missingTiming, run }), /durationMs is required/);
});

test('PNG intake rejects changed dimensions before publishing a source report', async (t) => {
  const { manifestFile, run } = await sequenceFixture(t);
  await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toFile(path.join(path.dirname(manifestFile), 'frame-02.png'));
  await assert.rejects(decodePngSequence({ manifest: manifestFile, run }), /identical canvas dimensions/);
  await assert.rejects(fs.lstat(path.join(run.root, 'reports', 'source.json')), /ENOENT/);
});
