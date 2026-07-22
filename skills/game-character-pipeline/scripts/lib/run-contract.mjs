import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { writeImmutableJson } from './artifacts.mjs';
import { loadProjectContract, validateProjectContract } from './project-contract.mjs';
import { exactObject, isoDate, portableId, sha256Value } from './schema.mjs';

const STATE_DIRECTORY = '.game-character-pipeline';
const RUN_AREAS = Object.freeze(['source', 'work', 'edits', 'approved', 'exports', 'reports']);

async function ensureRealDirectory(directory, { create = false, privateMode = false } = {}) {
  if (create) {
    try {
      await fs.mkdir(directory, { recursive: false, mode: privateMode ? 0o700 : 0o755 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('project state path must be a real directory');
  if (privateMode && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('project state directory permissions are unsafe');
  }
  return fs.realpath(directory);
}

async function stateRoot(projectRoot, { create = false } = {}) {
  const physicalProject = await ensureRealDirectory(path.resolve(projectRoot), { create });
  return ensureRealDirectory(path.join(physicalProject, STATE_DIRECTORY), { create, privateMode: true });
}

export async function loadInitializedProject(projectRoot) {
  const state = await stateRoot(projectRoot);
  return loadProjectContract(path.join(state, 'project.json'));
}

export async function createProject({ root, contractFile }) {
  const contract = await loadProjectContract(path.resolve(contractFile));
  const state = await stateRoot(root, { create: true });
  const projectFile = path.join(state, 'project.json');
  try {
    const existing = await loadProjectContract(projectFile);
    if (existing.sha256 !== contract.sha256) throw new Error('initialized project contains a different project contract');
    return { ...existing, root: path.resolve(root), stateRoot: state, reused: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeImmutableJson({ root: state, relative: 'project.json', value: contract.document, reuse: false });
  return { ...contract, root: path.resolve(root), stateRoot: state, reused: false };
}

function validateSourceRequest(sourceRequest, project) {
  exactObject(sourceRequest, ['actionId', 'kind'], 'source request');
  portableId(sourceRequest.actionId, 'source request action ID');
  const action = project.document.actions.find(({ id }) => id === sourceRequest.actionId);
  if (!action) throw new Error(`source request action is unknown: ${sourceRequest.actionId}`);
  if (!project.document.sources.allowedKinds.includes(sourceRequest.kind)) {
    throw new Error(`source request kind is not allowed: ${sourceRequest.kind}`);
  }
  const allowedForAction = [action.sources.preferred, ...action.sources.fallbacks];
  if (!allowedForAction.includes(sourceRequest.kind)) {
    throw new Error(`source request kind is not configured for action: ${sourceRequest.kind}`);
  }
  return structuredClone(sourceRequest);
}

function defaultRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, '').toLowerCase();
  return `run-${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
}

async function assertAbsent(target, label) {
  try {
    await fs.lstat(target);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function createRun({ projectRoot, project, sourceRequest, id, clock = () => new Date() }) {
  const initialized = await loadInitializedProject(projectRoot);
  validateProjectContract(project?.document);
  if (project.sha256 !== initialized.sha256 || sha256Value(project.document) !== initialized.sha256) {
    throw new Error('project hash mismatch');
  }
  const request = validateSourceRequest(sourceRequest, initialized);
  const created = clock();
  if (!(created instanceof Date) || Number.isNaN(created.valueOf())) throw new Error('run clock must return a valid Date');
  const createdAt = isoDate(created.toISOString(), 'run createdAt');
  const runId = id ?? defaultRunId(created);
  portableId(runId, 'run ID');

  const state = await stateRoot(projectRoot);
  const runsRoot = await ensureRealDirectory(path.join(state, 'runs'), { create: true, privateMode: true });
  const target = path.join(runsRoot, runId);
  const reservation = path.join(runsRoot, `.${runId}.reserve`);
  let reservationHandle;
  try {
    reservationHandle = await fs.open(reservation, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`run ${runId} already exists`);
    throw error;
  }

  const stage = path.join(runsRoot, `.pending-${runId}-${crypto.randomUUID()}`);
  try {
    await assertAbsent(target, `run ${runId}`);
    await fs.mkdir(stage, { mode: 0o700 });
    for (const area of RUN_AREAS) await fs.mkdir(path.join(stage, area), { mode: 0o700 });
    const document = {
      schemaVersion: 1,
      id: runId,
      projectSha256: initialized.sha256,
      createdAt,
      sourceRequest: request,
      state: 'created',
      artifacts: [],
      decoder: null
    };
    const manifest = await writeImmutableJson({ root: stage, relative: 'run.json', value: document, reuse: false });
    await assertAbsent(target, `run ${runId}`);
    await fs.rename(stage, target);
    return { id: runId, root: target, document, sha256: manifest.sha256 };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  } finally {
    await reservationHandle.close();
    await fs.rm(reservation, { force: true });
  }
}
