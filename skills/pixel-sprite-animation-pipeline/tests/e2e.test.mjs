import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { promoteVerifiedProfile } from '../scripts/lib/learning.mjs';
import { readRgba, sha256, writeRgba } from '../scripts/lib/image.mjs';
import { stableHash } from '../scripts/lib/state-auth.mjs';
import { makeAnchor } from './helpers/fixtures.mjs';

const packageDir = path.resolve(import.meta.dirname, '..');
const cli = path.join(packageDir, 'scripts', 'cli.mjs');

function invoke(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: cwd ?? packageDir,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function outputOf(result) {
  assert.ok(result.stdout, result.stderr);
  return JSON.parse(result.stdout);
}

function invokeAsync(args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: cwd ?? packageDir, env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function makeProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pixel-sprite-e2e-'));
}

function npmPackInvocation({ nodeExecutable = process.execPath, npmCli }) {
  return {
    command: nodeExecutable,
    args: [npmCli, 'pack', '--dry-run', '--json'],
    options: {
      cwd: packageDir,
      encoding: 'utf8',
      shell: false,
      env: { ...process.env, npm_config_cache: path.join(os.tmpdir(), 'pixel-sprite-e2e-npm-cache') }
    }
  };
}

async function resolveNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    if (path.basename(candidate).toLowerCase() !== 'npm-cli.js') continue;
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error('could not locate npm-cli.js for shell-free package inspection');
}

test('package test command uses Node discovery instead of a shell-expanded glob', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node --test');
});

test('guided resume rejects a symlinked authenticated run directory', async (t) => {
  const projectDir = await makeProject();
  const anchor = path.join(projectDir, 'approved.png');
  const frame = path.join(projectDir, 'generated.png');
  await makeAnchor(anchor); await makeAnchor(frame);
  const startedProcess = invoke(['run', '--input', anchor, '--project-dir', projectDir]);
  assert.equal(startedProcess.status, 2, startedProcess.stderr);
  const started = outputOf(startedProcess);
  const runDir = path.dirname(started.handoffPath);
  const moved = `${runDir}-moved`;
  await fs.rename(runDir, moved);
  try { await fs.symlink(moved, runDir, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('directory links unavailable'); return; } throw error; }

  const resumed = invoke(['run', '--resume', started.runId, '--resume-token', started.resumeToken, '--frame', frame, '--project-dir', projectDir]);

  assert.equal(resumed.status, 1, resumed.stderr);
  assert.match(resumed.stderr, /run directory.*symlink|real directory/i);
});

async function completeGuidedRun(projectDir, anchor, frame) {
  const startedProcess = invoke(['run', '--input', anchor, '--project-dir', projectDir]);
  assert.equal(startedProcess.status, 2, startedProcess.stderr);
  const started = outputOf(startedProcess);

  const generatedProcess = invoke([
    'run', '--resume', started.runId, '--resume-token', started.resumeToken,
    '--frame', frame, '--project-dir', projectDir
  ]);
  assert.equal(generatedProcess.status, 2, generatedProcess.stderr);
  const snapperHandoff = outputOf(generatedProcess);

  const finishedProcess = invoke([
    'run', '--resume', snapperHandoff.runId, '--resume-token', snapperHandoff.resumeToken,
    '--snapped-frame', frame, '--project-dir', projectDir
  ]);
  assert.ok([3, 4].includes(finishedProcess.status), finishedProcess.stderr);
  return { started, snapperHandoff, finished: outputOf(finishedProcess) };
}

