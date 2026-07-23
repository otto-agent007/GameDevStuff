import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import YAML from 'yaml';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { inspectImage } from '../scripts/lib/inspect.mjs';
import { createRun, promoteVerifiedProfile, proposeSkillRule, recordRunResult } from '../scripts/lib/learning.mjs';
import { writeSnapReceipt } from '../scripts/lib/snap-receipt.mjs';

const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const stableConfig = () => structuredClone(DEFAULT_CONFIG);

async function project() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sprite-learning-'));
}

async function artifact(runDir, name, contents) {
  const file = path.join(runDir, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return { path: name, sha256: hash(contents) };
}

test('createRun binds a redacted inspection snapshot to matching source bytes and dimensions', async () => {
  const cwd = await project();
  const input = path.join(cwd, 'anchor.png');
  await sharp({ create: { width: 3, height: 4, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } }).png().toFile(input);
  const inspection = await inspectImage(input);
  const run = await createRun({ projectDir: cwd, config: stableConfig(), inputs: [input], inspectionSnapshot: inspection, idFactory: () => 'inspection-run' });
  const manifest = JSON.parse(await fs.readFile(run.manifestPath, 'utf8'));
  assert.equal(manifest.inspection.snapshot.path, '<source-redacted>');
  assert.match(manifest.inspection.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(manifest).includes(cwd), false);

  await assert.rejects(
    createRun({ projectDir: cwd, config: stableConfig(), inputs: [input], inspectionSnapshot: { ...inspection, width: 99 }, idFactory: () => 'bad-inspection' }),
    /inspection dimensions do not match/
  );
  await assert.rejects(
    createRun({ projectDir: cwd, config: stableConfig(), inputs: [input], inspectionSnapshot: { ...inspection, sha256: '0'.repeat(64) }, idFactory: () => 'bad-hash' }),
    /inspection source hash does not match/
  );
});

async function passingReport(run, runDir, additions = {}) {
  const source = await artifact(runDir, 'source/frame.png', 'verified-source');
  const output = await artifact(runDir, 'output/frame.png', 'verified-output');
  const receipt = await writeSnapReceipt({
    projectDir: path.dirname(path.dirname(path.dirname(runDir))),
    run: { runId: run.runId, outputDir: runDir, manifestSha256: run.manifestSha256 },
    contract: { sha256: 'a'.repeat(64) },
    inputs: [path.join(runDir, source.path)], outputs: [path.join(runDir, output.path)], args: ['16'],
    identity: { origin: 'managed-cache', sha256: 'b'.repeat(64), size: 1, version: 'test', helpSha256: 'c'.repeat(64), fixtureRgbaSha256: 'd'.repeat(64), pinnedReleaseTag: null, upstreamCommit: null }
  });
  return {
    runId: run.runId,
    manifestSha256: run.manifestSha256,
    validation: { passed: true, artifacts: [output] },
    toolProvenanceVerified: true,
    snapReceipt: { path: path.basename(receipt.path), sha256: receipt.sha256 },
    ...additions
  };
}

async function correctionEvidence(run, { failureCode = 'BACKGROUND_REMAINS', correction = 'rekey' } = {}) {
  const beforeFile = path.join(run.runDir, 'input/before.png');
  const afterFile = path.join(run.runDir, 'correction-01/after.png');
  await fs.mkdir(path.dirname(beforeFile), { recursive: true });
  await fs.mkdir(path.dirname(afterFile), { recursive: true });
  await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } }).png().toFile(beforeFile);
  await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(afterFile);
  const before = { path: 'input/before.png', sha256: await fileHash(beforeFile) };
  const after = { path: 'correction-01/after.png', sha256: await fileHash(afterFile) };
  const document = {
    version: 1,
    correctionVersion: 1,
    run: { id: run.runId, manifestSha256: run.manifestSha256 },
    actions: [{
      code: failureCode,
      correction,
      approved: true,
      status: 'applied',
      evidenceVerification: {
        valid: true,
        target: { code: failureCode },
        beforeSha256: before.sha256,
        afterSha256: after.sha256,
        beforeValidation: { passed: false, failures: [{ code: failureCode }], artifacts: [before] },
        afterValidation: { passed: true, failures: [], artifacts: [after], measurements: { background: { opaqueBorderPixels: 0, configuredColorPixels: 0 } } }
      }
    }]
  };
  const file = path.join(run.runDir, 'correction-01/manifest.json');
  await fs.writeFile(file, `${JSON.stringify(document)}\n`);
  return { path: 'correction-01/manifest.json', sha256: hash(`${JSON.stringify(document)}\n`) };
}

