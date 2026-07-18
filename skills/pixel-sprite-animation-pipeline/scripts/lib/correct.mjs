import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const AUTOMATIC = new Set(['repad', 'nearest-rescale', 'rekey', 'realign', 'reexport-metadata', 'reexport-preview', 'reexport-sheet']);
const GENERATIVE = new Set(['stop-for-regeneration']);
const REVIEW = new Set(['palette-remap-review', 'timing-or-transition-review', 'stop-for-review']);
const CLEANUP_OPTIONS = Object.freeze({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

export async function removeCorrectionTree(directory, remove = fs.rm) { await remove(directory, CLEANUP_OPTIONS); }

function onlyReviewFailures(report) {
  return report?.passed === false && Array.isArray(report.failures) && report.failures.every((failure) => GENERATIVE.has(failure.correction) || REVIEW.has(failure.correction));
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateRun(run) {
  if (!run || typeof run.runDir !== 'string' || run.runDir.trim() === '') throw new Error('run runDir must be a nonempty path');
  if (!Array.isArray(run.corrections)) throw new Error('run corrections must be an array');
  if (run.generativeAttempts !== undefined) {
    const attempts = run.generativeAttempts;
    const prototype = attempts && typeof attempts === 'object' ? Object.getPrototypeOf(attempts) : null;
    if (attempts === null || typeof attempts !== 'object' || Array.isArray(attempts) || (prototype !== Object.prototype && prototype !== null)) throw new Error('run generativeAttempts must be a per-frame object');
  }
}

function equivalentKey(failure, runDir) {
  const target = failure.target ?? failure.frame ?? failure.artifact ?? failure.stage ?? null;
  const before = typeof failure.before === 'string'
    ? (path.isAbsolute(failure.before) || path.win32.isAbsolute(failure.before) ? path.resolve(failure.before) : path.resolve(runDir, failure.before))
    : null;
  return JSON.stringify({ correction: failure.correction, target, before });
}

function outputPaths(result) {
  const values = [];
  if (typeof result?.output === 'string') values.push(result.output);
  if (Array.isArray(result?.outputs)) values.push(...result.outputs);
  return values;
}

async function inputRecords(run, runDir) {
  const values = [];
  const collect = (value) => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) for (const item of value) collect(item);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item);
  };
  collect(run.inputs);
  collect(run.manifest?.inputs);
  const records = [];
  for (const value of values.filter((item) => typeof item === 'string')) {
    const resolved = path.isAbsolute(value) || path.win32.isAbsolute(value) ? path.resolve(value) : path.resolve(runDir, value);
    const stat = await fs.stat(resolved);
    records.push({ path: resolved, physical: await fs.realpath(resolved), dev: stat.dev, ino: stat.ino });
  }
  return records;
}

function generativeRemaining(failures, run, limit) {
  const remaining = {};
  for (const failure of failures) {
    if (!GENERATIVE.has(failure.correction) || failure.frame === undefined || failure.frame === null) continue;
    const used = Number.isInteger(run.generativeAttempts?.[failure.frame]) ? run.generativeAttempts[failure.frame] : 0;
    remaining[failure.frame] = Math.min(limit, Math.max(0, limit - used));
  }
  return remaining;
}

function validateRetryState(failures, attempts = {}) {
  for (const [frame, count] of Object.entries(attempts)) {
    const numeric = Number(frame);
    if (!Number.isSafeInteger(numeric) || numeric < 0 || String(numeric) !== frame) throw new Error('retry frame IDs must be canonical nonnegative integers');
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('retry counts must be nonnegative integers');
  }
  for (const failure of failures) if (GENERATIVE.has(failure.correction) && (!Number.isSafeInteger(failure.frame) || failure.frame < 0)) {
    throw new Error('generative failures require a nonnegative integer frame ID');
  }
}

function resolvedOutput(output, stagingDir) {
  return path.isAbsolute(output) || path.win32.isAbsolute(output) ? path.resolve(output) : path.resolve(stagingDir, output);
}

function failureTarget(failure) {
  return Object.fromEntries(['code', 'frame', 'stage', 'target']
    .filter((key) => failure[key] !== undefined)
    .map((key) => [key, failure[key]]));
}