async function writeAnimationContract(projectDir, anchor) {
  const rgba = [[0, 0, 0, 0], [20, 30, 60, 255], [0, 255, 0, 255]];
  const document = {
    version: 1,
    anchor: { sha256: await sha256(anchor), traitReferenceSha256: ['b'.repeat(64)] },
    sizes: { canonical: [128, 128], generation: [1024, 1024], runtime: [256, 256], pixelSize: 8 },
    pivot: { x: 64, y: 112 }, baseline: 111,
    palette: { rgba, sha256: stableHash(rgba), snapperPaletteHex: ['141e3c', '00ff00'] },
    clips: [{
      id: 'idle', loopMode: 'loop',
      loopTransition: { fromFrameId: 'idle-01', toFrameId: 'idle-01', reviewCheckpoint: 'loop-root' },
      frames: [{ id: 'idle-01', pose: 'rest', duration: 137, landmarkSemantic: { name: 'character-root', target: { x: 64, y: 112 } } }]
    }],
    review: { checkpoints: ['identity', 'loop-root'], approvers: ['artist@example.test'] }
  };
  const file = path.join(projectDir, 'animation-contract.json');
  await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  return { file, document, sha256: stableHash(document) };
}

async function prepareContractedApproval(projectDir) {
  const anchor = path.join(projectDir, 'approved.png');
  const frame = path.join(projectDir, 'idle.png');
  await makeAnchor(anchor); await makeAnchor(frame);
  const contract = await writeAnimationContract(projectDir, anchor);
  const startedProcess = invoke(['run', '--input', anchor, '--contract', contract.file, '--project-dir', projectDir]);
  assert.equal(startedProcess.status, 2, startedProcess.stderr);
  const started = outputOf(startedProcess);
  const generatedProcess = invoke(['run', '--resume', started.runId, '--resume-token', started.resumeToken, '--frame', frame, '--project-dir', projectDir]);
  assert.equal(generatedProcess.status, 2, generatedProcess.stderr);
  const snapper = outputOf(generatedProcess);
  const snappedProcess = invoke(['run', '--resume', snapper.runId, '--resume-token', snapper.resumeToken, '--snapped-frame', frame, '--project-dir', projectDir]);
  assert.equal(snappedProcess.status, 2, snappedProcess.stderr);
  const approvalHandoff = outputOf(snappedProcess);
  const request = path.join(projectDir, 'approval-request.json');
  await fs.writeFile(request, `${JSON.stringify({
    version: 1,
    frames: approvalHandoff.frames.map(({ id, path: framePath, sha256: frameSha256 }) => ({ id, path: framePath, sha256: frameSha256 })),
    approvals: [{ frameId: 'idle-01', landmark: { x: 6, y: 12 }, approved: true, approvedBy: 'artist@example.test', checkpoints: ['identity', 'loop-root'] }]
  }, null, 2)}\n`);
  const runDir = path.dirname(approvalHandoff.handoffPath);
  const receipt = path.join(runDir, ...approvalHandoff.snapReceipt.path.split('/'));
  const approvedProcess = invoke(['approve-frames', '--contract', contract.file, '--snap-receipt', receipt, '--approval-request', request, '--version', '1', '--project-dir', projectDir]);
  assert.equal(approvedProcess.status, 0, approvedProcess.stderr);
  return { projectDir, anchor, frame, contract, started, approvalHandoff, approval: outputOf(approvedProcess), runDir };
}

async function prepareContractedCorrectionRevision() {
  const value = await prepareContractedApproval(await makeProject());
  const completed = invoke(['run', '--resume', value.approvalHandoff.runId, '--resume-token', value.approvalHandoff.resumeToken, '--frame-approval', value.approval.path, '--approval-version', '1', '--project-dir', value.projectDir]);
  assert.ok([0, 4].includes(completed.status), completed.stderr);
  const original = outputOf(completed);
  const normalized = path.join(value.runDir, 'normalized', 'frame-00.png');
  const image = await readRgba(normalized);
  await writeRgba(`${normalized}.damaged`, { ...image, width: 127, data: Buffer.from(image.data.subarray(0, 127 * 128 * 4)) });
  await fs.rename(`${normalized}.damaged`, normalized);
  const correctionRequest = path.join(value.projectDir, 'contract-correction.json');
  await fs.writeFile(correctionRequest, `${JSON.stringify({
    version: 1, runId: value.started.runId, contractSha256: original.report.correctionContract.sha256,
    receiptSha256: original.correctionReceipt.sha256, receiptSignature: original.correctionReceipt.signature,
    declaredFailure: { code: 'CANVAS_SIZE', stage: 'canonical', frame: 0 }, reportVersion: 2
  })}\n`);
  const requested = invoke(['correct', '--request', correctionRequest, '--project-dir', value.projectDir]);
  assert.equal(requested.status, 2, requested.stderr);
  const replacement = path.join(value.runDir, 'snapped', 'frame-00-snapped.png');
  const staged = invoke(['correct', '--request', correctionRequest, '--replacement-snapped-frame', replacement, '--project-dir', value.projectDir]);
  assert.equal(staged.status, 2, staged.stderr);
  return { ...value, original, correctionRequest, revision: outputOf(staged), revisionDir: path.join(value.runDir, 'revision-02') };
}

