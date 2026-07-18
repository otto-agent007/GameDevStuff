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
import { sha256 } from '../scripts/lib/image.mjs';
import { normalizeFrames } from '../scripts/lib/normalize.mjs';
import { classifyFailures, validateIntegerScale, validateRun } from '../scripts/lib/validate.mjs';
import { applyDeterministicCorrections } from '../scripts/lib/correct.mjs';

async function temporaryDirectory(prefix = 'sprite-validate-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makePose(file, { width = 16, height = 16, color = [20, 30, 60, 255], background = [0, 0, 0, 0] } = {}) {
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(background, offset);
  for (let y = 4; y <= 11; y += 1) for (let x = 6; x <= 9; x += 1) data.set(color, (y * width + x) * 4);
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
}

async function makePassingRun() {
  const dir = await temporaryDirectory();
  const anchor = path.join(dir, 'anchor.png');
  await makePose(anchor);
  const anchorReport = await inspectImage(anchor);
  const normalized = await normalizeFrames({ inputs: [anchor], outputDir: path.join(dir, 'normalized'), config: DEFAULT_CONFIG });
  const exported = await exportAnimation({ frames: normalized.frames, outputDir: path.join(dir, 'export'), config: DEFAULT_CONFIG, columns: 1, durations: [80], name: 'walk' });
  return { dir, anchorReport, normalized, exported };
}

async function makeSmallExport(frameCount = 2) {
  const dir = await temporaryDirectory('sprite-small-export-');
  const frames = await Promise.all(Array.from({ length: frameCount }, async (_, index) => {
    const file = path.join(dir, `source-${index}.png`);
    await makePose(file, { color: [20 + index * 20, 30, 60, 255] });
    return file;
  }));
  const config = { ...DEFAULT_CONFIG, canonical: { width: 16, height: 16 }, generation: { width: 16, height: 16 }, runtime: { width: 16, height: 16 }, pivot: { x: 8, y: 14 } };
  const durations = frames.map((_, index) => 80 + index * 40);
  const exported = await exportAnimation({ frames, outputDir: path.join(dir, 'export'), config, columns: 2, durations, name: 'trusted' });
  const metadata = JSON.parse(await fs.readFile(exported.metadata, 'utf8'));
  return { dir, frames, config, durations, exported, metadata };
}

function validationTarget(failure) {
  return Object.fromEntries(['code', 'frame', 'stage', 'target'].filter((key) => failure[key] !== undefined).map((key) => [key, failure[key]]));
}

async function revalidationFor(failure, before, after, { removed = true } = {}) {
  return {
    target: validationTarget(failure),
    beforeValidation: { passed: false, failures: [validationTarget(failure)], artifacts: [{ path: before, sha256: await sha256(before) }] },
    afterValidation: { passed: removed, failures: removed ? [] : [validationTarget(failure)], artifacts: [{ path: after, sha256: await sha256(after) }] }
  };
}

test('integer scaling requires equal positive whole-number factors on both axes', () => {
  assert.deepEqual(validateIntegerScale({ source: { width: 128, height: 128 }, output: { width: 256, height: 256 } }), []);
  assert.deepEqual(validateIntegerScale({ source: { width: 128, height: 128 }, output: { width: 256, height: 384 } }).map(({ code }) => code), ['NON_INTEGER_SCALE']);
  assert.deepEqual(validateIntegerScale({ source: { width: 0, height: 128 }, output: { width: 256, height: 256 } }).map(({ code }) => code), ['NON_INTEGER_SCALE']);
});

test('classifies the complete correction taxonomy and gates unknown failures', () => {
  const codes = ['CANVAS_SIZE', 'NON_INTEGER_SCALE', 'INTERMEDIATE_COLORS', 'BACKGROUND_REMAINS', 'PIVOT_DRIFT', 'BASELINE_DRIFT', 'GLOBAL_SCALE_DRIFT', 'PALETTE_DRIFT', 'CLIPPED_FOREGROUND', 'FRAME_BLEED', 'FRAME_COUNT', 'TIMING_MISMATCH', 'METADATA_MISMATCH', 'SOURCE_HASH_MISMATCH', 'PREVIEW_MISMATCH', 'IDENTITY_DRIFT', 'DUPLICATE_POSE', 'LOOP_SEAM', 'NEW_FAILURE'];
  const classified = classifyFailures({ failures: codes.map((code) => ({ code })) });
  assert.deepEqual(classified.map(({ correction }) => correction), ['repad', 'nearest-rescale', 'nearest-rescale', 'rekey', 'realign', 'realign', 'nearest-rescale', 'palette-remap-review', 'stop-for-regeneration', 'repad', 'stop-for-review', 'reexport-metadata', 'reexport-metadata', 'stop-for-review', 'reexport-preview', 'stop-for-regeneration', 'stop-for-regeneration', 'timing-or-transition-review', 'stop-for-review']);
});

