import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compareRuns } from '../scripts/lib/audit.mjs';
import { runClockworkCourier } from '../examples/clockwork-courier/run-fixture.mjs';
import { sha256Value } from '../scripts/lib/schema.mjs';

async function tempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('Clockwork Courier completes the public workflow reproducibly', async (t) => {
  const leftRoot = await tempRoot('courier-a-');
  const rightRoot = await tempRoot('courier-b-');
  t.after(() => Promise.all([leftRoot, rightRoot].map((root) => fs.rm(root, { recursive: true, force: true }))));
  const first = await runClockworkCourier(leftRoot);
  const second = await runClockworkCourier(rightRoot);
  const expected = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, '..', 'examples', 'clockwork-courier', 'expected-audit.json'), 'utf8'));
  assert.equal(first.audit.passed, true, JSON.stringify(first.audit.failures));
  assert.equal(second.audit.passed, true, JSON.stringify(second.audit.failures));
  assert.deepEqual(compareRuns(first.audit, second.audit).changedDeterministicArtifacts, []);
  assert.deepEqual(first.exports.clips.map(({ id, loopMode }) => [id, loopMode]), [['idle', 'loop'], ['walk', 'loop'], ['unlock', 'hold-last']]);
  assert.equal(sha256Value(first.audit.deterministicHashes), expected.deterministicHashesSha256);
  assert.deepEqual(first.exports.clips.map(({ id, loopMode }) => [id, loopMode]), expected.clips);
  if (process.env.ACCEPTANCE_ARTIFACT_DIR) {
    const artifactRoot = path.resolve(process.env.ACCEPTANCE_ARTIFACT_DIR);
    await fs.mkdir(artifactRoot, { recursive: true });
    await fs.writeFile(path.join(artifactRoot, 'audit.json'), JSON.stringify(first.audit, null, 2));
    const exportRoot = path.join(leftRoot, 'run', 'exports', 'revision-0001');
    for (const relative of [
      'export/clips/idle/idle-contact-sheet.png', 'export/clips/idle/idle.webp',
      'export/clips/walk/walk-contact-sheet.png', 'export/clips/walk/walk.webp',
      'export/clips/unlock/unlock-contact-sheet.png', 'export/clips/unlock/unlock.webp'
    ]) {
      const target = path.join(artifactRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(exportRoot, relative), target);
    }
  }
});