async function signRevisionApproval(value, { receipt, frames, requestName = 'revision-approval.json' } = {}) {
  const revisionRequest = path.join(value.projectDir, requestName);
  const selectedFrames = frames ?? value.revision.frames;
  await fs.writeFile(revisionRequest, `${JSON.stringify({
    version: 1,
    frames: selectedFrames.map(({ id, path: framePath, sha256: frameSha256 }) => ({ id, path: framePath, sha256: frameSha256 })),
    approvals: [{ frameId: 'idle-01', landmark: { x: 6, y: 12 }, approved: true, approvedBy: 'artist@example.test', checkpoints: ['identity', 'loop-root'] }]
  }, null, 2)}\n`);
  const selectedReceipt = receipt ?? path.join(value.runDir, ...value.revision.snapReceipt.path.split('/'));
  const signed = invoke(['approve-frames', '--contract', value.contract.file, '--snap-receipt', selectedReceipt, '--approval-request', revisionRequest, '--version', '2', '--project-dir', value.projectDir]);
  assert.equal(signed.status, 0, signed.stderr);
  return outputOf(signed);
}

test('contracted guided animation waits for an explicitly selected signed frame approval', async () => {
  const projectDir = await makeProject();
  const { contract, started, approvalHandoff, approval, runDir } = await prepareContractedApproval(projectDir);
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(started.handoffPath), 'manifest.json'), 'utf8'));
  assert.equal(manifest.animationContract.sha256, contract.sha256);
  assert.equal(approvalHandoff.state, 'awaiting-frame-approval');
  assert.equal(approvalHandoff.animationContractSha256, contract.sha256);
  assert.equal(approvalHandoff.toolProvenanceVerified, false);

  const blocked = invoke(['run', '--resume', approvalHandoff.runId, '--resume-token', approvalHandoff.resumeToken, '--project-dir', projectDir]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /signed frame approval is required/i);

  const finishedProcess = invoke(['run', '--resume', approvalHandoff.runId, '--resume-token', approvalHandoff.resumeToken, '--frame-approval', approval.path, '--approval-version', '1', '--project-dir', projectDir]);
  assert.ok([0, 4].includes(finishedProcess.status), JSON.stringify({ status: finishedProcess.status, stdout: finishedProcess.stdout, stderr: finishedProcess.stderr }));
  const finished = outputOf(finishedProcess);
  assert.equal(finished.state, 'complete');
  assert.equal(finished.report.animationContractSha256, contract.sha256);
  assert.equal(finished.report.snapReceiptSha256, approvalHandoff.snapReceiptSha256);
  assert.equal(finished.report.frameApprovalSha256, approval.sha256);
  assert.equal(finished.report.toolProvenanceVerified, false);
  assert.equal(finished.report.popTAcceptance.eligible, false);
  assert.equal(finished.report.profilePromotion.eligible, false);
  const index = JSON.parse(await fs.readFile(path.join(runDir, 'runtime', 'animation-contract-export.json'), 'utf8'));
  assert.deepEqual(index.clips[0].frames.map(({ duration }) => duration), [137]);
});