function sameTarget(candidate, target) {
  return candidate && Object.entries(target).every(([key, value]) => candidate[key] === value);
}

async function digest(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

function artifactPath(value, base) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
}

function portableBasename(value) {
  return value.replaceAll('\\', '/').split('/').at(-1);
}

function jsonEqual(left, right) {
  const normalize = (value) => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
    : value;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

async function readRawImage(file, animated = false) {
  // Let Node own and close the file handle before libvips sees the image.  Passing
  // a path directly to Sharp can keep that path locked on Windows until libvips
  // releases its native image, which prevents the correction staging directory
  // from being renamed or removed even after the read has completed.
  const input = await fs.readFile(file);
  const pipeline = sharp(input, animated ? { animated: true } : undefined).ensureAlpha().raw();
  try {
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { data, info };
  } finally { pipeline.destroy(); }
}

async function readImageMetadata(file, options) {
  const input = await fs.readFile(file);
  const pipeline = sharp(input, options);
  try { return await pipeline.metadata(); }
  finally { pipeline.destroy(); }
}

async function verifyMetadataArtifact(file, expected) {
  if (!expected || typeof expected !== 'object') return false;
  let document;
  try { document = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return false; }
  const required = ['frameSize', 'canonicalPivot', 'pivot', 'durations', 'sources', 'frames', 'config'];
  if (!required.every((key) => document[key] !== undefined && expected[key] !== undefined)) return false;
  if (!Number.isInteger(document.frameSize?.width) || document.frameSize.width < 1 || !Number.isInteger(document.frameSize?.height) || document.frameSize.height < 1) return false;
  if (![document.canonicalPivot, document.pivot].every((pivot) => Number.isFinite(pivot?.x) && Number.isFinite(pivot?.y))) return false;
  if (!Array.isArray(document.frames) || !Array.isArray(document.sources) || !Array.isArray(document.durations)) return false;
  if (document.frames.length !== document.sources.length || document.frames.length !== document.durations.length) return false;
  if (document.durations.some((duration) => !Number.isInteger(duration) || duration < 11 || duration > 65535)) return false;
  if (document.sources.some((source, index) => source?.index !== index || !/^[a-f0-9]{64}$/.test(source?.sha256 ?? ''))) return false;
  if (document.frames.some((frame, index) => frame?.index !== index || frame?.duration !== document.durations[index] || frame?.width !== document.frameSize.width || frame?.height !== document.frameSize.height || typeof frame?.file !== 'string')) return false;
  if (!document.config || typeof document.config !== 'object' || Array.isArray(document.config)) return false;
  const normalizeDeliveryPaths = (value) => {
    const normalized = structuredClone(value);
    if (typeof normalized.sheet === 'string') normalized.sheet = portableBasename(normalized.sheet);
    if (typeof normalized.preview === 'string') normalized.preview = portableBasename(normalized.preview);
    if (Array.isArray(normalized.frames)) for (const frame of normalized.frames) if (typeof frame?.file === 'string') frame.file = portableBasename(frame.file);
    return normalized;
  };
  return jsonEqual(normalizeDeliveryPaths(document), normalizeDeliveryPaths(expected));
}

async function runtimeImages(expected) {
  if (!expected || !Array.isArray(expected.runtimeFrames) || expected.runtimeFrames.length === 0) return null;
  const images = [];
  for (const file of expected.runtimeFrames) {
    if (typeof file !== 'string') return null;
    images.push(await readRawImage(file));
  }
  const width = images[0].info.width;
  const height = images[0].info.height;
  if (images.some((image) => image.info.width !== width || image.info.height !== height || image.info.channels !== 4)) return null;
  if (expected.frameSize && (expected.frameSize.width !== width || expected.frameSize.height !== height)) return null;
  return { images, width, height };
}

async function verifyPreviewArtifact(file, expected, trustedMetadata) {
  try {
    const runtime = await runtimeImages(expected);
    if (!runtime || !Array.isArray(expected.durations) || expected.durations.length !== runtime.images.length) return false;
    const preview = await readRawImage(file, true);
    const metadata = await readImageMetadata(file, { animated: true });
    const pages = preview.info.pages ?? 1;
    const pageHeight = preview.info.pageHeight ?? preview.info.height / pages;
    if (pages !== runtime.images.length || preview.info.width !== runtime.width || pageHeight !== runtime.height) return false;
    if (pages === 1) {
      if (!Array.isArray(trustedMetadata?.durations) || !jsonEqual(trustedMetadata.durations, expected.durations)) return false;
    } else if (!Array.isArray(metadata.delay) || !jsonEqual(metadata.delay, expected.durations)) return false;
    const pageBytes = runtime.width * runtime.height * 4;
    for (let index = 0; index < pages; index += 1) if (!preview.data.subarray(index * pageBytes, (index + 1) * pageBytes).equals(runtime.images[index].data)) return false;
    return true;
  } catch { return false; }
}

async function verifySheetArtifact(file, expected) {
  try {
    const runtime = await runtimeImages(expected);
    if (!runtime || !Number.isInteger(expected.columns) || expected.columns < 1) return false;
    const rows = Math.ceil(runtime.images.length / expected.columns);
    const sheet = await readRawImage(file);
    if (sheet.info.width !== expected.columns * runtime.width || sheet.info.height !== rows * runtime.height) return false;
    for (let y = 0; y < sheet.info.height; y += 1) for (let x = 0; x < sheet.info.width; x += 1) {
      const cell = Math.floor(y / runtime.height) * expected.columns + Math.floor(x / runtime.width);
      const sheetOffset = (y * sheet.info.width + x) * 4;
      if (cell >= runtime.images.length) {
        if (sheet.data[sheetOffset + 3] !== 0) return false;
        continue;
      }
      const frameOffset = (((y % runtime.height) * runtime.width) + x % runtime.width) * 4;
      for (let channel = 0; channel < 4; channel += 1) if (sheet.data[sheetOffset + channel] !== runtime.images[cell].data[frameOffset + channel]) return false;
    }
    return true;
  } catch { return false; }
}

async function verifyArtifactForFailure(failure, file, run) {
  if (failure.correction === 'reexport-metadata' || String(failure.stage ?? '').startsWith('metadata')) return verifyMetadataArtifact(file, run.expected?.metadata);
  if (failure.correction === 'reexport-preview' || String(failure.stage ?? '').includes('preview')) return verifyPreviewArtifact(file, run.expected?.preview, run.expected?.metadata);
  if (failure.correction === 'reexport-sheet' || String(failure.stage ?? '').includes('sheet')) return verifySheetArtifact(file, run.expected?.sheet);
  if (['METADATA_MISMATCH', 'SOURCE_HASH_MISMATCH', 'TIMING_MISMATCH'].includes(failure.code)) return verifyMetadataArtifact(file, run.expected?.metadata);
  if (failure.code === 'FRAME_COUNT' && (failure.stage === 'metadata' || failure.correction === 'reexport-metadata')) return verifyMetadataArtifact(file, run.expected?.metadata);
  if (['FRAME_COUNT', 'PREVIEW_MISMATCH'].includes(failure.code)) return verifyPreviewArtifact(file, run.expected?.preview, run.expected?.metadata);
  if (failure.code === 'FRAME_BLEED') return verifySheetArtifact(file, run.expected?.sheet);
  return true;
}

async function verifiedArtifact(report, expectedPath, base) {
  if (!Array.isArray(report?.artifacts)) return null;
  for (const artifact of report.artifacts) {
    if (!artifact || typeof artifact.path !== 'string' || typeof artifact.sha256 !== 'string') continue;
    const resolved = artifactPath(artifact.path, base);
    if (resolved !== expectedPath) continue;
    const actual = await digest(resolved);
    if (actual === artifact.sha256) return { path: resolved, sha256: actual };
  }
  return null;
}

async function verifyRevalidation(failure, result, outputs, stagingDir, run) {
  const runDir = path.resolve(run.runDir);
  const invalid = { valid: false };
  const target = failureTarget(failure);
  const evidence = Array.isArray(result.revalidations) ? result.revalidations.find((item) => sameTarget(item?.target, target)) : null;
  if (!evidence || !Array.isArray(evidence.beforeValidation?.failures) || !Array.isArray(evidence.afterValidation?.failures)) return invalid;
  if (evidence.beforeValidation.passed !== false || (evidence.afterValidation.passed !== true && !onlyReviewFailures(evidence.afterValidation))) return invalid;
  if (!evidence.beforeValidation.failures.some((item) => sameTarget(item, target))) return invalid;
  if (evidence.afterValidation.failures.some((item) => sameTarget(item, target))) return invalid;
  if (typeof failure.before !== 'string') return invalid;
  const beforePath = artifactPath(failure.before, runDir);
  const before = await verifiedArtifact(evidence.beforeValidation, beforePath, runDir);
  if (!before) return invalid;
  const resolvedOutputs = outputs.map((output) => resolvedOutput(output, stagingDir));
  let after = null;
  for (const output of resolvedOutputs) {
    after = await verifiedArtifact(evidence.afterValidation, output, stagingDir);
    if (after) break;
  }
  if (!after) return invalid;
  if (before.sha256 === after.sha256) return invalid;
  if (!await verifyArtifactForFailure(failure, after.path, run)) return invalid;
  if (failure.code === 'CANVAS_SIZE') {
    if (!Array.isArray(failure.expected) || failure.expected.length !== 2 || !Array.isArray(failure.actual) || failure.actual.length !== 2) return invalid;
    const beforeMetadata = await readImageMetadata(before.path);
    const afterMetadata = await readImageMetadata(after.path);
    if (beforeMetadata.width !== failure.actual[0] || beforeMetadata.height !== failure.actual[1]) return invalid;
    if (afterMetadata.width !== failure.expected[0] || afterMetadata.height !== failure.expected[1]) return invalid;
  }
  const afterMeasurements = evidence.afterValidation.measurements;
  if (failure.code === 'PIVOT_DRIFT' && (failure.expected === undefined || JSON.stringify(afterMeasurements?.pivot) !== JSON.stringify(failure.expected))) return invalid;
  if (failure.code === 'BASELINE_DRIFT' && (failure.expected === undefined || afterMeasurements?.baseline !== failure.expected)) return invalid;
  if (failure.code === 'BACKGROUND_REMAINS' && (
    afterMeasurements?.background?.opaqueBorderPixels !== 0 ||
    afterMeasurements?.background?.configuredColorPixels !== 0
  )) return invalid;
  if (failure.code === 'INTERMEDIATE_COLORS' && (
    afterMeasurements?.scale?.nearestNeighbor !== true ||
    afterMeasurements?.scale?.intermediateColors !== 0
  )) return invalid;
  if (failure.code === 'NON_INTEGER_SCALE' && (
    afterMeasurements?.scale?.integer !== true ||
    afterMeasurements?.scale?.uniform !== true
  )) return invalid;
  if (failure.code === 'GLOBAL_SCALE_DRIFT' && (
    afterMeasurements?.scale?.integer !== true ||
    afterMeasurements?.scale?.uniform !== true ||
    afterMeasurements?.scale?.global !== true
  )) return invalid;
  return {
    valid: true,
    target,
    beforeSha256: before.sha256,
    afterSha256: after.sha256,
    beforeValidation: evidence.beforeValidation,
    afterValidation: evidence.afterValidation
  };
}

function translateDeep(value, stagingDir, correctionDir, artifacts, ancestors = new Set()) {
  if (typeof value === 'string') {
    const resolved = resolvedOutput(value, stagingDir);
    return artifacts.has(resolved) ? path.join(correctionDir, path.relative(stagingDir, resolved)) : value;
  }
  if (!value || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new Error('correction result must be acyclic');
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map((item) => translateDeep(item, stagingDir, correctionDir, artifacts, next));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translateDeep(item, stagingDir, correctionDir, artifacts, next)]));
}

