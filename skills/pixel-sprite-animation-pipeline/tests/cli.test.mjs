import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { exportAnimation } from '../scripts/lib/export.mjs';
import { readRgba, writeRgba } from '../scripts/lib/image.mjs';
import { inspectImage } from '../scripts/lib/inspect.mjs';
import { normalizeFrames } from '../scripts/lib/normalize.mjs';
import { prepareAnchor } from '../scripts/lib/prepare.mjs';
import { makeAnchor } from './helpers/fixtures.mjs';

const packageDir = path.resolve(import.meta.dirname, '..');
const cli = path.join(packageDir, 'scripts', 'cli.mjs');

function invoke(args, { cwd = packageDir, env = {} } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function json(output) {
  return JSON.parse(output);
}

async function tempProject(label = 'sprite cli project ') {
  return fs.mkdtemp(path.join(os.tmpdir(), label));
}

async function validationRequest(projectDir) {
  const input = path.join(projectDir, 'pilot anchor.png');
  await makeAnchor(input);
  const prepared = await prepareAnchor({ input, outputDir: path.join(projectDir, 'prepared'), config: structuredClone(DEFAULT_CONFIG) });
  const normalized = await normalizeFrames({
    inputs: [prepared.canonicalTransparent],
    outputDir: path.join(projectDir, 'normalized'),
    config: structuredClone(DEFAULT_CONFIG),
    scaleFactor: 1
  });
  const exported = await exportAnimation({
    frames: normalized.frames,
    outputDir: path.join(projectDir, 'export'),
    config: structuredClone(DEFAULT_CONFIG),
    columns: 1,
    durations: [100],
    name: 'walk'
  });
  const request = { version: 1, anchorReport: await inspectImage(input), normalized, exported, semanticEvidence: [] };
  const requestPath = path.join(projectDir, 'validation request.json');
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  return { request, requestPath };
}

test('CLI exposes every independently callable pipeline stage', () => {
  const result = invoke(['--help']);
  assert.equal(result.status, 0, result.stderr);
  for (const command of ['inspect', 'prepare', 'snap', 'normalize', 'export', 'validate', 'correct', 'promote-profile', 'propose-rule', 'run']) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test('skill instructions require structured argv handoff execution', async () => {
  const skill = await fs.readFile(path.join(packageDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /structured `next\.cwd` and `next\.argv`/);
  assert.match(skill, /Never reconstruct a shell command by joining argv/);
});

test('inspect emits JSON on stdout and accepts a Windows-hostile comma and space path', async () => {
  const projectDir = await tempProject();
  const input = path.join(projectDir, 'pilot, idle frame.png');
  await makeAnchor(input);
  const result = invoke(['inspect', '--input', input, '--tolerance', '0']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(json(result.stdout).width, 13);
});

test('usage and malformed numeric input emit actionable JSON only on stderr', () => {
  const result = invoke(['normalize', '--frame', 'a.png', '--output', 'out', '--scale', '1.5']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = json(result.stderr);
  assert.match(error.error, /scale.*positive integer/i);
  assert.equal('stack' in error, false);
});

test('snap emits a resumable manual handoff with exit 2 when Pixel Snapper is unavailable', async () => {
  const projectDir = await tempProject();
  const frame = path.join(projectDir, 'frame, one.png');
  await makeAnchor(frame);
  const output = path.join(projectDir, 'snap output');
  const result = invoke(['snap', '--frame', frame, '--output', output], { env: { PIXEL_SNAPPER_BIN: 'definitely-missing-pixel-snapper' } });
  assert.equal(result.status, 2, result.stderr);
  const response = json(result.stdout);
  assert.equal(response.status, 'manual-handoff');
  const handoff = JSON.parse(await fs.readFile(response.handoffPath, 'utf8'));
  assert.equal(handoff.next.cwd, packageDir);
  assert.equal(handoff.next.argv[0], process.execPath);
  assert.equal(handoff.next.argv[1], cli);
  assert.ok(handoff.snapperInvocations.every((invocation) => Array.isArray(invocation.argv)));
  assert.equal('resumeCommand' in handoff, false);
  assert.equal(result.stderr, '');
});

test('validate distinguishes objective failure exit 3 from required user review exit 4', async () => {
  const projectDir = await tempProject();
  const { request, requestPath } = await validationRequest(projectDir);
  const review = invoke(['validate', '--request', requestPath]);
  assert.equal(review.status, 4, review.stderr);
  assert.equal(json(review.stdout).passed, true);
  assert.ok(json(review.stdout).warnings.some((warning) => warning.code === 'HUMAN_REVIEW_REQUIRED'));

  const metadata = JSON.parse(await fs.readFile(request.exported.metadata, 'utf8'));
  metadata.durations = [10];
  await fs.writeFile(request.exported.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
  const failed = invoke(['validate', '--request', requestPath]);
  assert.equal(failed.status, 3, failed.stderr);
  assert.equal(json(failed.stdout).passed, false);
  assert.ok(json(failed.stdout).failures.some((failure) => failure.code === 'TIMING_MISMATCH'));
});

test('objective blockers take exit 3 priority when subjective review failures coexist', async () => {
  const projectDir = await tempProject();
  const { request, requestPath } = await validationRequest(projectDir);
  request.semanticEvidence = [{ code: 'IDENTITY_DRIFT', failed: true, frame: 0, evidence: { reviewer: 'human' } }];
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const metadata = JSON.parse(await fs.readFile(request.exported.metadata, 'utf8'));
  metadata.durations = [10];
  await fs.writeFile(request.exported.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
  const result = invoke(['validate', '--request', requestPath]);
  assert.equal(result.status, 3, result.stderr);
  const report = json(result.stdout);
  assert.ok(report.failures.some((failure) => failure.correction === 'reexport-metadata'));
  assert.ok(report.failures.some((failure) => failure.correction === 'stop-for-regeneration'));
});

test('validate rejects malformed and unknown request fields without evaluating data as code', async () => {
  const projectDir = await tempProject();
  const request = path.join(projectDir, 'bad.json');
  await fs.writeFile(request, JSON.stringify({ version: 1, anchorReport: {}, normalized: {}, exported: {}, operation: 'process.exit(0)' }));
  const result = invoke(['validate', '--request', request]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(json(result.stderr).error, /unknown validation request field/i);
});

test('guided run creates a versioned generation handoff and resumes inside the same run', async () => {
  const projectDir = await tempProject();
  const input = path.join(projectDir, 'anchor.png');
  const frame = path.join(projectDir, 'generated frame.png');
  await makeAnchor(input);
  await makeAnchor(frame);

  const initial = invoke(['run', '--input', input, '--project-dir', projectDir]);
  assert.equal(initial.status, 2, initial.stderr);
  const handoff = json(initial.stdout);
  assert.equal(handoff.status, 'generation-handoff');
  assert.equal(handoff.state, 'awaiting-generated-frames');
  const persisted = await fs.readFile(handoff.handoffPath, 'utf8');
  assert.equal(json(persisted).references.matrix.blockSize, 8);
  assert.equal(json(persisted).schema, 'pixel-sprite-run-handoff/v1');
  assert.match(json(persisted).configSha256, /^[a-f0-9]{64}$/);
  assert.match(json(persisted).transition.secretSha256, /^[a-f0-9]{64}$/);
  const tokenDocument = JSON.parse(Buffer.from(handoff.resumeToken, 'base64url').toString('utf8'));
  assert.match(tokenDocument.mac, /^[a-f0-9]{64}$/);
  assert.equal('nonce' in tokenDocument, false);
  assert.equal(json(persisted).next.cwd, projectDir);
  assert.equal(json(persisted).next.argv[0], process.execPath);
  assert.equal(json(persisted).next.argv[1], cli);
  assert.ok(json(persisted).next.argv.includes(projectDir));
  assert.ok(json(persisted).next.argv.includes(handoff.runId));
  assert.equal('command' in json(persisted).next, false);

  const resumed = invoke([
    'run', '--resume', handoff.runId, '--resume-token', handoff.resumeToken,
    '--frame', frame, '--project-dir', projectDir
  ], { env: { PIXEL_SNAPPER_BIN: 'definitely-missing-pixel-snapper' } });
  assert.equal(resumed.status, 2, resumed.stderr);
  const snapHandoff = json(resumed.stdout);
  assert.equal(snapHandoff.status, 'manual-handoff');
  assert.equal(snapHandoff.runId, handoff.runId);
  assert.equal(snapHandoff.state, 'awaiting-snapped-frames');
  assert.ok(snapHandoff.next.argv.includes('--resume'));
  assert.equal(snapHandoff.next.cwd, projectDir);

  const replay = invoke(['run', '--resume', handoff.runId, '--resume-token', handoff.resumeToken, '--frame', frame, '--project-dir', projectDir]);
  assert.equal(replay.status, 1);
  assert.match(json(replay.stderr).error, /already consumed/i);

  const finished = invoke([
    'run', '--resume', snapHandoff.runId, '--resume-token', snapHandoff.resumeToken,
    '--snapped-frame', frame, '--project-dir', projectDir
  ]);
  assert.equal(finished.status, 4, finished.stderr);
  const completed = json(finished.stdout);
  assert.equal(completed.validation.passed, true);
  assert.equal(completed.profilePromotion.eligible, true);
  assert.equal(completed.profilePromotion.applied, false);
  assert.equal(completed.profilePromotion.requiresUserApproval, true);
  assert.match(completed.report.reportPath, /report\.json$/);
});

test('guided run with supplied generated frames advances directly to snapping', async () => {
  const projectDir = await tempProject();
  const input = path.join(projectDir, 'anchor.png');
  const frame = path.join(projectDir, 'generated.png');
  await makeAnchor(input);
  await makeAnchor(frame);
  const result = invoke(['run', '--input', input, '--frame', frame, '--project-dir', projectDir], {
    env: { PIXEL_SNAPPER_BIN: 'definitely-missing-pixel-snapper' }
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(json(result.stdout).status, 'manual-handoff');
  assert.equal(json(result.stdout).state, 'awaiting-snapped-frames');
});

test('resume rejects an edited canonical handoff and a changed referenced artifact', async () => {
  for (const mutation of ['handoff', 'reference']) {
    const projectDir = await tempProject();
    const input = path.join(projectDir, 'anchor.png');
    const frame = path.join(projectDir, 'frame.png');
    await makeAnchor(input);
    await makeAnchor(frame);
    const initial = json(invoke(['run', '--input', input, '--project-dir', projectDir]).stdout);
    if (mutation === 'handoff') {
      const document = JSON.parse(await fs.readFile(initial.handoffPath, 'utf8'));
      document.state = 'awaiting-snapped-frames';
      await fs.writeFile(initial.handoffPath, `${JSON.stringify(document, null, 2)}\n`);
    } else {
      const document = JSON.parse(await fs.readFile(initial.handoffPath, 'utf8'));
      await fs.appendFile(path.join(path.dirname(initial.handoffPath), document.references.matrix.path), 'tamper');
    }
    const result = invoke(['run', '--resume', initial.runId, '--resume-token', initial.resumeToken, '--frame', frame, '--project-dir', projectDir]);
    assert.equal(result.status, 1);
    assert.match(json(result.stderr).error, /handoff.*hash|artifact.*hash/i);
  }
});

test('resume rejects symlinked run artifacts and never trusts an edited handoff path argument', async (t) => {
  const projectDir = await tempProject();
  const input = path.join(projectDir, 'anchor.png');
  const frame = path.join(projectDir, 'frame.png');
  await makeAnchor(input);
  await makeAnchor(frame);
  const initial = json(invoke(['run', '--input', input, '--project-dir', projectDir]).stdout);
  const document = JSON.parse(await fs.readFile(initial.handoffPath, 'utf8'));
  const matrix = path.join(path.dirname(initial.handoffPath), document.references.matrix.path);
  const backup = `${matrix}.backup`;
  await fs.rename(matrix, backup);
  try {
    await fs.symlink(backup, matrix);
  } catch (error) {
    if (error.code === 'EPERM') { t.skip('symlinks unavailable'); return; }
    throw error;
  }
  const result = invoke(['run', '--resume', initial.runId, '--resume-token', initial.resumeToken, '--frame', frame, '--project-dir', projectDir]);
  assert.equal(result.status, 1);
  assert.match(json(result.stderr).error, /symlink|regular.*file/i);

  const callerDocument = invoke(['run', '--resume', initial.handoffPath, '--resume-token', initial.resumeToken, '--frame', frame, '--project-dir', projectDir]);
  assert.equal(callerDocument.status, 1);
  assert.match(json(callerDocument.stderr).error, /run ID/i);
});

test('manual snapped-frame resume requires exact count and publishes the batch atomically', async () => {
  const projectDir = await tempProject();
  const input = path.join(projectDir, 'anchor.png');
  const first = path.join(projectDir, 'first.png');
  const second = path.join(projectDir, 'second.png');
  await makeAnchor(input);
  await makeAnchor(first);
  await makeAnchor(second);
  const distinct = await readRgba(second);
  distinct.data.set([20, 30, 60, 255], (3 * distinct.width + 4) * 4);
  await writeRgba(second, distinct);
  const snap = json(invoke(['run', '--input', input, '--frame', first, '--frame', second, '--project-dir', projectDir], {
    env: { PIXEL_SNAPPER_BIN: 'definitely-missing-pixel-snapper' }
  }).stdout);
  const runDir = path.dirname(snap.handoffPath);

  const short = invoke(['run', '--resume', snap.runId, '--resume-token', snap.resumeToken, '--snapped-frame', first, '--project-dir', projectDir]);
  assert.equal(short.status, 1);
  assert.match(json(short.stderr).error, /exactly 2 snapped frames/i);
  await assert.rejects(fs.lstat(path.join(runDir, 'snapped')), { code: 'ENOENT' });

  const missing = path.join(projectDir, 'missing.png');
  const partial = invoke(['run', '--resume', snap.runId, '--resume-token', snap.resumeToken, '--snapped-frame', first, '--snapped-frame', missing, '--project-dir', projectDir]);
  assert.equal(partial.status, 1);
  await assert.rejects(fs.lstat(path.join(runDir, 'snapped')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(runDir)).filter((name) => name.includes('snapped-stage')), []);

  const retry = invoke(['run', '--resume', snap.runId, '--resume-token', snap.resumeToken, '--snapped-frame', first, '--snapped-frame', second, '--project-dir', projectDir]);
  assert.equal(retry.status, 4, retry.stderr);
  assert.equal(json(retry.stdout).validation.passed, true);
  assert.deepEqual((await fs.readdir(path.join(runDir, 'snapped'))).sort(), ['frame-00-snapped.png', 'frame-01-snapped.png']);
});

test('generated batch survives a transient Pixel Snapper failure and identical retry consumes the transition once', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const projectDir = await tempProject();
  const input = path.join(projectDir, 'anchor.png');
  const frame = path.join(projectDir, 'generated.png');
  const fake = path.join(projectDir, 'fake snapper.js');
  const state = path.join(projectDir, 'fake snapper state');
  await makeAnchor(input);
  await makeAnchor(frame);
  await fs.writeFile(fake, `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[0]==='--help')process.exit(0);const s=process.env.FAKE_SNAPPER_STATE;if(!fs.existsSync(s)){fs.writeFileSync(s,'failed');process.stderr.write('transient snap failure');process.exit(7)}fs.copyFileSync(a[0],a[1]);\n`);
  await fs.chmod(fake, 0o755);
  const initial = json(invoke(['run', '--input', input, '--project-dir', projectDir]).stdout);
  const args = ['run', '--resume', initial.runId, '--resume-token', initial.resumeToken, '--frame', frame, '--project-dir', projectDir];
  const first = invoke(args, { env: { FAKE_SNAPPER_STATE: state, PIXEL_SNAPPER_BIN: fake } });
  assert.equal(first.status, 1);
  assert.match(json(first.stderr).error, /transient snap failure/);
  const generatedFile = path.join(path.dirname(initial.handoffPath), 'generated', 'frame-00.png');
  assert.deepEqual(await fs.readdir(path.dirname(generatedFile)), ['frame-00.png']);
  await fs.appendFile(generatedFile, 'tampered');
  const changed = invoke(args, { env: { FAKE_SNAPPER_STATE: state, PIXEL_SNAPPER_BIN: fake } });
  assert.equal(changed.status, 1);
  assert.match(json(changed.stderr).error, /hash does not match.*authenticated batch/i);
  await fs.copyFile(frame, generatedFile);

  const retry = invoke(args, { env: { FAKE_SNAPPER_STATE: state, PIXEL_SNAPPER_BIN: fake } });
  assert.equal(retry.status, 4, retry.stderr);
  assert.equal(json(retry.stdout).validation.passed, true);
  const replay = invoke(args, { env: { FAKE_SNAPPER_STATE: state, PIXEL_SNAPPER_BIN: fake } });
  assert.equal(replay.status, 1);
  assert.match(json(replay.stderr).error, /already consumed/i);
});

test('manual snapped batch is authenticated and reusable after downstream normalization failure', async () => {
  const projectDir = await tempProject();
  const input = path.join(projectDir, 'anchor.png');
  const frame = path.join(projectDir, 'frame.png');
  await makeAnchor(input);
  await makeAnchor(frame);
  const snap = json(invoke(['run', '--input', input, '--frame', frame, '--project-dir', projectDir], {
    env: { PIXEL_SNAPPER_BIN: 'definitely-missing-pixel-snapper' }
  }).stdout);
  const runDir = path.dirname(snap.handoffPath);
  const normalizedBlocker = path.join(runDir, 'normalized');
  await fs.writeFile(normalizedBlocker, 'temporary blocker');
  const args = ['run', '--resume', snap.runId, '--resume-token', snap.resumeToken, '--snapped-frame', frame, '--project-dir', projectDir];
  const first = invoke(args);
  assert.equal(first.status, 1);
  assert.deepEqual(await fs.readdir(path.join(runDir, 'snapped')), ['frame-00-snapped.png']);
  await fs.rm(normalizedBlocker);

  const rogue = path.join(runDir, 'snapped', 'rogue.png');
  await fs.copyFile(frame, rogue);
  const mismatch = invoke(args);
  assert.equal(mismatch.status, 1);
  assert.match(json(mismatch.stderr).error, /unexpected filename set|authenticated batch/i);
  await fs.rm(rogue);

  const snappedFile = path.join(runDir, 'snapped', 'frame-00-snapped.png');
  await fs.appendFile(snappedFile, 'tampered');
  const changed = invoke(args);
  assert.equal(changed.status, 1);
  assert.match(json(changed.stderr).error, /hash does not match.*authenticated batch/i);
  await fs.copyFile(frame, snappedFile);

  const retry = invoke(args);
  assert.equal(retry.status, 4, retry.stderr);
  assert.equal(json(retry.stdout).validation.passed, true);
  const replay = invoke(args);
  assert.equal(replay.status, 1);
  assert.match(json(replay.stderr).error, /already consumed/i);
});

test('identical retry reuses normalized and exported artifacts after a transient report failure', async () => {
  const projectDir = await tempProject();
  const input = path.join(projectDir, 'anchor.png');
  const frame = path.join(projectDir, 'frame.png');
  await makeAnchor(input);
  await makeAnchor(frame);
  const snap = json(invoke(['run', '--input', input, '--frame', frame, '--project-dir', projectDir], {
    env: { PIXEL_SNAPPER_BIN: 'definitely-missing-pixel-snapper' }
  }).stdout);
  const runDir = path.dirname(snap.handoffPath);
  const reportBlocker = path.join(runDir, 'report.json');
  await fs.mkdir(reportBlocker);
  const args = ['run', '--resume', snap.runId, '--resume-token', snap.resumeToken, '--snapped-frame', frame, '--project-dir', projectDir];
  const first = invoke(args);
  assert.equal(first.status, 1);
  assert.ok((await fs.lstat(path.join(runDir, 'normalized'))).isDirectory());
  assert.ok((await fs.lstat(path.join(runDir, 'runtime'))).isDirectory());
  await fs.rm(reportBlocker, { recursive: true });

  const retry = invoke(args);
  assert.equal(retry.status, 4, retry.stderr);
  assert.equal(json(retry.stdout).validation.passed, true);
  const replay = invoke(args);
  assert.equal(replay.status, 1);
  assert.match(json(replay.stderr).error, /already consumed/i);
});

test('failed validation records evidence without consuming the retry transition', async () => {
  const projectDir = await tempProject();
  const input = path.join(projectDir, 'anchor.png');
  const frame = path.join(projectDir, 'palette-drift.png');
  await makeAnchor(input);
  await makeAnchor(frame);
  const changed = await readRgba(frame);
  changed.data.set([255, 0, 0, 255], (5 * changed.width + 5) * 4);
  await writeRgba(frame, changed);
  const snap = json(invoke(['run', '--input', input, '--frame', frame, '--project-dir', projectDir], {
    env: { PIXEL_SNAPPER_BIN: 'definitely-missing-pixel-snapper' }
  }).stdout);
  const args = ['run', '--resume', snap.runId, '--resume-token', snap.resumeToken, '--snapped-frame', frame, '--project-dir', projectDir];
  const first = invoke(args);
  assert.equal(first.status, 4, first.stderr);
  assert.equal(json(first.stdout).validation.passed, false);
  const retry = invoke(args);
  assert.equal(retry.status, 4, retry.stderr);
  assert.equal(json(retry.stdout).validation.passed, false);
  assert.equal(json(retry.stdout).report.recoveredExistingReport, true);
});

test('stage commands accept repeated frames without treating commas as separators', async () => {
  const projectDir = await tempProject();
  const first = path.join(projectDir, 'first, frame.png');
  const second = path.join(projectDir, 'second frame.png');
  await makeAnchor(first);
  await makeAnchor(second);
  const output = path.join(projectDir, 'normalized frames');
  const result = invoke(['normalize', '--frame', first, '--frame', second, '--output', output, '--scale', '1']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result.stdout).frames.length, 2);
});