async function canvasCorrectionEvidence(run, { stage, beforeSize = [2, 2], afterSize = [4, 4], actionExpected = afterSize } = {}) {
  const beforeFile = path.join(run.runDir, 'input/before-canvas.png');
  const afterFile = path.join(run.runDir, 'correction-01/after-canvas.png');
  await fs.mkdir(path.dirname(beforeFile), { recursive: true });
  await fs.mkdir(path.dirname(afterFile), { recursive: true });
  await sharp({ create: { width: beforeSize[0], height: beforeSize[1], channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toFile(beforeFile);
  await sharp({ create: { width: afterSize[0], height: afterSize[1], channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toFile(afterFile);
  const before = { path: 'input/before-canvas.png', sha256: await fileHash(beforeFile) };
  const after = { path: 'correction-01/after-canvas.png', sha256: await fileHash(afterFile) };
  const target = { code: 'CANVAS_SIZE', ...(stage === undefined ? {} : { stage }) };
  const document = {
    version: 1,
    correctionVersion: 1,
    run: { id: run.runId, manifestSha256: run.manifestSha256 },
    actions: [{
      ...target,
      correction: 'repad',
      actual: beforeSize,
      expected: actionExpected,
      approved: true,
      status: 'applied',
      evidenceVerification: {
        valid: true,
        target,
        beforeSha256: before.sha256,
        afterSha256: after.sha256,
        beforeValidation: { passed: false, failures: [target], artifacts: [before] },
        afterValidation: { passed: true, failures: [], artifacts: [after] }
      }
    }]
  };
  const contents = `${JSON.stringify(document)}\n`;
  const file = path.join(run.runDir, 'correction-01/manifest.json');
  await fs.writeFile(file, contents);
  return { path: 'correction-01/manifest.json', sha256: hash(contents) };
}

async function fileHash(file) {
  return hash(await fs.readFile(file));
}

test('createRun publishes an immutable manifest with portable hashed inputs', async () => {
  const projectDir = await project();
  const input = path.join(projectDir, 'art', 'pilot.png');
  await fs.mkdir(path.dirname(input), { recursive: true });
  await fs.writeFile(input, 'pilot');
  const run = await createRun({
    projectDir,
    config: stableConfig(),
    inputs: [{ path: input, provenance: { source: 'pixel-snapper' } }],
    clock: () => new Date('2026-07-17T12:00:00.000Z'),
    idFactory: () => 'run-fixed'
  });
  const manifest = JSON.parse(await fs.readFile(run.manifestPath, 'utf8'));
  assert.equal(run.runId, 'run-fixed');
  assert.equal(manifest.createdAt, '2026-07-17T12:00:00.000Z');
  assert.deepEqual(manifest.inputs, [{ id: 'art/pilot.png', sha256: hash('pilot'), provenance: { source: 'pixel-snapper' } }]);
  assert.equal(JSON.stringify(manifest).includes(projectDir), false);
  await assert.rejects(createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-fixed' }), /already exists|reserved/);
});

test('concurrent run creation publishes exactly one complete manifest', async () => {
  const projectDir = await project();
  const attempts = await Promise.allSettled([1, 2].map(() => createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'same-run' })));
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((item) => item.status === 'rejected').length, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(projectDir, '.pixel-sprite-pipeline', 'runs', 'same-run', 'manifest.json'), 'utf8'));
  assert.equal(manifest.runId, 'same-run');
  assert.deepEqual((await fs.readdir(path.join(projectDir, '.pixel-sprite-pipeline', 'runs'))).filter((name) => name.includes('.tmp')), []);
});

test('run IDs reject Windows device stems, extensions, trailing punctuation, and controls on every platform', async () => {
  for (const id of ['CON', 'con.json', 'NUL', 'aux.txt', 'PRN', 'COM1', 'com9.log', 'LPT1', 'lpt9.data', 'run.', 'run ', 'bad\u0001id']) {
    const projectDir = await project();
    await assert.rejects(createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => id }), /Windows-safe/);
  }
});

test('createRun rejects non-JSON-safe state, secrets, and external inputs without a portable id', async () => {
  const projectDir = await project();
  const external = path.join(await project(), 'private.png');
  await fs.writeFile(external, 'private');
  await assert.rejects(createRun({ projectDir, config: { ...stableConfig(), extra: 1n }, inputs: [] }), /JSON-safe/);
  await assert.rejects(createRun({ projectDir, config: stableConfig(), inputs: [{ path: external }] }), /portable id/);
  await assert.rejects(createRun({ projectDir, config: stableConfig(), inputs: [{ path: external, id: 'external/private.png', provenance: { apiToken: 'nope' } }] }), /secret/);
  await assert.rejects(createRun({ projectDir, config: { ...stableConfig(), correction: { generativeAttempts: 2, skillProposalEvidence: 0 } }, inputs: [] }), /skillProposalEvidence/);
  await assert.rejects(createRun({ projectDir, config: { ...stableConfig(), surprise: true }, inputs: [] }), /unknown config key/);
  await assert.rejects(createRun({ projectDir, config: { ...stableConfig(), background: { ...stableConfig().background, surprise: true } }, inputs: [] }), /unknown config key/);
  await assert.rejects(createRun({ projectDir, config: { ...stableConfig(), background: { mode: 'configured', color: null, tolerance: 0 } }, inputs: [] }), /configured background.*RGBA/);
  await assert.rejects(createRun({ projectDir, config: { ...stableConfig(), background: { mode: 'border', color: { r: 0, g: 255, b: 0, a: 255 }, tolerance: 0 } }, inputs: [] }), /border background.*null/);
  await assert.rejects(createRun({ projectDir, config: stableConfig(), inputs: [{ path: external, id: 'external/private.png', provenance: { sourcePath: external } }] }), /absolute private paths/);
  assert.deepEqual(await fs.readdir(projectDir), []);
});

test('input normalization never follows file or parent-directory symlinks', async (t) => {
  const projectDir = await project();
  const local = path.join(projectDir, 'art', 'local.png');
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(local, 'local');
  const regular = await createRun({ projectDir, config: stableConfig(), inputs: [local], idFactory: () => 'regular-input' });
  assert.equal(JSON.parse(await fs.readFile(regular.manifestPath, 'utf8')).inputs[0].id, 'art/local.png');

  const externalDir = await project();
  const external = path.join(externalDir, 'external.png');
  await fs.writeFile(external, 'external');
  const fileLink = path.join(projectDir, 'art', 'file-link.png');
  const directoryLink = path.join(projectDir, 'linked-dir');
  try {
    await fs.symlink(external, fileLink);
    await fs.symlink(externalDir, directoryLink, 'dir');
  } catch (error) {
    if (error.code === 'EPERM') { t.skip('symlinks unavailable'); return; }
    throw error;
  }
  await assert.rejects(createRun({ projectDir, config: stableConfig(), inputs: [{ path: fileLink, id: 'external/file.png' }], idFactory: () => 'file-link' }), /symlink/);
  await assert.rejects(createRun({ projectDir, config: stableConfig(), inputs: [{ path: path.join(directoryLink, 'external.png'), id: 'external/parent.png' }], idFactory: () => 'parent-link' }), /symlink/);
  const explicit = await createRun({ projectDir, config: stableConfig(), inputs: [{ path: external, id: 'external/direct.png' }], idFactory: () => 'external-direct' });
  assert.equal(JSON.parse(await fs.readFile(explicit.manifestPath, 'utf8')).inputs[0].id, 'external/direct.png');
});

test('recordRunResult is immutable, tied to its manifest, and supports explicit versions', async () => {
  const projectDir = await project();
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-a' });
  const report = await passingReport(run, run.runDir);
  const first = await recordRunResult({ projectDir, runId: run.runId, report });
  assert.equal(path.basename(first.reportPath), 'report.json');
  await assert.rejects(recordRunResult({ projectDir, runId: run.runId, report }), /already exists/);
  const second = await recordRunResult({ projectDir, runId: run.runId, report, version: 2 });
  assert.equal(path.basename(second.reportPath), 'report-02.json');
  await assert.rejects(recordRunResult({ projectDir, runId: run.runId, report: { ...report, runId: 'wrong' }, version: 3 }), /run ID/);
  await assert.rejects(recordRunResult({ projectDir, runId: run.runId, report: { ...report, manifestSha256: '0'.repeat(64) }, version: 3 }), /manifest hash/);
  await assert.rejects(recordRunResult({ projectDir, runId: run.runId, report: { ...report, notes: path.join(projectDir, 'private.txt') }, version: 3 }), /absolute private paths/);
  await assert.rejects(fs.access(path.join(run.runDir, 'report-03.json')));
});

test('profile promotion requires artifact-backed passing evidence and preserves an existing profile on failure', async () => {
  const projectDir = await project();
  const stateDir = path.join(projectDir, '.pixel-sprite-pipeline');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(stateDir, 'profile.yaml'), 'sentinel: keep\n');
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-promote' });
  const badReport = { runId: run.runId, manifestSha256: run.manifestSha256, validation: { passed: true, artifacts: [] } };
  await recordRunResult({ projectDir, runId: run.runId, report: badReport });
  await assert.rejects(promoteVerifiedProfile({ projectDir, runId: run.runId }), /artifact-backed/);
  assert.equal(await fs.readFile(path.join(stateDir, 'profile.yaml'), 'utf8'), 'sentinel: keep\n');

  const goodReport = await passingReport(run, run.runDir);
  await recordRunResult({ projectDir, runId: run.runId, report: goodReport, version: 2 });
  await promoteVerifiedProfile({ projectDir, runId: run.runId, reportVersion: 2 });
  assert.deepEqual(YAML.parse(await fs.readFile(path.join(stateDir, 'profile.yaml'), 'utf8')), stableConfig());
});