test('uses stage and trusted-artifact evidence for provenance correction classification', () => {
  const classified = classifyFailures({ failures: [
    { code: 'FRAME_COUNT', stage: 'metadata', trustedArtifact: true },
    { code: 'FRAME_COUNT', stage: 'metadata', trustedArtifact: false },
    { code: 'FRAME_COUNT', stage: 'runtime' },
    { code: 'SOURCE_HASH_MISMATCH', stage: 'metadata', trustedArtifact: true },
    { code: 'SOURCE_HASH_MISMATCH', stage: 'metadata' },
    { code: 'SOURCE_HASH_MISMATCH', stage: 'anchor' }
  ] });
  assert.deepEqual(classified.map(({ correction }) => correction), [
    'reexport-metadata', 'stop-for-review', 'stop-for-review', 'reexport-metadata', 'stop-for-review', 'stop-for-review'
  ]);
});

test('pivot and baseline correction routing follows the owning artifact stage', () => {
  const classified = classifyFailures({ failures: [
    { code: 'PIVOT_DRIFT', stage: 'canonical' },
    { code: 'BASELINE_DRIFT', stage: 'runtime' },
    { code: 'PIVOT_DRIFT', stage: 'metadata-canonical' },
    { code: 'PIVOT_DRIFT', stage: 'metadata' },
    { code: 'BASELINE_DRIFT', stage: 'preview' },
    { code: 'PIVOT_DRIFT', stage: 'sheet' }
  ] });
  assert.deepEqual(classified.map(({ correction }) => correction), ['realign', 'realign', 'reexport-metadata', 'reexport-metadata', 'reexport-preview', 'reexport-sheet']);
});

test('validates a complete export from actual artifacts and provenance', async () => {
  const fixture = await makePassingRun();
  const report = await validateRun({ ...fixture, config: DEFAULT_CONFIG });
  assert.equal(report.passed, true, JSON.stringify(report.failures));
  assert.deepEqual(report.failures, []);
  assert.equal(report.measurements.runtimeFrames, 1);
  assert.equal(report.measurements.previewPages, 1);
  assert.equal(report.measurements.sourceHashes.length, 1);
  assert.ok(report.warnings.some(({ code }) => code === 'HUMAN_REVIEW_REQUIRED'));
});

test('derives anchor palette and normalized scale from actual artifacts instead of caller claims', async () => {
  const fixture = await makePassingRun();
  fixture.anchorReport.palette = [{ rgba: [99, 98, 97, 255], count: 999 }];
  fixture.normalized.scaleFactor = 99;
  for (const item of fixture.normalized.measurements) item.scaleFactor = 99;
  const report = await validateRun({ ...fixture, config: DEFAULT_CONFIG });
  assert.equal(report.failures.some(({ code }) => code === 'PALETTE_DRIFT'), false);
  assert.equal(report.failures.some(({ code }) => code === 'GLOBAL_SCALE_DRIFT'), false);
  assert.deepEqual(report.measurements.normalizedScales, [1]);
});

test('derives scale with largest, minimum-size, and reject-multiple normalization policies', async () => {
  const dir = await temporaryDirectory();
  const anchor = path.join(dir, 'anchor.png');
  const data = Buffer.alloc(16 * 16 * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([0, 255, 0, 255], offset);
  for (let y = 4; y <= 11; y += 1) for (let x = 6; x <= 9; x += 1) data.set([20, 30, 60, 255], (y * 16 + x) * 4);
  data.set([255, 0, 0, 255], (2 * 16 + 14) * 4);
  await sharp(data, { raw: { width: 16, height: 16, channels: 4 } }).png().toFile(anchor);
  const anchorReport = await inspectImage(anchor);
  for (const [name, foreground] of [
    ['largest', { retentionPolicy: 'largest', minimumComponentPixels: 1 }],
    ['minimum', { retentionPolicy: 'all', minimumComponentPixels: 2 }],
    ['reject', { retentionPolicy: 'reject-multiple', minimumComponentPixels: 2 }]
  ]) {
    const config = { ...DEFAULT_CONFIG, background: { mode: 'color', color: { r: 0, g: 255, b: 0 }, tolerance: 0 }, foreground };
    const normalized = await normalizeFrames({ inputs: [anchor], outputDir: path.join(dir, `normalized-${name}`), config });
    const exported = await exportAnimation({ frames: normalized.frames, outputDir: path.join(dir, `export-${name}`), config, columns: 1, durations: [80], name });
    const report = await validateRun({ anchorReport, normalized, exported, config });
    assert.equal(report.failures.some(({ code }) => code === 'GLOBAL_SCALE_DRIFT'), false, `${name}: ${JSON.stringify(report.failures)}`);
    assert.deepEqual(report.measurements.normalizedScales, [1]);
  }
});

test('detects forged canonical pivot, config snapshot, and preview pixels', async () => {
  const fixture = await makePassingRun();
  const metadata = JSON.parse(await fs.readFile(fixture.exported.metadata, 'utf8'));
  metadata.canonicalPivot = { x: 1, y: 2 };
  metadata.config.runtime.width = 999;
  await fs.writeFile(fixture.exported.metadata, JSON.stringify(metadata));
  const wrong = Buffer.alloc(256 * 256 * 4);
  wrong.set([255, 0, 0, 255], 0);
  await sharp(wrong, { raw: { width: 256, height: 256, channels: 4 } }).webp({ lossless: true }).toFile(`${fixture.exported.preview}.bad`);
  await fs.rename(`${fixture.exported.preview}.bad`, fixture.exported.preview);
  const report = await validateRun({ ...fixture, config: DEFAULT_CONFIG });
  assert.ok(report.failures.some(({ code, stage }) => code === 'PIVOT_DRIFT' && stage === 'metadata-canonical'));
  assert.ok(report.failures.some(({ code, field }) => code === 'METADATA_MISMATCH' && field === 'config'));
  assert.ok(report.failures.some(({ code, field }) => code === 'PREVIEW_MISMATCH' && field === 'pixels'));
});

test('detects tampered pixels, hashes, timing, canvas, background, clipping, and provenance', async () => {
  const fixture = await makePassingRun();
  const metadata = JSON.parse(await fs.readFile(fixture.exported.metadata, 'utf8'));
  metadata.sources[0].sha256 = '0'.repeat(64);
  metadata.frames[0].duration = 99;
  await fs.writeFile(fixture.exported.metadata, JSON.stringify(metadata));
  const runtime = fixture.exported.runtimeFrames[0];
  const image = await sharp(runtime).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < image.info.height; y += 1) for (let x = 0; x < 4; x += 1) image.data.set([0, 255, 0, 255], (y * image.info.width + x) * 4);
  image.data.set([111, 112, 113, 255], (20 * image.info.width + 20) * 4);
  await sharp(image.data, { raw: image.info }).resize(255, 256, { kernel: 'nearest' }).png().toFile(`${runtime}.bad`);
  await fs.rename(`${runtime}.bad`, runtime);
  const report = await validateRun({ ...fixture, config: DEFAULT_CONFIG });
  const codes = new Set(report.failures.map(({ code }) => code));
  for (const code of ['CANVAS_SIZE', 'NON_INTEGER_SCALE', 'BACKGROUND_REMAINS', 'CLIPPED_FOREGROUND', 'INTERMEDIATE_COLORS', 'PALETTE_DRIFT', 'SOURCE_HASH_MISMATCH', 'TIMING_MISMATCH']) assert.ok(codes.has(code), `missing ${code}: ${JSON.stringify(report.failures)}`);
  assert.equal(report.passed, false);
});

