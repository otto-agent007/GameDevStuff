import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import YAML from 'yaml';
import { validateConfig } from './config.mjs';

const HASH = /^[a-f0-9]{64}$/;
const SECRET_KEY = /(password|passwd|secret|token|api[-_]?key|credential|private[-_]?key)/i;

function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function fileSha(file) {
  return sha(await fs.readFile(file));
}

function cloneJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value, (key, item) => {
      if (SECRET_KEY.test(key)) throw new Error(`${label} must not contain secrets`);
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error(`${label} must be JSON-safe`);
      if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || item === undefined) throw new Error(`${label} must be JSON-safe`);
      return item;
    });
  } catch (error) {
    if (/must (not contain secrets|be JSON-safe)/.test(error.message)) throw error;
    throw new Error(`${label} must be JSON-safe`, { cause: error });
  }
  if (encoded === undefined) throw new Error(`${label} must be JSON-safe`);
  return JSON.parse(encoded);
}

function rejectAbsolutePrivatePaths(value, label, ancestors = new Set()) {
  if (typeof value === 'string') {
    if (path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error(`${label} must not persist absolute private paths`);
    return;
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) return;
  const next = new Set(ancestors).add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) rejectAbsolutePrivatePaths(child, label, next);
}

function portable(value) {
  return value.replaceAll('\\', '/');
}

function validRelative(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error(`${label} must be a normalized relative path`);
  const normalized = path.posix.normalize(portable(value));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || normalized !== portable(value)) throw new Error(`${label} must be a normalized relative path`);
  return normalized;
}

function statePaths(projectDir) {
  const root = path.resolve(projectDir, '.pixel-sprite-pipeline');
  return { root, runs: path.join(root, 'runs'), lessons: path.join(root, 'lessons.jsonl'), profile: path.join(root, 'profile.yaml') };
}

function safeRunId(value) {
  const device = typeof value === 'string' ? value.split('.')[0] : '';
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
    value === '.' || value === '..' || /[. ]$/.test(value) || /[\x00-\x1f]/.test(value) ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(device)
  ) throw new Error('run ID must be Windows-safe');
  return value;
}

function defaultRunId(clock) {
  return `${clock().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')}-${crypto.randomUUID()}`;
}