test('profile promotion requires a verified signed snap receipt provenance binding', async () => {
  const projectDir = await project();
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-provenance' });
  const report = await passingReport(run, run.runDir);
  await recordRunResult({ projectDir, runId: run.runId, report: { ...report, toolProvenanceVerified: false, snapReceipt: null } });
  await assert.rejects(promoteVerifiedProfile({ projectDir, runId: run.runId }), /verified tool provenance/i);
});

test('verified standard provenance cannot promote while human review warnings remain outstanding', async () => {
  const projectDir = await project();
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-review-warning' });
  const report = await passingReport(run, run.runDir, {
    validation: {
      passed: true,
      warnings: [{ code: 'HUMAN_REVIEW_REQUIRED', check: 'IDENTITY_DRIFT' }],
      artifacts: [await artifact(run.runDir, 'review/output.png', 'reviewed-output')]
    },
    profilePromotion: { eligible: true, reviewRequired: false }
  });
  await recordRunResult({ projectDir, runId: run.runId, report });
  await assert.rejects(promoteVerifiedProfile({ projectDir, runId: run.runId }), /human review|review required/i);
});

test('profile promotion rejects symlinked and hard-linked evidence artifacts', async (t) => {
  const projectDir = await project();
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-linked' });
  const outside = path.join(projectDir, 'outside.txt');
  await fs.writeFile(outside, 'outside');
  const symlink = path.join(run.runDir, 'linked.txt');
  try { await fs.symlink(outside, symlink); } catch (error) { if (error.code === 'EPERM') t.skip('symlinks unavailable'); else throw error; }
  const symlinkReport = { runId: run.runId, manifestSha256: run.manifestSha256, validation: { passed: true, artifacts: [{ path: 'linked.txt', sha256: await fileHash(outside) }] } };
  await recordRunResult({ projectDir, runId: run.runId, report: symlinkReport });
  await assert.rejects(promoteVerifiedProfile({ projectDir, runId: run.runId }), /regular non-symlink|artifact-backed/);

  const hardlink = path.join(run.runDir, 'hard.txt');
  await fs.link(outside, hardlink);
  const hardReport = { runId: run.runId, manifestSha256: run.manifestSha256, validation: { passed: true, artifacts: [{ path: 'hard.txt', sha256: await fileHash(outside) }] } };
  await recordRunResult({ projectDir, runId: run.runId, report: hardReport, version: 2 });
  await assert.rejects(promoteVerifiedProfile({ projectDir, runId: run.runId, reportVersion: 2 }), /hard-linked|artifact-backed/);
});