test('approval transition has one atomic winner and deterministic loser', async () => {
  const value = await prepareContractedApproval(await makeProject());
  const args = ['run', '--resume', value.approvalHandoff.runId, '--resume-token', value.approvalHandoff.resumeToken, '--frame-approval', value.approval.path, '--approval-version', '1', '--project-dir', value.projectDir];
  const results = await Promise.all([invokeAsync(args), invokeAsync(args)]);
  assert.equal(results.filter((result) => [0, 4].includes(result.status)).length, 1);
  const loser = results.find((result) => result.status === 1);
  assert.ok(loser, JSON.stringify(results));
  assert.match(loser.stderr, /already in progress|already consumed/i);
  assert.doesNotMatch(loser.stderr, /EEXIST|ENOENT|EPERM/);
});

test('approval transition waits for concurrent claim initialization', async () => {
  const value = await prepareContractedApproval(await makeProject());
  const claimPath = path.join(value.runDir, 'transition-frame-approval.claim');
  const claim = {
    version: 1,
    handoffSha256: await sha256(path.join(value.runDir, 'frame-approval-handoff.json')),
    frameApprovalSha256: value.approval.sha256,
    approvalVersion: 1
  };
  await fs.writeFile(claimPath, '', { flag: 'wx', mode: 0o600 });
  const args = ['run', '--resume', value.approvalHandoff.runId, '--resume-token', value.approvalHandoff.resumeToken, '--frame-approval', value.approval.path, '--approval-version', '1', '--project-dir', value.projectDir];
  const writer = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await fs.writeFile(claimPath, `${JSON.stringify(claim, null, 2)}\n`);
  })();
  const [loser] = await Promise.all([invokeAsync(args), writer]);

  assert.equal(loser.status, 1);
  assert.match(loser.stderr, /already in progress/i);
  await fs.unlink(claimPath);
});

test('approval transition releases its claim after an ordinary normalization failure', async () => {
  const value = await prepareContractedApproval(await makeProject());
  const request = path.join(value.projectDir, 'invalid-landmark-approval.json');
  await fs.writeFile(request, `${JSON.stringify({
    version: 1,
    frames: value.approvalHandoff.frames.map(({ id, path: framePath, sha256: frameSha256 }) => ({ id, path: framePath, sha256: frameSha256 })),
    approvals: [{ frameId: 'idle-01', landmark: { x: 99, y: 99 }, approved: true, approvedBy: 'artist@example.test', checkpoints: ['identity', 'loop-root'] }]
  })}\n`);
  const receipt = path.join(value.runDir, ...value.approvalHandoff.snapReceipt.path.split('/'));
  const invalid = invoke(['approve-frames', '--contract', value.contract.file, '--snap-receipt', receipt, '--approval-request', request, '--version', '2', '--project-dir', value.projectDir]);
  assert.equal(invalid.status, 0, invalid.stderr);
  const args = ['run', '--resume', value.approvalHandoff.runId, '--resume-token', value.approvalHandoff.resumeToken, '--frame-approval', outputOf(invalid).path, '--approval-version', '2', '--project-dir', value.projectDir];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const failed = invoke(args);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /landmark source.*inside|approved landmark/i);
    assert.doesNotMatch(failed.stderr, /already in progress|EEXIST/);
  }
  await assert.rejects(fs.access(path.join(value.runDir, 'transition-frame-approval.claim')), /ENOENT/);
});