test('semantic failures require explicit evidence and are otherwise human review warnings', async () => {
  const fixture = await makePassingRun();
  const withoutEvidence = await validateRun({ ...fixture, config: DEFAULT_CONFIG });
  assert.equal(withoutEvidence.failures.some(({ code }) => code === 'IDENTITY_DRIFT'), false);
  const withEvidence = await validateRun({ ...fixture, config: DEFAULT_CONFIG, semanticEvidence: [{ code: 'IDENTITY_DRIFT', frame: 0, failed: true, evidence: { reviewer: 'artist' } }] });
  assert.ok(withEvidence.failures.some(({ code }) => code === 'IDENTITY_DRIFT'));
});

test('validates sheet geometry and recorded palette against actual exported sources', async () => {
  const fixture = await makePassingRun();
  const metadata = JSON.parse(await fs.readFile(fixture.exported.metadata, 'utf8'));
  metadata.palette.colors = [{ rgba: [1, 2, 3, 255], count: 1 }];
  metadata.preview = '../wrong.webp';
  await fs.writeFile(fixture.exported.metadata, JSON.stringify(metadata));
  await sharp(fixture.exported.sheet).extract({ left: 0, top: 0, width: 255, height: 256 }).png().toFile(`${fixture.exported.sheet}.bad`);
  await fs.rename(`${fixture.exported.sheet}.bad`, fixture.exported.sheet);
  const report = await validateRun({ ...fixture, config: DEFAULT_CONFIG });
  assert.ok(report.failures.some(({ code }) => code === 'FRAME_BLEED'));
  assert.ok(report.failures.some(({ code, field }) => code === 'METADATA_MISMATCH' && field === 'palette'));
  assert.ok(report.failures.some(({ code, field }) => code === 'METADATA_MISMATCH' && field === 'artifactNames'));
});

test('correction preflight is atomic when an operation is missing or run state is invalid', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const run = { runDir, corrections: [], generativeAttempts: {} };
  await assert.rejects(applyDeterministicCorrections({ failures: [{ code: 'CANVAS_SIZE', correction: 'repad' }, { code: 'PIVOT_DRIFT', correction: 'realign' }], run, config: DEFAULT_CONFIG, operations: { repad: async () => ({ validationPassed: true }) } }), /missing deterministic correction operation: realign/);
  assert.deepEqual(await fs.readdir(runDir), []);
  await assert.rejects(applyDeterministicCorrections({ failures: [], run: { runDir, corrections: null }, config: DEFAULT_CONFIG, operations: {} }), /run corrections must be an array/);
  assert.deepEqual(await fs.readdir(runDir), []);
});

