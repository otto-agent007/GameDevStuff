import fs from 'node:fs/promises';
import path from 'node:path';

import { writeRevision } from './artifacts.mjs';
import {
  deepFreeze,
  exactObject,
  integer,
  isoDate,
  portableId,
  portableRelativePath,
  sha256File,
  sha256Value,
  uniqueList
} from './schema.mjs';

const HASH = /^[a-f0-9]{64}$/;
const ROLES = new Set(['actor', 'prop', 'effect']);

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new Error(`${label} must be a sha256`);
  }
  return value;
}

function projectContext(project) {
  const document = project?.document ?? project;
  if (!document || typeof document !== 'object') {
    throw new Error('pose selection requires a project contract');
  }
  return {
    document,
    sha256: project?.sha256 ?? sha256Value(document)
  };
}

function recoveryContext(recovery) {
  const document = recovery?.document ?? recovery;
  if (
    !document ||
    document.kind !== 'pose-board-recovery' ||
    typeof recovery?.sha256 !== 'string'
  ) {
    throw new Error('pose selection requires a published recovery report');
  }
  hash(recovery.sha256, 'pose-board recovery hash');
  return { document, sha256: recovery.sha256, path: recovery.path };
}

function contained(root, target, label) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the run root`);
  }
}

async function readCanonicalJson(file, runRoot, label) {
  const root = await fs.realpath(runRoot);
  const selected = path.resolve(file);
  contained(root, selected, label);
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a regular single-link file`);
  }
  const physical = await fs.realpath(selected);
  contained(root, physical, label);
  const document = JSON.parse(await fs.readFile(physical, 'utf8'));
  const sha256 = await sha256File(physical);
  if (sha256 !== sha256Value(document)) {
    throw new Error(`${label} must use canonical immutable JSON`);
  }
  return { document, path: physical, sha256 };
}

async function verifyRecoveryArtifact(run, recovery) {
  const selected = recoveryContext(recovery);
  if (selected.path) {
    const loaded = await readCanonicalJson(
      selected.path,
      run.root,
      'pose-board recovery report'
    );
    if (loaded.sha256 !== selected.sha256 || sha256Value(loaded.document) !== selected.sha256) {
      throw new Error('pose selection recovery ancestry mismatch');
    }
    if (sha256Value(loaded.document) !== sha256Value(selected.document)) {
      throw new Error('pose-board recovery report document mismatch');
    }
  }
  return selected;
}

function validateBindings({ selection, run, project, recovery }) {
  if (selection.projectSha256 !== project.sha256) {
    throw new Error('pose selection project hash mismatch');
  }
  if (selection.runId !== run.id) throw new Error('pose selection run mismatch');
  if (selection.actionId !== run.document.sourceRequest.actionId) {
    throw new Error('pose selection action mismatch');
  }
  if (selection.recoverySha256 !== recovery.sha256) {
    throw new Error('pose selection recovery ancestry mismatch');
  }
}

