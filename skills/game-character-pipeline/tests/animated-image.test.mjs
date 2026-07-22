import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

import { decodeAnimatedImage } from '../scripts/lib/animated-image.mjs';
import { inspectApng } from '../scripts/lib/apng-container.mjs';
import { inspectGif } from '../scripts/lib/gif-container.mjs';
import { createProject, createRun } from '../scripts/lib/run-contract.mjs';
import { inspectAnimatedWebp } from '../scripts/lib/webp-container.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFile = promisify(execFileCallback);
const cliPath = path.join(packageDir, 'scripts', 'cli.mjs');
const projectFixture = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');
const fixtureRoot = path.join(packageDir, 'tests', 'fixtures', 'animated');

function fixture(name) {
  return path.join(fixtureRoot, name);
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function rewritePngChunks(input, rewrite) {
  const bytes = Buffer.from(input);
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    const type = bytes.subarray(typeStart, dataStart).toString('ascii');
    rewrite(type, bytes.subarray(dataStart, crcOffset));
    bytes.writeUInt32BE(crc32(bytes.subarray(typeStart, crcOffset)), crcOffset);
    offset = crcOffset + 4;
  }
  return bytes;
}

async function freshRun(t, kind) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `game-character-animated-${kind}-`));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const projectRoot = path.join(parent, 'project');
  const project = await createProject({ root: projectRoot, contractFile: projectFixture });
  return createRun({ projectRoot, project, sourceRequest: { actionId: 'idle', kind } });
}

async function rgbaAt(run, frame, x, y) {
  const { data } = await sharp(path.join(run.root, frame.path))
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data.toString('hex');
}

test('container parsers preserve frame rectangles, timing, disposal, and blend metadata', async () => {
  const gif = inspectGif(await fs.readFile(fixture('disposal-previous.gif')));
  assert.deepEqual(gif.frames.map(({ durationMs }) => durationMs), [70, 130, 90]);
  assert.equal(gif.frames.some(({ dispose }) => dispose === 'previous'), true);
  assert.equal(gif.frames.some(({ rect }) => rect.width < gif.canvas.width || rect.height < gif.canvas.height), true);

  const apng = inspectApng(await fs.readFile(fixture('alpha.apng.png')));
  assert.deepEqual(apng.frames.map(({ durationMs }) => durationMs), [80, 120]);
  assert.equal(apng.frames.every(({ hasAlpha }) => hasAlpha), true);
  assert.deepEqual(apng.frames.map(({ blend }) => blend), ['source', 'over']);

  const webp = inspectAnimatedWebp(await fs.readFile(fixture('alpha.webp')));
  assert.deepEqual(webp.frames.map(({ durationMs }) => durationMs), [60, 140]);
  assert.equal(webp.frames.every(({ hasAlpha }) => hasAlpha), true);
  assert.deepEqual(webp.frames.map(({ blend }) => blend), ['source', 'over']);
});

test('GIF disposal restores prior composited pixels and retains delays', async (t) => {
  const run = await freshRun(t, 'gif');
  const result = await decodeAnimatedImage({ source: fixture('disposal-previous.gif'), run });
  assert.deepEqual(result.frames.map(({ durationMs }) => durationMs), [70, 130, 90]);
  assert.equal(await rgbaAt(run, result.frames[2], 3, 3), '00000000');
  assert.equal(result.diagnostics.some(({ code }) => code === 'PARTIAL_SOURCE_RECT'), true);
  assert.equal(result.diagnostics.some(({ code }) => code === 'DISPOSAL_RESTORE_PREVIOUS'), true);
});

test('APNG and WebP publish full composited RGBA pages with alpha', async (t) => {
  for (const [name, kind] of [['alpha.apng.png', 'apng'], ['alpha.webp', 'webp']]) {
    const run = await freshRun(t, kind);
    const result = await decodeAnimatedImage({ source: fixture(name), run });
    assert.equal(result.kind, kind);
    assert.equal(result.alpha, true);
    assert.equal(result.frames.every((frame) => frame.width === result.canvas.width), true);
    assert.equal(result.frames.every((frame) => frame.height === result.canvas.height), true);
    assert.match(result.decoder.version, /^sharp=.*;vips=/);
  }
});