test('deduplicates equivalent deterministic work while retaining traceability', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const runManifest = `${JSON.stringify({ version: 1, runId: 'bound-run' })}\n`;
  await fs.writeFile(path.join(runDir, 'manifest.json'), runManifest);
  const before = path.join(runDir, 'bad.png');
  await makePose(before);
  const trustedFrame = path.join(runDir, 'trusted-runtime.png');
  await makePose(trustedFrame, { width: 128, height: 128 });
  let calls = 0;
  const failures = [{ code: 'CANVAS_SIZE', target: 'anchor', expected: [128, 128], actual: [16, 16], correction: 'repad', before }, { code: 'FRAME_BLEED', target: 'anchor', correction: 'repad', before: path.basename(before) }];
  const result = await applyDeterministicCorrections({ failures, run: { runDir, corrections: [], inputs: [before], generativeAttempts: {}, expected: { sheet: { runtimeFrames: [trustedFrame], columns: 1, frameSize: { width: 128, height: 128 } } } }, config: DEFAULT_CONFIG, operations: { repad: async ({ failures: shared, outputDir }) => { calls += 1; const output = path.join(outputDir, 'fixed.png'); const sidecar = path.join(outputDir, 'measurements.json'); await makePose(output, { width: 128, height: 128 }); await fs.writeFile(sidecar, '{}'); return { output, details: { artifact: output, nested: { sidecar } }, validationPassed: true, improved: true, revalidations: await Promise.all(shared.map((failure) => revalidationFor(failure, before, output))) }; } } });
  assert.equal(calls, 1);
  assert.equal(result.actions.length, 2);
  assert.equal(result.actions[0].status, 'applied');
  assert.match(result.actions[0].evidenceVerification.beforeSha256, /^[a-f0-9]{64}$/);
  assert.match(result.actions[0].evidenceVerification.afterSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.actions[1].status, 'deduplicated');
  assert.equal(result.actions[1].duplicateOf, 0);
  assert.equal(result.actions[1].sharedExecution, result.actions[0].executionId);
  assert.equal(result.actions[1].approved, true);
  assert.equal(result.actions[0].result.details.artifact, path.join(result.correctionDir, 'fixed.png'));
  await fs.access(result.actions[0].result.details.artifact);
  assert.equal(result.actions[0].result.details.nested.sidecar, path.join(result.correctionDir, 'measurements.json'));
  await fs.access(result.actions[0].result.details.nested.sidecar);
  const correctionManifest = JSON.parse(await fs.readFile(path.join(result.correctionDir, 'manifest.json')));
  assert.equal(correctionManifest.version, 1);
  assert.deepEqual(correctionManifest.run, { id: 'bound-run', manifestSha256: crypto.createHash('sha256').update(runManifest).digest('hex') });
});

test('shared execution leaves a deduplicated failure unapproved when its revalidation still fails', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const before = path.join(runDir, 'bad.png');
  await makePose(before);
  const failures = [{ code: 'CANVAS_SIZE', target: 'anchor', expected: [128, 128], actual: [16, 16], correction: 'repad', before }, { code: 'FRAME_BLEED', target: 'anchor', correction: 'repad', before }];
  const result = await applyDeterministicCorrections({ failures, run: { runDir, corrections: [], inputs: [before], generativeAttempts: {} }, config: DEFAULT_CONFIG, operations: { repad: async ({ failures: shared, outputDir }) => { const output = path.join(outputDir, 'fixed.png'); await makePose(output, { width: 128, height: 128 }); return { output, validationPassed: true, improved: true, revalidations: [await revalidationFor(shared[0], before, output), await revalidationFor(shared[1], before, output, { removed: false })] }; } } });
  assert.equal(result.actions[0].approved, true);
  assert.notEqual(result.actions[1].approved, true);
  assert.equal(result.actions[1].status, 'unapproved-shared');
});

test('does not approve a removed target when the after validation report still fails', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const before = path.join(runDir, 'before.png');
  await makePose(before);
  const failure = { code: 'CANVAS_SIZE', target: 'anchor', expected: [128, 128], actual: [16, 16], correction: 'repad', before };
  const result = await applyDeterministicCorrections({ failures: [failure], run: { runDir, corrections: [], inputs: [before], generativeAttempts: {} }, config: DEFAULT_CONFIG, operations: { repad: async ({ outputDir }) => { const output = path.join(outputDir, 'fixed.png'); await makePose(output, { width: 128, height: 128 }); const revalidation = await revalidationFor(failure, before, output); revalidation.afterValidation.passed = false; revalidation.afterValidation.failures = [{ code: 'METADATA_MISMATCH', correction: 'reexport-metadata', frame: 0 }]; return { output, validationPassed: true, improved: true, revalidations: [revalidation] }; } } });
  assert.equal(result.actions[0].approved, false);
  assert.equal(result.actions[0].status, 'unapproved');
});

test('approves a targeted objective correction when only artistic review remains', async () => {
  const runDir = await temporaryDirectory('sprite-correct-mixed-');
  const before = path.join(runDir, 'before.png');
  await makePose(before);
  const objective = { code: 'CANVAS_SIZE', stage: 'canonical', frame: 0, expected: [128, 128], actual: [16, 16], correction: 'repad', before };
  const artistic = { code: 'IDENTITY_DRIFT', frame: 0, correction: 'stop-for-regeneration' };
  const result = await applyDeterministicCorrections({ failures: [objective, artistic], run: { runDir, corrections: [], inputs: [before], generativeAttempts: {} }, config: DEFAULT_CONFIG, operations: { repad: async ({ outputDir }) => { const output = path.join(outputDir, 'fixed.png'); await makePose(output, { width: 128, height: 128 }); const revalidation = await revalidationFor(objective, before, output); revalidation.afterValidation.passed = false; revalidation.afterValidation.failures = [artistic]; return { output, validationPassed: true, improved: true, revalidations: [revalidation] }; } } });
  assert.equal(result.actions[0].approved, true);
  assert.notEqual(result.actions[1].approved, true);
  assert.equal(result.actions[1].requires, 'generative-retry');
});