function validateSelectionDocument(value, { run, project, recovery }) {
  const selection = structuredClone(value);
  exactObject(
    selection,
    [
      'schemaVersion',
      'kind',
      'projectSha256',
      'runId',
      'actionId',
      'recoverySha256',
      'frames'
    ],
    'pose selection'
  );
  if (selection.schemaVersion !== 1 || selection.kind !== 'pose-board-selection') {
    throw new Error('pose selection identity is invalid');
  }
  hash(selection.projectSha256, 'pose selection project hash');
  portableId(selection.runId, 'pose selection run ID');
  portableId(selection.actionId, 'pose selection action ID');
  hash(selection.recoverySha256, 'pose selection recovery hash');
  validateBindings({ selection, run, project, recovery });

  uniqueList(selection.frames, 'pose selection frame IDs', {
    key: ({ id }) => id
  });
  const candidateIds = selection.frames.map(({ candidateId }) => candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error('pose selection candidate IDs must be unique');
  }

  const action = project.document.actions.find(({ id }) => id === selection.actionId);
  const trackById = new Map(project.document.tracks.map((track) => [track.id, track]));
  const allowedRoles = new Set(action.tracks.map((trackId) => trackById.get(trackId).kind));
  const candidateById = new Map(
    recovery.document.candidates.map((candidate) => [candidate.id, candidate])
  );
  const knownComponents = new Set(
    recovery.document.components.map((component) => component.id)
  );
  const assignedComponents = new Set();

  for (const frame of selection.frames) {
    exactObject(frame, ['id', 'candidateId', 'durationMs', 'tracks'], 'pose selection frame');
    portableId(frame.id, 'pose selection frame ID');
    portableId(frame.candidateId, 'pose selection candidate ID');
    integer(frame.durationMs, 'pose selection frame durationMs', { min: 1, max: 65535 });
    const candidate = candidateById.get(frame.candidateId);
    if (!candidate) throw new Error(`pose selection references unknown candidate ID: ${frame.candidateId}`);

    uniqueList(frame.tracks, `pose selection frame ${frame.id} track roles`, {
      key: ({ role }) => role
    });
    const frameComponents = new Set();
    for (const track of frame.tracks) {
      exactObject(track, ['role', 'componentIds'], 'pose selection track');
      if (!ROLES.has(track.role) || !allowedRoles.has(track.role)) {
        throw new Error(`pose selection track role is not configured for the action: ${track.role}`);
      }
      uniqueList(
        track.componentIds,
        `pose selection frame ${frame.id} ${track.role} component IDs`
      );
      for (const componentId of track.componentIds) {
        portableId(componentId, 'pose selection component ID');
        if (!knownComponents.has(componentId)) {
          throw new Error(`pose selection references unknown component ID: ${componentId}`);
        }
        if (assignedComponents.has(componentId)) {
          throw new Error('pose selection component membership must be unique');
        }
        assignedComponents.add(componentId);
        frameComponents.add(componentId);
      }
    }
    if (!frame.tracks.some(({ role }) => role === 'actor')) {
      throw new Error('pose selection frame requires an actor track');
    }
    const expected = [...candidate.componentIds].sort();
    const actual = [...frameComponents].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`pose selection frame ${frame.id} must use every whole candidate component exactly once`);
    }
  }

  if (
    recovery.document.contract.document.allowUnassigned === false &&
    assignedComponents.size !== knownComponents.size
  ) {
    throw new Error('pose selection requires complete eligible-component disposition');
  }
  return deepFreeze(selection);
}

export async function writePoseSelection({ run, project, recovery, value }) {
  if (!run?.root || !run?.id || !run?.document) {
    throw new Error('pose selection requires an immutable run');
  }
  const projectRecord = projectContext(project);
  const recoveryRecord = await verifyRecoveryArtifact(run, recovery);
  const document = validateSelectionDocument(value, {
    run,
    project: projectRecord,
    recovery: recoveryRecord
  });
  const written = await writeRevision({
    root: run.root,
    area: 'edits',
    stem: 'pose-selection',
    value: document
  });
  return deepFreeze({ ...written, document });
}

function validateDecision(project, { approver, decision, notes }) {
  portableId(approver, 'pose selection approval identity');
  if (!project.document.approvals.identities.includes(approver)) {
    throw new Error('pose selection approver must be a configured approval identity');
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error('pose selection approval decision must be approved or rejected');
  }
  if (typeof notes !== 'string' || notes.length > 4096) {
    throw new Error('pose selection approval notes must be at most 4096 characters');
  }
  if (decision === 'rejected' && notes.trim() === '') {
    throw new Error('pose selection rejection notes are required');
  }
}

async function verifySelectionArtifact({ run, project, recovery, selection }) {
  if (!selection?.path || !selection?.sha256) {
    throw new Error('pose selection approval requires a published selection revision');
  }
  const loaded = await readCanonicalJson(selection.path, run.root, 'pose selection revision');
  if (loaded.sha256 !== selection.sha256) throw new Error('pose selection revision hash mismatch');
  const document = validateSelectionDocument(loaded.document, { run, project, recovery });
  return {
    ...loaded,
    relative: portableRelativePath(
      path.relative(await fs.realpath(run.root), loaded.path).split(path.sep).join('/'),
      'pose selection revision path'
    ),
    revision: selection.revision,
    document
  };
}

