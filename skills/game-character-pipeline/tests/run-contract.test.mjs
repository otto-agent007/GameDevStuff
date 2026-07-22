import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createProject, createRun, loadInitializedProject } from '../scripts/lib/run-contract.mjs';

const execFile = promisify(execFileCallback);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFile = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-runs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('createRun allocates a complete append-only run', async (t) => {
  const parent = await sandbox(t);
  const projectRoot = path.join(parent, 'project');
  const project = await createProject({ root: projectRoot, contractFile: fixtureFile });
  const created = await createRun({
    projectRoot,
    project,
    sourceRequest: { actionId: 'idle', kind: 'gif' },
    id: 'run-001',
    clock: () => new Date('2026-07-21T12:00:00.000Z')
  });

  assert.deepEqual(
    (await fs.readdir(created.root)).sort(),
    ['approved', 'edits', 'exports', 'reports', 'run.json', 'source', 'work']
  );
  assert.deepEqual(created.document.sourceRequest, { actionId: 'idle', kind: 'gif' });
  assert.equal(created.document.projectSha256, project.sha256);
  assert.equal(created.document.createdAt, '2026-07-21T12:00:00.000Z');
  await assert.rejects(
    createRun({ projectRoot, project, sourceRequest: { actionId: 'idle', kind: 'gif' }, id: created.id }),
    /already exists/
  );
});

test('run creation has one atomic winner for a selected ID', async (t) => {
  const parent = await sandbox(t);
  const projectRoot = path.join(parent, 'project');
  const project = await createProject({ root: projectRoot, contractFile: fixtureFile });
  const request = { projectRoot, project, sourceRequest: { actionId: 'unlock', kind: 'generated-still' }, id: 'same-run' };
  const results = await Promise.allSettled([createRun(request), createRun(request)]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  const published = path.join(projectRoot, '.game-character-pipeline', 'runs', 'same-run');
  assert.equal((await fs.lstat(path.join(published, 'run.json'))).isFile(), true);
  assert.equal((await fs.readdir(path.dirname(published))).some((name) => name.startsWith('.pending-')), false);
});

test('run creation closes source requests and project identity', async (t) => {
  const parent = await sandbox(t);
  const projectRoot = path.join(parent, 'project');
  const project = await createProject({ root: projectRoot, contractFile: fixtureFile });
  await assert.rejects(
    createRun({ projectRoot, project, sourceRequest: { actionId: 'idle', kind: 'gif', source: '/private/input.gif' } }),
    /unknown source request field: source/
  );
  await assert.rejects(
    createRun({ projectRoot, project: { ...project, sha256: '0'.repeat(64) }, sourceRequest: { actionId: 'idle', kind: 'gif' } }),
    /project hash mismatch/
  );
});

test('initialized project retries only with the identical contract', async (t) => {
  const parent = await sandbox(t);
  const projectRoot = path.join(parent, 'project');
  const first = await createProject({ root: projectRoot, contractFile: fixtureFile });
  const retry = await createProject({ root: projectRoot, contractFile: fixtureFile });
  assert.equal(retry.reused, true);
  assert.equal((await loadInitializedProject(projectRoot)).sha256, first.sha256);

  const changedFile = path.join(parent, 'changed.json');
  const changed = JSON.parse(await fs.readFile(fixtureFile, 'utf8'));
  changed.character.name = 'Changed Courier';
  await fs.writeFile(changedFile, `${JSON.stringify(changed)}\n`);
  await assert.rejects(createProject({ root: projectRoot, contractFile: changedFile }), /different project contract/);
});

test('CLI initializes a project and allocates an intake run', async (t) => {
  const parent = await sandbox(t);
  const projectRoot = path.join(parent, 'project');
  const initialized = await execFile(process.execPath, [
    'scripts/cli.mjs', 'init', '--contract', fixtureFile, '--project-dir', projectRoot
  ], { cwd: packageDir });
  assert.equal(JSON.parse(initialized.stdout).status, 'created');

  const intake = await execFile(process.execPath, [
    'scripts/cli.mjs', 'intake', '--project-dir', projectRoot, '--action', 'idle', '--kind', 'gif'
  ], { cwd: packageDir });
  const result = JSON.parse(intake.stdout);
  assert.equal(result.status, 'created');
  assert.equal(result.state, 'created');
  assert.match(result.runId, /^run-/);
});
