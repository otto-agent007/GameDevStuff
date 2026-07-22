import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

import { requireProductionApproval, verifyApproval, writeApproval } from '../scripts/lib/approval.mjs';
import { writeImmutableBytes, writeImmutableJson, writeRevision } from '../scripts/lib/artifacts.mjs';
import { createProject, createRun } from '../scripts/lib/run-contract.mjs';
import { sha256Value } from '../scripts/lib/schema.mjs';

const execFile = promisify(execFileCallback);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractFile = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');
const cliPath = path.join(packageDir, 'scripts', 'cli.mjs');

async function fixture() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-approval-'));
  const projectRoot = path.join(temporary, 'project');
  const project = await createProject({ root: projectRoot, contractFile });
  const run = await createRun({ projectRoot, project, sourceRequest: { actionId: 'idle', kind: 'png-sequence' } });
  const png = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 245, g: 158, b: 11, alpha: 0.8 } }
  }).png().toBuffer();
  const frame = await writeImmutableBytes({ root: run.root, relative: 'work/decoded/approval-frame.png', bytes: png });
  const source = {
    kind: 'png-sequence', sourceSha256: 'c'.repeat(64),
    decoder: { name: 'approval-fixture', version: '1', arguments: [] },
    canvas: { width: 8, height: 8 }, alpha: true,
    timeBase: { numerator: 1, denominator: 1000 },
    frames: [{ index: 0, id: 'idle-1', path: frame.relative, sha256: frame.sha256, width: 8, height: 8, timestampMs: 0, durationMs: 100, sourceRect: { x: 0, y: 0, width: 8, height: 8 }, duplicateOf: null }],
    diagnostics: [], approval: null
  };
  await writeImmutableJson({ root: run.root, relative: 'reports/source.json', value: source });
  const edit = {
    schemaVersion: 1,
    kind: 'frame-studio-edit',
    projectSha256: project.sha256,
    sourceSha256: sha256Value(source),
    actionId: 'idle',
    frames: [{
      frameId: 'idle-1', included: true, label: 'settle', durationMs: 100,
      translation: { x: 0, y: 0 }, transform: null,
      markers: [
        { id: 'root', kind: 'root-pivot', x: 48, y: 84 },
        { id: 'hand', kind: 'socket', x: 60, y: 48 },
        { id: 'left-foot', kind: 'planted-foot', x: 43, y: 83 }
      ],
      contacts: ['left-foot'], groundTravel: { x: 0, y: 0 }, tracks: ['actor', 'satchel']
    }]
  };
  await writeRevision({
    root: run.root,
    area: 'edits',
    stem: 'studio-edit',
    value: {
      schemaVersion: 1,
      kind: 'studio-edit',
      runId: run.id,
      stage: 'selection',
      sourceSha256: sha256Value(source),
      previousSha256: sha256Value({ schemaVersion: 1, kind: 'studio-edit-root', runId: run.id, stage: 'selection', sourceSha256: sha256Value(source) }),
      edit
    }
  });
  return { temporary, projectRoot, project, run, source, edit };
}

test('approval rejects changed membership, source, edit, or rendered bytes', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.temporary, { recursive: true, force: true }));
  const approved = await writeApproval({
    ...data,
    editRevision: 1,
    approver: 'owner',
    decision: 'approved',
    notes: 'Timing and planted foot read clearly.',
    clock: () => new Date('2026-07-22T08:00:00.000Z')
  });
  const verified = await verifyApproval({ ...data, file: approved.path });
  assert.equal(verified.document.decision, 'approved');
  assert.equal(requireProductionApproval(verified), verified);
  await fs.appendFile(approved.derivatives[0].path, Buffer.from([0]));
  await assert.rejects(verifyApproval({ ...data, file: approved.path }), /derivative hash mismatch/);

  const changedEdit = structuredClone(data.edit);
  changedEdit.frames[0].included = false;
  await assert.rejects(verifyApproval({ ...data, edit: changedEdit, file: approved.path }), /edit hash mismatch|selected frame set mismatch/);
});

test('rejection records notes but cannot enter production', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.temporary, { recursive: true, force: true }));
  const rejected = await writeApproval({
    ...data,
    editRevision: 1,
    approver: 'owner',
    decision: 'rejected',
    notes: 'foot contact unreadable',
    clock: () => new Date('2026-07-22T08:01:00.000Z')
  });
  assert.equal(rejected.document.notes, 'foot contact unreadable');
  assert.throws(() => requireProductionApproval(rejected), /owner approval required/);
  await assert.rejects(writeApproval({ ...data, editRevision: 1, approver: 'intruder', decision: 'approved', notes: '' }), /configured approval identity/);
  await assert.rejects(writeApproval({ ...data, editRevision: 1, approver: 'owner', decision: 'rejected', notes: '' }), /rejection notes are required/);
});

test('render and approve CLI commands publish verified status and rejection exit 4', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.temporary, { recursive: true, force: true }));
  const rendered = await execFile(process.execPath, [
    cliPath, 'render', '--project-dir', data.projectRoot, '--run', data.run.id, '--edit', '1'
  ], { cwd: packageDir });
  assert.equal(JSON.parse(rendered.stdout).status, 'rendered');
  const approved = await execFile(process.execPath, [
    cliPath, 'approve', '--project-dir', data.projectRoot, '--run', data.run.id, '--edit', '1',
    '--approver', 'owner', '--decision', 'approved', '--notes', 'owner reviewed'
  ], { cwd: packageDir });
  assert.equal(JSON.parse(approved.stdout).status, 'approved');
  await assert.rejects(
    execFile(process.execPath, [
      cliPath, 'approve', '--project-dir', data.projectRoot, '--run', data.run.id, '--edit', '1',
      '--approver', 'owner', '--decision', 'rejected', '--notes', 'needs repair'
    ], { cwd: packageDir }),
    (error) => {
      assert.equal(error.code, 4);
      assert.equal(JSON.parse(error.stdout).status, 'rejected');
      return true;
    }
  );
});
