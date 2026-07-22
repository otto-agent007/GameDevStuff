import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { writeImmutableBytes, writeImmutableJson } from '../scripts/lib/artifacts.mjs';
import { createProject, createRun } from '../scripts/lib/run-contract.mjs';
import { sha256Value } from '../scripts/lib/schema.mjs';
import { startStudioServer } from '../scripts/studio/server.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectFixture = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');
const cliPath = path.join(packageDir, 'scripts', 'cli.mjs');

async function studioFixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-studio-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const projectRoot = path.join(parent, 'project');
  const project = await createProject({ root: projectRoot, contractFile: projectFixture });
  const run = await createRun({
    projectRoot,
    project,
    sourceRequest: { actionId: 'idle', kind: 'png-sequence' }
  });
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 0.75 } }
  }).png().toBuffer();
  const frame = await writeImmutableBytes({
    root: run.root,
    relative: 'work/decoded/studio-frame.png',
    bytes: png
  });
  const manifest = {
    kind: 'png-sequence',
    sourceSha256: 'a'.repeat(64),
    decoder: { name: 'studio-fixture', version: '1', arguments: [] },
    canvas: { width: 2, height: 2 },
    alpha: true,
    timeBase: { numerator: 1, denominator: 1000 },
    frames: [{
      index: 0,
      id: 'studio-frame',
      path: frame.relative,
      sha256: frame.sha256,
      width: 2,
      height: 2,
      timestampMs: 0,
      durationMs: 100,
      sourceRect: { x: 0, y: 0, width: 2, height: 2 },
      duplicateOf: null
    }],
    diagnostics: [{ code: 'ALPHA_PRESENT', frameId: null }],
    approval: null
  };
  await writeImmutableJson({ root: run.root, relative: 'reports/source.json', value: manifest });
  return { parent, projectRoot, project, run, frame, manifest };
}

async function responseJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function mutationHeaders(origin, editSha256, extra = {}) {
  return {
    Origin: origin,
    'Content-Type': 'application/json',
    'If-Match': editSha256,
    ...extra
  };
}

test('studio binds only to loopback and exposes a hash-bound session', async (t) => {
  const fixture = await studioFixture(t);
  await assert.rejects(
    startStudioServer({ projectDir: fixture.projectRoot, runId: fixture.run.id, stage: 'selection', host: '0.0.0.0' }),
    /loopback/
  );
  await assert.rejects(
    startStudioServer({ projectDir: fixture.projectRoot, runId: fixture.run.id, stage: 'unknown' }),
    /studio stage/
  );

  const studio = await startStudioServer({ projectDir: fixture.projectRoot, runId: fixture.run.id, stage: 'selection' });
  t.after(() => studio.close());
  assert.match(studio.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const { response, body } = await responseJson(`${studio.origin}/api/session`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; img-src 'self' blob:; connect-src 'self'");
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.runId, fixture.run.id);
  assert.equal(body.stage, 'selection');
  assert.equal(body.sourceSha256, sha256Value(fixture.manifest));
  assert.equal(body.editRevision, 0);
  assert.match(body.editSha256, /^[a-f0-9]{64}$/);
});

test('studio serves only immutable frames allowlisted by the review manifest', async (t) => {
  const fixture = await studioFixture(t);
  const studio = await startStudioServer({ projectDir: fixture.projectRoot, runId: fixture.run.id, stage: 'selection' });
  t.after(() => studio.close());

  const frame = await fetch(`${studio.origin}/api/frame/${fixture.frame.sha256}`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await frame.arrayBuffer()), await fs.readFile(fixture.frame.path));

  assert.equal((await fetch(`${studio.origin}/api/frame/${'f'.repeat(64)}`)).status, 404);
  assert.equal((await fetch(`${studio.origin}/api/frame/%2e%2e%2freports%2fsource.json`)).status, 404);

  await fs.appendFile(fixture.frame.path, Buffer.from([0]));
  const changed = await responseJson(`${studio.origin}/api/frame/${fixture.frame.sha256}`);
  assert.equal(changed.response.status, 409);
  assert.match(changed.body.error, /frame hash mismatch/);
});

test('studio accepts duplicate source frames that share immutable bytes', async (t) => {
  const fixture = await studioFixture(t);
  const duplicateManifest = structuredClone(fixture.manifest);
  duplicateManifest.frames.push({
    ...structuredClone(duplicateManifest.frames[0]),
    index: 1,
    id: 'studio-frame-duplicate',
    timestampMs: 100,
    duplicateOf: 'studio-frame'
  });
  const studio = await startStudioServer({
    projectDir: fixture.projectRoot,
    runId: fixture.run.id,
    stage: 'selection',
    reviewManifest: duplicateManifest
  });
  t.after(() => studio.close());
  const session = (await responseJson(`${studio.origin}/api/session`)).body;
  assert.equal(session.source.frames.length, 2);
  assert.equal((await fetch(`${studio.origin}/api/frame/${fixture.frame.sha256}`)).status, 200);
});

