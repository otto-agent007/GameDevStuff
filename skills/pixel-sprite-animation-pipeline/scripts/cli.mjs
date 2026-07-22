#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { loadConfig } from './lib/config.mjs';
import { exportAnimation, exportContractAnimation } from './lib/export.mjs';
import { inspectImage } from './lib/inspect.mjs';
import { createRun, promoteVerifiedProfile, proposeSkillRule, recordRunResult } from './lib/learning.mjs';
import { normalizeContractFrames, normalizeFrames } from './lib/normalize.mjs';
import { prepareAnchor } from './lib/prepare.mjs';
import { runPixelSnapper } from './lib/snapper.mjs';
import { verifySnapReceipt, writeManualHandoffReceipt } from './lib/snap-receipt.mjs';
import { loadAnimationContract, validateAnimationContract } from './lib/animation-contract.mjs';
import { verifyFrameApproval, writeFrameApproval } from './lib/frame-approval.mjs';
import { setupPixelSnapper } from './lib/setup-snapper.mjs';
import { readRgba, sha256 } from './lib/image.mjs';
import { validateRun } from './lib/validate.mjs';
import { repairValidationRun } from './lib/repair.mjs';
import { createCorrectionContract, loadCorrectionContext, sealCorrectionContract } from './lib/contract.mjs';
import { canonicalRelativePath, isPathContained, sameCanonicalPath } from './lib/path-security.mjs';

