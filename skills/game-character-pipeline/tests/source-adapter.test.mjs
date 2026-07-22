import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeImmutableBytes } from '../scripts/lib/artifacts.mjs';
import { createProject, createRun } from '../scripts/lib/run-contract.mjs';
import {
  decodeMotionSource,
  registerSourceAdapter,
  validateMotionSourceResult
} from '../scripts/lib/source-adapter.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectFixture = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');

async function runFixture(t, kind = 'gif') {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-source-adapter-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const projectRoot = path.join(parent, 'project');
  const project = await createProject({ root: projectRoot, contractFile: projectFixture });
  const run = await createRun({ projectRoot, project, sourceRequest: { actionId: 'idle', kind } });
  return { parent, projectRoot, project, run };
}

function resultFor(frame, overrides = {}) {
  return {
    kind: 'test-source',
    sourceSha256: 'b'.repeat(64),
    decoder: { name: 'test-decoder', version: '1.0.0', arguments: ['decode'] },
    canvas: { width: 1, height: 1 },
    alpha: true,
    timeBase: { numerator: 1, denominator: 1000 },
    frames: [{
      index: 0,
      id: 'frame-1',
      path: frame.relative,
      sha256: frame.sha256,
      width: 1,
      height: 1,
      timestampMs: 0,
      durationMs: 100,
      sourceRect: { x: 0, y: 0, width: 1, height: 1 },
      duplicateOf: null
    }],
    diagnostics: [{ code: 'ALPHA_PRESENT', frameId: 'frame-1' }],
    approval: null,
    ...overrides
  };
}

test('registered adapters publish one frozen source report', async (t) => {
  const { run } = await runFixture(t);
  const frame = await writeImmutableBytes({
    root: run.root,
    relative: 'work/decoded/custom.bin',
    bytes: Buffer.from([0, 0, 0, 0])
  });
  registerSourceAdapter('gif', async () => resultFor(frame, { kind: 'gif' }));

  const result = await decodeMotionSource({ kind: 'gif', source: null, run, options: {} });
  assert.equal(Object.isFrozen(result.frames[0]), true);
  assert.equal(result.approval, null);
  const report = JSON.parse(await fs.readFile(path.join(run.root, 'reports', 'source.json'), 'utf8'));
  assert.equal(report.sourceSha256, 'b'.repeat(64));
});

test('source result rejects absolute paths, bad timing, unknown diagnostics, and changed bytes', async (t) => {
  const { run } = await runFixture(t);
  const frame = await writeImmutableBytes({
    root: run.root,
    relative: 'work/decoded/custom.bin',
    bytes: Buffer.from([0, 0, 0, 0])
  });

  const absolute = resultFor(frame);
  absolute.frames[0].path = frame.path;
  await assert.rejects(validateMotionSourceResult(absolute, { run }), /portable relative path/);

  const timing = resultFor(frame);
  timing.frames[0].durationMs = 0;
  await assert.rejects(validateMotionSourceResult(timing, { run }), /durationMs/);

  const diagnostic = resultFor(frame, { diagnostics: [{ code: 'SURPRISE', frameId: null }] });
  await assert.rejects(validateMotionSourceResult(diagnostic, { run }), /diagnostic code is invalid/);

  await fs.writeFile(frame.path, Buffer.from([1, 1, 1, 1]));
  await assert.rejects(validateMotionSourceResult(resultFor(frame), { run }), /frame hash mismatch/);
});

test('unregistered and duplicate adapters fail closed', async () => {
  await assert.rejects(decodeMotionSource({ kind: 'missing', source: null, run: {}, options: {} }), /unregistered motion source kind/);
  registerSourceAdapter('duplicate-source', async () => ({}));
  assert.throws(() => registerSourceAdapter('duplicate-source', async () => ({})), /already registered/);
});