test('studio rejects unsafe methods, content types, origins, bodies, and stale edits', async (t) => {
  const fixture = await studioFixture(t);
  const studio = await startStudioServer({ projectDir: fixture.projectRoot, runId: fixture.run.id, stage: 'selection' });
  t.after(() => studio.close());
  const session = (await responseJson(`${studio.origin}/api/session`)).body;

  assert.equal((await fetch(`${studio.origin}/api/session`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${studio.origin}/api/edits`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${studio.origin}/api/edits`, {
    method: 'PUT',
    headers: { Origin: studio.origin, 'If-Match': session.editSha256 },
    body: '{}'
  })).status, 415);
  assert.equal((await fetch(`${studio.origin}/api/edits`, {
    method: 'PUT',
    headers: mutationHeaders('https://attacker.invalid', session.editSha256),
    body: '{}'
  })).status, 403);
  assert.equal((await fetch(`${studio.origin}/api/edits`, {
    method: 'PUT',
    headers: mutationHeaders(studio.origin, session.editSha256),
    body: JSON.stringify({ payload: 'x'.repeat(1024 * 1024) })
  })).status, 413);

  const edit = { schemaVersion: 1, frames: [{ frameId: 'studio-frame', included: true }] };
  const first = await responseJson(`${studio.origin}/api/edits`, {
    method: 'PUT',
    headers: mutationHeaders(studio.origin, session.editSha256),
    body: JSON.stringify(edit)
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.revision, 1);
  assert.match(first.body.sha256, /^[a-f0-9]{64}$/);

  const stale = await responseJson(`${studio.origin}/api/edits`, {
    method: 'PUT',
    headers: mutationHeaders(studio.origin, session.editSha256),
    body: JSON.stringify(edit)
  });
  assert.equal(stale.response.status, 409);
  assert.match(stale.body.error, /stale edit/);

  const saved = JSON.parse(await fs.readFile(path.join(fixture.run.root, 'edits', 'studio-edit-0001.json'), 'utf8'));
  assert.deepEqual(saved.edit, edit);
  assert.equal(saved.previousSha256, session.editSha256);
});

test('studio serializes concurrent edits so one stale writer loses', async (t) => {
  const fixture = await studioFixture(t);
  const studio = await startStudioServer({ projectDir: fixture.projectRoot, runId: fixture.run.id, stage: 'selection' });
  t.after(() => studio.close());
  const session = (await responseJson(`${studio.origin}/api/session`)).body;
  const request = (label) => fetch(`${studio.origin}/api/edits`, {
    method: 'PUT',
    headers: mutationHeaders(studio.origin, session.editSha256),
    body: JSON.stringify({ schemaVersion: 1, label })
  });
  const responses = await Promise.all([request('first'), request('second')]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
  assert.deepEqual(await fs.readdir(path.join(fixture.run.root, 'edits')), ['studio-edit-0001.json']);
});

test('studio approval endpoint writes an immutable revision against the current edit', async (t) => {
  const fixture = await studioFixture(t);
  const studio = await startStudioServer({ projectDir: fixture.projectRoot, runId: fixture.run.id, stage: 'selection' });
  t.after(() => studio.close());
  const session = (await responseJson(`${studio.origin}/api/session`)).body;
  const approval = await responseJson(`${studio.origin}/api/approval`, {
    method: 'POST',
    headers: mutationHeaders(studio.origin, session.editSha256),
    body: JSON.stringify({ decision: 'pending-task-10' })
  });
  assert.equal(approval.response.status, 200);
  assert.equal(approval.body.revision, 1);
  assert.match(approval.body.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await fs.lstat(path.join(fixture.run.root, 'approved', 'studio-approval-0001.json'))).isFile(), true);
});

test('studio CLI prints readiness once and closes on SIGTERM without edits', async (t) => {
  const fixture = await studioFixture(t);
  const child = spawn(process.execPath, [
    cliPath,
    'studio',
    '--project-dir', fixture.projectRoot,
    '--run', fixture.run.id
  ], { cwd: packageDir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`studio CLI readiness timeout: ${stderr}`)), 3000);
    child.stdout.on('data', () => {
      const line = stdout.split('\n').find(Boolean);
      if (!line) return;
      clearTimeout(timeout);
      resolve(JSON.parse(line));
    });
    child.once('exit', (code) => reject(new Error(`studio CLI exited early ${code}: ${stderr}`)));
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.runId, fixture.run.id);
  assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  child.kill('SIGTERM');
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(exit.code, 0);
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.deepEqual(await fs.readdir(path.join(fixture.run.root, 'edits')), []);
});
