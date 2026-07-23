import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { detectPixelSnapper, runPixelSnapper, writeSnapperHandoff } from '../scripts/lib/snapper.mjs';
import { verifySnapReceipt } from '../scripts/lib/snap-receipt.mjs';

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

test('guided contract palette is passed to Pixel Snapper and bound into its receipt', { skip: process.platform === 'win32' && 'POSIX executable fixture' }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-contract-palette-'));
  const outputDir = path.join(projectDir, 'output');
  const input = path.join(projectDir, 'frame.png');
  const invocation = path.join(projectDir, 'invocation.json');
  const executable = path.join(projectDir, 'snapper.mjs');
  await fs.mkdir(path.join(projectDir, '.pixel-sprite-pipeline'), { mode: 0o700 });
  await fs.writeFile(input, 'frame');
  await fs.writeFile(executable, `#!/usr/bin/env node\nimport fs from 'node:fs/promises';\nconst [input, output, ...args] = process.argv.slice(2); await fs.copyFile(input, output); await fs.writeFile(${JSON.stringify(invocation)}, JSON.stringify(args));\n`, { mode: 0o700 });
  const identity = { origin: 'environment', path: executable, physicalPath: executable, sha256: 'a'.repeat(64), version: 'test', helpSha256: 'b'.repeat(64), fixtureRgbaSha256: 'c'.repeat(64), size: 1 };
  const run = { id: 'run-contract-palette', outputDir, manifestSha256: 'd'.repeat(64) };
  const contract = { sha256: 'e'.repeat(64) };

  await runPixelSnapper({
    inputs: [input], outputDir, config: { snapper: { args: ['16'] } }, identity,
    paletteHex: ['06fd08', '040614', 'f1eff0'], receipt: { projectDir, run, contract }
  });

  assert.deepEqual(JSON.parse(await fs.readFile(invocation, 'utf8')), ['16', '--palette', '06fd08,040614,f1eff0']);
  const receipt = JSON.parse(await fs.readFile(path.join(outputDir, 'snap-receipt.json'), 'utf8'));
  assert.deepEqual(receipt.payload.arguments, ['16', '--palette', '06fd08,040614,f1eff0']);
});

test('standalone snap receipts allow an explicit null manifest binding', { skip: process.platform === 'win32' && 'POSIX executable fixture' }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-standalone-receipt-'));
  const outputDir = path.join(projectDir, 'output');
  const input = path.join(projectDir, 'frame.png');
  const executable = path.join(projectDir, 'snapper.mjs');
  await fs.mkdir(path.join(projectDir, '.pixel-sprite-pipeline'), { mode: 0o700 });
  await fs.writeFile(input, 'frame');
  await fs.writeFile(executable, `#!/usr/bin/env node\nimport fs from 'node:fs/promises';\nconst [input, output] = process.argv.slice(2); await fs.copyFile(input, output);\n`, { mode: 0o700 });
  const identity = { origin: 'environment', path: executable, physicalPath: executable, sha256: 'a'.repeat(64), version: 'test', helpSha256: 'b'.repeat(64), fixtureRgbaSha256: 'c'.repeat(64), size: 1 };
  const run = { id: null, outputDir, manifestSha256: null };
  const contract = { sha256: 'e'.repeat(64) };

  await runPixelSnapper({
    inputs: [input], outputDir, config: { snapper: { args: ['16'] } }, identity,
    receipt: { projectDir, run, contract }
  });

  const receipt = JSON.parse(await fs.readFile(path.join(outputDir, 'snap-receipt.json'), 'utf8'));
  assert.deepEqual(receipt.payload.run, { id: null, manifestSha256: null });
  await verifySnapReceipt({ projectDir, file: path.join(outputDir, 'snap-receipt.json'), expectedRun: run, expectedContract: contract });
});

