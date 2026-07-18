#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { loadConfig } from './lib/config.mjs';
import { exportAnimation } from './lib/export.mjs';
import { inspectImage } from './lib/inspect.mjs';
import { createRun, promoteVerifiedProfile, proposeSkillRule, recordRunResult } from './lib/learning.mjs';
import { normalizeFrames } from './lib/normalize.mjs';
import { prepareAnchor } from './lib/prepare.mjs';
import { runPixelSnapper } from './lib/snapper.mjs';
import { readRgba, sha256 } from './lib/image.mjs';
import { validateRun } from './lib/validate.mjs';
import { repairValidationRun } from './lib/repair.mjs';
import { createCorrectionContract, loadCorrectionContext, sealCorrectionContract } from './lib/contract.mjs';

const EXIT = Object.freeze({ success: 0, error: 1, handoff: 2, objectiveFailure: 3, review: 4 });
const REVIEW_CORRECTIONS = new Set(['palette-remap-review', 'stop-for-regeneration', 'stop-for-review', 'timing-or-transition-review']);
const LEARNABLE_FAILURES = new Set(['CANVAS_SIZE', 'BACKGROUND_REMAINS']);
const CLI_PATH = fileURLToPath(import.meta.url);
const HANDOFF_SCHEMA = 'pixel-sprite-run-handoff/v1';
const HANDOFF_FILES = Object.freeze({
  'awaiting-generated-frames': 'generation-handoff.json',
  'awaiting-snapped-frames': 'snapper-handoff.json'
});

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('value must be a positive integer');
  return parsed;
}

function duration(value, previous) {
  return [...(Array.isArray(previous) ? previous : []), positiveInteger(value)];
}

function tolerance(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) throw new InvalidArgumentError('tolerance must be an integer from 0 to 255');
  return parsed;
}

function frame(value, previous) {
  return [...(Array.isArray(previous) ? previous : []), value];
}

function combinedFrames(options, primary = 'frame') {
  const values = [...(options[primary] ?? []), ...(options.frames ?? [])];
  if (values.length === 0) throw new Error('at least one frame path is required');
  return values.map((file) => path.resolve(file));
}

function resolveCwd(options) {
  return path.resolve(options.cwd ?? options.projectDir ?? process.cwd());
}

async function configFor(options) {
  const cwd = resolveCwd(options);
  return loadConfig({ cwd, profilePath: options.profile ? path.resolve(options.profile) : undefined });
}

async function refuseExisting(target, label = 'output') {
  try {
    await fs.lstat(target);
    throw new Error(`${label} already exists; choose a new versioned path`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function setValidationExit(result) {
  if (result.passed) {
    if (result.warnings?.some((warning) => warning.code === 'HUMAN_REVIEW_REQUIRED' || warning.requiresUserReview === true)) process.exitCode = EXIT.review;
    return;
  }
  const objective = result.failures.some((failure) => failure.requiresUserReview !== true && !REVIEW_CORRECTIONS.has(failure.correction));
  process.exitCode = objective ? EXIT.objectiveFailure : EXIT.review;
}

function validateRequest(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('validation request must be an object');
  const allowed = new Set(['version', 'anchorReport', 'normalized', 'exported', 'semanticEvidence']);
  for (const key of Object.keys(document)) if (!allowed.has(key)) throw new Error(`unknown validation request field: ${key}`);
  if (document.version !== 1) throw new Error('validation request version must be 1');
  for (const key of ['anchorReport', 'normalized', 'exported']) {
    if (!document[key] || typeof document[key] !== 'object' || Array.isArray(document[key])) throw new Error(`validation request ${key} must be an object`);
  }
  if (document.semanticEvidence !== undefined && !Array.isArray(document.semanticEvidence)) throw new Error('validation request semanticEvidence must be an array');
  return document;
}

function validateRepairRequest(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('correction request must be an object');
  const allowed = new Set(['version', 'runId', 'contractSha256', 'receiptSha256', 'receiptSignature', 'declaredFailure', 'reportVersion']);
  for (const key of Object.keys(document)) if (!allowed.has(key)) throw new Error(`unknown correction request field: ${key}`);
  if (document.version !== 1) throw new Error('correction request version must be 1');
  safeRunId(document.runId);
  if (!/^[a-f0-9]{64}$/.test(document.contractSha256 ?? '')) throw new Error('correction request contractSha256 is required');
  if (!/^[a-f0-9]{64}$/.test(document.receiptSha256 ?? '') || !/^[a-f0-9]{64}$/.test(document.receiptSignature ?? '')) throw new Error('correction request signed receipt is required');
  if (!document.declaredFailure || typeof document.declaredFailure !== 'object' || Array.isArray(document.declaredFailure) || typeof document.declaredFailure.code !== 'string') throw new Error('correction request declaredFailure is required');
  for (const key of Object.keys(document.declaredFailure)) if (!['code', 'stage', 'frame', 'target'].includes(key)) throw new Error(`unknown declared failure field: ${key}`);
  if (document.reportVersion !== undefined && (!Number.isInteger(document.reportVersion) || document.reportVersion < 2)) throw new Error('correction reportVersion must be an integer of at least 2');
  return document;
}

function sameFailure(left, right) {
  return left?.code === right?.code && ['stage', 'frame', 'target'].every((key) => right[key] === undefined || left[key] === right[key]);
}

function portablePath(runDir, file) {
  const relative = path.relative(runDir, file).replaceAll('\\', '/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('run artifact escaped the versioned run directory');
  return relative;
}

function portableValue(value, runDir) {
  if (typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value))) {
    const relative = path.relative(runDir, value).replaceAll('\\', '/');
    return relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) ? '<external-path-redacted>' : relative;
  }
  if (Array.isArray(value)) return value.map((item) => portableValue(item, runDir));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portableValue(item, runDir)]));
  return value;
}