export async function approvePoseSelection({
  run,
  project,
  recovery,
  selection,
  approver,
  decision,
  notes = '',
  clock = () => new Date()
}) {
  const projectRecord = projectContext(project);
  const recoveryRecord = await verifyRecoveryArtifact(run, recovery);
  const selected = await verifySelectionArtifact({
    run,
    project: projectRecord,
    recovery: recoveryRecord,
    selection
  });
  validateDecision(projectRecord, { approver, decision, notes });
  const decided = clock();
  if (!(decided instanceof Date) || Number.isNaN(decided.valueOf())) {
    throw new Error('pose selection approval clock must return a valid Date');
  }
  const document = {
    schemaVersion: 1,
    kind: 'pose-board-selection-approval',
    projectSha256: projectRecord.sha256,
    runId: run.id,
    actionId: run.document.sourceRequest.actionId,
    recoverySha256: recoveryRecord.sha256,
    selection: {
      path: selected.relative,
      revision: selected.revision,
      sha256: selected.sha256
    },
    selectionSha256: selected.sha256,
    approver,
    decision,
    notes,
    decidedAt: isoDate(decided.toISOString(), 'pose selection approval decidedAt')
  };
  const written = await writeRevision({
    root: run.root,
    area: 'approved',
    stem: 'pose-selection-approval',
    value: document
  });
  return deepFreeze({ ...written, document });
}

function validateApprovalDocument(document) {
  exactObject(
    document,
    [
      'schemaVersion',
      'kind',
      'projectSha256',
      'runId',
      'actionId',
      'recoverySha256',
      'selection',
      'selectionSha256',
      'approver',
      'decision',
      'notes',
      'decidedAt'
    ],
    'pose selection approval'
  );
  if (
    document.schemaVersion !== 1 ||
    document.kind !== 'pose-board-selection-approval'
  ) {
    throw new Error('pose selection approval identity is invalid');
  }
  hash(document.projectSha256, 'pose selection approval project hash');
  portableId(document.runId, 'pose selection approval run ID');
  portableId(document.actionId, 'pose selection approval action ID');
  hash(document.recoverySha256, 'pose selection approval recovery hash');
  hash(document.selectionSha256, 'pose selection approval selection hash');
  exactObject(document.selection, ['path', 'revision', 'sha256'], 'pose selection approval selection');
  portableRelativePath(document.selection.path, 'pose selection approval selection path');
  integer(document.selection.revision, 'pose selection approval selection revision', {
    min: 1,
    max: 999999
  });
  hash(document.selection.sha256, 'pose selection approval selected revision hash');
  if (document.selection.sha256 !== document.selectionSha256) {
    throw new Error('pose selection approval selection hash mismatch');
  }
  isoDate(document.decidedAt, 'pose selection approval decidedAt');
  return document;
}

export async function loadApprovedPoseSelection({ run, project, recovery, file }) {
  const projectRecord = projectContext(project);
  const recoveryRecord = await verifyRecoveryArtifact(run, recovery);
  const approval = await readCanonicalJson(file, run.root, 'pose selection approval');
  const document = validateApprovalDocument(approval.document);
  if (document.projectSha256 !== projectRecord.sha256) {
    throw new Error('pose selection approval project hash mismatch');
  }
  if (document.runId !== run.id) throw new Error('pose selection approval run mismatch');
  if (document.actionId !== run.document.sourceRequest.actionId) {
    throw new Error('pose selection approval action mismatch');
  }
  if (document.recoverySha256 !== recoveryRecord.sha256) {
    throw new Error('pose selection approval recovery hash mismatch');
  }
  validateDecision(projectRecord, document);
  if (document.decision !== 'approved') {
    throw new Error('approved pose selection is required before source publication');
  }

  const selectionFile = path.join(
    run.root,
    ...document.selection.path.split('/')
  );
  const selected = await readCanonicalJson(
    selectionFile,
    run.root,
    'pose selection revision'
  );
  if (selected.sha256 !== document.selectionSha256) {
    throw new Error('pose selection approval selection hash mismatch');
  }
  const selectionDocument = validateSelectionDocument(selected.document, {
    run,
    project: projectRecord,
    recovery: recoveryRecord
  });
  return deepFreeze({
    path: approval.path,
    sha256: approval.sha256,
    document,
    selection: {
      ...selected,
      revision: document.selection.revision,
      document: selectionDocument
    },
    verified: true
  });
}