test('contracted correction creates a reapproval revision and rejects old approval ancestry', async () => {
  const value = await prepareContractedApproval(await makeProject());
  const completed = invoke(['run', '--resume', value.approvalHandoff.runId, '--resume-token', value.approvalHandoff.resumeToken, '--frame-approval', value.approval.path, '--approval-version', '1', '--project-dir', value.projectDir]);
  assert.ok([0, 4].includes(completed.status), completed.stderr);
  const original = outputOf(completed);
  const normalized = path.join(value.runDir, 'normalized', 'frame-00.png');
  const image = await readRgba(normalized);
  await writeRgba(`${normalized}.damaged`, { ...image, width: 127, data: Buffer.from(image.data.subarray(0, 127 * 128 * 4)) });
  await fs.rename(`${normalized}.damaged`, normalized);
  const correctionRequest = path.join(value.projectDir, 'contract-correction.json');
  await fs.writeFile(correctionRequest, `${JSON.stringify({
    version: 1, runId: value.started.runId, contractSha256: original.report.correctionContract.sha256,
    receiptSha256: original.correctionReceipt.sha256, receiptSignature: original.correctionReceipt.signature,
    declaredFailure: { code: 'CANVAS_SIZE', stage: 'canonical', frame: 0 }, reportVersion: 2
  })}\n`);
  const requested = invoke(['correct', '--request', correctionRequest, '--project-dir', value.projectDir]);
  assert.equal(requested.status, 2, requested.stderr);
  assert.equal(outputOf(requested).state, 'awaiting-corrected-snapped-frames');
  const replacement = path.join(value.runDir, 'snapped', 'frame-00-snapped.png');
  const staged = invoke(['correct', '--request', correctionRequest, '--replacement-snapped-frame', replacement, '--project-dir', value.projectDir]);
  assert.equal(staged.status, 2, staged.stderr);
  const revision = outputOf(staged);
  assert.equal(revision.state, 'awaiting-frame-approval');
  assert.equal(revision.toolProvenanceVerified, false);
  assert.notEqual(revision.snapReceiptSha256, original.report.snapReceiptSha256);
  const old = invoke(['correct', '--request', correctionRequest, '--frame-approval', value.approval.path, '--approval-version', '1', '--project-dir', value.projectDir]);
  assert.equal(old.status, 1);
  assert.match(old.stderr, /new numbered frame approval revision|required.*revision/i);

  const revisionRequest = path.join(value.projectDir, 'revision-approval.json');
  await fs.writeFile(revisionRequest, `${JSON.stringify({
    version: 1,
    frames: revision.frames.map(({ id, path: framePath, sha256: frameSha256 }) => ({ id, path: framePath, sha256: frameSha256 })),
    approvals: [{ frameId: 'idle-01', landmark: { x: 6, y: 12 }, approved: true, approvedBy: 'artist@example.test', checkpoints: ['identity', 'loop-root'] }]
  })}\n`);
  const revisionReceipt = path.join(value.runDir, ...revision.snapReceipt.path.split('/'));
  const signed = invoke(['approve-frames', '--contract', value.contract.file, '--snap-receipt', revisionReceipt, '--approval-request', revisionRequest, '--version', '2', '--project-dir', value.projectDir]);
  assert.equal(signed.status, 0, signed.stderr);
  const finished = invoke(['correct', '--request', correctionRequest, '--frame-approval', outputOf(signed).path, '--approval-version', '2', '--project-dir', value.projectDir]);
  assert.ok([0, 4].includes(finished.status), finished.stderr);
  const result = outputOf(finished);
  assert.equal(result.state, 'complete');
  assert.equal(result.report.toolProvenanceVerified, false);
  assert.equal(result.report.supersedes.frameApprovalSha256, original.report.frameApprovalSha256);
  await fs.access(path.join(value.runDir, 'revision-02', 'runtime', 'animation-contract-export.json'));
});