async function writeJsonNew(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await fs.link(temporary, file);
    await fs.unlink(temporary);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function writeJsonIdempotent(file, value, label) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error(`${label} existing state is not a regular authenticated file`);
    if (await fs.readFile(file, 'utf8') !== contents) throw new Error(`${label} existing state does not match the authenticated retry`);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeJsonNew(file, value);
}

async function copyNew(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  return { path: target, sha256: await sha256(target) };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function stableHash(value) {
  return tokenHash(JSON.stringify(stableValue(value)));
}

function safeRunId(value) {
  const stem = typeof value === 'string' ? value.split('.')[0] : '';
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(stem)) {
    throw new Error('resume run ID must be Windows-safe');
  }
  return value;
}

function transitionMac(secret, { runId, state, handoffSha256 }) {
  return crypto.createHmac('sha256', secret).update(`${runId}\n${state}\n${handoffSha256}`).digest('hex');
}

function transitionToken({ runId, state, handoffSha256, secret }) {
  const mac = transitionMac(secret, { runId, state, handoffSha256 });
  return Buffer.from(JSON.stringify({ version: 1, runId, state, handoffSha256, mac })).toString('base64url');
}

function parseTransitionToken(value) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value ?? '', 'base64url').toString('utf8')); }
  catch { throw new Error('invalid resume token'); }
  const keys = Object.keys(parsed ?? {}).sort().join(',');
  if (keys !== 'handoffSha256,mac,runId,state,version' || parsed.version !== 1 || !HANDOFF_FILES[parsed.state] || !/^[a-f0-9]{64}$/.test(parsed.handoffSha256 ?? '') || !/^[a-f0-9]{64}$/.test(parsed.mac ?? '')) {
    throw new Error('invalid resume token');
  }
  safeRunId(parsed.runId);
  return parsed;
}

async function safeRunArtifact(runDir, relative, expectedHash, label) {
  if (typeof relative !== 'string' || relative === '' || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw new Error(`${label} path must be relative`);
  const normalized = path.posix.normalize(relative.replaceAll('\\', '/'));
  if (normalized !== relative.replaceAll('\\', '/') || normalized === '..' || normalized.startsWith('../')) throw new Error(`${label} escaped the run directory`);
  const root = await fs.realpath(runDir);
  let current = root;
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not contain a symlink`);
  }
  const stat = await fs.lstat(current);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error(`${label} must be a regular non-linked file`);
  const physical = await fs.realpath(current);
  const containment = path.relative(root, physical);
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error(`${label} escaped the run directory`);
  const actualHash = await sha256(current);
  if (expectedHash && actualHash !== expectedHash) throw new Error(`${label} artifact hash does not match canonical handoff state`);
  return { path: current, relative: normalized, sha256: actualHash };
}

function secureHexMatches(actual, expected) {
  const left = Buffer.from(actual ?? '', 'hex');
  const right = Buffer.from(expected ?? '', 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function writeCanonicalHandoff(file, handoff, secret) {
  await writeJsonIdempotent(file, handoff, 'canonical handoff');
  const handoffSha256 = await sha256(file);
  return transitionToken({ runId: handoff.runId, state: handoff.state, handoffSha256, secret });
}

function nextInvocation(projectDir, runId, flag) {
  return {
    cwd: projectDir,
    argv: [process.execPath, CLI_PATH, 'run', '--resume', runId, '--resume-token', '<TOKEN>', flag, flag === '--frame' ? '<GENERATED_FRAME>' : '<SNAPPED_FRAME>', '--project-dir', projectDir]
  };
}

async function inspectExplicitInput(file, label) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const image = await readRgba(file);
  return { file, sha256: await sha256(file), width: image.width, height: image.height };
}

async function stageBatch({ inputs, targetDir, label, outputNames = inputs.map((_, index) => `frame-${String(index).padStart(2, '0')}.png`) }) {
  if (outputNames.length !== inputs.length || new Set(outputNames).size !== outputNames.length || outputNames.some((name) => path.basename(name) !== name || name === '.' || name === '..')) {
    throw new Error(`${label} output contract is invalid`);
  }
  const inspected = [];
  for (let index = 0; index < inputs.length; index += 1) inspected.push(await inspectExplicitInput(inputs[index], `${label} ${index}`));
  try {
    const targetStat = await fs.lstat(targetDir);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error(`${label} existing destination is not an authenticated batch directory`);
    const actualNames = (await fs.readdir(targetDir)).sort();
    const expectedNames = [...outputNames].sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error(`${label} existing destination has an unexpected filename set`);
    const root = await fs.realpath(targetDir);
    const outputs = [];
    for (let index = 0; index < outputNames.length; index += 1) {
      const output = path.join(targetDir, outputNames[index]);
      const stat = await fs.lstat(output);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error(`${label} existing file is not a regular authenticated batch member`);
      const physical = await fs.realpath(output);
      const containment = path.relative(root, physical);
      if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error(`${label} existing file escaped the authenticated batch`);
      if (await sha256(output) !== inspected[index].sha256) throw new Error(`${label} existing file hash does not match the supplied authenticated batch`);
      outputs.push(output);
    }
    return outputs;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stage = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}-stage-${crypto.randomUUID()}`);
  await fs.mkdir(stage, { recursive: true });
  try {
    const outputs = [];
    for (let index = 0; index < inspected.length; index += 1) {
      const output = path.join(stage, outputNames[index]);
      await fs.copyFile(inspected[index].file, output, fs.constants.COPYFILE_EXCL);
      if (await sha256(output) !== inspected[index].sha256) throw new Error(`${label} ${index} changed during staging`);
      outputs.push(output);
    }
    await fs.rename(stage, targetDir);
    return outputs.map((file) => path.join(targetDir, path.basename(file)));
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function flatDirectoryManifest(directory, label) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  const root = await fs.realpath(directory);
  const names = (await fs.readdir(directory)).sort();
  const files = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const child = await fs.lstat(file);
    if (!child.isFile() || child.isSymbolicLink() || child.nlink > 1) throw new Error(`${label} contains a non-regular artifact`);
    const physical = await fs.realpath(file);
    const containment = path.relative(root, physical);
    if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error(`${label} artifact escaped its directory`);
    files.push({ name, sha256: await sha256(file) });
  }
  return files;
}

