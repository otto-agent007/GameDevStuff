import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyImmutable, writeRevision } from '../scripts/lib/artifacts.mjs';
import { sha256File, sha256Value } from '../scripts/lib/schema.mjs';

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-artifacts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  return root;
}

test('immutable copy publishes one contained file and permits only an identical retry', async (t) => {
  const root = await sandbox(t);
  const source = path.join(root, 'candidate.bin');
  await fs.writeFile(source, Buffer.from('first-candidate'));

  const first = await copyImmutable({ source, root, relative: 'source/candidate.bin' });
  const retry = await copyImmutable({ source, root, relative: 'source/candidate.bin' });
  assert.equal(first.sha256, await sha256File(source));
  assert.equal(retry.reused, true);

  await fs.writeFile(source, Buffer.from('changed-candidate'));
  await assert.rejects(
    copyImmutable({ source, root, relative: 'source/candidate.bin' }),
    /existing immutable artifact differs/
  );
  assert.equal(await fs.readFile(first.path, 'utf8'), 'first-candidate');
});

test('immutable copy rejects symlinks, hard links, traversal, and linked targets', async (t) => {
  const root = await sandbox(t);
  const outside = path.join(root, 'outside.bin');
  await fs.writeFile(outside, 'outside');
  const symlink = path.join(root, 'source-link.bin');
  await fs.symlink(outside, symlink);
  await assert.rejects(copyImmutable({ source: symlink, root, relative: 'source/a.bin' }), /regular single-link file/);

  const hardSource = path.join(root, 'hard-source.bin');
  const hardAlias = path.join(root, 'hard-alias.bin');
  await fs.writeFile(hardSource, 'hard');
  await fs.link(hardSource, hardAlias);
  await assert.rejects(copyImmutable({ source: hardSource, root, relative: 'source/b.bin' }), /regular single-link file/);
  await assert.rejects(copyImmutable({ source: outside, root, relative: '../escape.bin' }), /portable relative path/);

  const published = await copyImmutable({ source: outside, root, relative: 'source/c.bin' });
  const targetAlias = path.join(root, 'target-alias.bin');
  await fs.link(published.path, targetAlias);
  await assert.rejects(copyImmutable({ source: outside, root, relative: 'source/c.bin' }), /regular single-link file/);
});

test('revision writes use canonical JSON and allocate immutable sequence numbers', async (t) => {
  const root = await sandbox(t);
  const first = await writeRevision({ root, area: 'edits', stem: 'alignment', value: { b: 2, a: 1 } });
  const second = await writeRevision({ root, area: 'edits', stem: 'alignment', value: { a: 1, b: 2 } });

  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.sha256, sha256Value({ a: 1, b: 2 }));
  assert.equal(await fs.readFile(first.path, 'utf8'), await fs.readFile(second.path, 'utf8'));
  await assert.rejects(fs.writeFile(first.path, 'replacement', { flag: 'wx' }), /EEXIST/);
});

test('revision writes reject unsafe areas and stems before creating files', async (t) => {
  const root = await sandbox(t);
  await assert.rejects(writeRevision({ root, area: '../outside', stem: 'edit', value: {} }), /revision area is invalid/);
  await assert.rejects(writeRevision({ root, area: 'edits', stem: 'CON', value: {} }), /portable ID/);
  assert.deepEqual(await fs.readdir(root), []);
});
