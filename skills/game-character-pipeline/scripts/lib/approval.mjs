import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { writeImmutableBytes, writeImmutableJson, writeRevision } from './artifacts.mjs';
import { renderEditRevision, validateEditManifest } from './edits.mjs';
import { deepFreeze, exactObject, isoDate, portableId, portableRelativePath, sha256File, sha256Value } from './schema.mjs';

const HASH = /^[a-f0-9]{64}$/;

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} must be a sha256`);
  return value;
}

function projectContext(project) {
  const document = project?.document ?? project;
  if (!document || typeof document !== 'object') throw new Error('approval requires a project contract');
  return { document, sha256: project?.sha256 ?? sha256Value(document) };
}

function contained(root, target, label) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escaped the run root`);
}

async function readCanonicalJson(file, runRoot, label) {
  const root = await fs.realpath(runRoot);
  const selected = path.resolve(file);
  contained(root, selected, label);
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a regular single-link file`);
  const physical = await fs.realpath(selected);
  contained(root, physical, label);
  const document = JSON.parse(await fs.readFile(physical, 'utf8'));
  const sha256 = await sha256File(physical);
  if (sha256 !== sha256Value(document)) throw new Error(`${label} must use canonical immutable JSON`);
  return { document, path: physical, sha256 };
}

async function readVerifiedArtifact(runRoot, relative, expectedSha256, label) {
  portableRelativePath(relative, `${label} path`);
  hash(expectedSha256, `${label} hash`);
  const root = await fs.realpath(runRoot);
  const selected = path.join(root, ...relative.split('/'));
  contained(root, selected, label);
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a regular single-link file`);
  const physical = await fs.realpath(selected);
  contained(root, physical, label);
  if (await sha256File(physical) !== expectedSha256) throw new Error(`${label} hash mismatch`);
  return physical;
}

export async function loadSourceReport(run) {
  return readCanonicalJson(path.join(run.root, 'reports', 'source.json'), run.root, 'motion source report');
}

export async function loadEditRevision({ run, sourceSha256, revision }) {
  if (!Number.isInteger(revision) || revision < 1 || revision > 999999) throw new Error('edit revision must be a positive integer');
  const rootSha256 = sha256Value({ schemaVersion: 1, kind: 'studio-edit-root', runId: run.id, stage: 'selection', sourceSha256 });
  let previousSha256 = rootSha256;
  let selected;
  for (let current = 1; current <= revision; current += 1) {
    const file = path.join(run.root, 'edits', `studio-edit-${String(current).padStart(4, '0')}.json`);
    const loaded = await readCanonicalJson(file, run.root, 'studio edit revision');
    exactObject(loaded.document, ['schemaVersion', 'kind', 'runId', 'stage', 'sourceSha256', 'previousSha256', 'edit'], 'studio edit revision');
    if (
      loaded.document.schemaVersion !== 1 ||
      loaded.document.kind !== 'studio-edit' ||
      loaded.document.runId !== run.id ||
      loaded.document.stage !== 'selection' ||
      loaded.document.sourceSha256 !== sourceSha256 ||
      loaded.document.previousSha256 !== previousSha256
    ) throw new Error('studio edit revision chain is invalid');
    previousSha256 = loaded.sha256;
    selected = { revision: current, revisionSha256: loaded.sha256, edit: loaded.document.edit, path: loaded.path };
  }
  return selected;
}

async function createContactSheet({ run, rendered, canvas }) {
  const columns = Math.min(4, Math.max(1, rendered.frames.length));
  const rows = Math.ceil(rendered.frames.length / columns);
  const padding = 2;
  const width = columns * canvas.width + (columns + 1) * padding;
  const height = rows * canvas.height + (rows + 1) * padding;
  const inputs = [];
  for (const [index, frame] of rendered.frames.entries()) {
    inputs.push({
      input: await fs.readFile(path.join(run.root, ...frame.path.split('/'))),
      left: padding + (index % columns) * (canvas.width + padding),
      top: padding + Math.floor(index / columns) * (canvas.height + padding)
    });
  }
  const bytes = await sharp({
    create: { width, height, channels: 4, background: { r: 17, g: 25, b: 29, alpha: 1 } }
  }).composite(inputs).png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
  const relative = `work/revisions/${rendered.editSha256}/contact-sheet.png`;
  return writeImmutableBytes({ root: run.root, relative, bytes, reuse: true });
}

