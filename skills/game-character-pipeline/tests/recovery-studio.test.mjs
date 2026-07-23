import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { recoverPoseBoard } from '../scripts/lib/pose-board.mjs';
import { createProject, createRun } from '../scripts/lib/run-contract.mjs';
import { startRecoveryStudioServer } from '../scripts/studio/recovery-server.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectFixture = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');
const BACKGROUND = [0, 255, 0, 255];

function writePixel(pixels, width, x, y, rgba) {
  pixels.set(rgba, ((y * width) + x) * 4);
}

async function writeBoard(file) {
  const width = 12;
  const height = 8;
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(BACKGROUND, offset);
  for (const [color, points] of [
    [[214, 30, 42, 255], [[4, 1], [5, 1], [6, 1], [7, 1], [5, 2], [6, 2]]],
    [[44, 77, 221, 255], [[0, 4], [1, 4], [2, 4], [1, 5]]],
    [[248, 198, 34, 255], [[9, 5], [10, 5], [9, 6], [10, 6]]]
  ]) {
    for (const [x, y] of points) writePixel(pixels, width, x, y, color);
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(file);
}

async function recoveryFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-recovery-studio-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'board.png');
  const contract = path.join(root, 'recovery.json');
  await writeBoard(source);
  await fs.writeFile(contract, JSON.stringify({
    schemaVersion: 1,
    background: { mode: 'color', rgba: BACKGROUND, tolerance: 8 },
    connectivity: 4,
    minimumComponentPixels: 4,
    maxDecodedRgbaBytes: 1024 * 1024,
    padding: 2,
    expectedCandidates: { min: 3, max: 3 },
    allowUnassigned: false,
    groups: []
  }));
  const projectRoot = path.join(root, 'project');
  const project = await createProject({ root: projectRoot, contractFile: projectFixture });
  const run = await createRun({
    projectRoot,
    project,
    sourceRequest: { actionId: 'idle', kind: 'pose-board' }
  });
  const recovery = await recoverPoseBoard({
    source,
    recoveryContract: contract,
    run,
    project
  });
  return { root, projectRoot, project, run, recovery };
}

function mutationHeaders(origin, sha256) {
  return {
    Origin: origin,
    'Content-Type': 'application/json',
    'If-Match': sha256
  };
}