test('contracted correction rejects a different valid same-run receipt and approval ancestry', async () => {
  const value = await prepareContractedCorrectionRevision();
  const originalReceipt = path.join(value.runDir, ...value.approvalHandoff.snapReceipt.path.split('/'));
  const alternateApproval = await signRevisionApproval(value, {
    receipt: originalReceipt,
    frames: value.approvalHandoff.frames,
    requestName: 'alternate-approval-request.json'
  });
  const selectedApproval = path.join(value.revisionDir, path.basename(alternateApproval.path));
  await fs.copyFile(alternateApproval.path, selectedApproval);
  const handoffFile = path.join(value.revisionDir, 'frame-approval-handoff.json');
  const handoff = JSON.parse(await fs.readFile(handoffFile, 'utf8'));
  handoff.snapReceiptSha256 = value.approvalHandoff.snapReceiptSha256;
  handoff.snapReceipt = structuredClone(value.approvalHandoff.snapReceipt);
  handoff.frames = structuredClone(value.approvalHandoff.frames);
  await fs.writeFile(handoffFile, `${JSON.stringify(handoff, null, 2)}\n`);

  const rejected = invoke(['correct', '--request', value.correctionRequest, '--frame-approval', selectedApproval, '--approval-version', '2', '--project-dir', value.projectDir]);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /correction revision|replacement handoff|snap receipt ancestry/i);
});

test('contracted correction rejects a linked replacement handoff', async () => {
  const value = await prepareContractedCorrectionRevision();
  const signed = await signRevisionApproval(value);
  const replacementHandoff = path.join(value.revisionDir, 'replacement-handoff.json');
  await fs.link(replacementHandoff, `${replacementHandoff}.alias`);

  const rejected = invoke(['correct', '--request', value.correctionRequest, '--frame-approval', signed.path, '--approval-version', '2', '--project-dir', value.projectDir]);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /replacement handoff.*regular|non-linked|single-link/i);
});

test('contracted correction rejects a redirected revision receipt', async () => {
  const value = await prepareContractedCorrectionRevision();
  const signed = await signRevisionApproval(value);
  const receipt = path.join(value.revisionDir, 'manual-handoff-receipt.json');
  const redirected = path.join(value.revisionDir, 'redirected-manual-handoff-receipt.json');
  await fs.rename(receipt, redirected);
  await fs.symlink(path.basename(redirected), receipt);

  const rejected = invoke(['correct', '--request', value.correctionRequest, '--frame-approval', signed.path, '--approval-version', '2', '--project-dir', value.projectDir]);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /snap receipt.*symlink|must not contain a symlink/i);
});

test('contracted correction rejects nonexistent approval ancestry before repair eligibility', async () => {
  const value = await prepareContractedApproval(await makeProject());
  const completed = invoke(['run', '--resume', value.approvalHandoff.runId, '--resume-token', value.approvalHandoff.resumeToken, '--frame-approval', value.approval.path, '--approval-version', '1', '--project-dir', value.projectDir]);
  assert.ok([0, 4].includes(completed.status), completed.stderr);
  const original = outputOf(completed);
  const contractDocument = JSON.parse(await fs.readFile(path.join(value.runDir, original.report.correctionContract.path), 'utf8'));
  assert.deepEqual(contractDocument.provenance.frameApproval, original.report.frameApproval);
  await fs.rename(value.approval.path, `${value.approval.path}.missing`);
  const request = path.join(value.projectDir, 'missing-ancestry-correction.json');
  await fs.writeFile(request, `${JSON.stringify({
    version: 1, runId: value.started.runId, contractSha256: original.report.correctionContract.sha256,
    receiptSha256: original.correctionReceipt.sha256, receiptSignature: original.correctionReceipt.signature,
    declaredFailure: { code: 'CANVAS_SIZE', stage: 'canonical', frame: 0 }, reportVersion: 2
  })}\n`);
  const rejected = invoke(['correct', '--request', request, '--project-dir', value.projectDir]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /frame approval.*selector does not exist|approval ancestry/i);
});

