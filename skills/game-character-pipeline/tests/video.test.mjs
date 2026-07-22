import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createProject, createRun } from '../scripts/lib/run-contract.mjs';
import { decodeVideo, inspectMediaTool, mediaToolInvocation } from '../scripts/lib/video.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFile = promisify(execFileCallback);
const cliPath = path.join(packageDir, 'scripts', 'cli.mjs');
const projectFixture = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');
const fixtureRoot = path.join(packageDir, 'tests', 'fixtures', 'video');
const fakeFfmpeg = path.join(fixtureRoot, 'fake-ffmpeg.mjs');

test('JavaScript media tool fixtures use the current Node executable portably', () => {
  assert.deepEqual(mediaToolInvocation(fakeFfmpeg, ['-version']), {
    file: process.execPath,
    args: [fakeFfmpeg, '-version']
  });
});

async function freshRun(t, kind = 'webm') {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `game-character-video-${kind}-`));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const projectRoot = path.join(parent, 'project');
  const project = await createProject({ root: projectRoot, contractFile: projectFixture });
  const run = await createRun({ projectRoot, project, sourceRequest: { actionId: 'idle', kind } });
  return { parent, projectRoot, run };
}

test('video intake derives nonuniform durations from presentation timestamps', async (t) => {
  const { run } = await freshRun(t);
  const expected = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'expected.json'), 'utf8'));
  const result = await decodeVideo({
    source: path.join(fixtureRoot, 'variable-rate.webm'),
    run,
    ffmpegPath: fakeFfmpeg
  });
  assert.deepEqual(result.frames.map(({ timestampMs }) => timestampMs), expected.timestampsMs);
  assert.deepEqual(result.frames.map(({ durationMs }) => durationMs), expected.durationsMs);
  assert.equal(result.frames.every(({ width }) => width === expected.width), true);
  assert.equal(result.frames.every(({ height }) => height === expected.height), true);
  assert.equal(result.diagnostics.some(({ code }) => code === 'VARIABLE_FRAME_RATE'), true);
  assert.equal(result.diagnostics.some(({ code }) => code === 'DUPLICATE_FRAME'), true);
  assert.equal(result.diagnostics.some(({ code }) => code === 'EMPTY_FRAME'), true);

  const retried = await decodeVideo({
    source: path.join(fixtureRoot, 'variable-rate.webm'),
    run,
    ffmpegPath: fakeFfmpeg
  });
  assert.deepEqual(retried.frames.map(({ sha256 }) => sha256), result.frames.map(({ sha256 }) => sha256));
});

test('video intake rejects missing presentation timestamps', async (t) => {
  const { parent, run } = await freshRun(t);
  const source = path.join(parent, 'missing-timestamps.webm');
  await fs.copyFile(path.join(fixtureRoot, 'variable-rate.webm'), source);
  await fs.appendFile(source, Buffer.from('missing-timestamps'));
  await assert.rejects(decodeVideo({ source, run, ffmpegPath: fakeFfmpeg }), /presentation timestamp/);
});

test('media tool inspection binds executable bytes and rejects a changed probe', async (t) => {
  const identity = await inspectMediaTool(fakeFfmpeg, 'ffmpeg');
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);
  assert.equal(identity.path, fakeFfmpeg);
  assert.match(identity.version, /^ffmpeg version/);

  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-changing-tool-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const changing = path.join(parent, 'ffmpeg.mjs');
  await fs.writeFile(changing, `import fs from 'node:fs';\nprocess.stdout.write('ffmpeg version changing\\n');\nfs.appendFileSync(process.argv[1], '\\n');\n`);
  await fs.chmod(changing, 0o700);
  await assert.rejects(inspectMediaTool(changing, 'ffmpeg'), /tool identity changed/);
});

test('missing media tools produce a structured exit-2 handoff', async (t) => {
  const { run } = await freshRun(t);
  await assert.rejects(
    decodeVideo({
      source: path.join(fixtureRoot, 'variable-rate.webm'),
      run,
      ffmpegPath: path.join(fixtureRoot, 'absent-ffmpeg')
    }),
    (error) => error.exitCode === 2 && error.handoff?.status === 'awaiting-media-tool'
  );
});

test('CLI emits the structured media-tool handoff on stdout with exit 2', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-video-cli-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const projectRoot = path.join(parent, 'project');
  await execFile(process.execPath, [cliPath, 'init', '--contract', projectFixture, '--project-dir', projectRoot]);
  let failure;
  try {
    await execFile(process.execPath, [
      cliPath,
      'intake',
      '--project-dir', projectRoot,
      '--action', 'idle',
      '--kind', 'webm',
      '--source', path.join(fixtureRoot, 'variable-rate.webm'),
      '--ffmpeg', path.join(fixtureRoot, 'absent-ffmpeg')
    ]);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, 2);
  const handoff = JSON.parse(failure.stdout);
  assert.equal(handoff.status, 'awaiting-media-tool');
  assert.match(handoff.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(handoff.runId, /^run-/);

  const resumed = await execFile(process.execPath, [
    cliPath,
    'intake',
    '--resume', handoff.runId,
    '--project-dir', projectRoot,
    '--action', 'idle',
    '--kind', 'webm',
    '--source', path.join(fixtureRoot, 'variable-rate.webm'),
    '--ffmpeg', fakeFfmpeg
  ]);
  const result = JSON.parse(resumed.stdout);
  assert.equal(result.status, 'intake-complete');
  const report = JSON.parse(await fs.readFile(path.join(
    projectRoot,
    '.game-character-pipeline',
    'runs',
    handoff.runId,
    'reports',
    'source.json'
  ), 'utf8'));
  assert.deepEqual(report.frames.map(({ timestampMs }) => timestampMs), [0, 40, 140, 180]);
});

test('video intake rejects decode corruption and immutable source changes', async (t) => {
  const corrupt = await freshRun(t);
  const corruptSource = path.join(corrupt.parent, 'corrupt.webm');
  await fs.copyFile(path.join(fixtureRoot, 'variable-rate.webm'), corruptSource);
  await fs.appendFile(corruptSource, Buffer.from('corrupt'));
  await assert.rejects(decodeVideo({ source: corruptSource, run: corrupt.run, ffmpegPath: fakeFfmpeg }), /decode corruption/);

  const changed = await freshRun(t);
  const changedSource = path.join(changed.parent, 'changed.webm');
  await fs.copyFile(path.join(fixtureRoot, 'variable-rate.webm'), changedSource);
  await decodeVideo({ source: changedSource, run: changed.run, ffmpegPath: fakeFfmpeg });
  await fs.appendFile(changedSource, Buffer.from('changed'));
  await assert.rejects(
    decodeVideo({ source: changedSource, run: changed.run, ffmpegPath: fakeFfmpeg }),
    /immutable artifact differs/
  );
});