async function reserve(lock) {
  await fs.mkdir(path.dirname(lock), { recursive: true });
  try {
    return await fs.open(lock, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${path.basename(lock, '.lock')} is already reserved or already exists`);
    throw error;
  }
}

async function atomicFile(file, contents, { overwrite = false } = {}) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temporary, contents, { flag: 'wx' });
    if (!overwrite) {
      try {
        await fs.link(temporary, file);
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error(`${path.basename(file)} already exists`);
        throw error;
      }
      await fs.unlink(temporary);
    } else {
      await fs.rename(temporary, file);
    }
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function normalizeInputs(projectDir, inputs) {
  if (!Array.isArray(inputs)) throw new Error('inputs must be an array');
  const root = await fs.realpath(projectDir);
  const output = [];
  const ids = new Set();
  for (const raw of inputs) {
    const item = typeof raw === 'string' ? { path: raw } : cloneJson(raw, 'input');
    if (!item || typeof item.path !== 'string') throw new Error('input path is required');
    const resolved = path.resolve(item.path);
    const parsed = path.parse(resolved);
    let current = parsed.root;
    for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`input path must not contain a symlink: ${item.id ?? path.basename(resolved)}`);
    }
    const stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('input must be a regular non-symlink file');
    const physical = await fs.realpath(resolved);
    const relative = path.relative(root, physical);
    const inside = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (!inside && !item.id) throw new Error('an external input requires a portable id');
    const id = validRelative(item.id ?? portable(relative), 'input id');
    if (ids.has(id)) throw new Error(`duplicate input id: ${id}`);
    ids.add(id);
    const provenance = cloneJson(item.provenance ?? {}, 'input provenance');
    rejectAbsolutePrivatePaths(provenance, 'input provenance');
    output.push({ id, sha256: await fileSha(physical), provenance });
  }
  return output;
}

function validateConfigClone(config) {
  const clean = cloneJson(config, 'config');
  const validated = validateConfig(clean);
  rejectAbsolutePrivatePaths(validated, 'config');
  return validated;
}

async function resolveRunArtifact(runDir, value, label) {
  const relative = validRelative(value, label);
  const root = await fs.realpath(runDir);
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file under the run directory`);
  }
  const stat = await fs.lstat(current);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file under the run directory`);
  if (stat.nlink > 1) throw new Error(`${label} must not be hard-linked`);
  const physical = await fs.realpath(current);
  const containment = path.relative(root, physical);
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error(`${label} must be physically contained under the run directory`);
  return { relative, absolute: current, stat };
}

export async function createRun({ projectDir, config, inputs = [], inspectionSnapshot, clock = () => new Date(), idFactory } = {}) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') throw new Error('projectDir is required');
  const effectiveConfig = validateConfigClone(config);
  const normalizedInputs = await normalizeInputs(projectDir, inputs);
  let inspection;
  if (inspectionSnapshot !== undefined) {
    if (normalizedInputs.length === 0) throw new Error('inspection snapshot requires a source input');
    const snapshot = cloneJson(inspectionSnapshot, 'inspection snapshot');
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !HASH.test(snapshot.sha256 ?? '')) throw new Error('inspection snapshot must contain a source sha256');
    if (!Number.isInteger(snapshot.width) || snapshot.width < 1 || !Number.isInteger(snapshot.height) || snapshot.height < 1) throw new Error('inspection snapshot dimensions must be positive integers');
    if (snapshot.sha256 !== normalizedInputs[0].sha256) throw new Error('inspection source hash does not match the immutable input');
    const rawInput = typeof inputs[0] === 'string' ? inputs[0] : inputs[0]?.path;
    const metadata = await sharp(rawInput).metadata();
    if (snapshot.width !== metadata.width || snapshot.height !== metadata.height) throw new Error('inspection dimensions do not match the immutable input');
    snapshot.path = '<source-redacted>';
    rejectAbsolutePrivatePaths(snapshot, 'inspection snapshot');
    inspection = { snapshot, sha256: sha(JSON.stringify(snapshot)) };
  }
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error('clock must return a valid Date');
  const runId = safeRunId(idFactory ? idFactory() : defaultRunId(() => now));
  const state = statePaths(projectDir);
  const runDir = path.join(state.runs, runId);
  const lock = `${runDir}.lock`;
  const handle = await reserve(lock);
  const stage = path.join(state.runs, `.${runId}.${crypto.randomUUID()}.tmp`);
  try {
    try {
      await fs.access(runDir);
      throw new Error(`run ${runId} already exists`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(stage);
    const manifest = { version: 1, runId, createdAt: now.toISOString(), config: effectiveConfig, inputs: normalizedInputs, ...(inspection ? { inspection } : {}) };
    const contents = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.writeFile(path.join(stage, 'manifest.json'), contents, { flag: 'wx' });
    await fs.rename(stage, runDir);
    return { runId, runDir, manifestPath: path.join(runDir, 'manifest.json'), manifestSha256: sha(contents) };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}

async function loadRun(projectDir, runId) {
  safeRunId(runId);
  const runDir = path.join(statePaths(projectDir).runs, runId);
  const directory = await fs.lstat(runDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('run directory must be a real immutable directory');
  const resolvedManifest = await resolveRunArtifact(runDir, 'manifest.json', 'run manifest');
  const manifestPath = resolvedManifest.absolute;
  const contents = await fs.readFile(manifestPath);
  const manifest = JSON.parse(contents);
  if (manifest.runId !== runId) throw new Error('manifest run ID does not match the run directory');
  return { runDir, manifestPath, manifest, manifestSha256: sha(contents) };
}

function reportName(version) {
  if (version === undefined || version === 1) return 'report.json';
  if (!Number.isInteger(version) || version < 2) throw new Error('report version must be an integer of 2 or greater');
  return `report-${String(version).padStart(2, '0')}.json`;
}

async function verifiedArtifactSet(validation, runDir) {
  if (!validation || !Array.isArray(validation.artifacts) || validation.artifacts.length === 0) return false;
  for (const artifact of validation.artifacts) {
    if (!artifact || !HASH.test(artifact.sha256 ?? '')) return false;
    let resolved;
    try { resolved = await resolveRunArtifact(runDir, artifact.path, 'validation artifact path'); } catch { return false; }
    if (await fileSha(resolved.absolute) !== artifact.sha256) return false;
  }
  return true;
}

async function verifiedArtifacts(validation, runDir) {
  return validation?.passed === true && verifiedArtifactSet(validation, runDir);
}

async function hasVerifiedArtifact(validation, expectedSha256, runDir) {
  if (!Array.isArray(validation?.artifacts)) return false;
  for (const artifact of validation.artifacts) {
    if (!artifact || artifact.sha256 !== expectedSha256 || typeof artifact.path !== 'string') continue;
    const resolved = await resolveRunArtifact(runDir, artifact.path, 'lesson validation artifact path').catch(() => null);
    if (resolved && await fileSha(resolved.absolute).catch(() => null) === expectedSha256) return true;
  }
  return false;
}

function lessonIdentity(lesson) {
  for (const key of ['failureCode', 'correction', 'proposedRule']) if (typeof lesson?.[key] !== 'string' || lesson[key].trim() === '') throw new Error(`lesson ${key} is required`);
  return { failureCode: lesson.failureCode, correction: lesson.correction, proposedRule: lesson.proposedRule };
}

async function backgroundCounts(file, config) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaqueBorderPixels = 0;
  let configuredColorPixels = 0;
  const color = config.background.color;
  const tolerance = config.background.tolerance;
  for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
    const offset = (y * info.width + x) * 4;
    if (data[offset + 3] > 0 && (x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1)) opaqueBorderPixels += 1;
    if (data[offset + 3] > 0 && color && Math.max(Math.abs(data[offset] - color.r), Math.abs(data[offset + 1] - color.g), Math.abs(data[offset + 2] - color.b)) <= tolerance) configuredColorPixels += 1;
  }
  return { opaqueBorderPixels, configuredColorPixels };
}

async function verifyCorrectionObjective(action, evidence, beforeFile, afterFile, config) {
  const measurements = evidence.afterValidation.measurements;
  if (action.code === 'BACKGROUND_REMAINS' && action.correction === 'rekey') {
    const before = await backgroundCounts(beforeFile, config);
    const after = await backgroundCounts(afterFile, config);
    return (before.opaqueBorderPixels > 0 || before.configuredColorPixels > 0) && after.opaqueBorderPixels === 0 && after.configuredColorPixels === 0 && measurements?.background?.opaqueBorderPixels === 0 && measurements?.background?.configuredColorPixels === 0;
  }
  if (action.code === 'CANVAS_SIZE' && action.correction === 'repad') {
    if (!['canonical', 'runtime', 'generation'].includes(action.stage)) return false;
    const expected = config[action.stage];
    const before = await sharp(beforeFile).metadata();
    const after = await sharp(afterFile).metadata();
    return Boolean(expected) && (before.width !== expected.width || before.height !== expected.height) && after.width === expected.width && after.height === expected.height;
  }
  return false;
}

function correctionTarget(value) {
  return Object.fromEntries(['code', 'frame', 'stage', 'target'].filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}

function sameCorrectionTarget(value, target) {
  return value && Object.entries(target).every(([key, expected]) => value[key] === expected);
}

async function verifyCorrectionLesson(run, lesson) {
  const runDir = run.runDir;
  const identity = lessonIdentity(lesson);
  if (!lesson.correctionManifest) throw new Error('lesson correctionManifest is required');
  const match = typeof lesson.correctionManifest.path === 'string' && /^correction-(\d{2,})\/manifest\.json$/.exec(portable(lesson.correctionManifest.path));
  if (!match) throw new Error('correctionManifest must use canonical correction-NN/manifest.json layout');
  const resolvedManifest = await resolveRunArtifact(runDir, lesson.correctionManifest.path, 'correctionManifest path');
  const manifestPath = resolvedManifest.relative;
  if (!HASH.test(lesson.correctionManifest.sha256 ?? '')) throw new Error('correctionManifest sha256 is required');
  const absolute = resolvedManifest.absolute;
  if (await fileSha(absolute) !== lesson.correctionManifest.sha256) throw new Error('correctionManifest hash does not match');
  const document = JSON.parse(await fs.readFile(absolute, 'utf8'));
  if (document.version !== 1 || !Number.isInteger(document.correctionVersion) || document.correctionVersion !== Number(match[1]) || document.run?.id !== run.manifest.runId || document.run?.manifestSha256 !== run.manifestSha256) throw new Error('correction manifest version, directory, or run binding is invalid');
  if (!Number.isInteger(lesson.actionIndex) || lesson.actionIndex < 0) throw new Error('lesson actionIndex must be a nonnegative integer');
  const action = document.actions?.[lesson.actionIndex];
  const evidence = action?.evidenceVerification;
  if (action?.code !== identity.failureCode || action?.correction !== identity.correction || action?.approved !== true || !['applied', 'deduplicated'].includes(action?.status)) throw new Error('lesson correction action is not approved evidence');
  if (evidence?.valid !== true || evidence.beforeValidation?.passed !== false || evidence.afterValidation?.passed !== true || !HASH.test(evidence.beforeSha256 ?? '') || !HASH.test(evidence.afterSha256 ?? '') || evidence.beforeSha256 === evidence.afterSha256) throw new Error('lesson requires matching before/after validation evidence and hashes');
  const beforeFailures = evidence.beforeValidation?.failures;
  const afterFailures = evidence.afterValidation?.failures;
  const target = correctionTarget(action);
  if (!sameCorrectionTarget(evidence.target, target) || !Array.isArray(beforeFailures) || !beforeFailures.some((failure) => sameCorrectionTarget(failure, target)) || !Array.isArray(afterFailures) || afterFailures.some((failure) => sameCorrectionTarget(failure, target))) throw new Error('lesson before/after validation evidence does not match the failure target');
  if (!await verifiedArtifactSet(evidence.beforeValidation, runDir) || !await verifiedArtifactSet(evidence.afterValidation, runDir) || !await hasVerifiedArtifact(evidence.beforeValidation, evidence.beforeSha256, runDir) || !await hasVerifiedArtifact(evidence.afterValidation, evidence.afterSha256, runDir)) throw new Error('lesson requires artifact-backed before/after validation evidence');
  const beforeArtifact = evidence.beforeValidation.artifacts.find((artifact) => artifact.sha256 === evidence.beforeSha256);
  const afterArtifact = evidence.afterValidation.artifacts.find((artifact) => artifact.sha256 === evidence.afterSha256);
  const beforeFile = (await resolveRunArtifact(runDir, beforeArtifact.path, 'before correction artifact')).absolute;
  const afterFile = (await resolveRunArtifact(runDir, afterArtifact.path, 'after correction artifact')).absolute;
  if (!await verifyCorrectionObjective(action, evidence, beforeFile, afterFile, run.manifest.config)) throw new Error('lesson lacks artifact-specific objective correction evidence');
  return { ...identity, correctionManifest: { path: manifestPath, sha256: lesson.correctionManifest.sha256 }, actionIndex: lesson.actionIndex, beforeSha256: evidence.beforeSha256, afterSha256: evidence.afterSha256 };
}

async function readLessonRows(file) {
  let contents;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('lessons.jsonl must be a regular non-linked state file');
    contents = await fs.readFile(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (line === '') continue;
    try {
      const row = JSON.parse(line);
      const valid = row && row.version === 1 && typeof row.runId === 'string' && typeof row.failureCode === 'string' && typeof row.correction === 'string' && typeof row.proposedRule === 'string' && row.report && row.correctionManifest;
      if (!valid) throw new Error('invalid lesson schema');
      rows.push(row);
    } catch (error) { throw new Error(`malformed lessons.jsonl row ${index + 1}`, { cause: error }); }
  }
  return rows;
}

async function appendLessons(file, rows) {
  if (rows.length === 0) return;
  const lock = `${file}.lock`;
  const handle = await reserve(lock);
  try {
    const existing = await readLessonRows(file);
    const keys = new Set(existing.map((row) => `${row.runId}:${row.report?.sha256}:${row.correctionManifest?.sha256}:${row.actionIndex}`));
    const additions = rows.filter((row) => {
      const key = `${row.runId}:${row.report.sha256}:${row.correctionManifest.sha256}:${row.actionIndex}`;
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    if (additions.length === 0) return;
    const contents = [...existing, ...additions].map((row) => JSON.stringify(row)).join('\n') + '\n';
    await atomicFile(file, contents, { overwrite: true });
  } finally {
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}

export async function recordRunResult({ projectDir, runId, report, version } = {}) {
  const run = await loadRun(projectDir, runId);
  const clean = cloneJson(report, 'report');
  rejectAbsolutePrivatePaths(clean, 'report');
  if (clean.runId !== runId) throw new Error('report run ID does not match');
  if (clean.manifestSha256 !== run.manifestSha256) throw new Error('report manifest hash does not match');
  const fileName = reportName(version);
  const reportPath = path.join(run.runDir, fileName);
  const lessons = [];
  for (const lesson of clean.lessons ?? []) lessons.push(await verifyCorrectionLesson(run, lesson));
  const contents = `${JSON.stringify(clean, null, 2)}\n`;
  const reportSha256 = sha(contents);
  const rows = lessons.map((lesson) => ({ version: 1, runId, manifestSha256: run.manifestSha256, report: { path: fileName, sha256: reportSha256 }, ...lesson }));
  let recoveredExistingReport = false;
  try {
    const existingReport = await resolveRunArtifact(run.runDir, fileName, 'existing run report');
    const existing = await fs.readFile(existingReport.absolute, 'utf8');
    if (existing !== contents) throw new Error(`${fileName} already exists with different content`);
    if (rows.length === 0) throw new Error(`${fileName} already exists`);
    recoveredExistingReport = true;
  } catch (error) {
    if (error.code === 'ENOENT') await atomicFile(reportPath, contents);
    else throw error;
  }
  await appendLessons(statePaths(projectDir).lessons, rows);
  return { reportPath, reportSha256, lessonsRecorded: rows.length, recoveredExistingReport };
}

function reportPath(runDir, version) {
  return path.join(runDir, reportName(version));
}

async function loadVerifiedReport(run, version) {
  const file = (await resolveRunArtifact(run.runDir, path.basename(reportPath(run.runDir, version)), 'run report')).absolute;
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  if (report.runId !== run.manifest.runId || report.manifestSha256 !== run.manifestSha256) throw new Error('report is not tied to the selected run manifest');
  if (!await verifiedArtifacts(report.validation, run.runDir)) throw new Error('profile promotion requires artifact-backed passing validation evidence');
  return { file, report, sha256: await fileSha(file) };
}

export async function promoteVerifiedProfile({ projectDir, runId, reportVersion } = {}) {
  const run = await loadRun(projectDir, runId);
  await loadVerifiedReport(run, reportVersion);
  const config = validateConfigClone(run.manifest.config);
  const state = statePaths(projectDir);
  const lock = `${state.profile}.lock`;
  const handle = await reserve(lock);
  try {
    await atomicFile(state.profile, YAML.stringify(config), { overwrite: true });
  } finally {
    await handle.close();
    await fs.rm(lock, { force: true });
  }
  return { profilePath: state.profile, runId };
}

async function verifyLessonRow(projectDir, row, identity) {
  if (!row || row.version !== 1 || row.failureCode !== identity.failureCode || row.correction !== identity.correction || row.proposedRule !== identity.proposedRule) return null;
  if (!HASH.test(row.manifestSha256 ?? '') || !HASH.test(row.report?.sha256 ?? '') || !HASH.test(row.correctionManifest?.sha256 ?? '') || !HASH.test(row.beforeSha256 ?? '') || !HASH.test(row.afterSha256 ?? '')) return null;
  const run = await loadRun(projectDir, row.runId).catch(() => null);
  if (!run || run.manifestSha256 !== row.manifestSha256) return null;
  const relativeReport = validRelative(row.report.path, 'lesson report path');
  const reportFile = (await resolveRunArtifact(run.runDir, relativeReport, 'lesson report').catch(() => null))?.absolute;
  if (!reportFile) return null;
  if (await fileSha(reportFile).catch(() => null) !== row.report.sha256) return null;
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  if (report.runId !== row.runId || report.manifestSha256 !== row.manifestSha256 || !await verifiedArtifacts(report.validation, run.runDir)) return null;
  const verified = await verifyCorrectionLesson(run, { ...identity, correctionManifest: row.correctionManifest, actionIndex: row.actionIndex }).catch(() => null);
  if (!verified || verified.beforeSha256 !== row.beforeSha256 || verified.afterSha256 !== row.afterSha256) return null;
  return { runId: row.runId, manifestSha256: row.manifestSha256, reportSha256: row.report.sha256, correctionManifestSha256: row.correctionManifest.sha256, beforeSha256: row.beforeSha256, afterSha256: row.afterSha256 };
}

export async function proposeSkillRule({ projectDir, lesson, config, thresholdOverride } = {}) {
  const identity = lessonIdentity(cloneJson(lesson, 'lesson'));
  const effective = validateConfigClone(config);
  const configuredThreshold = effective.correction.skillProposalEvidence;
  if (!Number.isInteger(configuredThreshold) || configuredThreshold < 1) throw new Error('correction skillProposalEvidence must be a positive integer');
  if (thresholdOverride !== undefined && (!Number.isInteger(thresholdOverride) || thresholdOverride < 1)) throw new Error('thresholdOverride must be a positive integer');
  const threshold = thresholdOverride ?? configuredThreshold;
  const rows = await readLessonRows(statePaths(projectDir).lessons);
  const byRun = new Map();
  const manifestHashes = new Set();
  let rejectedEvidenceCount = 0;
  for (const row of rows) {
    const evidence = await verifyLessonRow(projectDir, row, identity);
    const matches = row.failureCode === identity.failureCode && row.correction === identity.correction && row.proposedRule === identity.proposedRule;
    if (!evidence) {
      if (matches) rejectedEvidenceCount += 1;
      continue;
    }
    if (!byRun.has(evidence.runId) && !manifestHashes.has(evidence.manifestSha256)) {
      byRun.set(evidence.runId, evidence);
      manifestHashes.add(evidence.manifestSha256);
    }
  }
  const evidence = [...byRun.values()].sort((left, right) => left.runId.localeCompare(right.runId));
  const eligible = evidence.length >= threshold;
  const overrideText = thresholdOverride === undefined ? '' : ` A threshold override of ${thresholdOverride} was requested; the configured threshold is ${configuredThreshold}.`;
  return {
    ...identity,
    eligible,
    applied: false,
    requiresUserApproval: true,
    configuredThreshold,
    threshold,
    ...(thresholdOverride === undefined ? {} : { thresholdOverride }),
    evidenceCount: evidence.length,
    rejectedEvidenceCount,
    evidence,
    disclosure: `${evidence.length} of ${threshold} required independent verified runs are available.${rejectedEvidenceCount > 0 ? ` ${rejectedEvidenceCount} matching record(s) failed evidence verification and were not counted.` : ''}${overrideText}${eligible ? ' The rule is only a proposal and has not been applied.' : ' Evidence is insufficient.'}`
  };
}