async function assertStoredReferences(value, correctionDir, ancestors = new Set()) {
  if (typeof value === 'string') {
    const resolved = path.resolve(value);
    if (inside(correctionDir, resolved) && resolved !== correctionDir) await fs.access(resolved);
    return;
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) return;
  const next = new Set(ancestors).add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) await assertStoredReferences(item, correctionDir, next);
}

async function collectStagingArtifacts(value, stagingDir, artifacts = new Set(), ancestors = new Set()) {
  if (typeof value === 'string') {
    const resolved = resolvedOutput(value, stagingDir);
    if (!inside(stagingDir, resolved)) return artifacts;
    try {
      const stat = await fs.lstat(resolved);
      if (stat.isFile() || stat.isSymbolicLink()) artifacts.add(resolved);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error(`missing staged artifact reference: ${value}`);
    }
    return artifacts;
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) return artifacts;
  const next = new Set(ancestors).add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) await collectStagingArtifacts(item, stagingDir, artifacts, next);
  return artifacts;
}

async function nextCorrection(runDir, count) {
  let version = count + 1;
  while (true) {
    const name = `correction-${String(version).padStart(2, '0')}`;
    try {
      await fs.lstat(path.join(runDir, name));
      version += 1;
    } catch (error) {
      if (error.code === 'ENOENT') return { version, name };
      throw error;
    }
  }
}

