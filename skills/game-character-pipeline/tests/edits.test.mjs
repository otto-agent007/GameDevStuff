import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { writeImmutableBytes } from '../scripts/lib/artifacts.mjs';
import { renderEditRevision, validateEditManifest } from '../scripts/lib/edits.mjs';
import { createProject, createRun } from '../scripts/lib/run-contract.mjs';
import { sha256File, sha256Value } from '../scripts/lib/schema.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractFile = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');

async function fixture() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-edits-'));
  const projectRoot = path.join(temporary, 'project');
  const project = await createProject({ root: projectRoot, contractFile });
  const run = await createRun({ projectRoot, project, sourceRequest: { actionId: 'idle', kind: 'png-sequence' } });
  const pixels = Buffer.alloc(8 * 8 * 4);
  pixels.set([245, 158, 11, 255], (2 * 8 + 2) * 4);
  const bytes = await sharp(pixels, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
  const artifact = await writeImmutableBytes({ root: run.root, relative: 'work/decoded/source.png', bytes });
  const source = {
    kind: 'png-sequence',
    sourceSha256: 'b'.repeat(64),
    decoder: { name: 'edit-fixture', version: '1', arguments: [] },
    canvas: { width: 8, height: 8 },
    alpha: true,
    timeBase: { numerator: 1, denominator: 1000 },
    frames: [
      { index: 0, id: 'step-contact', path: artifact.relative, sha256: artifact.sha256, width: 8, height: 8, timestampMs: 0, durationMs: 80, sourceRect: { x: 0, y: 0, width: 8, height: 8 }, duplicateOf: null },
      { index: 1, id: 'step-pass', path: artifact.relative, sha256: artifact.sha256, width: 8, height: 8, timestampMs: 80, durationMs: 120, sourceRect: { x: 0, y: 0, width: 8, height: 8 }, duplicateOf: 'step-contact' }
    ],
    diagnostics: [],
    approval: null
  };
  const edit = {
    schemaVersion: 1,
    kind: 'frame-studio-edit',
    projectSha256: project.sha256,
    sourceSha256: sha256Value(source),
    actionId: 'idle',
    frames: source.frames.map((frame) => ({
      frameId: frame.id,
      included: true,
      label: '',
      durationMs: frame.durationMs,
      translation: { x: 0, y: 0 },
      transform: null,
      markers: [],
      contacts: [],
      groundTravel: { x: 0, y: 0 },
      tracks: ['actor', 'satchel']
    }))
  };
  return { temporary, project, run, source, edit };
}

test('edit manifest permits translation but rejects implicit fitting', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.temporary, { recursive: true, force: true }));
  data.edit.frames[0].translation = { x: -2, y: 1 };
  assert.equal(validateEditManifest(data.edit, data).frames[0].translation.x, -2);
  data.edit.frames[0].transform = { scale: 2, rotationQuarterTurns: 0 };
  data.edit.frames[1].transform = { scale: 2, rotationQuarterTurns: 0 };
  assert.throws(() => validateEditManifest(data.edit, data), /integer global transform requires explicit owner opt-in/);
  assert.equal(validateEditManifest(data.edit, { ...data, allowGlobalTransform: true }).frames[1].transform.scale, 2);
  const rendered = await renderEditRevision({ ...data, edit: data.edit, allowGlobalTransform: true });
  assert.equal(rendered.frames.length, 2);
});

test('edit manifest closes frame order, timing, references, marker bounds, and contact travel', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.temporary, { recursive: true, force: true }));
  const changed = structuredClone(data.edit);
  changed.frames.reverse();
  assert.throws(() => validateEditManifest(changed, data), /exact source order/);
  changed.frames.reverse();
  changed.frames[0].durationMs = 0;
  assert.throws(() => validateEditManifest(changed, data), /durationMs/);
  changed.frames[0].durationMs = 80;
  changed.frames[0].markers = [{ id: 'hand', kind: 'socket', x: 97, y: 2 }];
  assert.throws(() => validateEditManifest(changed, data), /logical canvas/);
  changed.frames[0].markers = [{ id: 'unknown', kind: 'socket', x: 2, y: 2 }];
  assert.throws(() => validateEditManifest(changed, data), /unknown socket/);
  changed.frames[0].markers = [];
  changed.frames[0].tracks = ['unknown'];
  assert.throws(() => validateEditManifest(changed, data), /unknown action track/);
  changed.frames[0].tracks = ['actor'];
  changed.frames[0].groundTravel = { x: 2, y: 0 };
  assert.throws(() => validateEditManifest(changed, data), /declared contact interval/);
  changed.frames[0].contacts = ['left-foot'];
  assert.equal(validateEditManifest(changed, data).frames[0].groundTravel.x, 2);
});

test('rendered edit revisions are deterministic derivatives and preserve source bytes', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.temporary, { recursive: true, force: true }));
  data.edit.frames[0].translation = { x: 1, y: 2 };
  data.edit.frames[0].markers = [{ id: 'hand', kind: 'socket', x: 20, y: 30 }];
  const sourceFile = path.join(data.run.root, data.source.frames[0].path);
  const sourceHash = await sha256File(sourceFile);
  const first = await renderEditRevision({ ...data, edit: data.edit });
  const second = await renderEditRevision({ ...data, edit: structuredClone(data.edit) });
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.frames.map(({ sha256 }) => sha256), second.frames.map(({ sha256 }) => sha256));
  assert.notEqual(first.frames[0].sha256, sourceHash);
  assert.equal(await sha256File(sourceFile), sourceHash);
  assert.equal(first.frames[0].markers[0].id, 'hand');
  assert.match(first.frames[0].path, /^work\/revisions\/[a-f0-9]{64}\/frames\//);
});