test('recorded lessons require correction-manifest evidence, not caller booleans', async () => {
  const projectDir = await project();
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-lesson' });
  const report = await passingReport(run, run.runDir);
  await assert.rejects(recordRunResult({
    projectDir,
    runId: run.runId,
    report: { ...report, lessons: [{ failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup', approved: true }] }
  }), /correctionManifest/);
  const correctionManifest = await correctionEvidence(run);
  await recordRunResult({
    projectDir,
    runId: run.runId,
    report: { ...report, lessons: [{ failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup', correctionManifest, actionIndex: 0 }] },
    version: 2
  });
  const rows = (await fs.readFile(path.join(projectDir, '.pixel-sprite-pipeline', 'lessons.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, run.runId);
  assert.equal(rows[0].beforeSha256, await fileHash(path.join(run.runDir, 'input/before.png')));
  assert.equal(rows[0].afterSha256, await fileHash(path.join(run.runDir, 'correction-01/after.png')));
});

test('lesson recording rejects correction evidence whose backing artifact was changed', async () => {
  const projectDir = await project();
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-tampered' });
  const correctionManifest = await correctionEvidence(run);
  await fs.writeFile(path.join(run.runDir, 'correction-01', 'after.png'), 'tampered');
  await assert.rejects(recordRunResult({
    projectDir,
    runId: run.runId,
    report: await passingReport(run, run.runDir, { lessons: [{ failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup', correctionManifest, actionIndex: 0 }] })
  }), /artifact-backed before\/after/);
  await assert.rejects(fs.access(path.join(run.runDir, 'report.json')));
});

test('lesson recording validates every artifact in the before and after evidence sets', async (t) => {
  const projectDir = await project();
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-extra-artifact' });
  const correctionManifest = await correctionEvidence(run);
  const outside = path.join(projectDir, 'outside-extra.png');
  await fs.writeFile(outside, 'outside');
  const linked = path.join(run.runDir, 'correction-01', 'extra.png');
  try { await fs.symlink(outside, linked); } catch (error) { if (error.code === 'EPERM') t.skip('symlinks unavailable'); else throw error; }
  const file = path.join(run.runDir, correctionManifest.path);
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  document.actions[0].evidenceVerification.afterValidation.artifacts.push({ path: 'correction-01/extra.png', sha256: await fileHash(outside) });
  await fs.writeFile(file, `${JSON.stringify(document)}\n`);
  const updated = { path: correctionManifest.path, sha256: await fileHash(file) };
  await assert.rejects(recordRunResult({ projectDir, runId: run.runId, report: await passingReport(run, run.runDir, { lessons: [{ failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup', correctionManifest: updated, actionIndex: 0 }] }) }), /artifact-backed/);
});

test('lesson authenticity rejects wrong run binding and non-objective arbitrary artifacts', async () => {
  const projectDir = await project();
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-auth' });
  const correctionManifest = await correctionEvidence(run);
  const file = path.join(run.runDir, correctionManifest.path);
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  document.run.id = 'another-run';
  await fs.writeFile(file, `${JSON.stringify(document)}\n`);
  const rebound = { path: correctionManifest.path, sha256: await fileHash(file) };
  await assert.rejects(recordRunResult({ projectDir, runId: run.runId, report: await passingReport(run, run.runDir, { lessons: [{ failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup', correctionManifest: rebound, actionIndex: 0 }] }) }), /run binding/);

  document.run.id = run.runId;
  const beforeFile = path.join(run.runDir, 'input/before.png');
  const afterFile = path.join(run.runDir, 'correction-01/after.png');
  await fs.writeFile(beforeFile, 'arbitrary before text');
  await fs.writeFile(afterFile, 'arbitrary after text');
  const action = document.actions[0];
  action.evidenceVerification.beforeSha256 = await fileHash(beforeFile);
  action.evidenceVerification.afterSha256 = await fileHash(afterFile);
  action.evidenceVerification.beforeValidation.artifacts = [{ path: 'input/before.png', sha256: action.evidenceVerification.beforeSha256 }];
  action.evidenceVerification.afterValidation.artifacts = [{ path: 'correction-01/after.png', sha256: action.evidenceVerification.afterSha256 }];
  await fs.writeFile(file, `${JSON.stringify(document)}\n`);
  const arbitrary = { path: correctionManifest.path, sha256: await fileHash(file) };
  await assert.rejects(recordRunResult({ projectDir, runId: run.runId, report: await passingReport(run, run.runDir, { lessons: [{ failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup', correctionManifest: arbitrary, actionIndex: 0 }] }) }), /objective correction evidence|unsupported image format/);
});

test('canvas lessons derive expected dimensions from the bound run stage, never action claims', async () => {
  const projectDir = await project();
  const config = stableConfig();
  config.canonical = { width: 4, height: 4 };
  config.generation = { width: 8, height: 8 };
  config.runtime = { width: 12, height: 12 };
  config.pivot = { x: 2, y: 3 };

  const forgedRun = await createRun({ projectDir, config, inputs: [], idFactory: () => 'canvas-forged' });
  const forgedManifest = await canvasCorrectionEvidence(forgedRun, { stage: 'canonical', afterSize: [3, 3], actionExpected: [3, 3] });
  await assert.rejects(recordRunResult({ projectDir, runId: forgedRun.runId, report: await passingReport(forgedRun, forgedRun.runDir, { lessons: [{ failureCode: 'CANVAS_SIZE', correction: 'repad', proposedRule: 'Repad canonical cells', correctionManifest: forgedManifest, actionIndex: 0 }] }) }), /objective correction evidence/);

  const ambiguousRun = await createRun({ projectDir, config, inputs: [], idFactory: () => 'canvas-ambiguous' });
  const ambiguousManifest = await canvasCorrectionEvidence(ambiguousRun, { afterSize: [4, 4] });
  await assert.rejects(recordRunResult({ projectDir, runId: ambiguousRun.runId, report: await passingReport(ambiguousRun, ambiguousRun.runDir, { lessons: [{ failureCode: 'CANVAS_SIZE', correction: 'repad', proposedRule: 'Repad canonical cells', correctionManifest: ambiguousManifest, actionIndex: 0 }] }) }), /valid target stage|objective correction evidence/);

  const validRun = await createRun({ projectDir, config, inputs: [], idFactory: () => 'canvas-valid' });
  const validManifest = await canvasCorrectionEvidence(validRun, { stage: 'runtime', beforeSize: [2, 2], afterSize: [12, 12], actionExpected: [99, 99] });
  const recorded = await recordRunResult({ projectDir, runId: validRun.runId, report: await passingReport(validRun, validRun.runDir, { lessons: [{ failureCode: 'CANVAS_SIZE', correction: 'repad', proposedRule: 'Repad runtime cells', correctionManifest: validManifest, actionIndex: 0 }] }) });
  assert.equal(recorded.lessonsRecorded, 1);
});

test('proposal counts independently verified runs once and never applies a rule', async () => {
  const projectDir = await project();
  for (let index = 1; index <= 3; index += 1) {
    const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => `run-${index}` });
    const correctionManifest = await correctionEvidence(run);
    const report = await passingReport(run, run.runDir, { lessons: [
      { failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup', correctionManifest, actionIndex: 0 },
      { failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup', correctionManifest, actionIndex: 0 }
    ] });
    await recordRunResult({ projectDir, runId: run.runId, report });
  }
  const proposal = await proposeSkillRule({ projectDir, lesson: { failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup' }, config: stableConfig() });
  assert.equal(proposal.eligible, true);
  assert.equal(proposal.evidenceCount, 3);
  assert.deepEqual(proposal.evidence.map((item) => item.runId), ['run-1', 'run-2', 'run-3']);
  assert.equal(proposal.requiresUserApproval, true);
  assert.equal(proposal.applied, false);
});

test('proposal discloses threshold overrides and insufficient evidence', async () => {
  const projectDir = await project();
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-one' });
  const correctionManifest = await correctionEvidence(run);
  await recordRunResult({ projectDir, runId: run.runId, report: await passingReport(run, run.runDir, { lessons: [{ failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup', correctionManifest, actionIndex: 0 }] }) });
  const regular = await proposeSkillRule({ projectDir, lesson: { failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup' }, config: stableConfig() });
  assert.equal(regular.eligible, false);
  assert.match(regular.disclosure, /1 of 3/);
  const overridden = await proposeSkillRule({ projectDir, lesson: { failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup' }, config: stableConfig(), thresholdOverride: 1 });
  assert.equal(overridden.eligible, true);
  assert.equal(overridden.thresholdOverride, 1);
  assert.match(overridden.disclosure, /override/i);
});

test('proposal discloses matching records that fail later evidence verification', async () => {
  const projectDir = await project();
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-stale' });
  const correctionManifest = await correctionEvidence(run);
  await recordRunResult({ projectDir, runId: run.runId, report: await passingReport(run, run.runDir, { lessons: [{ failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup', correctionManifest, actionIndex: 0 }] }) });
  await fs.writeFile(path.join(run.runDir, correctionManifest.path), '{}\n');
  const proposal = await proposeSkillRule({ projectDir, lesson: { failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup' }, config: stableConfig() });
  assert.equal(proposal.evidenceCount, 0);
  assert.equal(proposal.rejectedEvidenceCount, 1);
  assert.match(proposal.disclosure, /failed evidence verification/);
});

test('an identical report can be retried to recover missing lesson-index publication', async () => {
  const projectDir = await project();
  const run = await createRun({ projectDir, config: stableConfig(), inputs: [], idFactory: () => 'run-recover' });
  const correctionManifest = await correctionEvidence(run);
  const report = await passingReport(run, run.runDir, { lessons: [{ failureCode: 'BACKGROUND_REMAINS', correction: 'rekey', proposedRule: 'Prefer chroma cleanup', correctionManifest, actionIndex: 0 }] });
  const lessonsFile = path.join(projectDir, '.pixel-sprite-pipeline', 'lessons.jsonl');
  await fs.writeFile(lessonsFile, '{bad json}\n');
  await assert.rejects(recordRunResult({ projectDir, runId: run.runId, report }), /malformed lessons.jsonl/);
  await fs.rm(lessonsFile);
  const recovered = await recordRunResult({ projectDir, runId: run.runId, report });
  assert.equal(recovered.recoveredExistingReport, true);
  assert.equal((await fs.readFile(lessonsFile, 'utf8')).trim().split('\n').length, 1);
  await assert.rejects(recordRunResult({ projectDir, runId: run.runId, report: { ...report, note: 'conflict' } }), /already exists.*different content/);
});

test('malformed lesson JSONL is surfaced instead of silently skipped', async () => {
  const projectDir = await project();
  const stateDir = path.join(projectDir, '.pixel-sprite-pipeline');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(stateDir, 'lessons.jsonl'), '{bad json}\n');
  await assert.rejects(proposeSkillRule({ projectDir, lesson: { failureCode: 'X', correction: 'Y', proposedRule: 'Z' }, config: stableConfig() }), /malformed lessons.jsonl row 1/);
});

test('well-formed JSON with a malformed lesson schema is also surfaced', async () => {
  const projectDir = await project();
  const stateDir = path.join(projectDir, '.pixel-sprite-pipeline');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(stateDir, 'lessons.jsonl'), '{}\n');
  await assert.rejects(proposeSkillRule({ projectDir, lesson: { failureCode: 'X', correction: 'Y', proposedRule: 'Z' }, config: stableConfig() }), /malformed lessons.jsonl row 1/);
});