async function publishDirectory(stage, target, label) {
  try {
    await fs.lstat(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.rename(stage, target);
    return;
  }
  const [staged, existing] = await Promise.all([flatDirectoryManifest(stage, `${label} staging`), flatDirectoryManifest(target, `${label} existing`)]);
  if (JSON.stringify(staged) !== JSON.stringify(existing)) throw new Error(`${label} existing artifacts do not match the authenticated retry`);
  await fs.rm(stage, { recursive: true });
}

function rebasePaths(value, from, to) {
  if (typeof value === 'string' && path.isAbsolute(value)) {
    const relative = path.relative(from, value);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? path.join(to, relative) : value;
  }
  if (Array.isArray(value)) return value.map((item) => rebasePaths(item, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebasePaths(item, from, to)]));
  return value;
}

async function recordRunResultIdempotent({ context, report }) {
  const reportPath = path.join(context.runDir, 'report.json');
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  try {
    const stat = await fs.lstat(reportPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('existing run report is not a regular authenticated file');
    if (await fs.readFile(reportPath, 'utf8') !== contents) throw new Error('existing run report does not match the authenticated retry');
    return { reportPath, reportSha256: tokenHash(contents), lessonsRecorded: 0, recoveredExistingReport: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return recordRunResult({ projectDir: context.projectDir, runId: context.handoff.runId, report });
}

async function enhanceStandaloneSnapperHandoff({ result, inputs, outputDir, cwd }) {
  const document = JSON.parse(await fs.readFile(result.handoffPath, 'utf8'));
  const outputs = document.expectedOutputs.map((name) => path.join(outputDir, name));
  const snapperInvocations = inputs.map((input, index) => ({
    cwd,
    argv: [document.executable, input, outputs[index], '16', ...document.commandTemplate.slice(4)]
  }));
  const argv = [process.execPath, CLI_PATH, 'normalize'];
  for (const output of outputs) argv.push('--frame', output);
  argv.push('--output', '<NORMALIZED_OUTPUT_DIR>', '--cwd', cwd);
  const enhanced = {
    version: document.version,
    status: 'manual-handoff',
    executable: document.executable,
    sourceInputs: document.sourceInputs,
    expectedOutputs: document.expectedOutputs,
    snapperInvocations,
    next: { cwd, argv }
  };
  await fs.writeFile(result.handoffPath, `${JSON.stringify(enhanced, null, 2)}\n`);
  return result;
}

async function initialRun(options) {
  if (!options.input) throw new Error('--input is required when starting a guided run');
  const projectDir = resolveCwd(options);
  const input = path.resolve(options.input);
  const config = await configFor({ ...options, cwd: projectDir });
  const sourceInspection = await inspectImage(input, {
    tolerance: config.background.tolerance,
    backgroundColor: config.background.mode === 'configured' ? config.background.color : undefined
  });
  const extension = path.extname(input) || '.png';
  const anchorId = `source/approved-anchor${extension}`;
  const run = await createRun({
    projectDir,
    config,
    inputs: [{ path: input, id: anchorId, provenance: { role: 'approved-anchor' } }],
    inspectionSnapshot: sourceInspection
  });
  const anchor = await copyNew(input, path.join(run.runDir, ...anchorId.split('/')));
  const anchorReport = await inspectImage(anchor.path, {
    tolerance: config.background.tolerance,
    backgroundColor: config.background.mode === 'configured' ? config.background.color : undefined
  });
  const prepared = await prepareAnchor({ input: anchor.path, outputDir: path.join(run.runDir, 'prepared'), config });
  const transitionSecret = crypto.randomBytes(32);
  const transitionSecretPath = path.join(run.runDir, '.transition-secret');
  await fs.writeFile(transitionSecretPath, transitionSecret, { flag: 'wx', mode: 0o600 });
  const handoffPath = path.join(run.runDir, 'generation-handoff.json');
  const generationScale = config.generation.width / config.canonical.width;
  const handoff = {
    version: 1,
    schema: HANDOFF_SCHEMA,
    kind: 'image-generation',
    status: 'generation-handoff',
    state: 'awaiting-generated-frames',
    runId: run.runId,
    manifestSha256: run.manifestSha256,
    configSha256: stableHash(config),
    transition: { secretSha256: await sha256(transitionSecretPath) },
    anchor: { path: portablePath(run.runDir, anchor.path), sha256: anchor.sha256 },
    references: {
      anchor: { path: portablePath(run.runDir, prepared.generationPlate), sha256: prepared.hashes.generationPlate },
      matrix: { path: portablePath(run.runDir, prepared.pixelMatrix), sha256: prepared.hashes.pixelMatrix, blockSize: generationScale, usage: 'constraint-only-not-composited' }
    },
    config,
    sourceFrames: [],
    requiredOutputs: { role: 'generated-frames', count: null, format: 'PNG', mode: 'one-frame-at-a-time', references: ['anchor', 'matrix'] },
    next: nextInvocation(projectDir, run.runId, '--frame')
  };
  const resumeToken = await writeCanonicalHandoff(handoffPath, handoff, transitionSecret);
  return { ...handoff, transition: undefined, resumeToken, handoffPath, anchorReport, prepared };
}

function validateHandoff(document) {
  if (!document || document.version !== 1 || document.schema !== HANDOFF_SCHEMA || !['image-generation', 'pixel-snapper'].includes(document.kind)) throw new Error('unsupported run handoff schema');
  for (const key of ['runId', 'manifestSha256', 'configSha256', 'state']) if (typeof document[key] !== 'string' || document[key] === '') throw new Error(`run handoff ${key} is required`);
  if (!HANDOFF_FILES[document.state] || !Array.isArray(document.sourceFrames) || !document.requiredOutputs || !document.next || !Array.isArray(document.next.argv)) throw new Error('run handoff state is incomplete');
  if ((document.kind === 'image-generation') !== (document.state === 'awaiting-generated-frames') || !/^[a-f0-9]{64}$/.test(document.transition?.secretSha256 ?? '')) throw new Error('run handoff kind/state transition is invalid');
  if (document.kind === 'pixel-snapper') {
    if (!Array.isArray(document.requiredOutputs) || document.sourceFrames.length === 0 || document.requiredOutputs.length !== document.sourceFrames.length) throw new Error('Pixel Snapper handoff frame count is invalid');
    const outputPaths = new Set();
    for (let index = 0; index < document.sourceFrames.length; index += 1) {
      const source = document.sourceFrames[index];
      const output = document.requiredOutputs[index];
      if (source.index !== index || output.index !== index || output.sourceSha256 !== source.sha256 || !Number.isInteger(source.width) || source.width < 1 || !Number.isInteger(source.height) || source.height < 1) throw new Error('Pixel Snapper handoff frame order or provenance is invalid');
      if (typeof output.path !== 'string' || path.isAbsolute(output.path) || path.win32.isAbsolute(output.path) || output.path.includes('..') || outputPaths.has(output.path)) throw new Error('Pixel Snapper handoff required output path is invalid');
      outputPaths.add(output.path);
    }
  }
  return document;
}

async function loadResume(options) {
  const projectDir = resolveCwd(options);
  const requestedRunId = safeRunId(options.resume);
  const token = parseTransitionToken(options.resumeToken);
  if (token.runId !== requestedRunId) throw new Error('resume token run ID does not match requested run ID');
  const stateRoot = path.join(projectDir, '.pixel-sprite-pipeline', 'runs');
  const runDir = path.join(stateRoot, requestedRunId);
  const runStat = await fs.lstat(runDir);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error('run directory must be a real directory');
  const handoffArtifact = await safeRunArtifact(runDir, HANDOFF_FILES[token.state], token.handoffSha256, 'canonical handoff');
  const handoff = validateHandoff(JSON.parse(await fs.readFile(handoffArtifact.path, 'utf8')));
  if (handoff.runId !== requestedRunId || handoff.state !== token.state) throw new Error('resume token does not authenticate canonical handoff state');
  const secretArtifact = await safeRunArtifact(runDir, '.transition-secret', handoff.transition?.secretSha256, 'transition secret');
  const transitionSecret = await fs.readFile(secretArtifact.path);
  const expectedMac = transitionMac(transitionSecret, token);
  if (!secureHexMatches(token.mac, expectedMac)) throw new Error('resume token does not authenticate canonical handoff state');
  const receipt = path.join(runDir, `transition-${handoff.kind}.json`);
  try { await fs.lstat(receipt); throw new Error('handoff state transition was already consumed'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifestArtifact = await safeRunArtifact(runDir, 'manifest.json', handoff.manifestSha256, 'run manifest');
  const manifest = JSON.parse(await fs.readFile(manifestArtifact.path, 'utf8'));
  if (manifest.runId !== requestedRunId || stableHash(manifest.config) !== handoff.configSha256) throw new Error('canonical handoff does not match the immutable run manifest');
  const anchorInput = manifest.inputs?.find((item) => item.provenance?.role === 'approved-anchor');
  if (!anchorInput) throw new Error('run manifest lacks approved anchor provenance');
  const anchorArtifact = await safeRunArtifact(runDir, anchorInput.id, anchorInput.sha256, 'approved anchor');
  if (handoff.anchor?.path !== anchorInput.id || handoff.anchor?.sha256 !== anchorInput.sha256) throw new Error('canonical handoff anchor does not match manifest provenance');
  for (const [name, reference] of Object.entries(handoff.references ?? {})) await safeRunArtifact(runDir, reference.path, reference.sha256, `${name} reference`);
  for (const source of handoff.sourceFrames) await safeRunArtifact(runDir, source.path, source.sha256, `source frame ${source.index}`);
  return { projectDir, runDir, handoffPath: handoffArtifact.path, handoffSha256: handoffArtifact.sha256, handoff, manifest, config: manifest.config, anchorArtifact, transitionSecret };
}

async function writeSnapperResume(context, generated, snapResult) {
  const handoffPath = path.join(context.runDir, 'snapper-handoff.json');
  const sourceFrames = await Promise.all(generated.map(async (file, index) => {
    const image = await readRgba(file);
    return { index, path: portablePath(context.runDir, file), sha256: await sha256(file), width: image.width, height: image.height };
  }));
  const requiredOutputs = generated.map((file, index) => ({ index, path: `snapped/frame-${String(index).padStart(2, '0')}-snapped.png`, sourceSha256: sourceFrames[index].sha256 }));
  const handoff = {
    version: 1,
    schema: HANDOFF_SCHEMA,
    kind: 'pixel-snapper',
    status: 'manual-handoff',
    state: 'awaiting-snapped-frames',
    runId: context.handoff.runId,
    manifestSha256: context.handoff.manifestSha256,
    configSha256: context.handoff.configSha256,
    transition: { secretSha256: context.handoff.transition.secretSha256 },
    anchor: context.handoff.anchor,
    references: context.handoff.references,
    config: context.config,
    sourceFrames,
    requiredOutputs,
    snapper: { executable: path.basename(snapResult.executable), colorCount: 16 },
    next: nextInvocation(context.projectDir, context.handoff.runId, '--snapped-frame')
  };
  const token = await writeCanonicalHandoff(handoffPath, handoff, context.transitionSecret);
  await writeJsonIdempotent(path.join(context.runDir, `transition-${context.handoff.kind}.json`), { version: 1, from: context.handoffSha256, to: await sha256(handoffPath) }, 'generation transition receipt');
  return { ...handoff, transition: undefined, resumeToken: token, handoffPath };
}

async function finishRun(context, snappedFrames) {
  const normalizedDir = path.join(context.runDir, 'normalized');
  const normalizedStage = path.join(context.runDir, `.normalized-stage-${crypto.randomUUID()}`);
  let normalized;
  try {
    const staged = await normalizeFrames({ inputs: snappedFrames, outputDir: normalizedStage, config: context.config, scaleFactor: 1 });
    await publishDirectory(normalizedStage, normalizedDir, 'normalized frame batch');
    normalized = rebasePaths(staged, normalizedStage, normalizedDir);
  } catch (error) {
    await fs.rm(normalizedStage, { recursive: true, force: true });
    throw error;
  }
  const runtimeDir = path.join(context.runDir, 'runtime');
  const runtimeStage = path.join(context.runDir, `.runtime-stage-${crypto.randomUUID()}`);
  let exported;
  try {
    const staged = await exportAnimation({
      frames: normalized.frames,
      outputDir: runtimeStage,
      config: context.config,
      columns: Math.min(4, normalized.frames.length),
      durations: normalized.frames.map(() => 100),
      name: 'animation'
    });
    await publishDirectory(runtimeStage, runtimeDir, 'runtime export batch');
    exported = rebasePaths(staged, runtimeStage, runtimeDir);
  } catch (error) {
    await fs.rm(runtimeStage, { recursive: true, force: true });
    throw error;
  }
  const anchorReport = await inspectImage(context.anchorArtifact.path, {
    tolerance: context.config.background.tolerance,
    backgroundColor: context.config.background.mode === 'configured' ? context.config.background.color : undefined
  });
  const correctionContract = await createCorrectionContract({ runDir: context.runDir, runId: context.handoff.runId, config: context.config, anchorReport, normalized, exported });
  let validation = await validateRun({ anchorReport, normalized, exported, config: context.config, semanticEvidence: [] });
  let automaticCorrection = null;
  if (!validation.passed && validation.failures.some((failure) => !REVIEW_CORRECTIONS.has(failure.correction))) {
    const correctionNames = (await fs.readdir(context.runDir)).filter((name) => /^correction-\d+$/.test(name));
    automaticCorrection = await repairValidationRun({
      request: { anchorReport, normalized, exported, semanticEvidence: [] },
      run: { runDir: context.runDir, corrections: correctionNames, inputs: snappedFrames, generativeAttempts: {} },
      config: context.config,
      expected: correctionContract.document.expected,
      delivery: correctionContract.document.delivery
    });
    if (automaticCorrection.afterValidation.passed) {
      normalized = automaticCorrection.normalized;
      exported = automaticCorrection.exported;
      validation = automaticCorrection.afterValidation;
    }
  }
  const artifactFiles = [...exported.runtimeFrames, exported.sheet, exported.metadata, exported.preview];
  const artifacts = await Promise.all(artifactFiles.map(async (file) => ({ path: portablePath(context.runDir, file), sha256: await sha256(file) })));
  const correctionManifest = automaticCorrection?.correction?.manifest
    ? { path: portablePath(context.runDir, automaticCorrection.correction.manifest), sha256: await sha256(automaticCorrection.correction.manifest) }
    : null;
  const lessons = correctionManifest ? automaticCorrection.correction.actions.flatMap((action, actionIndex) => action.approved && LEARNABLE_FAILURES.has(action.code) && action.evidenceVerification?.afterValidation?.passed === true ? [{
    failureCode: action.code,
    correction: action.correction,
    proposedRule: `Use ${action.correction} for ${action.code}`,
    correctionManifest,
    actionIndex
  }] : []) : [];
  const report = {
    version: 1,
    runId: context.handoff.runId,
    manifestSha256: context.handoff.manifestSha256,
    validation: { ...portableValue(validation, context.runDir), artifacts },
    correctionContract: { path: portablePath(context.runDir, correctionContract.path), sha256: correctionContract.sha256 },
    lessons,
    profilePromotion: {
      eligible: validation.passed,
      applied: false,
      requiresUserApproval: true,
      reviewRequired: validation.warnings.some((warning) => warning.code === 'HUMAN_REVIEW_REQUIRED'),
      nextAction: 'Review the animation, then explicitly approve project-local profile promotion.'
    }
  };
  const recorded = await recordRunResultIdempotent({ context, report });
  const correctionReceipt = await sealCorrectionContract({ projectDir: context.projectDir, runDir: context.runDir, runId: context.handoff.runId, contract: correctionContract });
  if (validation.passed) await writeJsonIdempotent(path.join(context.runDir, `transition-${context.handoff.kind}.json`), { version: 1, from: context.handoffSha256, report: portablePath(context.runDir, recorded.reportPath) }, 'completion transition receipt');
  const result = { runId: context.handoff.runId, normalized, exported, validation, correction: automaticCorrection?.correction ?? null, correctionReceipt: { path: portablePath(context.runDir, correctionReceipt.path), sha256: correctionReceipt.sha256, signature: correctionReceipt.signature }, report: recorded, profilePromotion: report.profilePromotion };
  setValidationExit(validation);
  return result;
}

async function resumeRun(options) {
  const context = await loadResume(options);
  if (context.handoff.kind === 'pixel-snapper') {
    const supplied = combinedFrames(options, 'snappedFrame');
    const expected = context.handoff.sourceFrames.length;
    if (supplied.length !== expected || context.handoff.requiredOutputs.length !== expected) throw new Error(`exactly ${expected} snapped frames are required in source-frame order`);
    const outputNames = context.handoff.requiredOutputs.map((item) => path.basename(item.path));
    const snappedFrames = await stageBatch({ inputs: supplied, targetDir: path.join(context.runDir, 'snapped'), label: 'snapped frame batch', outputNames });
    return finishRun(context, snappedFrames);
  }

  const supplied = combinedFrames(options);
  const generated = await stageBatch({ inputs: supplied, targetDir: path.join(context.runDir, 'generated'), label: 'generated frame batch' });
  const snappedDir = path.join(context.runDir, 'snapped');
  const snapStage = path.join(context.runDir, `.snapped-stage-${crypto.randomUUID()}`);
  try {
    const snapped = await runPixelSnapper({ inputs: generated, outputDir: snapStage, config: context.config });
    if (snapped.status === 'manual-handoff') {
      await fs.rm(snapStage, { recursive: true, force: true });
      process.exitCode = EXIT.handoff;
      return writeSnapperResume(context, generated, snapped);
    }
    if (snapped.outputs.length !== generated.length) throw new Error('Pixel Snapper output count does not match source frame count');
    await publishDirectory(snapStage, snappedDir, 'snapped frame batch');
    const outputs = snapped.outputs.map((file) => path.join(snappedDir, path.basename(file)));
    return finishRun(context, outputs);
  } catch (error) {
    await fs.rm(snapStage, { recursive: true, force: true });
    throw error;
  }
}

const program = new Command()
  .name('pixel-sprite-pipeline')
  .description('Prepare and normalize animated pixel-art sprites')
  .version('0.1.0')
  .exitOverride()
  .configureOutput({ writeErr: () => {} });

program.command('inspect')
  .description('Inspect a pixel-art anchor or frame')
  .requiredOption('-i, --input <file>')
  .option('--tolerance <n>', 'background tolerance (0-255)', tolerance, 0)
  .action(async (options) => print(await inspectImage(path.resolve(options.input), { tolerance: options.tolerance })));

program.command('prepare')
  .description('Prepare canonical, generation, runtime, and matrix references')
  .requiredOption('-i, --input <file>')
  .requiredOption('-o, --output <dir>')
  .option('--profile <file>')
  .option('--cwd <dir>')
  .action(async (options) => {
    const outputDir = path.resolve(options.output);
    await refuseExisting(outputDir);
    print(await prepareAnchor({ input: path.resolve(options.input), outputDir, config: await configFor(options) }));
  });

program.command('snap')
  .description('Run Pixel Snapper or produce a resumable manual handoff')
  .option('-f, --frame <file>', 'frame path; repeat for multiple frames', frame, [])
  .option('--frames <files...>', 'multiple frame paths')
  .requiredOption('-o, --output <dir>')
  .option('--profile <file>')
  .option('--cwd <dir>')
  .action(async (options) => {
    const outputDir = path.resolve(options.output);
    await refuseExisting(outputDir);
    const inputs = combinedFrames(options);
    let result = await runPixelSnapper({ inputs, outputDir, config: await configFor(options) });
    if (result.status === 'manual-handoff') result = await enhanceStandaloneSnapperHandoff({ result, inputs, outputDir, cwd: resolveCwd(options) });
    print(result);
    if (result.status === 'manual-handoff') process.exitCode = EXIT.handoff;
  });

program.command('normalize')
  .description('Normalize frames with one integer scale and shared pivot')
  .option('-f, --frame <file>', 'frame path; repeat for multiple frames', frame, [])
  .option('--frames <files...>', 'multiple frame paths')
  .requiredOption('-o, --output <dir>')
  .option('--scale <n>', 'shared positive integer scale', positiveInteger, 1)
  .option('--profile <file>')
  .option('--cwd <dir>')
  .action(async (options) => {
    const outputDir = path.resolve(options.output);
    await refuseExisting(outputDir);
    print(await normalizeFrames({ inputs: combinedFrames(options), outputDir, config: await configFor(options), scaleFactor: options.scale }));
  });

program.command('export')
  .description('Export runtime PNG frames, sheet, JSON, and animated WebP')
  .option('-f, --frame <file>', 'frame path; repeat for multiple frames', frame, [])
  .option('--frames <files...>', 'multiple frame paths')
  .requiredOption('-o, --output <dir>')
  .requiredOption('-n, --name <name>')
  .option('--columns <n>', 'positive integer sheet columns', positiveInteger, 4)
  .option('--duration <ms>', 'frame duration; repeat in frame order', duration, [])
  .option('--profile <file>')
  .option('--cwd <dir>')
  .action(async (options) => {
    const frames = combinedFrames(options);
    const outputDir = path.resolve(options.output);
    await refuseExisting(outputDir);
    const durations = options.duration.length === 0 ? frames.map(() => 100) : options.duration;
    if (durations.length !== frames.length || durations.some((value) => value < 11 || value > 65535)) throw new Error('durations must provide one integer from 11 to 65535 per frame');
    print(await exportAnimation({ frames, outputDir, config: await configFor(options), columns: options.columns, durations, name: options.name }));
  });

program.command('validate')
  .description('Validate a version 1 artifact request manifest')
  .requiredOption('--request <file>')
  .option('--profile <file>')
  .option('--cwd <dir>')
  .action(async (options) => {
    const request = validateRequest(JSON.parse(await fs.readFile(path.resolve(options.request), 'utf8')));
    const result = await validateRun({ ...request, config: await configFor(options) });
    print(result);
    setValidationExit(result);
  });

program.command('correct')
  .alias('repair')
  .description('Apply allowlisted deterministic corrections and objectively revalidate a version 1 run request')
  .requiredOption('--request <file>')
  .requiredOption('--project-dir <dir>')
  .action(async (options) => {
    const document = validateRepairRequest(JSON.parse(await fs.readFile(path.resolve(options.request), 'utf8')));
    const projectDir = path.resolve(options.projectDir);
    const context = await loadCorrectionContext({ projectDir, runId: document.runId, contractSha256: document.contractSha256, receiptSha256: document.receiptSha256, receiptSignature: document.receiptSignature, declaredFailure: document.declaredFailure });
    const { runDir, config, request, manifest } = context;
    const beforeValidation = await validateRun({ ...request, config });
    if (!beforeValidation.failures.some((failure) => sameFailure(failure, document.declaredFailure))) throw new Error('declared correction failure is not identified by objective validation');
    const candidates = [request.anchorReport.path, ...request.normalized.frames, ...request.normalized.measurements.map((item) => item.input), ...request.exported.runtimeFrames, request.exported.sheet, request.exported.metadata, request.exported.preview];
    const names = await fs.readdir(runDir);
    const corrections = names.filter((name) => /^correction-\d+$/.test(name));
    const result = await repairValidationRun({
      request,
      run: { runDir, corrections, inputs: candidates, generativeAttempts: {} },
      config,
      expected: context.expected,
      delivery: context.contract.delivery
    });
    if (result.afterValidation.passed && result.correction) {
      const delivered = [...result.exported.runtimeFrames, result.exported.sheet, result.exported.metadata, result.exported.preview];
      const artifacts = await Promise.all(delivered.map(async (file) => ({ path: portablePath(runDir, file), sha256: await sha256(file) })));
      const correctionManifest = { path: portablePath(runDir, result.correction.manifest), sha256: await sha256(result.correction.manifest) };
      const lessons = result.correction.actions.flatMap((action, actionIndex) => action.approved && LEARNABLE_FAILURES.has(action.code) && action.evidenceVerification?.afterValidation?.passed === true ? [{
        failureCode: action.code,
        correction: action.correction,
        proposedRule: `Use ${action.correction} for ${action.code}`,
        correctionManifest,
        actionIndex
      }] : []);
      result.recorded = await recordRunResult({
        projectDir,
        runId: document.runId,
        version: document.reportVersion ?? 2,
        report: {
          version: 1,
          runId: document.runId,
          manifestSha256: context.contract.manifest.sha256,
          validation: { ...portableValue(result.afterValidation, runDir), artifacts },
          lessons
        }
      });
    }
    print(portableValue(result, runDir));
    setValidationExit(result.afterValidation);
  });

program.command('promote-profile')
  .description('Explicitly promote a verified immutable run configuration into the project profile')
  .requiredOption('--run <run-id>')
  .requiredOption('--project-dir <dir>')
  .option('--report-version <n>', 'verified report version', positiveInteger)
  .action(async (options) => print(await promoteVerifiedProfile({ projectDir: path.resolve(options.projectDir), runId: safeRunId(options.run), reportVersion: options.reportVersion })));

program.command('propose-rule')
  .description('Propose, but never apply, a skill rule from independently verified project lessons')
  .requiredOption('--failure <code>')
  .requiredOption('--correction <action>')
  .requiredOption('--rule <text>')
  .requiredOption('--project-dir <dir>')
  .option('--threshold <n>', 'explicit evidence threshold override', positiveInteger)
  .option('--profile <file>')
  .action(async (options) => print(await proposeSkillRule({
    projectDir: path.resolve(options.projectDir),
    lesson: { failureCode: options.failure, correction: options.correction, proposedRule: options.rule },
    config: await configFor({ ...options, cwd: options.projectDir }),
    thresholdOverride: options.threshold
  })));

program.command('run')
  .description('Start or resume a versioned guided animation run')
  .option('-i, --input <anchor>')
  .option('--resume <handoff>')
  .option('--resume-token <token>')
  .option('-f, --frame <file>', 'generated frame; repeat in frame order', frame, [])
  .option('--frames <files...>', 'multiple generated frame paths')
  .option('--snapped-frame <file>', 'manually snapped frame; repeat in frame order', frame, [])
  .option('--profile <file>')
  .option('--project-dir <dir>')
  .option('--cwd <dir>')
  .action(async (options) => {
    let result;
    if (options.resume) {
      result = await resumeRun(options);
    } else {
      const started = await initialRun(options);
      const suppliedFrames = (options.frame?.length ?? 0) + (options.frames?.length ?? 0);
      result = suppliedFrames === 0
        ? started
        : await resumeRun({ ...options, resume: started.runId, resumeToken: started.resumeToken });
    }
    print(result);
    if (result.status === 'generation-handoff') process.exitCode = EXIT.handoff;
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error.code === 'commander.helpDisplayed' ? null : error.message;
  if (message) {
    process.stdout.write('');
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = EXIT.error;
  }
}
