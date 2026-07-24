import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { exportAnimation } from '../scripts/lib/export.mjs';
import { inspectImage } from '../scripts/lib/inspect.mjs';
import { proposeSkillRule, recordRunResult } from '../scripts/lib/learning.mjs';
import { normalizeFrames } from '../scripts/lib/normalize.mjs';
import { correctionExecutionStem, repairValidationRun } from '../scripts/lib/repair.mjs';
import { sha256 } from '../scripts/lib/image.mjs';
import { makeAnchor } from './helpers/fixtures.mjs';

test('real correction revalidates, records authenticated learning, and proposes only at the independent-run threshold', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-repair-e2e-'));
  const identity = { failureCode: 'CANVAS_SIZE', correction: 'repad', proposedRule: 'Use repad for CANVAS_SIZE' };
  for (let number = 1; number <= 3; number += 1) {
    const runId = `repair-run-${number}`;
    const runDir = path.join(project, '.pixel-sprite-pipeline', 'runs', runId);
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    const source = path.join(runDir, 'source.png');
    await makeAnchor(source);
    const anchorReport = await inspectImage(source);
    const good = await normalizeFrames({ inputs: [source], outputDir: path.join(runDir, 'good-normalized'), config: DEFAULT_CONFIG });
    const exported = await exportAnimation({ frames: good.frames, outputDir: path.join(runDir, 'good-runtime'), config: DEFAULT_CONFIG, columns: 1, durations: [100], name: 'animation' });
    const badFrame = path.join(runDir, 'bad-normalized.png');
    await sharp(good.frames[0]).extract({ left: 0, top: 0, width: 127, height: 128 }).png().toFile(badFrame);
    const normalized = { ...good, frames: [badFrame] };
    const manifest = { version: 1, runId, config: DEFAULT_CONFIG, inputs: [] };
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.writeFile(path.join(runDir, 'manifest.json'), manifestBytes);
    const request = { anchorReport, normalized, exported, semanticEvidence: [] };
    const expectedMetadata = JSON.parse(await fs.readFile(exported.metadata, 'utf8'));
    const result = await repairValidationRun({ request, run: { runDir, corrections: [], inputs: [source, badFrame], generativeAttempts: {} }, config: DEFAULT_CONFIG, expected: { metadata: expectedMetadata }, delivery: { name: 'animation', columns: 1, durations: [100], frameSize: DEFAULT_CONFIG.runtime } });
    assert.equal(result.beforeValidation.passed, false);
    assert.ok(result.beforeValidation.failures.some(({ code }) => code === 'CANVAS_SIZE'));
    assert.equal(result.afterValidation.passed, true);
    const actionIndex = result.correction.actions.findIndex(({ code, approved }) => code === 'CANVAS_SIZE' && approved);
    assert.ok(actionIndex >= 0);
    const manifestHash = crypto.createHash('sha256').update(manifestBytes).digest('hex');
    assert.equal(JSON.parse(await fs.readFile(result.correction.manifest, 'utf8')).run.manifestSha256, manifestHash);
    const delivered = [...result.exported.runtimeFrames, result.exported.sheet, result.exported.metadata, result.exported.preview];
    const artifacts = await Promise.all(delivered.map(async (file) => ({ path: path.relative(runDir, file).replaceAll('\\', '/'), sha256: await sha256(file) })));
    const correctionManifest = { path: path.relative(runDir, result.correction.manifest).replaceAll('\\', '/'), sha256: await sha256(result.correction.manifest) };
    await recordRunResult({ projectDir: project, runId, report: { runId, manifestSha256: manifestHash, validation: { passed: true, artifacts }, lessons: [{ ...identity, correctionManifest, actionIndex }] } });
    const proposal = await proposeSkillRule({ projectDir: project, lesson: identity, config: DEFAULT_CONFIG });
    assert.equal(proposal.evidenceCount, number);
    assert.equal(proposal.eligible, number === 3);
    assert.equal(proposal.requiresUserApproval, true);
  }
});