test('animated image intake reports duplicates and empty composited frames', async (t) => {
  const run = await freshRun(t, 'gif');
  const result = await decodeAnimatedImage({ source: fixture('duplicates-empty.gif'), run });
  assert.equal(result.diagnostics.some(({ code }) => code === 'DUPLICATE_FRAME'), true);
  assert.equal(result.diagnostics.some(({ code }) => code === 'EMPTY_FRAME'), true);
});

test('container corruption, zero delays, and changed bytes fail closed', async (t) => {
  const gif = await fs.readFile(fixture('disposal-previous.gif'));
  assert.throws(() => inspectGif(gif.subarray(0, gif.length - 1)), /truncated|trailer/);
  const zeroDelayGif = await fs.readFile(fixture('zero-delay.gif'));
  assert.throws(() => inspectGif(zeroDelayGif), /zero frame delay/);

  const apng = await fs.readFile(fixture('alpha.apng.png'));
  const corruptApng = Buffer.from(apng);
  corruptApng[corruptApng.length - 8] ^= 1;
  assert.throws(() => inspectApng(corruptApng), /CRC|IEND/);

  const webp = await fs.readFile(fixture('alpha.webp'));
  assert.throws(() => inspectAnimatedWebp(webp.subarray(0, webp.length - 2)), /RIFF|truncated/);

  const run = await freshRun(t, 'gif');
  const source = path.join(path.dirname(run.root), 'changed.gif');
  await fs.copyFile(fixture('disposal-previous.gif'), source);
  await decodeAnimatedImage({ source, run });
  await fs.appendFile(source, Buffer.from([0]));
  await assert.rejects(decodeAnimatedImage({ source, run }), /immutable artifact differs|GIF.*trailer|source/);
});

test('container parsers reject out-of-bounds frames and reserved flags', async () => {
  const gif = Buffer.from(await fs.readFile(fixture('disposal-previous.gif')));
  gif.writeUInt16LE(3, 6);
  assert.throws(() => inspectGif(gif), /rectangle exceeds/);

  const webp = Buffer.from(await fs.readFile(fixture('alpha.webp')));
  const secondFrame = webp.indexOf(Buffer.from('ANMF'), webp.indexOf(Buffer.from('ANMF')) + 4);
  webp[secondFrame + 8 + 15] |= 0x80;
  assert.throws(() => inspectAnimatedWebp(webp), /reserved bits/);

  const apng = rewritePngChunks(await fs.readFile(fixture('alpha.apng.png')), (type, data) => {
    if (type === 'acTL') data.writeUInt32BE(3, 0);
  });
  assert.throws(() => inspectApng(apng), /frame-count disagreement/);
});

test('animated image intake enforces the decoded RGBA memory bound before decoding', async (t) => {
  const oversized = rewritePngChunks(await fs.readFile(fixture('alpha.apng.png')), (type, data) => {
    if (type === 'IHDR') {
      data.writeUInt32BE(8193, 0);
      data.writeUInt32BE(8193, 4);
    }
    if (type === 'fcTL') {
      data.writeUInt32BE(8193, 4);
      data.writeUInt32BE(8193, 8);
    }
  });
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-animated-bound-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'oversized.png');
  await fs.writeFile(source, oversized);
  const run = await freshRun(t, 'apng');
  await assert.rejects(decodeAnimatedImage({ source, run }), /512 MiB decoded RGBA limit/);
});

test('CLI decodes animated sources through the closed adapter and publishes a report', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-animated-cli-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const projectRoot = path.join(parent, 'project');
  await execFile(process.execPath, [cliPath, 'init', '--contract', projectFixture, '--project-dir', projectRoot]);
  const decoded = await execFile(process.execPath, [
    cliPath,
    'intake',
    '--project-dir', projectRoot,
    '--action', 'idle',
    '--kind', 'gif',
    '--source', fixture('disposal-previous.gif')
  ]);
  const result = JSON.parse(decoded.stdout);
  assert.equal(result.status, 'intake-complete');
  const reportPath = path.join(projectRoot, '.game-character-pipeline', 'runs', result.runId, 'reports', 'source.json');
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.equal(report.kind, 'gif');
  assert.equal(report.frames.length, 3);
});
