import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { detectPixelSnapper, runPixelSnapper, writeSnapperHandoff } from '../scripts/lib/snapper.mjs';

test('missing Pixel Snapper produces a resumable manifest', async () => {
  const config = { snapper: { executable: 'definitely-not-installed-pixel-snapper', args: ['16'] } };
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-handoff-'));
  const manifest = JSON.parse(await fs.readFile(new URL('./fixtures/tool-manifest.fixture.json', import.meta.url), 'utf8'));
  assert.equal((await detectPixelSnapper(config, { manifest, projectDir: outputDir, env: {}, pathValue: '' })).available, false);
  const result = await writeSnapperHandoff({ inputs: ['frame-00.png'], outputDir, config });

  assert.equal(result.status, 'manual-handoff');
  const handoff = JSON.parse(await fs.readFile(result.handoffPath, 'utf8'));
  assert.equal(handoff.origin, 'manual-handoff');
  assert.equal(handoff.toolProvenanceVerified, false);
  assert.equal(handoff.binary, null);
  assert.equal(handoff.arguments, null);
  assert.deepEqual(handoff.expectedOutputs, ['frame-00-snapped.png']);
  assert.deepEqual(handoff.commandTemplate, ['definitely-not-installed-pixel-snapper', '<INPUT>', '<OUTPUT>', '16']);
  assert.deepEqual(handoff.sourceInputs, ['frame-00.png']);
  assert.equal(handoff.resumeCommand, `pixel-sprite-pipeline normalize --frames ${outputDir}`);
});

test('executable-only Snapper config retains the default grid-size argument', async () => {
  const config = { snapper: { executable: 'custom-pixel-snapper' } };
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-executable-only-'));
  const result = await writeSnapperHandoff({ inputs: ['frame-00.png'], outputDir, config });
  const handoff = JSON.parse(await fs.readFile(result.handoffPath, 'utf8'));

  assert.equal(handoff.executable, 'custom-pixel-snapper');
  assert.deepEqual(handoff.commandTemplate, ['custom-pixel-snapper', '<INPUT>', '<OUTPUT>', '16']);
});

test('args-only Snapper config retains the default executable and command ordering', async () => {
  const config = { snapper: { args: ['--palette', 'limited'] } };
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-args-only-'));
  const result = await writeSnapperHandoff({ inputs: ['frame-00.png'], outputDir, config });
  const handoff = JSON.parse(await fs.readFile(result.handoffPath, 'utf8'));

  assert.equal(handoff.executable, 'spritefusion-pixel-snapper');
  assert.deepEqual(handoff.commandTemplate, [
    'spritefusion-pixel-snapper', '<INPUT>', '<OUTPUT>', '16', '--palette', 'limited'
  ]);
});

test('PIXEL_SNAPPER_BIN overrides a configured executable', async () => {
  const config = { snapper: { executable: 'configured-pixel-snapper', args: ['--palette', 'limited'] } };
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-env-override-'));
  const originalExecutable = process.env.PIXEL_SNAPPER_BIN;
  process.env.PIXEL_SNAPPER_BIN = 'environment-pixel-snapper';
  try {
    const result = await writeSnapperHandoff({ inputs: ['frame-00.png'], outputDir, config });
    const handoff = JSON.parse(await fs.readFile(result.handoffPath, 'utf8'));

    assert.deepEqual(handoff.commandTemplate, [
      'environment-pixel-snapper', '<INPUT>', '<OUTPUT>', '16', '--palette', 'limited'
    ]);
  } finally {
    if (originalExecutable === undefined) delete process.env.PIXEL_SNAPPER_BIN;
    else process.env.PIXEL_SNAPPER_BIN = originalExecutable;
  }
});

test('handoff command uses the resolver environment rather than ambient process state', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-effective-env-'));
  const original = process.env.PIXEL_SNAPPER_BIN;
  process.env.PIXEL_SNAPPER_BIN = 'ambient-pixel-snapper';
  try {
    const result = await writeSnapperHandoff({ inputs: ['frame-00.png'], outputDir, config: { snapper: { executable: 'configured', args: [] } }, env: { PIXEL_SNAPPER_BIN: 'resolved-pixel-snapper' } });
    const handoff = JSON.parse(await fs.readFile(result.handoffPath, 'utf8'));
    assert.equal(handoff.executable, 'resolved-pixel-snapper');
  } finally {
    if (original === undefined) delete process.env.PIXEL_SNAPPER_BIN;
    else process.env.PIXEL_SNAPPER_BIN = original;
  }
});

