import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { promoteVerifiedProfile } from '../scripts/lib/learning.mjs';
import { readRgba, sha256, writeRgba } from '../scripts/lib/image.mjs';
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

async function completeGuidedRun(projectDir, anchor, frame) {
  const startedProcess = invoke(['run', '--input', anchor, '--project-dir', projectDir]);
  assert.equal(startedProcess.status, 2, startedProcess.stderr);
  const started = outputOf(startedProcess);

  const generatedProcess = invoke([
    'run', '--resume', started.runId, '--resume-token', started.resumeToken,
    '--frame', frame, '--project-dir', projectDir
  ], { env: { PIXEL_SNAPPER_BIN: 'unavailable-e2e-pixel-snapper' } });
  assert.equal(generatedProcess.status, 2, generatedProcess.stderr);
  const snapperHandoff = outputOf(generatedProcess);

  const finishedProcess = invoke([
    'run', '--resume', snapperHandoff.runId, '--resume-token', snapperHandoff.resumeToken,
    '--snapped-frame', frame, '--project-dir', projectDir
  ]);
  assert.ok([3, 4].includes(finishedProcess.status), finishedProcess.stderr);
  return { started, snapperHandoff, finished: outputOf(finishedProcess) };
}

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
  for (const durable of [manifest, report, metadata]) assert.equal(durable.includes(anchor), false);
  for (const file of [
    'prepared/anchor-canonical-transparent.png', 'prepared/anchor-generation.png',
    'prepared/anchor-runtime.png', 'prepared/pixel-matrix.png',
    'normalized/frame-00.png', 'runtime/animation-00.png', 'runtime/animation-sheet.png',
    'runtime/animation.json', 'runtime/animation.webp', 'report.json'
  ]) await fs.access(path.join(runDir, ...file.split('/')));

  const promoted = await promoteVerifiedProfile({ projectDir, runId: happy.started.runId });
  const profileBeforeFailure = await fs.readFile(promoted.profilePath, 'utf8');
  assert.deepEqual(YAML.parse(profileBeforeFailure).canonical, { width: 128, height: 128 });

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
    /passing validation evidence/i
  );
  assert.equal(await fs.readFile(promoted.profilePath, 'utf8'), profileBeforeFailure);
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
