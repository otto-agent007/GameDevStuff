import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSignedState, stableHash, writeSignedState } from '../scripts/lib/state-auth.mjs';

async function secureProject(prefix) {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(projectDir, '.pixel-sprite-pipeline');
  await fs.mkdir(stateDir, { mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(stateDir, 0o700);
  return projectDir;
}

test('signed state is domain-separated and fails after payload tampering', async () => {
  const projectDir = await secureProject('state-auth-');
  const file = path.join(projectDir, '.pixel-sprite-pipeline', 'receipt.json');
  await writeSignedState({ projectDir, file, domain: 'pixel-sprite-snap/v1', payload: { runId: 'run-1' }, createKey: true });
  assert.deepEqual((await readSignedState({ projectDir, file, domain: 'pixel-sprite-snap/v1' })).payload, { runId: 'run-1' });
  const changed = JSON.parse(await fs.readFile(file, 'utf8'));
  changed.payload.runId = 'run-2';
  await fs.writeFile(file, JSON.stringify(changed));
  await assert.rejects(readSignedState({ projectDir, file, domain: 'pixel-sprite-snap/v1' }), /signature mismatch/);
});

test('signed state cannot be verified in another domain', async () => {
  const projectDir = await secureProject('state-domain-');
  const file = path.join(projectDir, '.pixel-sprite-pipeline', 'receipt.json');
  await writeSignedState({ projectDir, file, domain: 'pixel-sprite-snap/v1', payload: { runId: 'run-1' }, createKey: true });
  await assert.rejects(readSignedState({ projectDir, file, domain: 'pixel-sprite-correction-receipt/v1' }), /signature mismatch/);
});

test('stable hashes ignore object key insertion order', () => {
  assert.equal(stableHash({ beta: 2, alpha: { second: 2, first: 1 } }), stableHash({ alpha: { first: 1, second: 2 }, beta: 2 }));
});