const EXIT = Object.freeze({ success: 0, error: 1, handoff: 2, objectiveFailure: 3, review: 4 });
const REVIEW_CORRECTIONS = new Set(['palette-remap-review', 'stop-for-regeneration', 'stop-for-review', 'timing-or-transition-review']);
const LEARNABLE_FAILURES = new Set(['CANVAS_SIZE', 'BACKGROUND_REMAINS']);
const CLI_PATH = fileURLToPath(import.meta.url);
const HANDOFF_SCHEMA = 'pixel-sprite-run-handoff/v1';
const APPROVAL_HANDOFF_SCHEMA = 'pixel-sprite-frame-approval-handoff/v1';
const HANDOFF_FILES = Object.freeze({
  'awaiting-generated-frames': 'generation-handoff.json',
  'awaiting-snapped-frames': 'snapper-handoff.json',
  'awaiting-frame-approval': 'frame-approval-handoff.json'
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

function packagedToolManifest() {
  return fileURLToPath(new URL('../references/pixel-snapper-tool-manifest.json', import.meta.url));
}

async function snapperResolverOptions(projectDir, manifestPath = packagedToolManifest()) {
  try {
    return { projectDir, manifest: JSON.parse(await fs.readFile(manifestPath, 'utf8')), env: process.env };
  } catch (error) {
    if (error.code === 'ENOENT') return { projectDir, env: process.env };
    throw error;
  }
}

async function ensureReceiptState(projectDir) {
  const state = path.join(projectDir, '.pixel-sprite-pipeline');
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(state);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('snap receipt state directory must be a real directory');
  if (process.platform !== 'win32') await fs.chmod(state, 0o700);
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

function validateApprovalRequest(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('frame approval request must be an object');
  const allowed = new Set(['version', 'frames', 'approvals']);
  for (const key of Object.keys(document)) if (!allowed.has(key)) throw new Error(`unknown frame approval request field: ${key}`);
  if (document.version !== 1) throw new Error('frame approval request version must be 1');
  if (!Array.isArray(document.frames) || !Array.isArray(document.approvals)) throw new Error('frame approval request requires explicit frames and approvals');
  return document;
}

function sameFailure(left, right) {
  return left?.code === right?.code && ['stage', 'frame', 'target'].every((key) => right[key] === undefined || left[key] === right[key]);
}

async function portablePath(runDir, file) {
  try { return await canonicalRelativePath(runDir, file); }
  catch { throw new Error('run artifact escaped the versioned run directory'); }
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

function approvalInvocations(projectDir, runId, contractPath, snapReceiptPath) {
  return {
    approveFrames: {
      cwd: projectDir,
      argv: [process.execPath, CLI_PATH, 'approve-frames', '--contract', contractPath, '--snap-receipt', snapReceiptPath, '--approval-request', '<APPROVAL_REQUEST>', '--version', '<NUMBER>', '--project-dir', projectDir]
    },
    resume: {
      cwd: projectDir,
      argv: [process.execPath, CLI_PATH, 'run', '--resume', runId, '--resume-token', '<TOKEN>', '--frame-approval', '<SIGNED_FRAME_APPROVAL>', '--approval-version', '<NUMBER>', '--project-dir', projectDir]
    }
  };
}

function manifestAnimationContract(manifest) {
  if (manifest.animationContract === undefined) return null;
  const selected = structuredClone(manifest.animationContract);
  if (!selected || typeof selected !== 'object' || Array.isArray(selected) || Object.keys(selected).sort().join(',') !== 'document,sha256') throw new Error('run manifest animation contract binding is invalid');
  validateAnimationContract(selected.document);
  if (stableHash(selected.document) !== selected.sha256) throw new Error('run manifest animation contract hash is invalid');
  return selected;
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
  const files = [];
  async function visit(current, prefix = '') {
    for (const name of (await fs.readdir(current)).sort()) {
      const file = path.join(current, name);
      const child = await fs.lstat(file);
      if (child.isSymbolicLink()) throw new Error(`${label} contains a symlink`);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (child.isDirectory()) { await visit(file, relative); continue; }
      if (!child.isFile() || child.nlink > 1) throw new Error(`${label} contains a non-regular artifact`);
      const physical = await fs.realpath(file);
      const containment = path.relative(root, physical);
      if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error(`${label} artifact escaped its directory`);
      files.push({ name: relative, sha256: await sha256(file) });
    }
  }
  await visit(directory);
  return files;
}

async function productionInputs({ contractFile, contract, projectDir }) {
  const file = `${contractFile}.inputs.json`;
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  const keys = Object.keys(document ?? {}).sort().join(',');
  if (keys !== 'anchor,frames,selectionApprovalSha256,version' || document.version !== 1 || document.selectionApprovalSha256 !== contract.document.selectionApprovalSha256 || !Array.isArray(document.frames)) throw new Error('production input manifest approval binding mismatch');
  if (!document.anchor || Object.keys(document.anchor).sort().join(',') !== 'path,sha256' || document.anchor.sha256 !== contract.document.character.anchorSha256) throw new Error('production input manifest character anchor binding mismatch');
  const anchor = await safeRunArtifact(projectDir, document.anchor.path, document.anchor.sha256, 'production anchor');
  const definitions = contract.document.clips.flatMap((clip) => clip.frames.flatMap((frame) => frame.tracks.map((trackId) => ({ frameId: frame.id, trackId }))));
  if (document.frames.length !== definitions.length) throw new Error('production input manifest membership does not match the v2 contract');
  const inputs = [];
  for (const [index, record] of document.frames.entries()) {
    if (!record || Object.keys(record).sort().join(',') !== 'frameId,path,sha256,trackId' || record.frameId !== definitions[index].frameId || record.trackId !== definitions[index].trackId || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')) throw new Error('production input manifest ordered membership is invalid');
    const selected = await safeRunArtifact(projectDir, record.path, record.sha256, 'production input');
    inputs.push(selected.path);
  }
  return { file, document, anchor, inputs };
}

function v2Config(contract, base) {
  return {
    ...base,
    canonical: { width: contract.document.canvas.width, height: contract.document.canvas.height },
    runtime: { ...contract.document.scale.runtime },
    pivot: { ...contract.document.canvas.pivot }
  };
}

function approvalVersion(file) {
  const match = /frame-approval-(\d+)\.json$/.exec(path.basename(file));
  if (!match || Number(match[1]) < 1) throw new Error('selected frame approval must use its immutable numbered filename');
  return Number(match[1]);
}

async function productionArtifacts(root) {
  return (await flatDirectoryManifest(root, 'pixel production export')).map(({ name, sha256: artifactSha256 }) => ({ path: name, sha256: artifactSha256 }));
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
  const { resumeCommand, ...handoff } = document;
  const enhanced = {
    ...handoff,
    status: 'manual-handoff',
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
  const animationContract = options.contract ? await loadAnimationContract(path.resolve(options.contract)) : null;
  if (animationContract && animationContract.document.anchor.sha256 !== sourceInspection.sha256) throw new Error('animation contract anchor hash does not match the approved guided-run input');
  const extension = path.extname(input) || '.png';
  const anchorId = `source/approved-anchor${extension}`;
  const run = await createRun({
    projectDir,
    config,
    inputs: [{ path: input, id: anchorId, provenance: { role: 'approved-anchor' } }],
    inspectionSnapshot: sourceInspection,
    ...(animationContract ? { animationContract } : {})
  });
  let contractReference = null;
  if (animationContract) {
    const contractPath = path.join(run.runDir, 'animation-contract.json');
    await writeJsonNew(contractPath, animationContract.document);
    contractReference = { path: 'animation-contract.json', sha256: await sha256(contractPath) };
  }
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
    anchor: { path: await portablePath(run.runDir, anchor.path), sha256: anchor.sha256 },
    references: {
      anchor: { path: await portablePath(run.runDir, prepared.generationPlate), sha256: prepared.hashes.generationPlate },
      matrix: { path: await portablePath(run.runDir, prepared.pixelMatrix), sha256: prepared.hashes.pixelMatrix, blockSize: generationScale, usage: 'constraint-only-not-composited' },
      ...(contractReference ? { animationContract: contractReference } : {})
    },
    ...(animationContract ? { animationContractSha256: animationContract.sha256 } : {}),
    config,
    sourceFrames: [],
    requiredOutputs: {
      role: 'generated-frames',
      count: animationContract ? animationContract.document.clips.reduce((count, clip) => count + clip.frames.length, 0) : null,
      ...(animationContract ? { frameIds: animationContract.document.clips.flatMap((clip) => clip.frames.map((frameDefinition) => frameDefinition.id)) } : {}),
      format: 'PNG', mode: 'one-frame-at-a-time', references: animationContract ? ['anchor', 'matrix', 'animationContract'] : ['anchor', 'matrix']
    },
    next: nextInvocation(projectDir, run.runId, '--frame')
  };
  const resumeToken = await writeCanonicalHandoff(handoffPath, handoff, transitionSecret);
  return { ...handoff, transition: undefined, resumeToken, handoffPath, anchorReport, prepared };
}

function validateHandoff(document) {
  if (!document || document.version !== 1 || !['image-generation', 'pixel-snapper', 'frame-approval'].includes(document.kind)) throw new Error('unsupported run handoff schema');
  const approval = document.kind === 'frame-approval';
  if (document.schema !== (approval ? APPROVAL_HANDOFF_SCHEMA : HANDOFF_SCHEMA)) throw new Error('unsupported run handoff schema');
  for (const key of ['runId', 'manifestSha256', 'configSha256', 'state']) if (typeof document[key] !== 'string' || document[key] === '') throw new Error(`run handoff ${key} is required`);
  if (!HANDOFF_FILES[document.state] || !Array.isArray(document.sourceFrames) || !document.next || !/^[a-f0-9]{64}$/.test(document.transition?.secretSha256 ?? '')) throw new Error('run handoff state is incomplete');
  const expectedState = { 'image-generation': 'awaiting-generated-frames', 'pixel-snapper': 'awaiting-snapped-frames', 'frame-approval': 'awaiting-frame-approval' }[document.kind];
  if (document.state !== expectedState) throw new Error('run handoff kind/state transition is invalid');
  if (approval) {
    if (!/^[a-f0-9]{64}$/.test(document.animationContractSha256 ?? '') || !/^[a-f0-9]{64}$/.test(document.snapReceiptSha256 ?? '') || !document.snapReceipt || document.snapReceipt.sha256 !== document.snapReceiptSha256 || !Array.isArray(document.frames) || document.frames.length === 0 || typeof document.toolProvenanceVerified !== 'boolean') throw new Error('frame approval handoff binding is incomplete');
    if (!document.next.approveFrames || !Array.isArray(document.next.approveFrames.argv) || !document.next.resume || !Array.isArray(document.next.resume.argv)) throw new Error('frame approval handoff invocations are incomplete');
    const ids = new Set();
    for (const [index, frameRecord] of document.frames.entries()) {
      if (frameRecord.index !== index || typeof frameRecord.id !== 'string' || frameRecord.id === '' || ids.has(frameRecord.id) || typeof frameRecord.path !== 'string' || !/^[a-f0-9]{64}$/.test(frameRecord.sha256 ?? '') || !frameRecord.landmarkSemantic) throw new Error('frame approval handoff ordered frame binding is invalid');
      ids.add(frameRecord.id);
    }
    return document;
  }
  if (!document.requiredOutputs || !Array.isArray(document.next.argv)) throw new Error('run handoff state is incomplete');
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
  const logicalRunDir = path.join(stateRoot, requestedRunId);
  for (const directory of [projectDir, path.join(projectDir, '.pixel-sprite-pipeline'), stateRoot, logicalRunDir]) {
    const runStat = await fs.lstat(directory);
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error('run directory must be a real non-symlink directory');
  }
  const [physicalStateRoot, runDir] = await Promise.all([fs.realpath(stateRoot), fs.realpath(logicalRunDir)]);
  if (!isPathContained(physicalStateRoot, runDir)) throw new Error('run directory escaped the authenticated runs root');
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
  const animationContract = manifestAnimationContract(manifest);
  if ((handoff.animationContractSha256 !== undefined || handoff.kind === 'frame-approval') && handoff.animationContractSha256 !== animationContract?.sha256) throw new Error('canonical handoff does not match the immutable animation contract');
  const anchorInput = manifest.inputs?.find((item) => item.provenance?.role === 'approved-anchor');
  if (!anchorInput) throw new Error('run manifest lacks approved anchor provenance');
  const anchorArtifact = await safeRunArtifact(runDir, anchorInput.id, anchorInput.sha256, 'approved anchor');
  if (handoff.anchor?.path !== anchorInput.id || handoff.anchor?.sha256 !== anchorInput.sha256) throw new Error('canonical handoff anchor does not match manifest provenance');
  for (const [name, reference] of Object.entries(handoff.references ?? {})) await safeRunArtifact(runDir, reference.path, reference.sha256, `${name} reference`);
  for (const source of handoff.sourceFrames) await safeRunArtifact(runDir, source.path, source.sha256, `source frame ${source.index}`);
  if (handoff.kind === 'frame-approval') {
    const snapReceiptArtifact = await safeRunArtifact(runDir, handoff.snapReceipt.path, undefined, 'selected snap receipt');
    for (const frameRecord of handoff.frames) {
      if (path.isAbsolute(frameRecord.path) || path.win32.isAbsolute(frameRecord.path) || frameRecord.path.includes('\\') || frameRecord.path === '..' || frameRecord.path.startsWith('../') || path.posix.normalize(frameRecord.path) !== frameRecord.path) throw new Error('frame approval handoff output path is invalid');
      const physical = path.join(path.dirname(snapReceiptArtifact.path), ...frameRecord.path.split('/'));
      await safeRunArtifact(runDir, await portablePath(runDir, physical), frameRecord.sha256, `frame approval output ${frameRecord.index}`);
    }
  }
  return { projectDir, runDir, handoffPath: handoffArtifact.path, handoffSha256: handoffArtifact.sha256, handoff, manifest, config: manifest.config, animationContract, anchorArtifact, transitionSecret };
}

async function writeSnapperResume(context, generated, snapResult) {
  const handoffPath = path.join(context.runDir, 'snapper-handoff.json');
  const sourceFrames = await Promise.all(generated.map(async (file, index) => {
    const image = await readRgba(file);
    return { index, path: await portablePath(context.runDir, file), sha256: await sha256(file), width: image.width, height: image.height };
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
    ...(context.animationContract ? { animationContractSha256: context.animationContract.sha256 } : {}),
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

async function writeApprovalResume(context, snapProvenance) {
  if (!context.animationContract) throw new Error('frame approval handoff requires an immutable animation contract');
  if (!snapProvenance?.receipt?.path) throw new Error('frame approval handoff requires a signed snap receipt');
  const receiptPath = path.isAbsolute(snapProvenance.receipt.path)
    ? snapProvenance.receipt.path
    : path.join(context.runDir, ...snapProvenance.receipt.path.split('/'));
  const selectedReceipt = await verifySnapReceipt({
    projectDir: context.projectDir,
    file: receiptPath,
    expectedRun: { id: context.handoff.runId, outputDir: context.runDir, manifestSha256: context.handoff.manifestSha256 },
    expectedContract: context.animationContract
  });
  if (selectedReceipt.sha256 !== snapProvenance.receipt.sha256) throw new Error('frame approval handoff snap receipt hash mismatch');
  const definitions = context.animationContract.document.clips.flatMap((clip) => clip.frames);
  const outputs = selectedReceipt.document.payload.outputs;
  if (outputs.length !== definitions.length) throw new Error('signed snap receipt does not cover every contracted frame');
  const frames = outputs.map((output, index) => ({
    index,
    id: definitions[index].id,
    path: output.path,
    sha256: output.sha256,
    landmarkSemantic: definitions[index].landmarkSemantic
  }));
  const snapReceipt = { path: await portablePath(context.runDir, receiptPath), sha256: selectedReceipt.sha256 };
  const contractPath = context.handoff.references?.animationContract?.path ?? 'animation-contract.json';
  const handoffPath = path.join(context.runDir, 'frame-approval-handoff.json');
  const handoff = {
    version: 1,
    schema: APPROVAL_HANDOFF_SCHEMA,
    kind: 'frame-approval',
    status: 'frame-approval-handoff',
    state: 'awaiting-frame-approval',
    runId: context.handoff.runId,
    manifestSha256: context.handoff.manifestSha256,
    configSha256: context.handoff.configSha256,
    transition: { secretSha256: context.handoff.transition.secretSha256 },
    anchor: context.handoff.anchor,
    references: context.handoff.references,
    config: context.config,
    sourceFrames: context.handoff.sourceFrames,
    animationContractSha256: context.animationContract.sha256,
    snapReceiptSha256: selectedReceipt.sha256,
    snapReceipt,
    toolProvenanceVerified: selectedReceipt.document.payload.toolProvenanceVerified === true,
    frames,
    next: approvalInvocations(context.projectDir, context.handoff.runId, path.join(context.runDir, ...contractPath.split('/')), receiptPath)
  };
  const resumeToken = await writeCanonicalHandoff(handoffPath, handoff, context.transitionSecret);
  await writeJsonIdempotent(path.join(context.runDir, `transition-${context.handoff.kind}.json`), { version: 1, from: context.handoffSha256, to: await sha256(handoffPath) }, 'snap-to-approval transition receipt');
  process.exitCode = EXIT.handoff;
  return { ...handoff, transition: undefined, resumeToken, handoffPath };
}

async function acquireApprovalTransition(context, selection) {
  // Claims are intentionally not age-reclaimed. After abrupt process death an
  // operator must inspect/remove crash debris; automatic stale recovery could
  // let two approval revisions mutate the same immutable delivery ancestry.
  const claimPath = path.join(context.runDir, 'transition-frame-approval.claim');
  const finalPath = path.join(context.runDir, 'transition-frame-approval.json');
  const claim = { version: 1, handoffSha256: context.handoffSha256, frameApprovalSha256: selection.sha256, approvalVersion: selection.version };
  const contents = `${JSON.stringify(claim, null, 2)}\n`;
  let handle;
  try { await fs.lstat(finalPath); throw new Error('handoff state transition was already consumed'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    handle = await fs.open(claimPath, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code !== 'EEXIST') throw error;
    try { await fs.lstat(finalPath); throw new Error('handoff state transition was already consumed'); }
    catch (finalError) { if (finalError.code !== 'ENOENT') throw finalError; }
    let existing;
    try {
      const stat = await fs.lstat(claimPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('approval transition claim is invalid and requires manual recovery');
      existing = JSON.parse(await fs.readFile(claimPath, 'utf8'));
    } catch (claimError) {
      if (/approval transition claim/.test(claimError.message)) throw claimError;
      throw new Error('approval transition claim is invalid and requires manual recovery');
    }
    if (existing.handoffSha256 === claim.handoffSha256 && existing.frameApprovalSha256 === claim.frameApprovalSha256 && existing.approvalVersion === claim.approvalVersion) throw new Error('approval transition is already in progress');
    throw new Error('approval transition is claimed by a different signed approval');
  }
  await handle.close();
  async function release() {
    try {
      const stat = await fs.lstat(claimPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || await fs.readFile(claimPath, 'utf8') !== contents) return;
      await fs.unlink(claimPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {
    async fail() { await release(); },
    async complete(reportPath) {
      await writeJsonNew(finalPath, { version: 1, from: context.handoffSha256, frameApprovalSha256: selection.sha256, approvalVersion: selection.version, report: await portablePath(context.runDir, reportPath) });
      await release();
    }
  };
}

async function finishRun(context, snappedFrames, snapProvenance = { toolProvenanceVerified: false, receipt: null }) {
  const contracted = Boolean(context.animationContract);
  if (contracted && !snapProvenance.approval) throw new Error('a signed frame approval is required before normalization');
  const approvalPayload = snapProvenance.approval?.document?.payload;
  const landmarks = contracted ? approvalPayload.frames.map((approved, index) => ({
    frameId: approved.id,
    source: { ...approved.landmark },
    target: { ...context.animationContract.document.clips.flatMap((clip) => clip.frames)[index].landmarkSemantic.target }
  })) : undefined;
  const normalizedDir = path.join(context.runDir, 'normalized');
  const normalizedStage = path.join(context.runDir, `.normalized-stage-${crypto.randomUUID()}`);
  let normalized;
  try {
    const staged = await normalizeFrames({ inputs: snappedFrames, outputDir: normalizedStage, config: context.config, scaleFactor: 1, ...(contracted ? { landmarks, animationContract: context.animationContract } : {}) });
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
    const staged = contracted
      ? await exportContractAnimation({ normalized, contract: context.animationContract, outputDir: runtimeStage, config: context.config, columns: Math.min(4, normalized.frames.length), frameApprovalSha256: snapProvenance.approval.sha256 })
      : await exportAnimation({
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
  const provenance = contracted ? {
    animationContractSha256: context.animationContract.sha256,
    snapReceiptSha256: snapProvenance.receipt.sha256,
    frameApprovalSha256: snapProvenance.approval.sha256,
    toolProvenanceVerified: snapProvenance.toolProvenanceVerified === true,
    snapReceipt: { path: snapProvenance.receipt.path, sha256: snapProvenance.receipt.sha256 },
    frameApproval: { path: snapProvenance.approval.path, sha256: snapProvenance.approval.sha256, version: snapProvenance.approval.version }
  } : undefined;
  const correctionContract = await createCorrectionContract({ runDir: context.runDir, runId: context.handoff.runId, config: context.config, anchorReport, normalized, exported, provenance });
  const validationRequest = {
    anchorReport, normalized, exported, config: context.config, semanticEvidence: [],
    ...(contracted ? {
      animationContract: context.animationContract,
      frameApproval: {
        projectDir: context.projectDir,
        file: path.join(context.runDir, ...snapProvenance.approval.path.split('/')),
        snapReceipt: { path: path.join(context.runDir, ...snapProvenance.receipt.path.split('/')), sha256: snapProvenance.receipt.sha256 },
        version: snapProvenance.approval.version
      }
    } : {})
  };
  let validation = await validateRun(validationRequest);
  let automaticCorrection = null;
  if (!contracted && !validation.passed && validation.failures.some((failure) => !REVIEW_CORRECTIONS.has(failure.correction))) {
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
  const artifactFiles = contracted
    ? [exported.metadata, ...Object.values(exported.clips).flatMap((clip) => [...clip.runtimeFrames, clip.sheet, clip.metadata, clip.preview])]
    : [...exported.runtimeFrames, exported.sheet, exported.metadata, exported.preview];
  const artifacts = await Promise.all(artifactFiles.map(async (file) => ({ path: await portablePath(context.runDir, file), sha256: await sha256(file) })));
  const correctionManifest = automaticCorrection?.correction?.manifest
    ? { path: await portablePath(context.runDir, automaticCorrection.correction.manifest), sha256: await sha256(automaticCorrection.correction.manifest) }
    : null;
  const lessons = correctionManifest ? automaticCorrection.correction.actions.flatMap((action, actionIndex) => action.approved && LEARNABLE_FAILURES.has(action.code) && action.evidenceVerification?.afterValidation?.passed === true ? [{
    failureCode: action.code,
    correction: action.correction,
    proposedRule: `Use ${action.correction} for ${action.code}`,
    correctionManifest,
    actionIndex
  }] : []) : [];
  const humanReviewOutstanding = validation.warnings.some((warning) => warning.code === 'HUMAN_REVIEW_REQUIRED' || warning.requiresUserReview === true);
  const report = {
    version: 1,
    runId: context.handoff.runId,
    manifestSha256: context.handoff.manifestSha256,
    validation: { ...portableValue(validation, context.runDir), artifacts },
    correctionContract: { path: await portablePath(context.runDir, correctionContract.path), sha256: correctionContract.sha256 },
    ...(provenance ?? {}),
    toolProvenanceVerified: snapProvenance.toolProvenanceVerified === true,
    snapReceipt: snapProvenance.receipt ? { path: snapProvenance.receipt.path, sha256: snapProvenance.receipt.sha256 } : null,
    ...(contracted ? { frameApproval: { path: snapProvenance.approval.path, sha256: snapProvenance.approval.sha256, version: snapProvenance.approval.version } } : {}),
    lessons,
    profilePromotion: {
      eligible: validation.passed && snapProvenance.toolProvenanceVerified === true && !humanReviewOutstanding,
      applied: false,
      requiresUserApproval: true,
      reviewRequired: humanReviewOutstanding,
      nextAction: 'Review the animation, then explicitly approve project-local profile promotion.'
    },
    ...(contracted ? { popTAcceptance: {
      eligible: validation.passed && snapProvenance.toolProvenanceVerified === true && !humanReviewOutstanding,
      applied: false,
      requiresUserApproval: true,
      reason: snapProvenance.toolProvenanceVerified === true ? 'Requires private Pop T visual acceptance.' : 'Manual handoff provenance is permanently ineligible for Pop T release acceptance.'
    } } : {})
  };
  const recorded = await recordRunResultIdempotent({ context, report });
  const correctionReceipt = await sealCorrectionContract({ projectDir: context.projectDir, runDir: context.runDir, runId: context.handoff.runId, contract: correctionContract });
  if (validation.passed && context.handoff.kind !== 'frame-approval') await writeJsonIdempotent(path.join(context.runDir, `transition-${context.handoff.kind}.json`), { version: 1, from: context.handoffSha256, report: await portablePath(context.runDir, recorded.reportPath) }, 'completion transition receipt');
  const result = { state: 'complete', runId: context.handoff.runId, normalized, exported, validation, correction: automaticCorrection?.correction ?? null, correctionReceipt: { path: await portablePath(context.runDir, correctionReceipt.path), sha256: correctionReceipt.sha256, signature: correctionReceipt.signature }, report: { ...report, ...recorded }, recorded, profilePromotion: report.profilePromotion };
  setValidationExit(validation);
  return result;
}

async function resumeRun(options, { manifestPath = packagedToolManifest() } = {}) {
  const context = await loadResume(options);
  if (context.handoff.kind !== 'frame-approval' && (options.frameApproval || options.approvalVersion)) throw new Error('frame approval selection is valid only for an authenticated awaiting-frame-approval state');
  if (context.handoff.kind === 'frame-approval') {
    if (!options.frameApproval || !options.approvalVersion) throw new Error('an explicitly selected numbered signed frame approval is required before normalization');
    const approvalPath = path.resolve(options.frameApproval);
    const approvalArtifact = await safeRunArtifact(context.runDir, await portablePath(context.runDir, approvalPath), undefined, 'selected frame approval');
    const receiptArtifact = await safeRunArtifact(context.runDir, context.handoff.snapReceipt.path, undefined, 'selected snap receipt');
    const verified = await verifyFrameApproval({
      projectDir: context.projectDir,
      file: approvalArtifact.path,
      contract: context.animationContract,
      snapReceipt: { path: receiptArtifact.path, sha256: context.handoff.snapReceiptSha256 },
      version: options.approvalVersion
    });
    const approvedFrames = verified.document.payload.frames;
    if (verified.document.payload.animationContractSha256 !== context.handoff.animationContractSha256 || verified.document.payload.snapReceiptSha256 !== context.handoff.snapReceiptSha256 || approvedFrames.length !== context.handoff.frames.length) throw new Error('signed frame approval does not match the immutable approval handoff');
    for (let index = 0; index < approvedFrames.length; index += 1) {
      const approved = approvedFrames[index];
      const expected = context.handoff.frames[index];
      if (approved.index !== expected.index || approved.id !== expected.id || approved.path !== expected.path || approved.sha256 !== expected.sha256 || JSON.stringify(approved.landmarkSemantic) !== JSON.stringify(expected.landmarkSemantic)) throw new Error('signed frame approval ordered outputs do not match the immutable approval handoff');
    }
    const snappedFrames = context.handoff.frames.map((frameRecord) => path.join(path.dirname(receiptArtifact.path), ...frameRecord.path.split('/')));
    const transition = await acquireApprovalTransition(context, { sha256: verified.sha256, version: options.approvalVersion });
    try {
      const result = await finishRun(context, snappedFrames, {
        toolProvenanceVerified: context.handoff.toolProvenanceVerified,
        receipt: context.handoff.snapReceipt,
        approval: { path: await portablePath(context.runDir, verified.path), sha256: verified.sha256, version: options.approvalVersion, document: verified.document }
      });
      await transition.complete(result.recorded.reportPath);
      return result;
    } catch (error) {
      await transition.fail();
      throw error;
    }
  }
  if (context.handoff.kind === 'pixel-snapper') {
    const supplied = combinedFrames(options, 'snappedFrame');
    const expected = context.handoff.sourceFrames.length;
    if (supplied.length !== expected || context.handoff.requiredOutputs.length !== expected) throw new Error(`exactly ${expected} snapped frames are required in source-frame order`);
    const outputNames = context.handoff.requiredOutputs.map((item) => path.basename(item.path));
    const snappedFrames = await stageBatch({ inputs: supplied, targetDir: path.join(context.runDir, 'snapped'), label: 'snapped frame batch', outputNames });
    const manualReceipt = await writeManualHandoffReceipt({
      projectDir: context.projectDir, run: { id: context.handoff.runId, outputDir: context.runDir, manifestSha256: context.handoff.manifestSha256 },
      handoff: context.handoffPath, inputs: context.handoff.sourceFrames.map((source) => path.join(context.runDir, ...source.path.split('/'))), outputs: snappedFrames
    });
    const snapReceipt = { path: await portablePath(context.runDir, manualReceipt.path), sha256: manualReceipt.sha256, signature: manualReceipt.document.signature };
    if (context.animationContract) return writeApprovalResume(context, { toolProvenanceVerified: false, receipt: snapReceipt });
    return { ...(await finishRun(context, snappedFrames, { toolProvenanceVerified: false, receipt: snapReceipt })), snapReceipt };
  }

  const supplied = combinedFrames(options);
  if (context.animationContract) {
    const expected = context.animationContract.document.clips.reduce((count, clip) => count + clip.frames.length, 0);
    if (supplied.length !== expected) throw new Error(`exactly ${expected} generated frames are required in animation-contract order`);
  }
  const generated = await stageBatch({ inputs: supplied, targetDir: path.join(context.runDir, 'generated'), label: 'generated frame batch' });
  const snappedDir = path.join(context.runDir, 'snapped');
  const snapStage = path.join(context.runDir, `.snapped-stage-${crypto.randomUUID()}`);
  try {
    const snapped = await runPixelSnapper({
      inputs: generated, outputDir: snapStage, config: context.config,
      paletteHex: context.animationContract?.document.palette.snapperPaletteHex,
      resolverOptions: await snapperResolverOptions(context.projectDir, manifestPath),
      receipt: { projectDir: context.projectDir, run: { id: context.handoff.runId, outputDir: snapStage, manifestSha256: context.handoff.manifestSha256 }, contract: context.animationContract ?? { sha256: context.handoffSha256 }, durableReceiptFile: path.join(snappedDir, 'snap-receipt.json') }
    });
    if (snapped.status === 'manual-handoff') {
      await fs.rm(snapStage, { recursive: true, force: true });
      process.exitCode = EXIT.handoff;
      return writeSnapperResume(context, generated, snapped);
    }
    if (snapped.outputs.length !== generated.length) throw new Error('Pixel Snapper output count does not match source frame count');
    if (snapped.recoveredExistingReceipt) {
      const provenance = { toolProvenanceVerified: true, receipt: { ...snapped.receipt, path: await portablePath(context.runDir, snapped.receipt.path) } };
      return context.animationContract ? writeApprovalResume(context, provenance) : finishRun(context, snapped.outputs, provenance);
    }
    await publishDirectory(snapStage, snappedDir, 'snapped frame batch');
    const outputs = snapped.outputs.map((file) => path.join(snappedDir, path.basename(file)));
    const provenance = { toolProvenanceVerified: true, receipt: { ...snapped.receipt, path: await portablePath(context.runDir, path.join(snappedDir, path.basename(snapped.receipt.path))) } };
    return context.animationContract ? writeApprovalResume(context, provenance) : finishRun(context, outputs, provenance);
  } catch (error) {
    await fs.rm(snapStage, { recursive: true, force: true });
    throw error;
  }
}

function correctionRevisionVersion(document) {
  if (!Number.isInteger(document.reportVersion) || document.reportVersion < 2) throw new Error('contracted correction requires an explicit reportVersion of at least 2');
  return document.reportVersion;
}

function revisionDirectory(context, version) {
  return path.join(context.runDir, `revision-${String(version).padStart(2, '0')}`);
}

function projectDirectory(context) {
  return path.dirname(path.dirname(path.dirname(context.runDir)));
}

function correctionRevisionRequest(context, document, version) {
  return {
    version: 1,
    schema: 'pixel-sprite-correction-revision/v1',
    state: 'awaiting-corrected-snapped-frames',
    revisionVersion: version,
    runId: document.runId,
    manifestSha256: context.contract.manifest.sha256,
    correctionContractSha256: document.contractSha256,
    correctionReceiptSha256: document.receiptSha256,
    original: structuredClone(context.provenance),
    declaredFailure: structuredClone(document.declaredFailure),
    next: { cwd: projectDirectory(context), argv: [process.execPath, CLI_PATH, 'correct', '--request', '<SAME_SIGNED_CORRECTION_REQUEST>', '--replacement-snapped-frame', '<CORRECTED_SNAPPED_FRAME>', '--project-dir', '<PROJECT_DIR>'] }
  };
}

function exactJsonDocument(actual, expected, label) {
  if (JSON.stringify(stableValue(actual)) !== JSON.stringify(stableValue(expected))) throw new Error(`${label} does not match the authenticated correction revision`);
}

async function requireCanonicalRevisionDirectory(context, version) {
  const revisionDir = revisionDirectory(context, version);
  const stat = await fs.lstat(revisionDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('correction revision directory must be a real directory');
  const runRoot = await fs.realpath(context.runDir);
  const physical = await fs.realpath(revisionDir);
  const expected = path.join(runRoot, path.basename(revisionDir));
  const containment = path.relative(runRoot, physical);
  if (physical !== expected || containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error('correction revision directory escaped the authenticated run');
  return revisionDir;
}

async function revisionArtifact(context, version, relative, expectedHash, label) {
  const revisionName = `revision-${String(version).padStart(2, '0')}`;
  return safeRunArtifact(context.runDir, `${revisionName}/${relative}`, expectedHash, label);
}

function correctionReplacementHandoff({ context, document, version, revisionRequestSha256, outputs }) {
  const definitions = context.manifest.animationContract.document.clips.flatMap((clip) => clip.frames);
  return {
    version: 1,
    schema: 'pixel-sprite-correction-replacement/v1',
    runId: document.runId,
    revisionVersion: version,
    revisionRequestSha256,
    supersedes: structuredClone(context.provenance),
    toolProvenanceVerified: false,
    outputs: outputs.map((output, index) => ({ index, id: definitions[index].id, path: output.relative, sha256: output.sha256 }))
  };
}

async function correctionApprovalHandoff({ context, document, version, receipt, definitions }) {
  const frames = receipt.document.payload.outputs.map((output, index) => ({ index, id: definitions[index].id, path: output.path, sha256: output.sha256, landmarkSemantic: definitions[index].landmarkSemantic }));
  return {
    version: 1,
    schema: APPROVAL_HANDOFF_SCHEMA,
    state: 'awaiting-frame-approval',
    runId: document.runId,
    revisionVersion: version,
    animationContractSha256: context.manifest.animationContract.sha256,
    supersedesFrameApprovalSha256: context.provenance.frameApprovalSha256,
    snapReceiptSha256: receipt.sha256,
    snapReceipt: { path: await portablePath(context.runDir, receipt.path), sha256: receipt.sha256 },
    toolProvenanceVerified: false,
    frames
  };
}

async function requireRevisionRequest(context, document, version) {
  const revisionDir = revisionDirectory(context, version);
  await fs.mkdir(revisionDir, { recursive: true });
  await requireCanonicalRevisionDirectory(context, version);
  const request = correctionRevisionRequest(context, document, version);
  const file = path.join(revisionDir, 'revision-request.json');
  await writeJsonIdempotent(file, request, 'correction revision request');
  return { revisionDir, file, request };
}

async function stageCorrectionRevision({ context, document, revision, inputs }) {
  const definitions = context.manifest.animationContract.document.clips.flatMap((clip) => clip.frames);
  if (inputs.length !== definitions.length) throw new Error(`exactly ${definitions.length} corrected snapped frames are required in animation-contract order`);
  const outputNames = definitions.map((_, index) => `frame-${String(index).padStart(2, '0')}-snapped.png`);
  const outputs = await stageBatch({ inputs, targetDir: path.join(revision.revisionDir, 'snapped'), label: 'correction revision snapped batch', outputNames });
  const outputRecords = await Promise.all(outputs.map(async (file) => ({ relative: await portablePath(revision.revisionDir, file), sha256: await sha256(file) })));
  const replacementHandoff = correctionReplacementHandoff({
    context, document, version: revision.request.revisionVersion,
    revisionRequestSha256: await sha256(revision.file), outputs: outputRecords
  });
  const replacementFile = path.join(revision.revisionDir, 'replacement-handoff.json');
  await writeJsonIdempotent(replacementFile, replacementHandoff, 'correction replacement handoff');
  const oldInputs = context.ancestry.verifiedApproval.document.payload.frames.map((frameRecord) => path.join(path.dirname(context.ancestry.receiptFile), ...frameRecord.path.split('/')));
  const receipt = await writeManualHandoffReceipt({
    projectDir: projectDirectory(context),
    run: { id: document.runId, outputDir: revision.revisionDir, manifestSha256: context.contract.manifest.sha256 },
    handoff: replacementFile,
    inputs: oldInputs,
    outputs
  });
  const approvalHandoff = await correctionApprovalHandoff({ context, document, version: revision.request.revisionVersion, receipt, definitions });
  const handoffFile = path.join(revision.revisionDir, 'frame-approval-handoff.json');
  await writeJsonIdempotent(handoffFile, approvalHandoff, 'correction frame approval handoff');
  process.exitCode = EXIT.handoff;
  return { ...approvalHandoff, handoffPath: handoffFile };
}

async function finishCorrectionRevision({ context, document, revision, approvalFile, approvalVersion }) {
  const version = revision.request.revisionVersion;
  if (!Number.isInteger(approvalVersion) || approvalVersion !== version || approvalVersion <= context.provenance.frameApproval.version) throw new Error('a new numbered frame approval revision is required for corrected pixels');
  const revisionDir = await requireCanonicalRevisionDirectory(context, version);
  const requestArtifact = await revisionArtifact(context, version, 'revision-request.json', undefined, 'correction revision request');
  const actualRequest = JSON.parse(await fs.readFile(requestArtifact.path, 'utf8'));
  exactJsonDocument(actualRequest, correctionRevisionRequest(context, document, version), 'correction revision request');

  const definitions = context.manifest.animationContract.document.clips.flatMap((clip) => clip.frames);
  const outputArtifacts = [];
  for (const [index] of definitions.entries()) {
    const relative = `snapped/frame-${String(index).padStart(2, '0')}-snapped.png`;
    outputArtifacts.push({ ...(await revisionArtifact(context, version, relative, undefined, `correction revision replacement frame ${index}`)), relative });
  }
  const expectedReplacement = correctionReplacementHandoff({ context, document, version, revisionRequestSha256: requestArtifact.sha256, outputs: outputArtifacts });
  const replacementArtifact = await revisionArtifact(context, version, 'replacement-handoff.json', undefined, 'correction revision replacement handoff');
  const actualReplacement = JSON.parse(await fs.readFile(replacementArtifact.path, 'utf8'));
  exactJsonDocument(actualReplacement, expectedReplacement, 'correction revision replacement handoff');

  const receiptArtifact = await revisionArtifact(context, version, 'manual-handoff-receipt.json', undefined, 'correction revision snap receipt');
  const receiptFile = receiptArtifact.path;
  const receipt = await verifySnapReceipt({
    projectDir: projectDirectory(context), file: receiptFile,
    expectedRun: { runId: document.runId, runDir: revisionDir, manifestSha256: context.contract.manifest.sha256 },
    expectedContract: context.manifest.animationContract
  });
  const expectedInputs = context.ancestry.verifiedApproval.document.payload.frames.map((frameRecord, index) => {
    const original = path.join(path.dirname(context.ancestry.receiptFile), ...frameRecord.path.split('/'));
    return { index, path: path.relative(revisionDir, original).replaceAll('\\', '/'), sha256: frameRecord.sha256 };
  });
  const expectedReceiptPayload = {
    version: 1,
    origin: 'manual-handoff',
    toolProvenanceVerified: false,
    run: { id: document.runId, manifestSha256: context.contract.manifest.sha256 },
    handoffSha256: replacementArtifact.sha256,
    inputs: expectedInputs,
    outputs: outputArtifacts.map((output, index) => ({ index, path: output.relative, sha256: output.sha256 })),
    arguments: null,
    binary: null,
    createdAt: receipt.document.payload.createdAt
  };
  exactJsonDocument(receipt.document.payload, expectedReceiptPayload, 'correction revision snap receipt ancestry');

  const expectedHandoff = await correctionApprovalHandoff({ context, document, version, receipt, definitions });
  const handoffArtifact = await revisionArtifact(context, version, 'frame-approval-handoff.json', undefined, 'correction revision frame approval handoff');
  const handoff = JSON.parse(await fs.readFile(handoffArtifact.path, 'utf8'));
  exactJsonDocument(handoff, expectedHandoff, 'correction revision frame approval handoff');
  const selectedApproval = path.resolve(approvalFile);
  const expectedApprovalPath = path.join(revisionDir, `frame-approval-${String(approvalVersion).padStart(2, '0')}.json`);
  if (!await sameCanonicalPath(selectedApproval, expectedApprovalPath)) throw new Error('new frame approval must be the canonical numbered file in the correction revision');
  const approvalArtifact = await revisionArtifact(context, version, path.basename(expectedApprovalPath), undefined, 'correction revision frame approval');
  const approval = await verifyFrameApproval({ projectDir: projectDirectory(context), file: approvalArtifact.path, contract: context.manifest.animationContract, snapReceipt: { path: receiptFile, sha256: receipt.sha256 }, version: approvalVersion });
  if (approval.document.payload.frames.length !== expectedHandoff.frames.length || approval.document.payload.frames.some((frameRecord, index) => frameRecord.id !== expectedHandoff.frames[index].id || frameRecord.path !== expectedHandoff.frames[index].path || frameRecord.sha256 !== expectedHandoff.frames[index].sha256)) throw new Error('new frame approval does not match the corrected revision outputs');
  const sourceFrames = outputArtifacts.map((output) => output.path);
  const landmarks = approval.document.payload.frames.map((frameRecord, index) => ({ frameId: frameRecord.id, source: frameRecord.landmark, target: definitions[index].landmarkSemantic.target }));
  const normalizedDir = path.join(revisionDir, 'normalized');
  const normalizedStage = path.join(revisionDir, `.normalized-stage-${crypto.randomUUID()}`);
  let normalized;
  try {
    const staged = await normalizeFrames({ inputs: sourceFrames, outputDir: normalizedStage, config: context.config, scaleFactor: 1, landmarks, animationContract: context.manifest.animationContract });
    await publishDirectory(normalizedStage, normalizedDir, 'correction revision normalized batch');
    normalized = rebasePaths(staged, normalizedStage, normalizedDir);
  } catch (error) { await fs.rm(normalizedStage, { recursive: true, force: true }); throw error; }
  const runtimeDir = path.join(revisionDir, 'runtime');
  const runtimeStage = path.join(revisionDir, `.runtime-stage-${crypto.randomUUID()}`);
  let exported;
  try {
    const staged = await exportContractAnimation({ normalized, contract: context.manifest.animationContract, outputDir: runtimeStage, config: context.config, columns: Math.min(4, normalized.frames.length), frameApprovalSha256: approval.sha256 });
    await publishDirectory(runtimeStage, runtimeDir, 'correction revision runtime batch');
    exported = rebasePaths(staged, runtimeStage, runtimeDir);
  } catch (error) { await fs.rm(runtimeStage, { recursive: true, force: true }); throw error; }
  const anchorReport = await inspectImage(path.join(context.runDir, context.contract.anchor.path), { tolerance: context.config.background.tolerance, backgroundColor: context.config.background.mode === 'configured' ? context.config.background.color : undefined });
  const validation = await validateRun({
    anchorReport, normalized, exported, config: context.config, semanticEvidence: [], animationContract: context.manifest.animationContract,
    frameApproval: { projectDir: projectDirectory(context), file: approvalArtifact.path, snapReceipt: { path: receiptFile, sha256: receipt.sha256 }, version: approvalVersion }
  });
  const artifacts = await Promise.all([exported.metadata, ...Object.values(exported.clips).flatMap((clip) => [...clip.runtimeFrames, clip.sheet, clip.metadata, clip.preview])].map(async (file) => ({ path: await portablePath(context.runDir, file), sha256: await sha256(file) })));
  const humanReviewOutstanding = validation.warnings.some((warning) => warning.code === 'HUMAN_REVIEW_REQUIRED' || warning.requiresUserReview === true);
  const report = {
    version: 1, runId: document.runId, revisionVersion: version, manifestSha256: context.contract.manifest.sha256,
    supersedes: structuredClone(context.provenance),
    animationContractSha256: context.manifest.animationContract.sha256, snapReceiptSha256: receipt.sha256, frameApprovalSha256: approval.sha256, toolProvenanceVerified: false,
    snapReceipt: { path: await portablePath(context.runDir, receiptFile), sha256: receipt.sha256 }, frameApproval: { path: await portablePath(context.runDir, approvalArtifact.path), sha256: approval.sha256, version: approvalVersion },
    validation: { ...portableValue(validation, context.runDir), artifacts },
    profilePromotion: { eligible: false, applied: false, requiresUserApproval: true, reviewRequired: humanReviewOutstanding },
    popTAcceptance: { eligible: false, applied: false, requiresUserApproval: true, reason: 'Correction replacement was supplied through a manual handoff and cannot inherit verified-tool provenance.' }
  };
  const reportFile = path.join(revisionDir, 'report.json');
  await writeJsonIdempotent(reportFile, report, 'correction revision report');
  await writeJsonIdempotent(path.join(revisionDir, 'revision-complete.json'), { version: 1, report: 'report.json', reportSha256: await sha256(reportFile), frameApprovalSha256: approval.sha256 }, 'correction revision completion');
  setValidationExit(validation);
  return { state: 'complete', runId: document.runId, revisionVersion: version, normalized, exported, validation, report };
}

async function handleContractCorrection({ context, document, options, beforeValidation }) {
  if (!beforeValidation.failures.some((failure) => sameFailure(failure, document.declaredFailure))) throw new Error('declared correction failure is not identified by objective validation');
  const version = correctionRevisionVersion(document);
  const revision = await requireRevisionRequest(context, document, version);
  const replacements = options.replacementSnappedFrame ?? [];
  if (replacements.length > 0 && options.frameApproval) throw new Error('replacement snapped frames and frame approval must be submitted in separate revision steps');
  if (replacements.length > 0) return stageCorrectionRevision({ context, document, revision, inputs: replacements.map((file) => path.resolve(file)) });
  if (options.frameApproval || options.approvalVersion) {
    if (!options.frameApproval || !options.approvalVersion) throw new Error('both --frame-approval and --approval-version are required');
    return finishCorrectionRevision({ context, document, revision, approvalFile: options.frameApproval, approvalVersion: options.approvalVersion });
  }
  process.exitCode = EXIT.handoff;
  return { ...revision.request, handoffPath: revision.file };
}

export function createProgram({ setupPixelSnapperImpl = setupPixelSnapper, manifestPath = packagedToolManifest(), printImpl = print } = {}) {
const program = new Command()
  .name('pixel-sprite-pipeline')
  .description('Prepare and normalize animated pixel-art sprites')
  .version('0.1.0', '-V, --pipeline-version')
  .exitOverride()
  .configureOutput({ writeErr: () => {} });

program.command('setup-snapper')
  .description('Install and verify the pinned Pixel Snapper binary for this platform')
  .option('--project-dir <path>')
  .option('--force')
  .action(async (options) => printImpl(await setupPixelSnapperImpl({
    projectDir: resolveCwd(options),
    manifestPath,
    force: options.force === true
  })));

program.command('inspect')
  .description('Inspect a pixel-art anchor or frame')
  .requiredOption('-i, --input <file>')
  .option('--tolerance <n>', 'background tolerance (0-255)', tolerance, 0)
  .action(async (options) => print(await inspectImage(path.resolve(options.input), { tolerance: options.tolerance })));

program.command('contract')
  .description('Inspect a closed pre-generation animation contract')
  .command('inspect')
  .description('Load, validate, freeze, and hash an explicit animation contract')
  .requiredOption('--file <file>')
  .action(async (options) => printImpl(await loadAnimationContract(path.resolve(options.file))));

program.command('approve-frames')
  .description('Create one signed numbered post-snap approval from explicit landmark data')
  .requiredOption('--contract <file>')
  .requiredOption('--snap-receipt <file>')
  .requiredOption('--approval-request <file>')
  .requiredOption('--version <n>', 'positive approval revision', positiveInteger)
  .option('--project-dir <dir>')
  .option('--cwd <dir>')
  .action(async (options) => {
    const projectDir = resolveCwd(options);
    const request = validateApprovalRequest(JSON.parse(await fs.readFile(path.resolve(options.approvalRequest), 'utf8')));
    await ensureReceiptState(projectDir);
    printImpl(await writeFrameApproval({
      projectDir, runDir: path.dirname(path.resolve(options.snapReceipt)), contract: await loadAnimationContract(path.resolve(options.contract)),
      snapReceipt: { path: path.resolve(options.snapReceipt) }, frames: request.frames, approvals: request.approvals, version: options.version
    }));
  });

program.command('produce-contract')
  .description('Produce one authenticated version-2 multi-track animation package')
  .requiredOption('--contract <file>')
  .requiredOption('--project-dir <dir>')
  .requiredOption('--output <dir>')
  .option('--snap-receipt <file>')
  .option('--frame-approval <file>')
  .action(async (options) => {
    const projectDir = path.resolve(options.projectDir);
    const contractFile = path.resolve(options.contract);
    const contract = await loadAnimationContract(contractFile);
    if (contract.document.version !== 2) throw new Error('produce-contract requires an animation contract version 2');
    const selectedInputs = await productionInputs({ contractFile, contract, projectDir });
    const productionBinding = {
      contract: { path: contractFile, sha256: contract.sha256 },
      inputManifest: { path: selectedInputs.file, sha256: stableHash(selectedInputs.document) }
    };
    const outputRoot = path.resolve(options.output);
    const snapDir = path.join(outputRoot, 'snapped');
    const config = v2Config(contract, await configFor({ projectDir }));
    await ensureReceiptState(projectDir);
    let receipt;
    let snappedOutputs;
    if (options.snapReceipt) {
      receipt = await verifySnapReceipt({ projectDir, file: path.resolve(options.snapReceipt), expectedContract: contract });
      snappedOutputs = receipt.document.payload.outputs.map((record) => path.resolve(path.dirname(receipt.path), record.path));
    } else {
      await refuseExisting(outputRoot, 'pixel production output');
      await fs.mkdir(outputRoot, { recursive: true });
      const snapped = await runPixelSnapper({
        inputs: selectedInputs.inputs,
        outputDir: snapDir,
        config,
        paletteHex: contract.document.palette.snapperPaletteHex,
        resolverOptions: await snapperResolverOptions(projectDir, manifestPath),
        receipt: { projectDir, run: { id: null, outputDir: snapDir, manifestSha256: stableHash(selectedInputs.document) }, contract }
      });
      if (snapped.status === 'manual-handoff') {
        printImpl({
          status: 'manual-handoff',
          ...productionBinding,
          handoffPath: snapped.handoffPath,
          next: { kind: 'pixel-snapper-manual', cwd: projectDir, argv: [process.execPath, CLI_PATH, 'produce-contract', '--contract', contractFile, '--project-dir', projectDir, '--output', outputRoot, '--snap-receipt', '<SIGNED_SNAP_RECEIPT>'] }
        });
        process.exitCode = EXIT.handoff;
        return;
      }
      receipt = await verifySnapReceipt({ projectDir, file: snapped.receipt.path, expectedContract: contract });
      snappedOutputs = snapped.outputs;
    }
    const receiptSelection = { path: receipt.path, sha256: receipt.sha256 };
    if (!options.frameApproval) {
      printImpl({
        status: 'awaiting-frame-approval',
        ...productionBinding,
        receipt: receiptSelection,
        snapped: receipt.document.payload.outputs,
        next: {
          kind: 'post-snap-frame-approval',
          cwd: projectDir,
          argv: [process.execPath, CLI_PATH, 'approve-frames', '--contract', contractFile, '--snap-receipt', receipt.path, '--approval-request', '<POST_SNAP_LANDMARK_REQUEST>', '--version', '<NUMBER>', '--project-dir', projectDir]
        }
      });
      process.exitCode = EXIT.review;
      return;
    }
    const frameApprovalFile = path.resolve(options.frameApproval);
    const version = approvalVersion(frameApprovalFile);
    const verifiedApproval = await verifyFrameApproval({ projectDir, file: frameApprovalFile, contract, snapReceipt: receiptSelection, version });
    if (snappedOutputs.length !== contract.document.clips.flatMap((clip) => clip.frames.flatMap((frame) => frame.tracks)).length) throw new Error('signed snap receipt membership does not match the v2 contract');
    const normalized = await normalizeContractFrames({ contract, frameApproval: verifiedApproval, outputDir: path.join(outputRoot, 'normalized') });
    const exported = await exportContractAnimation({ normalized, contract, outputDir: path.join(outputRoot, 'export'), config, frameApprovalSha256: verifiedApproval.sha256 });
    const anchorReport = await inspectImage(selectedInputs.anchor.path);
    const frameApprovalSelection = { projectDir, file: frameApprovalFile, snapReceipt: receiptSelection, version };
    const report = await validateRun({ anchorReport, normalized, exported, config, animationContract: contract, frameApproval: frameApprovalSelection });
    if (!report.passed) {
      printImpl({ status: 'objective-failure', ...productionBinding, receipt: receiptSelection, frameApproval: { path: frameApprovalFile, sha256: verifiedApproval.sha256 }, report });
      process.exitCode = EXIT.objectiveFailure;
      return;
    }
    printImpl({
      status: 'complete',
      ...productionBinding,
      receipt: receiptSelection,
      frameApproval: { path: frameApprovalFile, sha256: verifiedApproval.sha256 },
      exports: { root: path.dirname(exported.metadata), metadata: exported.metadata, artifacts: await productionArtifacts(path.dirname(exported.metadata)) },
      report
    });
  });

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
    const cwd = resolveCwd(options);
    const config = await configFor(options);
    await ensureReceiptState(cwd);
    let result = await runPixelSnapper({
      inputs, outputDir, config, resolverOptions: await snapperResolverOptions(cwd, manifestPath),
      receipt: { projectDir: cwd, run: { id: null, outputDir, manifestSha256: null }, contract: { sha256: stableHash({ kind: 'standalone-snap', arguments: config.snapper?.args ?? ['16'] }) } }
    });
    if (result.status === 'manual-handoff') result = await enhanceStandaloneSnapperHandoff({ result, inputs, outputDir, cwd });
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
  .option('-n, --name <name>')
  .option('--columns <n>', 'positive integer sheet columns', positiveInteger, 4)
  .option('--duration <ms>', 'frame duration; repeat in frame order', duration, [])
  .option('--contract <file>', 'closed animation contract; timings come only from this document')
  .option('--normalization <file>', 'normalization result JSON with ordered frame IDs and landmarks')
  .option('--frame-approval-sha256 <sha256>', 'selected signed frame approval hash')
  .option('--profile <file>')
  .option('--cwd <dir>')
  .action(async (options) => {
    const outputDir = path.resolve(options.output);
    await refuseExisting(outputDir);
    const config = await configFor(options);
    if (options.contract) {
      if (options.duration.length > 0) throw new Error('--duration cannot be used with --contract; contract frame durations are authoritative');
      if (!options.normalization) throw new Error('--normalization is required with --contract');
      if ((options.frame?.length ?? 0) > 0 || (options.frames?.length ?? 0) > 0) throw new Error('--frame and --frames cannot be used with --contract; the normalization manifest is authoritative');
      const normalized = JSON.parse(await fs.readFile(path.resolve(options.normalization), 'utf8'));
      const allowed = ['frames', 'canonicalPivot', 'scaleFactor', 'measurements'];
      if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized) || Object.keys(normalized).length !== allowed.length || allowed.some((key) => !Object.hasOwn(normalized, key))) throw new Error('contract export normalization manifest schema is invalid');
      print(await exportContractAnimation({
        normalized,
        contract: await loadAnimationContract(path.resolve(options.contract)),
        outputDir,
        config,
        columns: options.columns,
        frameApprovalSha256: options.frameApprovalSha256
      }));
      return;
    }
    if (options.normalization || options.frameApprovalSha256) throw new Error('--normalization and --frame-approval-sha256 require --contract');
    if (!options.name) throw new Error('--name is required without --contract');
    const frames = combinedFrames(options);
    const durations = options.duration.length === 0 ? frames.map(() => 100) : options.duration;
    if (durations.length !== frames.length || durations.some((value) => value < 11 || value > 65535)) throw new Error('durations must provide one integer from 11 to 65535 per frame');
    print(await exportAnimation({ frames, outputDir, config, columns: options.columns, durations, name: options.name }));
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
  .option('--replacement-snapped-frame <file>', 'corrected snapped frame for a contracted immutable revision; repeat in contract order', frame, [])
  .option('--frame-approval <file>', 'new signed numbered approval for a staged contracted revision')
  .option('--approval-version <n>', 'new contracted revision approval number', positiveInteger)
  .action(async (options) => {
    const document = validateRepairRequest(JSON.parse(await fs.readFile(path.resolve(options.request), 'utf8')));
    const projectDir = path.resolve(options.projectDir);
    const context = await loadCorrectionContext({ projectDir, runId: document.runId, contractSha256: document.contractSha256, receiptSha256: document.receiptSha256, receiptSignature: document.receiptSignature, declaredFailure: document.declaredFailure });
    if (context.contractAnimation) {
      const beforeValidation = await validateRun({ ...context.request, config: context.config });
      const result = await handleContractCorrection({ context, document, options, beforeValidation });
      print(portableValue(result, context.runDir));
      return;
    }
    if ((options.replacementSnappedFrame?.length ?? 0) > 0 || options.frameApproval || options.approvalVersion) throw new Error('contracted correction revision options require an animation-contract run');
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
      const artifacts = await Promise.all(delivered.map(async (file) => ({ path: await portablePath(runDir, file), sha256: await sha256(file) })));
      const correctionManifest = { path: await portablePath(runDir, result.correction.manifest), sha256: await sha256(result.correction.manifest) };
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
          ...(context.provenance ?? {}),
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
  .option('--contract <file>', 'closed animation contract bound immutably when the run is created')
  .option('--resume <handoff>')
  .option('--resume-token <token>')
  .option('-f, --frame <file>', 'generated frame; repeat in frame order', frame, [])
  .option('--frames <files...>', 'multiple generated frame paths')
  .option('--snapped-frame <file>', 'manually snapped frame; repeat in frame order', frame, [])
  .option('--frame-approval <file>', 'explicit signed numbered frame approval selected for normalization')
  .option('--approval-version <n>', 'selected positive frame approval revision', positiveInteger)
  .option('--profile <file>')
  .option('--project-dir <dir>')
  .option('--cwd <dir>')
  .action(async (options) => {
    let result;
    if (options.resume) {
      if (options.contract) throw new Error('--contract is bound only when a new guided run is created');
      result = await resumeRun(options, { manifestPath });
    } else {
      if (options.frameApproval || options.approvalVersion) throw new Error('--frame-approval and --approval-version require an authenticated approval resume');
      const started = await initialRun(options);
      const suppliedFrames = (options.frame?.length ?? 0) + (options.frames?.length ?? 0);
      result = suppliedFrames === 0
        ? started
        : await resumeRun({ ...options, resume: started.runId, resumeToken: started.resumeToken }, { manifestPath });
    }
    print(result);
    if (result.status === 'generation-handoff') process.exitCode = EXIT.handoff;
  });

return program;
}

let directExecution = false;
try { directExecution = await fs.realpath(process.argv[1] ?? '') === await fs.realpath(CLI_PATH); } catch {}
if (directExecution) {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error) {
    const message = error.code === 'commander.helpDisplayed' ? null : error.message;
    if (message) {
      process.stdout.write('');
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      process.exitCode = EXIT.error;
    }
  }
}