test('guided workflow records validated portable artifacts and explicitly promotes only a verified profile', async () => {
  const projectDir = await makeProject();
  const anchor = path.join(projectDir, 'approved anchor.png');
  const frame = path.join(projectDir, 'generated idle.png');
  await makeAnchor(anchor);
  await makeAnchor(frame);
  const inputHash = await sha256(anchor);

  const happy = await completeGuidedRun(projectDir, anchor, frame);
  assert.equal(happy.started.status, 'generation-handoff');
  assert.equal(happy.snapperHandoff.status, 'manual-handoff');
  assert.equal(happy.finished.validation.passed, true);
  assert.equal(happy.finished.profilePromotion.applied, false);
  assert.deepEqual(
    { width: happy.started.anchorReport.width, height: happy.started.anchorReport.height },
    { width: 13, height: 14 }
  );
  assert.match(
    JSON.parse(Buffer.from(happy.started.resumeToken, 'base64url').toString('utf8')).mac,
    /^[a-f0-9]{64}$/
  );
  assert.match(
    JSON.parse(Buffer.from(happy.snapperHandoff.resumeToken, 'base64url').toString('utf8')).mac,
    /^[a-f0-9]{64}$/
  );

  const runDir = path.dirname(happy.started.handoffPath);
  const manifestPath = path.join(runDir, 'manifest.json');
  const reportPath = path.join(runDir, 'report.json');
  const metadataPath = path.join(runDir, 'runtime', 'animation.json');
  const [manifest, report, metadata] = await Promise.all([
    fs.readFile(manifestPath, 'utf8'),
    fs.readFile(reportPath, 'utf8'),
    fs.readFile(metadataPath, 'utf8')
  ]);
  assert.equal(JSON.parse(manifest).inputs[0].sha256, inputHash);
  assert.equal(await sha256(manifestPath), happy.started.manifestSha256);
  assert.equal(await sha256(path.join(runDir, 'source', 'approved-anchor.png')), inputHash);
  assert.equal(await sha256(anchor), inputHash);
  const manualReceipt = JSON.parse(await fs.readFile(path.join(runDir, 'manual-handoff-receipt.json'), 'utf8'));
  assert.equal(manualReceipt.payload.origin, 'manual-handoff');
  assert.equal(manualReceipt.payload.toolProvenanceVerified, false);
  for (const durable of [manifest, report, metadata]) assert.equal(durable.includes(anchor), false);
  for (const file of [
    'prepared/anchor-canonical-transparent.png', 'prepared/anchor-generation.png',
    'prepared/anchor-runtime.png', 'prepared/pixel-matrix.png',
    'normalized/frame-00.png', 'runtime/animation-00.png', 'runtime/animation-sheet.png',
    'runtime/animation.json', 'runtime/animation.webp', 'report.json'
  ]) await fs.access(path.join(runDir, ...file.split('/')));

  assert.equal(happy.finished.profilePromotion.eligible, false);
  await assert.rejects(promoteVerifiedProfile({ projectDir, runId: happy.started.runId }), /verified tool provenance/i);

  const failingAnchor = path.join(projectDir, 'failure anchor.png');
  const failingFrame = path.join(projectDir, 'palette drift.png');
  await makeAnchor(failingAnchor);
  await makeAnchor(failingFrame);
  const drift = await readRgba(failingFrame);
  drift.data.set([255, 0, 0, 255], (5 * drift.width + 5) * 4);
  await writeRgba(failingFrame, drift);
  const failed = await completeGuidedRun(projectDir, failingAnchor, failingFrame);
  assert.equal(failed.finished.validation.passed, false);
  await assert.rejects(
    promoteVerifiedProfile({ projectDir, runId: failed.started.runId }),
    /verified tool provenance|passing validation evidence/i
  );
});

test('installable package excludes tests and generated or private working data', async () => {
  const invocation = npmPackInvocation({ npmCli: await resolveNpmCli() });
  const packed = spawnSync(invocation.command, invocation.args, invocation.options);
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map(({ path: file }) => file.replaceAll('\\', '/'));
  assert.ok(files.includes('SKILL.md'));
  assert.ok(files.includes('scripts/cli.mjs'));
  assert.ok(files.includes('agents/openai.yaml'));
  assert.ok(files.includes('npm-shrinkwrap.json'));
  assert.ok(files.some((file) => file.startsWith('references/')));
  assert.equal(files.some((file) => file.startsWith('tests/')), false);
  assert.equal(files.some((file) => /(^|\/)(private|generated|node_modules)(\/|$)/.test(file)), false);
});

