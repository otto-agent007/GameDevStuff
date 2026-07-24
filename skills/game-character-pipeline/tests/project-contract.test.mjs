import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  deepFreeze,
  finiteNumber,
  hashString,
  integer,
  isoDate,
  portableId,
  portableRelativePath,
  sha256Value,
  uniqueList
} from '../scripts/lib/schema.mjs';
import { loadProjectContract, validateProjectContract } from '../scripts/lib/project-contract.mjs';

const fixtureFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project.valid.json');

async function validProject() {
  return JSON.parse(await fs.readFile(fixtureFile, 'utf8'));
}

test('project contract binds one global scale and explicit action behavior', async () => {
  const input = await validProject();
  const project = validateProjectContract(input);

  assert.equal(project.scale.integer, 2);
  assert.deepEqual(
    project.actions.map(({ id, loopMode }) => [id, loopMode]),
    [['idle', 'loop'], ['unlock', 'hold-last']]
  );
  assert.equal(Object.isFrozen(project), true);
  assert.equal(Object.isFrozen(project.actions[0].sources), true);
  assert.notEqual(project, input);
  assert.equal(project.sources.allowedKinds.includes('pose-board'), true);
  assert.equal(project.actions[0].sources.fallbacks.includes('pose-board'), true);
});

test('project contract accepts an actor-only project without sockets or contacts', async () => {
  const input = await validProject();
  input.tracks = [input.tracks.find(({ id }) => id === 'actor')];
  input.sockets = [];
  input.contacts = [];
  input.actions = input.actions.map((action) => ({
    ...action,
    tracks: ['actor'],
    sockets: [],
    contacts: []
  }));

  const project = validateProjectContract(input);

  assert.deepEqual(project.tracks.map(({ id }) => id), ['actor']);
  assert.deepEqual(project.sockets, []);
  assert.deepEqual(project.contacts, []);
});

test('project contract rejects unknown fields and per-action scale', async () => {
  const extra = { ...(await validProject()), surprise: true };
  assert.throws(() => validateProjectContract(extra), /unknown project field: surprise/);

  const changed = await validProject();
  changed.actions[0].scale = 3;
  assert.throws(() => validateProjectContract(changed), /unknown action field: scale/);
});

test('project contract closes palette, IDs, references, source kinds, and loop modes', async () => {
  const palette = await validProject();
  palette.palette.rgba[0] = [0, 0, 0, 255];
  assert.throws(() => validateProjectContract(palette), /leading transparent/);

  const duplicate = await validProject();
  duplicate.tracks[1].id = 'actor';
  assert.throws(() => validateProjectContract(duplicate), /track IDs must be unique/);

  const socket = await validProject();
  socket.actions[0].sockets = ['missing'];
  assert.throws(() => validateProjectContract(socket), /unknown socket: missing/);

  const source = await validProject();
  source.actions[0].sources.preferred = 'avi';
  assert.throws(() => validateProjectContract(source), /source kind is not allowed: avi/);

  const loop = await validProject();
  loop.actions[0].loopMode = 'restart';
  assert.throws(() => validateProjectContract(loop), /loopMode is invalid/);
});

test('project contract binds scale, canvas, attachment, contact, and approval invariants', async () => {
  const scale = await validProject();
  scale.scale.runtime.width = 191;
  assert.throws(() => validateProjectContract(scale), /runtime dimensions must equal canvas dimensions times global scale/);

  const attachment = await validProject();
  attachment.tracks[1].attachTo = 'missing';
  assert.throws(() => validateProjectContract(attachment), /unknown attachment socket: missing/);

  const contact = await validProject();
  contact.contacts[0].trackId = 'satchel';
  assert.throws(() => validateProjectContract(contact), /planted-foot contact must belong to the actor track/);

  const approvals = await validProject();
  approvals.approvals.requiredGates = ['canonical-anchor', 'final-preview'];
  assert.throws(() => validateProjectContract(approvals), /required approval gates/);
});

test('loadProjectContract returns the stable file-independent contract hash', async () => {
  const loaded = await loadProjectContract(fixtureFile);
  assert.equal(loaded.sha256, sha256Value(loaded.document));
  assert.match(loaded.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(loaded.document.character.anchors), true);
});

test('schema primitives reject ambiguous values and portable path hazards', () => {
  assert.equal(portableId('walk-cycle', 'clip ID'), 'walk-cycle');
  assert.throws(() => portableId('Walk Cycle', 'clip ID'), /portable ID/);
  assert.equal(portableRelativePath('source/anchor.png', 'anchor path'), 'source/anchor.png');
  for (const value of ['../anchor.png', 'source\\anchor.png', 'C:\\anchor.png', 'source/CON.png']) {
    assert.throws(() => portableRelativePath(value, 'anchor path'), /portable relative path/);
  }
  assert.equal(integer(2, 'scale', { min: 1, max: 8 }), 2);
  assert.throws(() => integer(1.5, 'scale'), /integer/);
  assert.equal(finiteNumber(1.25, 'coordinate'), 1.25);
  assert.throws(() => finiteNumber(Number.POSITIVE_INFINITY, 'coordinate'), /finite number/);
  assert.equal(isoDate('2026-07-21T12:00:00.000Z', 'createdAt'), '2026-07-21T12:00:00.000Z');
  assert.throws(() => isoDate('tomorrow', 'createdAt'), /ISO date/);
  assert.deepEqual(uniqueList(['a', 'b'], 'values'), ['a', 'b']);
  assert.throws(() => uniqueList(['a', 'a'], 'values'), /unique/);
  assert.equal(hashString('character'), '4bcef3de76eaf574c6bac3fc98f364793a73aa3e31fe45a7d1dcc0239ed2a5c4');
  assert.equal(sha256Value({ b: 2, a: 1 }), sha256Value({ a: 1, b: 2 }));
  assert.equal(Object.isFrozen(deepFreeze({ nested: { value: true } }).nested), true);
});