test('verified snap receipt is published atomically and blocks changed retry identity before execution', { skip: process.platform === 'win32' && 'POSIX executable fixture' }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-receipt-'));
  const outputDir = path.join(projectDir, 'output');
  const input = path.join(projectDir, 'frame.png');
  const marker = path.join(projectDir, 'invoked');
  const executable = path.join(projectDir, 'snapper.mjs');
  await fs.mkdir(path.join(projectDir, '.pixel-sprite-pipeline'), { mode: 0o700 });
  await fs.writeFile(input, 'frame');
  await fs.writeFile(executable, `#!/usr/bin/env node\nimport fs from 'node:fs/promises';\nconst [input, output] = process.argv.slice(2); await fs.copyFile(input, output); await fs.appendFile(${JSON.stringify(marker)}, 'x');\n`, { mode: 0o700 });
  const identity = { origin: 'environment', path: executable, physicalPath: executable, sha256: 'a'.repeat(64), version: 'test', helpSha256: 'b'.repeat(64), fixtureRgbaSha256: 'c'.repeat(64), size: 1 };
  const run = { id: 'run-1', outputDir, manifestSha256: 'd'.repeat(64) };
  const contract = { sha256: 'e'.repeat(64) };
  const first = await runPixelSnapper({ inputs: [input], outputDir, config: { snapper: { args: [] } }, identity, receipt: { projectDir, run, contract } });
  assert.equal(first.status, 'complete');
  await fs.access(path.join(outputDir, 'snap-receipt.json'));
  await assert.rejects(runPixelSnapper({ inputs: [input], outputDir, config: { snapper: { args: [] } }, identity: { ...identity, sha256: 'f'.repeat(64) }, receipt: { projectDir, run, contract } }), /binary identity mismatch/);
  assert.equal(await fs.readFile(marker, 'utf8'), 'x');
});

test('durable guided receipt is reused before spawning and rejects drift', { skip: process.platform === 'win32' && 'POSIX executable fixture' }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-durable-receipt-'));
  const durableDir = path.join(projectDir, 'snapped');
  const stageDir = path.join(projectDir, 'stage');
  const input = path.join(projectDir, 'generated.png');
  const marker = path.join(projectDir, 'invoked');
  const executable = path.join(projectDir, 'snapper.mjs');
  await fs.mkdir(path.join(projectDir, '.pixel-sprite-pipeline'), { mode: 0o700 });
  await fs.writeFile(input, 'frame');
  await fs.writeFile(executable, `#!/usr/bin/env node\nimport fs from 'node:fs/promises';\nconst [input, output] = process.argv.slice(2); await fs.copyFile(input, output); await fs.appendFile(${JSON.stringify(marker)}, 'x');\n`, { mode: 0o700 });
  const identity = { origin: 'environment', path: executable, physicalPath: executable, sha256: 'a'.repeat(64), version: 'test', helpSha256: 'b'.repeat(64), fixtureRgbaSha256: 'c'.repeat(64), size: 1, pinnedReleaseTag: null, upstreamCommit: null };
  const run = { id: 'guided-run', outputDir: durableDir, manifestSha256: 'd'.repeat(64) };
  const contract = { sha256: 'e'.repeat(64) };
  await runPixelSnapper({ inputs: [input], outputDir: durableDir, config: { snapper: { args: [] } }, identity, receipt: { projectDir, run, contract } });
  const reused = await runPixelSnapper({ inputs: [input], outputDir: stageDir, config: { snapper: { args: [] } }, identity, receipt: { projectDir, run: { ...run, outputDir: stageDir }, contract, durableReceiptFile: path.join(durableDir, 'snap-receipt.json') } });
  assert.equal(reused.recoveredExistingReceipt, true);
  assert.equal(await fs.readFile(marker, 'utf8'), 'x');
  await assert.rejects(runPixelSnapper({ inputs: [input], outputDir: stageDir, config: { snapper: { args: ['--changed'] } }, identity, receipt: { projectDir, run: { ...run, outputDir: stageDir }, contract, durableReceiptFile: path.join(durableDir, 'snap-receipt.json') } }), /argument binding mismatch/);
  await assert.rejects(runPixelSnapper({ inputs: [input], outputDir: stageDir, config: { snapper: { args: [] } }, identity: { ...identity, sha256: 'f'.repeat(64) }, receipt: { projectDir, run: { ...run, outputDir: stageDir }, contract, durableReceiptFile: path.join(durableDir, 'snap-receipt.json') } }), /binary identity mismatch/);
  await assert.rejects(runPixelSnapper({ inputs: [input], outputDir: stageDir, config: { snapper: { args: [] } }, identity, receipt: { projectDir, run: { ...run, outputDir: stageDir }, contract: { sha256: 'f'.repeat(64) }, durableReceiptFile: path.join(durableDir, 'snap-receipt.json') } }), /contract binding mismatch/);
  await fs.appendFile(input, 'changed');
  await assert.rejects(runPixelSnapper({ inputs: [input], outputDir: stageDir, config: { snapper: { args: [] } }, identity, receipt: { projectDir, run: { ...run, outputDir: stageDir }, contract, durableReceiptFile: path.join(durableDir, 'snap-receipt.json') } }), /input hash mismatch/);
  assert.equal(await fs.readFile(marker, 'utf8'), 'x');
});