test('does not approve byte-identical pivot output despite a claimed passing report', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const before = path.join(runDir, 'before.png');
  await makePose(before);
  const failure = { code: 'PIVOT_DRIFT', target: 'frame-0', expected: { x: 64, y: 112 }, actual: { x: 60, y: 112 }, correction: 'realign', before };
  const result = await applyDeterministicCorrections({ failures: [failure], run: { runDir, corrections: [], inputs: [before], generativeAttempts: {} }, config: DEFAULT_CONFIG, operations: { realign: async ({ outputDir }) => { const output = path.join(outputDir, 'same.png'); await fs.copyFile(before, output); const revalidation = await revalidationFor(failure, before, output); revalidation.afterValidation.measurements = { pivot: { x: 64, y: 112 } }; return { output, validationPassed: true, improved: true, revalidations: [revalidation] }; } } });
  assert.equal(result.actions[0].approved, false);
  assert.equal(result.actions[0].status, 'unapproved');
});

test('automatic correction classes require their failure-specific after measurements', async () => {
  const cases = [
    { code: 'PIVOT_DRIFT', correction: 'realign', expected: { x: 64, y: 112 }, actual: { x: 60, y: 112 } },
    { code: 'BASELINE_DRIFT', correction: 'realign', expected: 111, actual: 108 },
    { code: 'BACKGROUND_REMAINS', correction: 'rekey' },
    { code: 'INTERMEDIATE_COLORS', correction: 'nearest-rescale' },
    { code: 'NON_INTEGER_SCALE', correction: 'nearest-rescale' },
    { code: 'GLOBAL_SCALE_DRIFT', correction: 'nearest-rescale' }
  ];
  for (const item of cases) {
    const runDir = await temporaryDirectory('sprite-correct-');
    const before = path.join(runDir, 'before.png');
    await makePose(before);
    const failure = { ...item, target: 'frame-0', before };
    const result = await applyDeterministicCorrections({ failures: [failure], run: { runDir, corrections: [], inputs: [before], generativeAttempts: {} }, config: DEFAULT_CONFIG, operations: { [item.correction]: async ({ outputDir }) => { const output = path.join(outputDir, 'changed.png'); await makePose(output, { color: [40, 50, 70, 255] }); return { output, validationPassed: true, improved: true, revalidations: [await revalidationFor(failure, before, output)] }; } } });
    assert.equal(result.actions[0].approved, false, item.code);
  }
});

test('rejects malformed metadata and unrelated preview or sheet artifacts', async () => {
  const runtimeDir = await temporaryDirectory('sprite-runtime-');
  const runtimeFrames = [path.join(runtimeDir, 'frame-0.png'), path.join(runtimeDir, 'frame-1.png')];
  await makePose(runtimeFrames[0]);
  await makePose(runtimeFrames[1], { color: [40, 50, 70, 255] });
  const cases = [
    {
      code: 'METADATA_MISMATCH', correction: 'reexport-metadata', extension: 'json', contents: 'not json',
      expectedArtifact: { metadata: { frameSize: { width: 16, height: 16 }, canonicalPivot: { x: 8, y: 14 }, pivot: { x: 8, y: 14 }, durations: [80, 120], sources: [], frames: [], config: {} } }
    },
    {
      code: 'PREVIEW_MISMATCH', correction: 'reexport-preview', extension: 'webp',
      expectedArtifact: { preview: { runtimeFrames, durations: [80, 120] } }
    },
    {
      code: 'FRAME_BLEED', correction: 'repad', extension: 'png',
      expectedArtifact: { sheet: { runtimeFrames, columns: 2, frameSize: { width: 16, height: 16 } } }
    }
  ];
  for (const item of cases) {
    const runDir = await temporaryDirectory('sprite-correct-');
    const before = path.join(runDir, `before.${item.extension}`);
    if (item.extension === 'json') await fs.writeFile(before, '{}');
    else await makePose(before);
    const failure = { code: item.code, correction: item.correction, target: 'artifact', before };
    const result = await applyDeterministicCorrections({ failures: [failure], run: { runDir, corrections: [], inputs: [before], generativeAttempts: {}, expected: item.expectedArtifact }, config: DEFAULT_CONFIG, operations: { [item.correction]: async ({ outputDir }) => { const output = path.join(outputDir, `candidate.${item.extension}`); if (item.contents) await fs.writeFile(output, item.contents); else if (item.extension === 'webp') await sharp(runtimeFrames[0]).webp({ lossless: true }).toFile(output); else await makePose(output, { color: [80, 90, 100, 255] }); return { output, validationPassed: true, improved: true, revalidations: [await revalidationFor(failure, before, output)] }; } } });
    assert.equal(result.actions[0].approved, false, item.code);
  }
});

