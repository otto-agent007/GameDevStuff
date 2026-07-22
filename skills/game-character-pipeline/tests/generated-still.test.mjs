import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

import {
  createGenerationHandoff,
  importGeneratedCandidate,
  loadGenerationHandoff
} from '../scripts/lib/generated-still.mjs';
import { createProject, createRun } from '../scripts/lib/run-contract.mjs';

const execFile = promisify(execFileCallback);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(packageDir, 'scripts', 'cli.mjs');
const projectFixture = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');

async function generatedFixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-generated-still-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const projectRoot = path.join(parent, 'project');
  const project = await createProject({ root: projectRoot, contractFile: projectFixture });
  const run = await createRun({ projectRoot, project, sourceRequest: { actionId: 'unlock', kind: 'generated-still' } });
  const generatedPng = path.join(parent, 'generated.png');
  await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 178, g: 112, b: 48, alpha: 1 } } })
    .png()
    .toFile(generatedPng);
  return { parent, projectRoot, project, run, generatedPng };
}

test('generated candidates remain unapproved immutable sources', async (t) => {
  const { project, run, generatedPng } = await generatedFixture(t);
  const handoff = await createGenerationHandoff({ project, run, actionId: 'unlock', poseId: 'key-turn', cliPath });
  assert.deepEqual(handoff.next.argv.slice(0, 3), [process.execPath, cliPath, 'intake']);

  const imported = await importGeneratedCandidate({ handoff, source: generatedPng, run, durationMs: 140 });
  assert.equal(imported.approval, null);
  assert.match(imported.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(imported.frames[0].durationMs, 140);
  assert.equal((await fs.lstat(path.join(run.root, imported.frames[0].path))).isFile(), true);
});

test('generated intake rejects missing timing and a changed handoff', async (t) => {
  const { project, run, generatedPng } = await generatedFixture(t);
  const handoff = await createGenerationHandoff({ project, run, actionId: 'unlock', poseId: 'key-turn', cliPath });
  await assert.rejects(importGeneratedCandidate({ handoff, source: generatedPng, run }), /explicit candidate duration/);

  await fs.writeFile(handoff.path, JSON.stringify({ changed: true }));
  await assert.rejects(
    importGeneratedCandidate({ handoff, source: generatedPng, run, durationMs: 140 }),
    /generation handoff hash mismatch/
  );
});

test('generated intake rejects a copied canonical handoff outside the run', async (t) => {
  const { parent, project, run } = await generatedFixture(t);
  const handoff = await createGenerationHandoff({ project, run, actionId: 'unlock', poseId: 'key-turn', cliPath });
  const copiedPath = path.join(parent, 'copied-handoff.json');
  await fs.copyFile(handoff.path, copiedPath);

  await assert.rejects(
    loadGenerationHandoff({ file: copiedPath, run }),
    /immutable generation handoff/
  );
});

test('CLI exits 2 with a structured generation handoff and resumes it', async (t) => {
  const { projectRoot, generatedPng } = await generatedFixture(t);
  let handoffError;
  try {
    await execFile(process.execPath, [
      cliPath, 'intake', '--project-dir', projectRoot, '--action', 'unlock', '--kind', 'generated-still', '--pose', 'key-turn'
    ], { cwd: packageDir });
  } catch (error) {
    handoffError = error;
  }
  assert.equal(handoffError.code, 2);
  const handoff = JSON.parse(handoffError.stdout);
  assert.equal(handoff.status, 'awaiting-generated-image');
  assert.equal(handoff.next.cwd, projectRoot);

  const argv = handoff.next.argv.map((value) => value === '<GENERATED_IMAGE>' ? generatedPng : value === '<DURATION_MS>' ? '140' : value);
  const resumed = await execFile(argv[0], argv.slice(1), { cwd: handoff.next.cwd });
  const result = JSON.parse(resumed.stdout);
  assert.equal(result.status, 'intake-complete');
  assert.equal(result.approval, null);
});