export async function renderReviewRevision({ run, project, editRevision, allowGlobalTransform = false }) {
  const sourceRecord = await loadSourceReport(run);
  const sourceSha256 = sourceRecord.sha256;
  const revision = await loadEditRevision({ run, sourceSha256, revision: editRevision });
  const edit = validateEditManifest(revision.edit, { project, source: sourceRecord.document, allowGlobalTransform });
  const rendered = await renderEditRevision({ run, project, source: sourceRecord.document, edit, allowGlobalTransform });
  if (rendered.frames.length === 0) throw new Error('approval render requires at least one included frame');
  const contactSheet = await createContactSheet({ run, rendered, canvas: sourceRecord.document.canvas });
  const review = {
    schemaVersion: 1,
    kind: 'rendered-edit-review',
    editRevision,
    editRevisionSha256: revision.revisionSha256,
    editSha256: rendered.editSha256,
    sourceSha256,
    renderedManifest: { path: rendered.path, sha256: rendered.sha256 },
    contactSheet: { path: contactSheet.relative, sha256: contactSheet.sha256 },
    frames: rendered.frames.map(({ frameId, path: framePath, sha256, durationMs }) => ({ frameId, path: framePath, sha256, durationMs }))
  };
  const written = await writeImmutableJson({
    root: run.root,
    relative: `work/revisions/${rendered.editSha256}/review.json`,
    value: review,
    reuse: true
  });
  return deepFreeze({ ...review, path: written.relative, sha256: written.sha256, edit });
}

function validateDecision({ project, approver, decision, notes }) {
  portableId(approver, 'approval identity');
  if (!project.approvals.identities.includes(approver)) throw new Error('approver must be a configured approval identity');
  if (decision !== 'approved' && decision !== 'rejected') throw new Error('approval decision must be approved or rejected');
  if (typeof notes !== 'string' || notes.length > 4096) throw new Error('approval notes must be a string of at most 4096 characters');
  if (decision === 'rejected' && notes.trim() === '') throw new Error('rejection notes are required');
}

export async function writeApproval({
  run,
  project,
  editRevision,
  approver,
  decision,
  notes = '',
  allowGlobalTransform = false,
  clock = () => new Date()
}) {
  if (!run?.root || !run?.id) throw new Error('approval requires an immutable run');
  const projectRecord = projectContext(project);
  validateDecision({ project: projectRecord.document, approver, decision, notes });
  const decided = clock();
  if (!(decided instanceof Date) || Number.isNaN(decided.valueOf())) throw new Error('approval clock must return a valid Date');
  const decidedAt = isoDate(decided.toISOString(), 'approval decidedAt');
  const rendered = await renderReviewRevision({ run, project, editRevision, allowGlobalTransform });
  const source = (await loadSourceReport(run)).document;
  const sourceById = new Map(source.frames.map((frame) => [frame.id, frame]));
  const document = {
    schemaVersion: 1,
    kind: 'selection-approval',
    runId: run.id,
    projectSha256: projectRecord.sha256,
    sourceSha256: rendered.sourceSha256,
    editRevision,
    editRevisionSha256: rendered.editRevisionSha256,
    editSha256: rendered.editSha256,
    renderedReview: { path: rendered.path, sha256: rendered.sha256 },
    renderedManifest: rendered.renderedManifest,
    selectedFrames: rendered.frames.map((frame) => ({
      frameId: frame.frameId,
      sourceFrameSha256: sourceById.get(frame.frameId).sha256,
      derivativeSha256: frame.sha256,
      durationMs: frame.durationMs
    })),
    derivatives: rendered.frames.map(({ frameId, path: framePath, sha256 }) => ({ frameId, path: framePath, sha256 })),
    contactSheet: rendered.contactSheet,
    approver,
    decision,
    notes,
    decidedAt
  };
  const written = await writeRevision({ root: run.root, area: 'approved', stem: 'selection-approval', value: document });
  return deepFreeze({
    path: written.path,
    relative: written.relative,
    sha256: written.sha256,
    revision: written.revision,
    document,
    derivatives: document.derivatives.map((derivative) => ({ ...derivative, path: path.join(run.root, ...derivative.path.split('/')) })),
    contactSheet: { ...document.contactSheet, path: path.join(run.root, ...document.contactSheet.path.split('/')) }
  });
}