test('canvas correction persists while identity drift remains review-only with no delivery report', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-repair-mixed-'));
  const runDir = path.join(project, '.pixel-sprite-pipeline', 'runs', 'mixed-run');
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  const source = path.join(runDir, 'source.png'); await makeAnchor(source);
  const anchorReport = await inspectImage(source);
  const good = await normalizeFrames({ inputs: [source], outputDir: path.join(runDir, 'good'), config: DEFAULT_CONFIG });
  const exported = await exportAnimation({ frames: good.frames, outputDir: path.join(runDir, 'runtime'), config: DEFAULT_CONFIG, columns: 1, durations: [100], name: 'animation' });
  const bad = path.join(runDir, 'bad.png'); await sharp(good.frames[0]).extract({ left: 0, top: 0, width: 127, height: 128 }).png().toFile(bad);
  const manifestBytes = `${JSON.stringify({ version: 1, runId: 'mixed-run', config: DEFAULT_CONFIG, inputs: [] }, null, 2)}\n`; await fs.writeFile(path.join(runDir, 'manifest.json'), manifestBytes);
  const expectedMetadata = JSON.parse(await fs.readFile(exported.metadata, 'utf8'));
  const request = { anchorReport, normalized: { ...good, frames: [bad] }, exported, semanticEvidence: [{ code: 'IDENTITY_DRIFT', frame: 0, failed: true, evidence: { requires: 'artist-review' } }] };
  const result = await repairValidationRun({ request, run: { runDir, corrections: [], inputs: [source, bad], generativeAttempts: {} }, config: DEFAULT_CONFIG, expected: { metadata: expectedMetadata }, delivery: { name: 'animation', columns: 1, durations: [100], frameSize: DEFAULT_CONFIG.runtime } });
  assert.equal(result.afterValidation.passed, false);
  assert.deepEqual(result.afterValidation.failures.map(({ code }) => code), ['IDENTITY_DRIFT']);
  assert.ok(result.correction.actions.some(({ code, approved }) => code === 'CANVAS_SIZE' && approved));
  await assert.rejects(fs.access(path.join(runDir, 'report.json')), /ENOENT/);
});

test('simultaneous normalized metadata and runtime pivot failures receive unique execution identities', () => {
  const failures = [
    { code: 'PIVOT_DRIFT', frame: 0 },
    { code: 'PIVOT_DRIFT', stage: 'metadata-canonical', frame: 0 },
    { code: 'PIVOT_DRIFT', stage: 'runtime', frame: 0 }
  ];
  const stems = failures.map((failure) => correctionExecutionStem('realign', failure, 1));
  assert.equal(new Set(stems).size, 3);
});

test('simultaneous image and canonical/runtime metadata pivot drift repairs every owning artifact', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-pivot-e2e-'));
  const runDir = path.join(project, '.pixel-sprite-pipeline', 'runs', 'pivot-run'); await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  const source = path.join(runDir, 'source.png'); await makeAnchor(source);
  const anchorReport = await inspectImage(source);
  const good = await normalizeFrames({ inputs: [source], outputDir: path.join(runDir, 'good'), config: DEFAULT_CONFIG });
  const exported = await exportAnimation({ frames: good.frames, outputDir: path.join(runDir, 'runtime'), config: DEFAULT_CONFIG, columns: 1, durations: [100], name: 'animation' });
  const expectedMetadata = JSON.parse(await fs.readFile(exported.metadata, 'utf8'));
  const badFrame = path.join(runDir, 'bad-shifted.png');
  await sharp(good.frames[0]).extract({ left: 0, top: 0, width: 128, height: 127 }).extend({ top: 1, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(badFrame);
  const damagedMetadata = structuredClone(expectedMetadata); damagedMetadata.canonicalPivot = { x: 60, y: 110 }; damagedMetadata.pivot = { x: 120, y: 220 }; await fs.writeFile(exported.metadata, `${JSON.stringify(damagedMetadata)}\n`);
  const manifestBytes = `${JSON.stringify({ version: 1, runId: 'pivot-run', config: DEFAULT_CONFIG, inputs: [] }, null, 2)}\n`; await fs.writeFile(path.join(runDir, 'manifest.json'), manifestBytes);
  const request = { anchorReport, normalized: { ...good, frames: [badFrame], canonicalPivot: { x: 60, y: 110 } }, exported, semanticEvidence: [] };
  const result = await repairValidationRun({ request, run: { runDir, corrections: [], inputs: [source, badFrame, exported.metadata], generativeAttempts: {} }, config: DEFAULT_CONFIG, expected: { metadata: expectedMetadata }, delivery: { name: 'animation', columns: 1, durations: [100], frameSize: DEFAULT_CONFIG.runtime } });
  assert.ok(result.beforeValidation.failures.filter(({ code }) => code === 'PIVOT_DRIFT').length >= 3);
  assert.equal(result.afterValidation.passed, true, JSON.stringify(result.afterValidation.failures));
  const pivotActions = result.correction.actions.filter(({ code }) => code === 'PIVOT_DRIFT');
  assert.ok(pivotActions.every(({ approved }) => approved));
  assert.ok(pivotActions.some(({ correction }) => correction === 'realign'));
  assert.ok(pivotActions.filter(({ correction }) => correction === 'reexport-metadata').length >= 2);
  const outputs = pivotActions.filter(({ status }) => status === 'applied').map(({ result: actionResult }) => actionResult.output);
  assert.equal(new Set(outputs).size, outputs.length);
});