test('approves metadata, preview, and sheet corrections only when artifacts match trusted expectations', async () => {
  const fixtureDir = await temporaryDirectory('sprite-artifacts-');
  const sourceFrames = [path.join(fixtureDir, 'source-0.png'), path.join(fixtureDir, 'source-1.png')];
  await makePose(sourceFrames[0]);
  await makePose(sourceFrames[1], { color: [40, 50, 70, 255] });
  const smallConfig = { ...DEFAULT_CONFIG, canonical: { width: 16, height: 16 }, generation: { width: 16, height: 16 }, runtime: { width: 16, height: 16 }, pivot: { x: 8, y: 14 } };
  const exported = await exportAnimation({ frames: sourceFrames, outputDir: path.join(fixtureDir, 'export'), config: smallConfig, columns: 2, durations: [80, 120], name: 'trusted' });
  const expectedMetadata = JSON.parse(await fs.readFile(exported.metadata, 'utf8'));
  const cases = [
    { code: 'METADATA_MISMATCH', correction: 'reexport-metadata', source: exported.metadata, extension: 'json', expected: { metadata: expectedMetadata } },
    { code: 'PREVIEW_MISMATCH', correction: 'reexport-preview', source: exported.preview, extension: 'webp', expected: { preview: { runtimeFrames: exported.runtimeFrames, durations: [80, 120] } } },
    { code: 'FRAME_BLEED', correction: 'repad', source: exported.sheet, extension: 'png', expected: { sheet: { runtimeFrames: exported.runtimeFrames, columns: 2, frameSize: { width: 16, height: 16 } } } }
  ];
  for (const item of cases) {
    const runDir = await temporaryDirectory('sprite-correct-');
    const before = path.join(runDir, `before.${item.extension}`);
    if (item.extension === 'json') await fs.writeFile(before, '{}');
    else if (item.extension === 'webp') await sharp(sourceFrames[0]).webp({ lossless: true }).toFile(before);
    else await makePose(before, { color: [80, 90, 100, 255] });
    const failure = { code: item.code, correction: item.correction, target: 'artifact', before };
    const result = await applyDeterministicCorrections({ failures: [failure], run: { runDir, corrections: [], inputs: [before], generativeAttempts: {}, expected: item.expected }, config: smallConfig, operations: { [item.correction]: async ({ outputDir }) => { const output = path.join(outputDir, `fixed.${item.extension}`); await fs.copyFile(item.source, output); return { output, validationPassed: true, improved: true, revalidations: [await revalidationFor(failure, before, output)] }; } } });
    assert.equal(result.actions[0].approved, true, item.code);
  }
});

test('metadata correction requires the complete trusted document including future delivery fields', async () => {
  const fixture = await makeSmallExport();
  const runDir = await temporaryDirectory('sprite-correct-');
  const before = path.join(runDir, 'before.json');
  await fs.writeFile(before, '{}');
  const candidate = structuredClone(fixture.metadata);
  delete candidate.palette;
  candidate.futureDeliveryField = { ignoredByOldValidator: true };
  const failure = { code: 'METADATA_MISMATCH', stage: 'metadata', correction: 'reexport-metadata', target: 'metadata', before };
  const result = await applyDeterministicCorrections({ failures: [failure], run: { runDir, corrections: [], inputs: [before], generativeAttempts: {}, expected: { metadata: fixture.metadata } }, config: fixture.config, operations: { 'reexport-metadata': async ({ outputDir }) => { const output = path.join(outputDir, 'candidate.json'); await fs.writeFile(output, JSON.stringify(candidate)); return { output, validationPassed: true, improved: true, revalidations: [await revalidationFor(failure, before, output)] }; } } });
  assert.equal(result.actions[0].approved, false);
});

test('routes frame-count artifact verification by metadata or preview stage', async () => {
  const fixture = await makeSmallExport();
  for (const item of [
    { stage: 'metadata', correction: 'reexport-metadata', source: fixture.exported.metadata, extension: 'json' },
    { stage: 'preview', correction: 'reexport-preview', source: fixture.exported.preview, extension: 'webp' }
  ]) {
    const runDir = await temporaryDirectory('sprite-correct-');
    const before = path.join(runDir, `before.${item.extension}`);
    if (item.extension === 'json') await fs.writeFile(before, '{}');
    else await sharp(fixture.frames[0]).webp({ lossless: true }).toFile(before);
    const failure = { code: 'FRAME_COUNT', stage: item.stage, correction: item.correction, target: item.stage, before };
    const result = await applyDeterministicCorrections({ failures: [failure], run: { runDir, corrections: [], inputs: [before], generativeAttempts: {}, expected: { metadata: fixture.metadata, preview: { runtimeFrames: fixture.exported.runtimeFrames, durations: fixture.durations } } }, config: fixture.config, operations: { [item.correction]: async ({ outputDir }) => { const output = path.join(outputDir, `fixed.${item.extension}`); await fs.copyFile(item.source, output); return { output, validationPassed: true, improved: true, revalidations: [await revalidationFor(failure, before, output)] }; } } });
    assert.equal(result.actions[0].approved, true, item.stage);
  }
});