async function responseJson(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

function selectionValue(fixture) {
  return {
    schemaVersion: 1,
    kind: 'pose-board-selection',
    projectSha256: fixture.project.sha256,
    runId: fixture.run.id,
    actionId: 'idle',
    recoverySha256: fixture.recovery.sha256,
    frames: fixture.recovery.document.candidates.map((candidate, index) => ({
      id: `stride-${String(index + 1).padStart(2, '0')}`,
      candidateId: candidate.id,
      durationMs: 80 + (index * 20),
      tracks: [{ role: 'actor', componentIds: candidate.componentIds }]
    }))
  };
}

test('recovery Studio is loopback-only and publishes a no-store recovery session', async (t) => {
  const fixture = await recoveryFixture(t);
  await assert.rejects(
    startRecoveryStudioServer({
      projectDir: fixture.projectRoot,
      runId: fixture.run.id,
      host: '0.0.0.0'
    }),
    /loopback/
  );
  const studio = await startRecoveryStudioServer({
    projectDir: fixture.projectRoot,
    runId: fixture.run.id
  });
  t.after(() => studio.close());
  assert.match(studio.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  const { response, body } = await responseJson(`${studio.origin}/api/recovery-session`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(
    response.headers.get('content-security-policy'),
    "default-src 'self'; img-src 'self' blob:; connect-src 'self'"
  );
  assert.equal(body.stage, 'recovery');
  assert.equal(body.runId, fixture.run.id);
  assert.equal(body.recoverySha256, fixture.recovery.sha256);
  assert.equal(body.selectionRevision, 0);
  assert.match(body.selectionSha256, /^[a-f0-9]{64}$/);
});

test('recovery Studio only serves hash-allowlisted immutable images', async (t) => {
  const fixture = await recoveryFixture(t);
  const studio = await startRecoveryStudioServer({
    projectDir: fixture.projectRoot,
    runId: fixture.run.id
  });
  t.after(() => studio.close());
  const candidate = fixture.recovery.document.candidates[0];
  const image = await fetch(`${studio.origin}/api/candidate/${candidate.sha256}`);
  assert.equal(image.status, 200);
  assert.deepEqual(
    Buffer.from(await image.arrayBuffer()),
    await fs.readFile(path.join(fixture.run.root, candidate.path))
  );
  const overlay = await fetch(
    `${studio.origin}/api/overlay/${fixture.recovery.document.overlay.sha256}`
  );
  assert.equal(overlay.status, 200);
  assert.equal((await fetch(`${studio.origin}/api/candidate/${'f'.repeat(64)}`)).status, 404);
  assert.equal(
    (await fetch(`${studio.origin}/api/candidate/%2e%2e%2freports%2fpose-board-recovery.json`)).status,
    404
  );

  await fs.appendFile(path.join(fixture.run.root, candidate.path), Buffer.from([0]));
  const changed = await responseJson(`${studio.origin}/api/candidate/${candidate.sha256}`);
  assert.equal(changed.response.status, 409);
  assert.match(changed.body.error, /hash mismatch/);
});

test('recovery Studio rejects unsafe mutations and serializes selection revisions', async (t) => {
  const fixture = await recoveryFixture(t);
  const studio = await startRecoveryStudioServer({
    projectDir: fixture.projectRoot,
    runId: fixture.run.id
  });
  t.after(() => studio.close());
  const session = (await responseJson(`${studio.origin}/api/recovery-session`)).body;
  const selection = selectionValue(fixture);

  assert.equal(
    (await fetch(`${studio.origin}/api/recovery-session`, { method: 'POST' })).status,
    405
  );
  assert.equal((await fetch(`${studio.origin}/api/pose-selections`, {
    method: 'PUT',
    headers: { Origin: studio.origin, 'If-Match': session.selectionSha256 },
    body: '{}'
  })).status, 415);
  assert.equal((await fetch(`${studio.origin}/api/pose-selections`, {
    method: 'PUT',
    headers: mutationHeaders('https://attacker.invalid', session.selectionSha256),
    body: JSON.stringify(selection)
  })).status, 403);
  assert.equal((await fetch(`${studio.origin}/api/pose-selections`, {
    method: 'PUT',
    headers: mutationHeaders(studio.origin, session.selectionSha256),
    body: JSON.stringify({ payload: 'x'.repeat(1024 * 1024) })
  })).status, 413);

  const request = () => responseJson(`${studio.origin}/api/pose-selections`, {
    method: 'PUT',
    headers: mutationHeaders(studio.origin, session.selectionSha256),
    body: JSON.stringify(selection)
  });
  const concurrent = await Promise.all([request(), request()]);
  assert.deepEqual(
    concurrent.map(({ response }) => response.status).sort(),
    [200, 409]
  );
  const saved = concurrent.find(({ response }) => response.status === 200).body;
  assert.equal(saved.revision, 1);
  assert.match(saved.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    await fs.readdir(path.join(fixture.run.root, 'edits')),
    ['pose-selection-0001.json']
  );

  const approval = await responseJson(`${studio.origin}/api/pose-selection-approval`, {
    method: 'POST',
    headers: mutationHeaders(studio.origin, saved.sha256),
    body: JSON.stringify({
      approver: 'owner',
      decision: 'approved',
      notes: 'Reviewed in recovery Studio.'
    })
  });
  assert.equal(approval.response.status, 200);
  assert.equal(approval.body.decision, 'approved');
  assert.equal(
    (await fs.lstat(path.join(
      fixture.run.root,
      'approved',
      'pose-selection-approval-0001.json'
    ))).isFile(),
    true
  );
});