function validateApprovalShape(document) {
  exactObject(
    document,
    ['schemaVersion', 'kind', 'runId', 'projectSha256', 'sourceSha256', 'editRevision', 'editRevisionSha256', 'editSha256', 'renderedReview', 'renderedManifest', 'selectedFrames', 'derivatives', 'contactSheet', 'approver', 'decision', 'notes', 'decidedAt'],
    'selection approval'
  );
  if (document.schemaVersion !== 1 || document.kind !== 'selection-approval') throw new Error('selection approval identity is invalid');
  if (!Number.isInteger(document.editRevision) || document.editRevision < 1) throw new Error('selection approval edit revision is invalid');
  for (const [label, record] of [
    ['rendered review', document.renderedReview],
    ['rendered manifest', document.renderedManifest],
    ['contact sheet', document.contactSheet]
  ]) {
    exactObject(record, ['path', 'sha256'], `selection approval ${label}`);
    portableRelativePath(record.path, `selection approval ${label} path`);
    hash(record.sha256, `selection approval ${label} hash`);
  }
  if (!Array.isArray(document.selectedFrames) || document.selectedFrames.length === 0) throw new Error('selection approval selected frames must not be empty');
  for (const selected of document.selectedFrames) {
    exactObject(selected, ['frameId', 'sourceFrameSha256', 'derivativeSha256', 'durationMs'], 'selection approval selected frame');
    portableId(selected.frameId, 'selection approval selected frame ID');
    hash(selected.sourceFrameSha256, 'selection approval source frame hash');
    hash(selected.derivativeSha256, 'selection approval derivative hash');
    if (!Number.isInteger(selected.durationMs) || selected.durationMs < 1 || selected.durationMs > 65535) throw new Error('selection approval frame duration is invalid');
  }
  if (!Array.isArray(document.derivatives) || document.derivatives.length === 0) throw new Error('selection approval derivatives must not be empty');
  for (const derivative of document.derivatives) {
    exactObject(derivative, ['frameId', 'path', 'sha256'], 'selection approval derivative');
    portableId(derivative.frameId, 'selection approval derivative frame ID');
    portableRelativePath(derivative.path, 'selection approval derivative path');
    hash(derivative.sha256, 'selection approval derivative hash');
  }
  return document;
}

export async function verifyApproval({ run, file, project, source, edit }) {
  if (!run?.root || !run?.id) throw new Error('approval verification requires an immutable run');
  const loaded = await readCanonicalJson(path.resolve(file), run.root, 'selection approval');
  const document = validateApprovalShape(loaded.document);
  const projectRecord = projectContext(project);
  if (document.runId !== run.id) throw new Error('approval run mismatch');
  if (document.projectSha256 !== projectRecord.sha256) throw new Error('approval project hash mismatch');
  const sourceDocument = source ?? (await loadSourceReport(run)).document;
  if (document.sourceSha256 !== sha256Value(sourceDocument)) throw new Error('approval source hash mismatch');
  if (document.editSha256 !== sha256Value(edit)) throw new Error('approval edit hash mismatch');
  const revision = await loadEditRevision({ run, sourceSha256: document.sourceSha256, revision: document.editRevision });
  if (revision.revisionSha256 !== document.editRevisionSha256 || sha256Value(revision.edit) !== document.editSha256) {
    throw new Error('approval edit revision hash mismatch');
  }
  validateDecision({ project: projectRecord.document, approver: document.approver, decision: document.decision, notes: document.notes });
  isoDate(document.decidedAt, 'approval decidedAt');

  const selected = edit.frames.filter(({ included }) => included);
  if (selected.length !== document.selectedFrames.length || selected.length !== document.derivatives.length) throw new Error('approval selected frame set mismatch');
  for (const [index, frameEdit] of selected.entries()) {
    const sourceFrame = sourceDocument.frames.find(({ id }) => id === frameEdit.frameId);
    const selectedFrame = document.selectedFrames[index];
    const derivative = document.derivatives[index];
    if (
      !sourceFrame ||
      selectedFrame.frameId !== frameEdit.frameId ||
      selectedFrame.sourceFrameSha256 !== sourceFrame.sha256 ||
      selectedFrame.durationMs !== frameEdit.durationMs ||
      derivative.frameId !== frameEdit.frameId ||
      selectedFrame.derivativeSha256 !== derivative.sha256
    ) throw new Error('approval selected frame set mismatch');
    await readVerifiedArtifact(run.root, derivative.path, derivative.sha256, 'derivative');
  }
  await readVerifiedArtifact(run.root, document.contactSheet.path, document.contactSheet.sha256, 'contact sheet');
  await readVerifiedArtifact(run.root, document.renderedManifest.path, document.renderedManifest.sha256, 'rendered manifest');
  await readVerifiedArtifact(run.root, document.renderedReview.path, document.renderedReview.sha256, 'rendered review');
  hash(document.editRevisionSha256, 'approval edit revision hash');
  hash(document.editSha256, 'approval edit hash');
  return deepFreeze({ path: loaded.path, sha256: loaded.sha256, document, verified: true });
}

export function requireProductionApproval(value) {
  const document = value?.document ?? value;
  if (!document || value?.verified !== true || document.kind !== 'selection-approval' || document.decision !== 'approved') {
    throw new Error('owner approval required before production');
  }
  return value;
}