test('single-frame preview verifies pixels while timing comes from trusted metadata', async () => {
  const fixture = await makeSmallExport(1);
  for (const [metadataDuration, wrongPixels, approved] of [[80, false, true], [99, false, false], [80, true, false]]) {
    const runDir = await temporaryDirectory('sprite-correct-');
    const before = path.join(runDir, 'before.webp');
    await makePose(before, { color: [100, 110, 120, 255] });
    const failure = { code: 'PREVIEW_MISMATCH', stage: 'preview', correction: 'reexport-preview', target: 'preview', before };
    const result = await applyDeterministicCorrections({ failures: [failure], run: { runDir, corrections: [], inputs: [before], generativeAttempts: {}, expected: { metadata: { durations: [metadataDuration] }, preview: { runtimeFrames: fixture.exported.runtimeFrames, durations: fixture.durations } } }, config: fixture.config, operations: { 'reexport-preview': async ({ outputDir }) => { const output = path.join(outputDir, 'fixed.webp'); if (wrongPixels) await sharp(fixture.frames[0]).negate({ alpha: false }).webp({ lossless: true }).toFile(output); else await fs.copyFile(fixture.exported.preview, output); return { output, validationPassed: true, improved: true, revalidations: [await revalidationFor(failure, before, output)] }; } } });
    assert.equal(result.actions[0].approved, approved, `trusted duration ${metadataDuration}, wrongPixels ${wrongPixels}`);
  }
});

test('rejects non-image correction output even when supplied reports claim success', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const before = path.join(runDir, 'before.png');
  await makePose(before);
  await assert.rejects(applyDeterministicCorrections({
    failures: [{ code: 'CANVAS_SIZE', target: 'anchor', correction: 'repad', before }],
    run: { runDir, corrections: [], inputs: [before], generativeAttempts: {} }, config: DEFAULT_CONFIG,
    operations: { repad: async ({ failure, outputDir }) => { const output = path.join(outputDir, 'banana.png'); await fs.writeFile(output, 'banana'); return { output, validationPassed: true, improved: true, revalidations: [{ target: validationTarget(failure), beforeValidation: { failures: [validationTarget(failure)], artifacts: [{ path: before, sha256: await sha256(before) }] }, afterValidation: { failures: [], artifacts: [{ path: output, sha256: await sha256(output) }] } }] }; } }
  }), /valid image/);
});

test('rejects a nested staged artifact reference that does not exist', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const before = path.join(runDir, 'before.png');
  await makePose(before);
  const failure = { code: 'CANVAS_SIZE', target: 'anchor', expected: [128, 128], actual: [16, 16], correction: 'repad', before };
  await assert.rejects(applyDeterministicCorrections({
    failures: [failure], run: { runDir, corrections: [], inputs: [before], generativeAttempts: {} }, config: DEFAULT_CONFIG,
    operations: { repad: async ({ outputDir }) => { const output = path.join(outputDir, 'fixed.png'); await makePose(output, { width: 128, height: 128 }); return { output, details: { missing: path.join(outputDir, 'missing.json') }, validationPassed: true, improved: true, revalidations: [await revalidationFor(failure, before, output)] }; } }
  }), /missing staged artifact reference/);
});

test('does not approve true validation without explicit improvement and tied evidence', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const before = path.join(runDir, 'before.png');
  await makePose(before);
  const result = await applyDeterministicCorrections({
    failures: [{ code: 'CANVAS_SIZE', target: 'anchor', correction: 'repad', before }],
    run: { runDir, corrections: [], inputs: [before], generativeAttempts: {} },
    config: DEFAULT_CONFIG,
    operations: { repad: async ({ outputDir }) => { const output = path.join(outputDir, 'after.png'); await makePose(output); return { output, validationPassed: true }; } }
  });
  assert.equal(result.actions[0].status, 'unapproved');
  assert.equal(result.actions[0].approved, false);
  assert.equal(result.actions[0].improved, false);
});

test('rejects forged evidence that names another failure or an unrelated after artifact', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const before = path.join(runDir, 'before.png');
  await makePose(before);
  const result = await applyDeterministicCorrections({
    failures: [{ code: 'CANVAS_SIZE', target: 'anchor', correction: 'repad', before }],
    run: { runDir, corrections: [], inputs: [before], generativeAttempts: {} }, config: DEFAULT_CONFIG,
    operations: { repad: async ({ outputDir }) => { const output = path.join(outputDir, 'after.png'); await makePose(output); return { output, validationPassed: true, improved: true, evidence: { failureCode: 'PIVOT_DRIFT', target: 'anchor', before: { reference: before, measurement: { width: 131 } }, after: { reference: before, measurement: { width: 128 } } } }; } }
  });
  assert.equal(result.actions[0].status, 'unapproved');
});

test('does not treat identical before and after measurements as improvement', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const before = path.join(runDir, 'before.png');
  await makePose(before);
  const result = await applyDeterministicCorrections({
    failures: [{ code: 'CANVAS_SIZE', target: 'anchor', correction: 'repad', before }],
    run: { runDir, corrections: [], inputs: [before], generativeAttempts: {} }, config: DEFAULT_CONFIG,
    operations: { repad: async ({ outputDir }) => { const output = path.join(outputDir, 'after.png'); await makePose(output); return { output, validationPassed: true, improved: true, evidence: { failureCode: 'CANVAS_SIZE', target: 'anchor', before: { reference: before, measurement: { width: 131 } }, after: { reference: output, measurement: { width: 131 } } } }; } }
  });
  assert.equal(result.actions[0].status, 'unapproved');
});