test('explicit correction derives all paths from the immutable run contract', async () => {
  const projectDir = await makeProject();
  const anchor = path.join(projectDir, 'contract anchor.png');
  const frame = path.join(projectDir, 'contract frame.png');
  await makeAnchor(anchor);
  await makeAnchor(frame);
  const happy = await completeGuidedRun(projectDir, anchor, frame);
  const runDir = path.dirname(happy.started.handoffPath);
  const report = JSON.parse(await fs.readFile(path.join(runDir, 'report.json'), 'utf8'));
  const normalized = path.join(runDir, 'normalized', 'frame-00.png');
  const damaged = await readRgba(normalized);
  await writeRgba(`${normalized}.damaged`, { ...damaged, data: Buffer.from(damaged.data.subarray(0, 127 * 128 * 4)), width: 127 });
  await fs.rename(`${normalized}.damaged`, normalized);
  const request = path.join(projectDir, 'correction-request.json');
  await fs.writeFile(request, `${JSON.stringify({ version: 1, runId: happy.started.runId, contractSha256: report.correctionContract.sha256, receiptSha256: happy.finished.correctionReceipt.sha256, receiptSignature: happy.finished.correctionReceipt.signature, declaredFailure: { code: 'CANVAS_SIZE', stage: 'canonical', frame: 0 }, reportVersion: 2 })}\n`);
  const corrected = invoke(['correct', '--request', request, '--project-dir', projectDir]);
  assert.equal(corrected.status, 4, corrected.stderr);
  const result = outputOf(corrected);
  assert.equal(result.afterValidation.passed, true);
  assert.ok(result.correction.actions.some(({ code, approved }) => code === 'CANVAS_SIZE' && approved));
  await fs.access(path.join(runDir, 'report-02.json'));
});

test('metadata correction ignores tampered geometry palette source and provenance fields', async () => {
  const projectDir = await makeProject();
  const anchor = path.join(projectDir, 'metadata anchor.png');
  const frame = path.join(projectDir, 'metadata frame.png');
  await makeAnchor(anchor); await makeAnchor(frame);
  const happy = await completeGuidedRun(projectDir, anchor, frame);
  const runDir = path.dirname(happy.started.handoffPath);
  const report = JSON.parse(await fs.readFile(path.join(runDir, 'report.json'), 'utf8'));
  const contract = JSON.parse(await fs.readFile(path.join(runDir, report.correctionContract.path), 'utf8'));
  const metadataPath = path.join(runDir, contract.delivery.metadata.path);
  const damaged = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  damaged.frameSize = { width: 9, height: 9 };
  damaged.columns = 9;
  damaged.palette.colors = [];
  damaged.sources[0].sha256 = '0'.repeat(64);
  damaged.config.pivot = { x: 1, y: 1 };
  await fs.writeFile(metadataPath, `${JSON.stringify(damaged)}\n`);
  const request = path.join(projectDir, 'metadata-correction.json');
  await fs.writeFile(request, `${JSON.stringify({ version: 1, runId: happy.started.runId, contractSha256: report.correctionContract.sha256, receiptSha256: happy.finished.correctionReceipt.sha256, receiptSignature: happy.finished.correctionReceipt.signature, declaredFailure: { code: 'METADATA_MISMATCH' }, reportVersion: 2 })}\n`);
  const corrected = invoke(['correct', '--request', request, '--project-dir', projectDir]);
  assert.equal(corrected.status, 4, corrected.stderr);
  const result = outputOf(corrected);
  assert.equal(result.afterValidation.passed, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runDir, result.exported.metadata), 'utf8')), contract.expected.metadata);
});

test('package inspection invokes the npm JavaScript CLI without a Windows command shim or shell', () => {
  const invocation = npmPackInvocation({
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    npmCli: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  });
  assert.equal(invocation.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(invocation.args, [
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    'pack', '--dry-run', '--json'
  ]);
  assert.equal(invocation.options.shell, false);
});