test('v2 production binds the contracted pixel size and canonicalizes transparent Snapper padding before signing', { skip: process.platform === 'win32' && 'POSIX executable fixture' }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-v2-canvas-'));
  const outputDir = path.join(projectDir, 'output');
  const input = path.join(projectDir, 'frame.png');
  const invocation = path.join(projectDir, 'invocation.json');
  const executable = path.join(projectDir, 'snapper.mjs');
  await fs.mkdir(path.join(projectDir, '.pixel-sprite-pipeline'), { mode: 0o700 });
  await sharp({ create: { width: 10, height: 11, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(input);
  await fs.writeFile(executable, `#!/usr/bin/env node\nimport fs from 'node:fs/promises';\nconst [input, output, ...args] = process.argv.slice(2); await fs.copyFile(input, output); await fs.writeFile(${JSON.stringify(invocation)}, JSON.stringify(args));\n`, { mode: 0o700 });
  const identity = { origin: 'environment', path: executable, physicalPath: executable, sha256: 'a'.repeat(64), version: 'test', helpSha256: 'b'.repeat(64), fixtureRgbaSha256: 'c'.repeat(64), size: 1 };
  const run = { id: 'run-v2-canvas', outputDir, manifestSha256: 'd'.repeat(64) };
  const contract = { sha256: 'e'.repeat(64) };

  const result = await runPixelSnapper({
    inputs: [input], outputDir, config: { snapper: { args: ['16'] } }, identity,
    pixelSize: 2, outputCanvas: { width: 8, height: 8 }, receipt: { projectDir, run, contract }
  });

  assert.deepEqual(JSON.parse(await fs.readFile(invocation, 'utf8')), ['16', '--pixel-size', '2']);
  assert.deepEqual(await sharp(result.outputs[0]).metadata().then(({ width, height }) => ({ width, height })), { width: 8, height: 8 });
  const receipt = JSON.parse(await fs.readFile(path.join(outputDir, 'snap-receipt.json'), 'utf8'));
  assert.deepEqual(receipt.payload.arguments, ['16', '--pixel-size', '2']);
});

test('v2 production preserves an exactly aligned integer-scale source without invoking Pixel Snapper', { skip: process.platform === 'win32' && 'POSIX executable fixture' }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-aligned-source-'));
  const outputDir = path.join(projectDir, 'output');
  const input = path.join(projectDir, 'frame.png');
  const marker = path.join(projectDir, 'invoked');
  const executable = path.join(projectDir, 'snapper.mjs');
  await fs.mkdir(path.join(projectDir, '.pixel-sprite-pipeline'), { mode: 0o700 });
  const transparent = [0, 0, 0, 0];
  const ink = [4, 6, 20, 255];
  const paletteSha256 = crypto.createHash('sha256').update(JSON.stringify([transparent, ink])).digest('hex');
  const logical = [transparent, ink, ink, transparent];
  const scaled = Buffer.alloc(4 * 4 * 4);
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) scaled.set(logical[Math.floor(y / 2) * 2 + Math.floor(x / 2)], (y * 4 + x) * 4);
  await sharp(scaled, { raw: { width: 4, height: 4, channels: 4 } }).png().toFile(input);
  await fs.writeFile(executable, `#!/usr/bin/env node\nimport fs from 'node:fs/promises';\nconst [input, output] = process.argv.slice(2); await fs.copyFile(input, output); await fs.writeFile(${JSON.stringify(marker)}, 'invoked');\n`, { mode: 0o700 });
  const identity = { origin: 'environment', path: executable, physicalPath: executable, sha256: 'a'.repeat(64), version: 'test', helpSha256: 'b'.repeat(64), fixtureRgbaSha256: 'c'.repeat(64), size: 1 };
  const run = { id: 'run-aligned-source', outputDir, manifestSha256: 'd'.repeat(64) };
  const contract = { sha256: 'e'.repeat(64) };

  const result = await runPixelSnapper({
    inputs: [input], outputDir, config: { snapper: { args: ['16'] } }, identity,
    pixelSize: 2, outputCanvas: { width: 2, height: 2 },
    alignedSource: { scale: 2, canvas: { width: 2, height: 2 }, paletteRgba: [transparent, ink], paletteSha256 },
    receipt: { projectDir, run, contract }
  });

  await assert.rejects(fs.access(marker), /ENOENT/);
  assert.equal(result.origin, 'verified-aligned-source');
  const { data, info } = await sharp(result.outputs[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual({ width: info.width, height: info.height }, { width: 2, height: 2 });
  assert.deepEqual([...data], logical.flat());
  const receipt = JSON.parse(await fs.readFile(path.join(outputDir, 'snap-receipt.json'), 'utf8'));
  assert.equal(receipt.payload.origin, 'verified-aligned-source');
  assert.equal(receipt.payload.toolProvenanceVerified, false);
  assert.equal(receipt.payload.deterministicProvenanceVerified, true);
  assert.deepEqual(receipt.payload.derivation, { kind: 'integer-grid-collapse', scale: 2, canvas: { width: 2, height: 2 }, paletteSha256 });
  await verifySnapReceipt({ projectDir, file: path.join(outputDir, 'snap-receipt.json'), expectedRun: run, expectedContract: contract });
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