test('non-improving corrections remain unapproved and never replace an artifact', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const input = path.join(runDir, 'approved.png');
  await makePose(input);
  const originalHash = await sha256(input);
  const result = await applyDeterministicCorrections({ failures: [{ code: 'CANVAS_SIZE', frame: 0, correction: 'repad', before: input }], run: { runDir, corrections: [], inputs: [input], generativeAttempts: {} }, config: DEFAULT_CONFIG, operations: { repad: async ({ outputDir }) => { const output = path.join(outputDir, 'candidate.png'); await makePose(output); return { output, validationPassed: false, improved: false, after: { width: 131 } }; } } });
  assert.equal(result.actions[0].status, 'unapproved');
  assert.equal(result.actions[0].before, input);
  assert.equal(result.actions[0].after, path.join(result.correctionDir, 'candidate.png'));
  assert.equal(await sha256(input), originalHash);
});

test('rejects escaped correction outputs and removes the staged batch', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  await assert.rejects(applyDeterministicCorrections({ failures: [{ code: 'CANVAS_SIZE', correction: 'repad' }], run: { runDir, corrections: [], generativeAttempts: {} }, config: DEFAULT_CONFIG, operations: { repad: async () => ({ output: path.join(runDir, 'escaped.png'), validationPassed: true }) } }), /outside correction directory/);
  assert.deepEqual((await fs.readdir(runDir)).filter((name) => name.startsWith('correction-') || name.startsWith('.correction-')), []);
});

test('rejects a symlinked output that resolves outside the correction directory', async (t) => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const outside = path.join(runDir, 'outside.png');
  await fs.writeFile(outside, 'outside');
  await assert.rejects(applyDeterministicCorrections({
    failures: [{ code: 'CANVAS_SIZE', correction: 'repad' }],
    run: { runDir, corrections: [], generativeAttempts: {} },
    config: DEFAULT_CONFIG,
    operations: { repad: async ({ outputDir }) => { const output = path.join(outputDir, 'linked.png'); try { await fs.symlink(outside, output); } catch (error) { if (error.code === 'EPERM') t.skip('symlinks unavailable'); throw error; } return { output, validationPassed: true }; } }
  }), /symbolic links|outside correction directory/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
});

test('rejects hard-linked input aliases and resolves relative manifest inputs from runDir', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const input = path.join(runDir, 'input.png');
  await fs.writeFile(input, 'input');
  await assert.rejects(applyDeterministicCorrections({
    failures: [{ code: 'CANVAS_SIZE', target: 'anchor', correction: 'repad', before: input }],
    run: { runDir, corrections: [], manifest: { inputs: { sources: [{ file: 'input.png' }] }, unrelated: { cache: 'not-an-input.png' } }, generativeAttempts: {} },
    config: DEFAULT_CONFIG,
    operations: { repad: async ({ outputDir }) => { const output = path.join(outputDir, 'alias.png'); await fs.link(input, output); return { output, validationPassed: true, improved: true }; } }
  }), /same file as an input/);
});

test('validates retry frame IDs and counters before creating a staging directory', async () => {
  for (const [generativeAttempts, frame, pattern] of [
    [new Map(), 1, /per-frame object/],
    [{ '-1': 0 }, 1, /retry frame IDs/],
    [{ 1: -1 }, 1, /retry counts/],
    [{ 1: 1.5 }, 1, /retry counts/],
    [{ 1: 0 }, '1', /generative failures require a nonnegative integer frame ID/]
  ]) {
    const runDir = await temporaryDirectory('sprite-correct-');
    await assert.rejects(applyDeterministicCorrections({
      failures: [{ code: 'IDENTITY_DRIFT', frame, correction: 'stop-for-regeneration' }],
      run: { runDir, corrections: [], generativeAttempts }, config: DEFAULT_CONFIG, operations: {}
    }), pattern);
    assert.deepEqual(await fs.readdir(runDir), []);
  }
});

test('generative retry accounting is capped per affected frame and never calls operations', async () => {
  const runDir = await temporaryDirectory('sprite-correct-');
  const result = await applyDeterministicCorrections({ failures: [{ code: 'IDENTITY_DRIFT', frame: 2, correction: 'stop-for-regeneration' }, { code: 'CLIPPED_FOREGROUND', frame: 4, correction: 'stop-for-regeneration' }, { code: 'LOOP_SEAM', correction: 'timing-or-transition-review' }, { code: 'NEW_FAILURE', correction: 'stop-for-review' }], run: { runDir, corrections: [], generativeAttempts: { 2: 1, 4: 2 } }, config: DEFAULT_CONFIG, operations: {} });
  assert.deepEqual(result.generativeAttemptsRemaining, { 2: 1, 4: 0 });
  assert.deepEqual(result.actions.map(({ requires }) => requires), ['generative-retry', 'generative-retry-exhausted', 'user-review', 'user-review']);
});
