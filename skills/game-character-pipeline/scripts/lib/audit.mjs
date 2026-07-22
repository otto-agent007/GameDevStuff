import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { writeImmutableJson, writeRevision } from './artifacts.mjs';
import { exactObject, portableRelativePath, sha256File, sha256Value } from './schema.mjs';

const HASH = /^[a-f0-9]{64}$/;
const PROVENANCE_KEYS = new Set(['animationContractSha256', 'selectionApprovalSha256', 'frameApprovalSha256', 'snapReceiptSha256']);

function failure(failures, code, details = {}) {
  failures.push({ code, ...details });
}

function same(left, right) {
  if (left === undefined || right === undefined) return left === right;
  try { return sha256Value(left) === sha256Value(right); }
  catch { return Object.is(left, right); }
}

function deterministicValue(value) {
  if (Array.isArray(value)) return value.map(deterministicValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !PROVENANCE_KEYS.has(key))
      .map(([key, item]) => [key, deterministicValue(item)]));
  }
  return value;
}

async function containedFile(root, relative, label) {
  portableRelativePath(relative, `${label} path`);
  const physicalRoot = await fs.realpath(root);
  let selected = physicalRoot;
  for (const component of relative.split('/')) {
    selected = path.join(selected, component);
    if ((await fs.lstat(selected)).isSymbolicLink()) throw new Error(`${label} path contains a symlink`);
  }
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a regular single-link file`);
  const physical = await fs.realpath(selected);
  const containment = path.relative(physicalRoot, physical);
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error(`${label} escaped its root`);
  return physical;
}

async function readCanonical(file, root, label) {
  const physicalRoot = await fs.realpath(root);
  const selected = path.resolve(file);
  const relative = path.relative(physicalRoot, selected);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escaped the run root`);
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a regular single-link file`);
  const document = JSON.parse(await fs.readFile(selected, 'utf8'));
  if (await sha256File(selected) !== sha256Value(document)) throw new Error(`${label} must be canonical immutable JSON`);
  return { path: selected, document, sha256: await sha256File(selected) };
}

async function verifyIntegerBlocks(file, canvas, scale) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== canvas.width * scale || info.height !== canvas.height * scale || info.channels !== 4) return false;
  for (let sourceY = 0; sourceY < canvas.height; sourceY += 1) for (let sourceX = 0; sourceX < canvas.width; sourceX += 1) {
    const origin = ((sourceY * scale) * info.width + sourceX * scale) * 4;
    for (let y = 0; y < scale; y += 1) for (let x = 0; x < scale; x += 1) {
      const offset = (((sourceY * scale) + y) * info.width + (sourceX * scale) + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) if (data[offset + channel] !== data[origin + channel]) return false;
    }
  }
  return true;
}

function artifactReferences(index) {
  const references = [];
  for (const clip of index.clips ?? []) {
    for (const frame of clip.frames ?? []) {
      for (const output of frame.outputs ?? []) references.push({ label: `${frame.id}/${output.trackId}`, record: output, pixels: true });
      references.push({ label: `${frame.id}/combined`, record: frame.combined, pixels: true });
    }
    for (const [name, record] of [['sheet', clip.sheet], ['contactSheet', clip.contactSheet], ['metadata', clip.metadata], ['preview', clip.preview]]) {
      references.push({ label: `${clip.id}/${name}`, record, pixels: false });
    }
  }
  return references;
}

async function inspectEngineIndex({ index, exportRoot, enginePrefix, artifactHashes, project, manifest, failures }) {
  if (index?.version !== 2 || !index.animationContract || !Array.isArray(index.clips)) {
    failure(failures, 'METADATA_MISMATCH', { field: 'engineIndex' });
    return;
  }
  const contract = index.animationContract;
  if (
    index.selectionApprovalSha256 !== manifest.selectionApprovalSha256 ||
    index.snapReceiptSha256 !== manifest.snapReceiptSha256 ||
    index.frameApprovalSha256 !== manifest.frameApprovalSha256
  ) failure(failures, 'PROVENANCE_MISMATCH', { field: 'engineIndex' });
  if (index.character?.id !== project.document?.id || !same(index.canvas, contract.canvas) || !same(index.scale, contract.scale)) failure(failures, 'METADATA_MISMATCH', { field: 'projectGeometry' });
  if (!same(index.canvas, project.document?.canvas) || !same(index.scale, project.document?.scale)) failure(failures, 'METADATA_MISMATCH', { field: 'initializedProjectGeometry' });
  if (!Number.isInteger(contract.scale?.integer) || contract.scale.integer < 1 || contract.scale.runtime?.width !== contract.canvas?.width * contract.scale.integer || contract.scale.runtime?.height !== contract.canvas?.height * contract.scale.integer) failure(failures, 'NON_INTEGER_SCALE');
  if (index.clips.length !== contract.clips?.length) failure(failures, 'FRAME_COUNT', { field: 'clips' });
  const tracks = new Map((contract.tracks ?? []).map((track) => [track.id, track]));
  for (const [clipIndex, clip] of index.clips.entries()) {
    const definition = contract.clips?.[clipIndex];
    if (!definition || clip.id !== definition.id || clip.loopMode !== definition.loopMode) { failure(failures, 'METADATA_MISMATCH', { field: 'clip', clip: clip.id }); continue; }
    const restart = definition.loopMode === 'loop' ? 'loop' : 'stop';
    if (clip.restart !== restart) failure(failures, 'NONCYCLIC_RESTART', { clip: clip.id });
    if (!Array.isArray(clip.frames) || clip.frames.length !== definition.frames.length) { failure(failures, 'FRAME_COUNT', { clip: clip.id }); continue; }
    for (const [frameIndex, frame] of clip.frames.entries()) {
      const expected = definition.frames[frameIndex];
      if (!expected || frame.id !== expected.id || !Number.isInteger(frame.duration) || frame.duration < 11 || frame.duration !== expected.duration) failure(failures, 'TIMING_MISMATCH', { frame: frame.id });
      if (!same(frame.root, contract.canvas.pivot) || frame.baseline !== contract.canvas.baseline) failure(failures, 'LANDMARK_DRIFT', { frame: frame.id });
      if (!same(frame.tracks, expected.tracks) || !same(frame.groundTravel, expected.groundTravel)) failure(failures, 'METADATA_MISMATCH', { frame: frame.id });
      if ((frame.groundTravel?.x !== 0 || frame.groundTravel?.y !== 0) && Object.keys(frame.contacts ?? {}).length === 0) failure(failures, 'GROUND_TRAVEL_CONTACT', { frame: frame.id });
      for (const output of frame.outputs ?? []) {
        const track = tracks.get(output.trackId);
        if (!track || output.kind !== track.kind || output.attachTo !== track.attachTo || (track.attachTo !== null && !expected.sockets.includes(track.attachTo))) failure(failures, 'SOCKET_ATTACHMENT', { frame: frame.id, track: output.trackId });
      }
    }
  }
  for (const { label, record, pixels } of artifactReferences(index)) {
    const publishedPath = record?.file && enginePrefix !== '.' ? `${enginePrefix}/${record.file}` : record?.file;
    if (!record || typeof record.file !== 'string' || !HASH.test(record.sha256 ?? '') || artifactHashes.get(publishedPath) !== record.sha256) {
      failure(failures, 'ARTIFACT_SET_MISMATCH', { artifact: label });
      continue;
    }
    if (pixels) {
      try {
        const file = await containedFile(exportRoot, publishedPath, 'runtime artifact');
        if (!await verifyIntegerBlocks(file, contract.canvas, contract.scale.integer)) failure(failures, 'INTERPOLATION_DETECTED', { artifact: label });
      } catch (error) {
        failure(failures, 'ARTIFACT_READ_FAILURE', { artifact: label, reason: error.message });
      }
    }
  }
}

export async function auditRun({ run, project, expected }) {
  const failures = [];
  const reviews = [];
  const evidence = [];
  const deterministicHashes = {};
  let publishedValidation;
  const envelope = structuredClone(expected?.envelope ?? { runId: run?.id, createdAt: run?.document?.createdAt });
  if (!run?.id || !run?.root || !project?.sha256 || !expected?.exportManifest) throw new Error('audit requires an immutable run, project, and expected export manifest');
  if (run.document?.projectSha256 !== project.sha256) failure(failures, 'PROJECT_BINDING_MISMATCH');
  for (const artifact of expected.deterministicArtifacts ?? []) {
    try {
      exactObject(artifact, ['id', 'path', 'sha256'], 'audit deterministic artifact');
      if (typeof artifact.id !== 'string' || artifact.id === '' || !HASH.test(artifact.sha256)) throw new Error('deterministic artifact identity is invalid');
      const file = await containedFile(run.root, artifact.path, 'deterministic artifact');
      const actual = await sha256File(file);
      deterministicHashes[artifact.id] = actual;
      evidence.push({ kind: 'run-artifact', path: artifact.path, sha256: actual });
      if (actual !== artifact.sha256) failure(failures, 'BROKEN_ARTIFACT_HASH', { artifact: artifact.id });
    } catch (error) {
      failure(failures, 'ARTIFACT_READ_FAILURE', { artifact: artifact?.id ?? null, reason: error.message });
    }
  }
  try {
    const loaded = await readCanonical(expected.exportManifest, run.root, 'export manifest');
    const manifest = loaded.document;
    exactObject(manifest, ['schemaVersion', 'kind', 'revision', 'runId', 'runSha256', 'projectSha256', 'sourceSha256', 'editSha256', 'selectionApprovalSha256', 'snapReceiptSha256', 'frameApprovalSha256', 'artifacts'], 'export manifest');
    if (manifest.schemaVersion !== 1 || manifest.kind !== 'pixel-production-export' || manifest.runId !== run.id || manifest.runSha256 !== run.sha256 || manifest.projectSha256 !== project.sha256) failure(failures, 'EXPORT_BINDING_MISMATCH');
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) failure(failures, 'ARTIFACT_SET_MISMATCH');
    const exportRoot = path.dirname(loaded.path);
    const artifactHashes = new Map();
    let engineIndex;
    let enginePath;
    for (const artifact of manifest.artifacts ?? []) {
      try {
        exactObject(artifact, ['path', 'sha256'], 'export artifact');
        if (!HASH.test(artifact.sha256)) throw new Error('artifact hash is invalid');
        const file = await containedFile(exportRoot, artifact.path, 'export artifact');
        const actual = await sha256File(file);
        artifactHashes.set(artifact.path, actual);
        evidence.push({ kind: 'artifact', path: artifact.path, sha256: actual });
        if (actual !== artifact.sha256) failure(failures, 'BROKEN_ARTIFACT_HASH', { artifact: artifact.path });
        if (artifact.path === 'animation-contract-export.json' || artifact.path.endsWith('/animation-contract-export.json')) {
          engineIndex = JSON.parse(await fs.readFile(file, 'utf8'));
          enginePath = artifact.path;
        }
        else if (artifact.path === 'validation-report.json') publishedValidation = JSON.parse(await fs.readFile(file, 'utf8'));
        else deterministicHashes[`export/${artifact.path}`] = actual;
      } catch (error) {
        failure(failures, 'ARTIFACT_READ_FAILURE', { artifact: artifact?.path ?? null, reason: error.message });
      }
    }
    if (!engineIndex) failure(failures, 'METADATA_MISMATCH', { field: 'animation-contract-export.json' });
    else {
      deterministicHashes['export/animation-contract-export.semantic.json'] = sha256Value(deterministicValue(engineIndex));
      await inspectEngineIndex({ index: engineIndex, exportRoot, enginePrefix: path.posix.dirname(enginePath), artifactHashes, project, manifest, failures });
    }
  } catch (error) {
    failure(failures, 'EXPORT_MANIFEST_INVALID', { reason: error.message });
  }
  const validation = publishedValidation;
  if (!validation || typeof validation !== 'object' || !Array.isArray(validation.failures) || !Array.isArray(validation.warnings)) failure(failures, 'MISSING_VALIDATION_REPORT');
  else {
    if (!same(validation, expected.validationReport)) failure(failures, 'VALIDATION_REPORT_BINDING_MISMATCH');
    deterministicHashes['reports/objective-validation.semantic.json'] = sha256Value(deterministicValue(validation));
    for (const item of validation.failures) failure(failures, item.code ?? 'OBJECTIVE_VALIDATION_FAILURE', { source: 'pixel-validation' });
    for (const warning of validation.warnings) reviews.push(structuredClone(warning));
    if (validation.passed !== true && validation.failures.length === 0) failure(failures, 'OBJECTIVE_VALIDATION_FAILURE');
  }
  return {
    passed: failures.length === 0,
    deterministicHashes: Object.fromEntries(Object.entries(deterministicHashes).sort(([left], [right]) => left.localeCompare(right))),
    evidence,
    failures,
    reviews,
    envelope
  };
}

export function compareRuns(left, right) {
  const leftHashes = left?.deterministicHashes ?? {};
  const rightHashes = right?.deterministicHashes ?? {};
  const changedDeterministicArtifacts = [...new Set([...Object.keys(leftHashes), ...Object.keys(rightHashes)])].sort().flatMap((artifact) => {
    const leftSha256 = leftHashes[artifact] ?? null;
    const rightSha256 = rightHashes[artifact] ?? null;
    return leftSha256 === rightSha256 ? [] : [{ artifact, leftSha256, rightSha256 }];
  });
  const leftEnvelope = left?.envelope ?? {};
  const rightEnvelope = right?.envelope ?? {};
  const envelopeDifferences = [...new Set([...Object.keys(leftEnvelope), ...Object.keys(rightEnvelope)])].sort().flatMap((field) => same(leftEnvelope[field], rightEnvelope[field]) ? [] : [{ field, left: leftEnvelope[field] ?? null, right: rightEnvelope[field] ?? null }]);
  return { passed: left?.passed === true && right?.passed === true && changedDeterministicArtifacts.length === 0, changedDeterministicArtifacts, envelopeDifferences };
}

function revisionNumber(value) {
  if (!Number.isInteger(value) || value < 1 || value > 9999) throw new Error('audit export revision must be an integer from 1 to 9999');
  return value;
}

export async function recordProductionValidation({ run, exportRevision, exportManifestSha256, validationReport }) {
  revisionNumber(exportRevision);
  if (!run?.id || !run?.root || !HASH.test(exportManifestSha256 ?? '') || !validationReport || typeof validationReport !== 'object') throw new Error('production validation record requires a run, export manifest, and report');
  const document = {
    schemaVersion: 1,
    kind: 'pixel-production-validation',
    runId: run.id,
    exportRevision,
    exportManifestSha256,
    report: structuredClone(validationReport)
  };
  return writeImmutableJson({
    root: run.root,
    relative: `reports/production-validation-${String(exportRevision).padStart(4, '0')}.json`,
    value: document,
    reuse: true
  });
}

async function selectedRevision(run, requested) {
  const entries = await fs.readdir(path.join(run.root, 'exports'));
  const revisions = entries.filter((name) => /^revision-\d{4}$/.test(name)).map((name) => Number(name.slice(-4))).sort((left, right) => left - right);
  if (revisions.length === 0) throw new Error('run has no published export revisions');
  const revision = requested === undefined ? revisions.at(-1) : revisionNumber(requested);
  if (!revisions.includes(revision)) throw new Error(`export revision ${revision} does not exist`);
  return revision;
}

export async function loadAuditExpected({ run, revision }) {
  const selected = await selectedRevision(run, revision);
  const exportManifest = path.join(run.root, 'exports', `revision-${String(selected).padStart(4, '0')}`, 'manifest.json');
  const manifest = await readCanonical(exportManifest, run.root, 'export manifest');
  const validationFile = path.join(run.root, 'reports', `production-validation-${String(selected).padStart(4, '0')}.json`);
  const validation = await readCanonical(validationFile, run.root, 'production validation report');
  exactObject(validation.document, ['schemaVersion', 'kind', 'runId', 'exportRevision', 'exportManifestSha256', 'report'], 'production validation report');
  if (
    validation.document.schemaVersion !== 1 ||
    validation.document.kind !== 'pixel-production-validation' ||
    validation.document.runId !== run.id ||
    validation.document.exportRevision !== selected ||
    validation.document.exportManifestSha256 !== manifest.sha256
  ) throw new Error('production validation report binding mismatch');
  const approvalFiles = (await fs.readdir(path.join(run.root, 'approved'))).filter((name) => /^selection-approval-\d{4}\.json$/.test(name));
  const source = await readCanonical(path.join(run.root, 'reports', 'source.json'), run.root, 'motion source report');
  let approval;
  for (const name of approvalFiles) {
    const file = path.join(run.root, 'approved', name);
    if (await sha256File(file) === manifest.document.selectionApprovalSha256) {
      approval = JSON.parse(await fs.readFile(file, 'utf8'));
      break;
    }
  }
  if (!approval) throw new Error('published export selection approval is unavailable');
  const deterministicArtifacts = [];
  for (const frame of source.document.frames ?? []) deterministicArtifacts.push({ id: `decoded/${frame.id}`, path: frame.path, sha256: frame.sha256 });
  for (const derivative of approval.derivatives ?? []) deterministicArtifacts.push({ id: `edit/${derivative.frameId}`, path: derivative.path, sha256: derivative.sha256 });
  for (const [id, record] of [['edit/contact-sheet', approval.contactSheet], ['edit/rendered-manifest', approval.renderedManifest], ['edit/rendered-review', approval.renderedReview]]) {
    if (record) deterministicArtifacts.push({ id, path: record.path, sha256: record.sha256 });
  }
  return {
    exportManifest,
    validationReport: validation.document.report,
    deterministicArtifacts,
    envelope: { runId: run.id, createdAt: run.document.createdAt, approvedBy: approval.approver, approvedAt: approval.decidedAt }
  };
}

export async function recordAuditReport({ run, kind, value }) {
  if (kind !== 'validation-audit' && kind !== 'reproducibility-audit') throw new Error('audit report kind is invalid');
  return writeRevision({
    root: run.root,
    area: 'reports',
    stem: kind,
    value: { schemaVersion: 1, kind, runId: run.id, ...structuredClone(value) }
  });
}