async function correctionRunBinding(runDir) {
  const manifestPath = path.join(runDir, 'manifest.json');
  try {
    const contents = await fs.readFile(manifestPath);
    const manifest = JSON.parse(contents);
    return { id: manifest.runId ?? path.basename(runDir), manifestSha256: crypto.createHash('sha256').update(contents).digest('hex') };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { id: path.basename(runDir), manifestSha256: null };
  }
}

function durablePaths(value, runDir, ancestors = new Set()) {
  if (typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value))) {
    const relative = path.relative(runDir, value);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return relative.replaceAll('\\', '/');
    return '<external-path-redacted>';
  }
  if (!value || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new Error('correction manifest must be acyclic');
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map((item) => durablePaths(item, runDir, next));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, durablePaths(item, runDir, next)]));
}

export async function applyDeterministicCorrections({ failures, run, config, operations = {} }) {
  validateRun(run);
  if (!Array.isArray(failures)) throw new Error('failures must be an array');
  const limit = config?.correction?.generativeAttempts ?? 2;
  if (!Number.isInteger(limit) || limit < 0) throw new Error('generativeAttempts must be a nonnegative integer');
  for (const failure of failures) {
    if (!failure || typeof failure.code !== 'string' || typeof failure.correction !== 'string') throw new Error('each failure must be classified before correction');
    if (!AUTOMATIC.has(failure.correction) && !GENERATIVE.has(failure.correction) && !REVIEW.has(failure.correction)) throw new Error(`unknown correction action requires review: ${failure.correction}`);
    if (AUTOMATIC.has(failure.correction) && typeof operations[failure.correction] !== 'function') throw new Error(`missing deterministic correction operation: ${failure.correction}`);
  }
  validateRetryState(failures, run.generativeAttempts ?? {});

  const resolvedRunDir = path.resolve(run.runDir);
  const stat = await fs.stat(resolvedRunDir);
  if (!stat.isDirectory()) throw new Error('run runDir must be an existing directory');
  const inputs = await inputRecords(run, resolvedRunDir);
  const { version, name } = await nextCorrection(resolvedRunDir, run.corrections.length);
  const correctionDir = path.join(resolvedRunDir, name);
  const stagingDir = await fs.mkdtemp(path.join(resolvedRunDir, `.${name}-stage-`));
  const remaining = generativeRemaining(failures, run, limit);
  const actions = [];
  const groups = new Map();
  for (let index = 0; index < failures.length; index += 1) {
    if (!AUTOMATIC.has(failures[index].correction)) continue;
    const key = equivalentKey(failures[index], resolvedRunDir);
    const indices = groups.get(key) ?? [];
    indices.push(index);
    groups.set(key, indices);
  }
  const executions = new Map();

  try {
    for (let index = 0; index < failures.length; index += 1) {
      const failure = failures[index];
      if (GENERATIVE.has(failure.correction)) {
        const attempts = failure.frame === undefined || failure.frame === null ? limit : remaining[failure.frame];
        actions.push({ ...failure, status: 'blocked', requires: attempts > 0 ? 'generative-retry' : 'generative-retry-exhausted', generativeAttemptsRemaining: attempts });
        continue;
      }
      if (REVIEW.has(failure.correction)) {
        actions.push({ ...failure, status: 'blocked', requires: 'user-review' });
        continue;
      }
      const key = equivalentKey(failure, resolvedRunDir);
      if (executions.has(key)) {
        const execution = executions.get(key);
        const evidenceVerification = execution.verifications.get(index) ?? { valid: false };
        const approved = execution.batchApproved && evidenceVerification.valid;
        actions.push({
          ...failure,
          status: approved ? 'deduplicated' : 'unapproved-shared',
          approved,
          improved: approved,
          duplicateOf: execution.primaryIndex,
          sharedExecution: execution.executionId,
          evidenceVerification: translateDeep(evidenceVerification, stagingDir, correctionDir, execution.artifacts),
          before: failure.before ?? null,
          after: execution.translatedResult.output ?? execution.translatedResult.outputs ?? null,
          outputDir: correctionDir,
          result: execution.translatedResult
        });
        continue;
      }
      const executionId = `execution-${String(index).padStart(3, '0')}`;
      const groupIndices = groups.get(key);
      const sharedFailures = groupIndices.map((groupIndex) => failures[groupIndex]);
      const result = await operations[failure.correction]({ failure, failures: sharedFailures, outputDir: stagingDir, correctionVersion: version });
      if (!result || typeof result !== 'object') throw new Error(`deterministic correction ${failure.correction} must return a result`);
      const outputs = outputPaths(result);
      const artifacts = await collectStagingArtifacts(result, stagingDir);
      for (const output of outputs) artifacts.add(resolvedOutput(output, stagingDir));
      for (const resolved of artifacts) {
        if (!inside(stagingDir, resolved)) throw new Error(`correction output is outside correction directory: ${resolved}`);
        const outputStat = await fs.lstat(resolved);
        if (outputStat.isSymbolicLink()) throw new Error(`correction outputs must not be symbolic links: ${resolved}`);
        const physical = await fs.realpath(resolved);
        if (!inside(await fs.realpath(stagingDir), physical)) throw new Error(`correction output is outside correction directory: ${resolved}`);
        if (inputs.some((input) => input.path === resolved || input.physical === physical || (input.dev === outputStat.dev && input.ino === outputStat.ino))) throw new Error(`correction output is the same file as an input: ${resolved}`);
      }
      if (failure.correction !== 'reexport-metadata') {
        if (outputs.length === 0) throw new Error(`deterministic correction ${failure.correction} must produce a valid image`);
        for (const output of outputs) {
          try {
            const metadata = await readImageMetadata(resolvedOutput(output, stagingDir));
            if (!metadata.width || !metadata.height) throw new Error('missing image dimensions');
          } catch (error) {
            throw new Error(`correction output must be a valid image: ${output}`, { cause: error });
          }
        }
      }
      const verifications = new Map();
      for (const groupIndex of groupIndices) verifications.set(groupIndex, await verifyRevalidation(failures[groupIndex], result, outputs, stagingDir, run));
      const translatedResult = translateDeep(result, stagingDir, correctionDir, artifacts);
      const evidenceVerification = verifications.get(index);
      const approved = result.validationPassed === true && result.improved === true && evidenceVerification.valid;
      executions.set(key, { executionId, primaryIndex: index, verifications, translatedResult, artifacts, batchApproved: result.validationPassed === true && result.improved === true });
      actions.push({
        ...failure,
        status: approved ? 'applied' : 'unapproved',
        approved,
        executionId,
        evidenceVerification: translateDeep(evidenceVerification, stagingDir, correctionDir, artifacts),
        before: failure.before ?? result.before ?? null,
        after: translatedResult.output ?? translatedResult.outputs ?? result.after ?? null,
        improved: result.improved === true && evidenceVerification.valid,
        outputDir: correctionDir,
        result: translatedResult
      });
    }
    const manifest = {
      version: 1,
      correctionVersion: version,
      run: await correctionRunBinding(resolvedRunDir),
      createdAt: new Date().toISOString(),
      actions: durablePaths(actions, resolvedRunDir),
      generativeAttemptsRemaining: remaining
    };
    await fs.writeFile(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(stagingDir, correctionDir);
    await assertStoredReferences(actions, correctionDir);
    return { correctionDir, actions, generativeAttemptsRemaining: remaining, manifest: path.join(correctionDir, 'manifest.json') };
  } catch (error) {
    const cleanup = await Promise.allSettled([removeCorrectionTree(stagingDir), removeCorrectionTree(correctionDir)]);
    const cleanupFailures = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (cleanupFailures.length > 0) throw new AggregateError([error, ...cleanupFailures], 'correction failed and cleanup did not complete');
    throw error;
  }
}
