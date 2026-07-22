import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { connectedComponents, extractPrimaryComponent } from '../scripts/lib/components.mjs';
import { loadAnimationContract } from '../scripts/lib/animation-contract.mjs';
import { readRgba, sha256 } from '../scripts/lib/image.mjs';
import { normalizeFrames } from '../scripts/lib/normalize.mjs';
import * as normalizeApi from '../scripts/lib/normalize.mjs';
import { stableHash } from '../scripts/lib/state-auth.mjs';

const HASH = (letter) => letter.repeat(64);

function animationContractDocument() {
  const rgba = [[0, 0, 0, 0], [26, 32, 63, 255], [220, 60, 40, 255]];
  return {
    version: 1, anchor: { sha256: HASH('a'), traitReferenceSha256: [HASH('b')] },
    sizes: { canonical: [128, 128], generation: [1024, 1024], runtime: [256, 256], pixelSize: 8 }, pivot: { x: 64, y: 112 }, baseline: 111,
    palette: { rgba, sha256: stableHash(rgba), snapperPaletteHex: ['1a203f', 'dc3c28'] },
    clips: [{ id: 'idle', loopMode: 'loop', loopTransition: { fromFrameId: 'idle-2', toFrameId: 'idle-1', reviewCheckpoint: 'motion' }, frames: [
      { id: 'idle-1', pose: 'rest', duration: 100, landmarkSemantic: { name: 'character-root', target: { x: 64, y: 112 } } },
      { id: 'idle-2', pose: 'reach', duration: 120, landmarkSemantic: { name: 'character-root', target: { x: 64, y: 112 } } }
    ] }],
    review: { checkpoints: ['identity', 'motion'], approvers: ['artist@example.test'] }
  };
}

async function animationContract() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-contract-'));
  const file = path.join(dir, 'animation-contract.json');
  await fs.writeFile(file, `${JSON.stringify(animationContractDocument())}\n`);
  return loadAnimationContract(file);
}

async function frame(file, left, top, width, height) {
  await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).composite([{
    input: {
      create: {
        width,
        height,
        channels: 4,
        background: '#1a203fff'
      }
    },
    left,
    top
  }]).png().toFile(file);
}

async function pngNames(dir) {
  try {
    return (await fs.readdir(dir)).filter((name) => name.endsWith('.png'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function pixelAt(image, x, y) {
  return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
}

async function makeExtendedLimbFrames() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-landmarks-'));
  const frames = [path.join(dir, 'rest.png'), path.join(dir, 'reach.png')];
  const torso = [220, 60, 40, 255];
  for (const [index, file] of frames.entries()) {
    const data = Buffer.alloc(64 * 64 * 4);
    for (let y = 25; y <= 49; y += 1) for (let x = 25; x <= 34; x += 1) data.set(torso, (y * 64 + x) * 4);
    const armStart = index === 0 ? 20 : 5;
    for (let x = armStart; x <= 24; x += 1) data.set([26, 32, 63, 255], (30 * 64 + x) * 4);
    await sharp(data, { raw: { width: 64, height: 64, channels: 4 } }).png().toFile(file);
  }
  return {
    frames,
    landmarks: frames.map((_, index) => ({ frameId: `idle-${index + 1}`, source: { x: 30, y: 50 }, target: { x: 64, y: 112 } })),
    torso
  };
}

async function torsoX(file, torso) {
  const image = await readRgba(file);
  for (let x = 0; x < image.width; x += 1) for (let y = 0; y < image.height; y += 1) {
    if (pixelAt(image, x, y).every((channel, index) => channel === torso[index])) return x;
  }
  throw new Error('torso color was not found');
}

async function v2Fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-v2-'));
  const runDir = path.join(dir, 'run');
  await fs.mkdir(runDir);
  const rgba = [[0, 0, 0, 0], [26, 32, 63, 255], [220, 60, 40, 255]];
  const document = {
    version: 2, selectionApprovalSha256: HASH('c'),
    character: { id: 'clockwork-courier', anchorSha256: HASH('d') },
    canvas: { width: 16, height: 16, pivot: { x: 8, y: 14 }, baseline: 13 },
    scale: { integer: 2, runtime: { width: 32, height: 32 } },
    palette: { rgba, sha256: stableHash(rgba), snapperPaletteHex: ['1a203f', 'dc3c28'] },
    tracks: [
      { id: 'actor', kind: 'actor', required: true, attachTo: null },
      { id: 'satchel', kind: 'prop', required: true, attachTo: 'hand' }
    ],
    sockets: [{ id: 'hand', trackId: 'actor', required: true }],
    contacts: [{ id: 'left-foot', trackId: 'actor', kind: 'planted-foot', required: true }],
    clips: [{ id: 'walk', loopMode: 'loop', frames: [
      { id: 'walk-contact', semantic: 'contact', duration: 80, tracks: ['actor', 'satchel'], sockets: ['hand'], contacts: ['left-foot'], groundTravel: { x: 0, y: 0 } },
      { id: 'walk-pass', semantic: 'passing', duration: 120, tracks: ['actor', 'satchel'], sockets: ['hand'], contacts: ['left-foot'], groundTravel: { x: 2, y: 0 } }
    ] }],
    review: { checkpoints: ['identity', 'motion', 'landmarks'], approvers: ['owner'] }
  };
  const contract = { document, sha256: stableHash(document) };
  const definitions = document.clips[0].frames;
  const approvalFrames = [];
  for (const [frameIndex, definition] of definitions.entries()) {
    const rootX = 6 + frameIndex;
    const outputs = [];
    for (const [trackIndex, trackId] of definition.tracks.entries()) {
      const file = path.join(runDir, `${definition.id}--${trackId}.png`);
      const data = Buffer.alloc(16 * 16 * 4);
      const x = trackId === 'actor' ? rootX : rootX + 4;
      const color = trackId === 'actor' ? rgba[1] : rgba[2];
      data.set(color, (10 * 16 + x) * 4);
      data.set(color, (11 * 16 + x) * 4);
      await sharp(data, { raw: { width: 16, height: 16, channels: 4 } }).png().toFile(file);
      outputs.push({ index: frameIndex * 2 + trackIndex, trackId, path: path.basename(file), sha256: await sha256(file) });
    }
    approvalFrames.push({
      index: frameIndex, id: definition.id, semantic: definition.semantic, duration: definition.duration, outputs,
      landmarks: {
        root: { x: rootX, y: 12 }, baseline: 11,
        sockets: [{ id: 'hand', x: rootX + 4, y: 8 }],
        contacts: [{ id: 'left-foot', x: rootX, y: 11 }], groundTravel: { ...definition.groundTravel }
      },
      approved: true, approvedBy: 'owner', checkpoints: ['identity', 'motion', 'landmarks']
    });
  }
  const frameApproval = {
    path: path.join(runDir, 'frame-approval-01.json'), sha256: HASH('e'),
    document: { payload: {
      version: 2, approvalVersion: 1, animationContractSha256: contract.sha256,
      selectionApprovalSha256: document.selectionApprovalSha256, snapReceiptSha256: HASH('f'),
      frames: approvalFrames, approvedBy: 'owner', createdAt: '2026-07-22T08:00:00.000Z'
    } }
  };
  return { contract, frameApproval, outputDir: path.join(dir, 'normalized') };
}

test('v2 normalization keeps scale fixed and maps sockets exactly', async () => {
  const fixture = await v2Fixture();
  const result = await normalizeApi.normalizeContractFrames(fixture);
  assert.equal(new Set(result.frames.map((frame) => frame.scale)).size, 1);
  assert.equal(result.frames.every((frame) => frame.scale === 2), true);
  assert.equal(result.frames.every((frame) => frame.sockets.hand.x === 12), true);
  assert.equal(result.frames.every((frame) => frame.root.x === 8 && frame.root.y === 14), true);
  assert.deepEqual(result.frames.map((frame) => Object.keys(frame.tracks)), [['actor', 'satchel'], ['actor', 'satchel']]);

  const changed = await v2Fixture();
  const source = path.join(path.dirname(changed.frameApproval.path), changed.frameApproval.document.payload.frames[0].outputs[0].path);
  await fs.appendFile(source, Buffer.from([0]));
  await assert.rejects(normalizeApi.normalizeContractFrames(changed), /source hash/i);
  await assert.rejects(fs.access(changed.outputDir), { code: 'ENOENT' });
});

test('authored roots stay fixed when pose bounds change', async () => {
  const { frames, landmarks, torso } = await makeExtendedLimbFrames();
  const result = await normalizeFrames({ inputs: frames, landmarks, outputDir: path.join(path.dirname(frames[0]), 'out'), config: DEFAULT_CONFIG, scaleFactor: 1 });

  assert.deepEqual(result.measurements.map((item) => item.frameId), ['idle-1', 'idle-2']);
  assert.deepEqual(result.measurements.map((item) => item.sourceLandmark), [{ x: 30, y: 50 }, { x: 30, y: 50 }]);
  assert.deepEqual(result.measurements.map((item) => item.canonicalLandmark), [{ x: 64, y: 112 }, { x: 64, y: 112 }]);
  assert.deepEqual(result.measurements.map((item) => item.landmarkDrift), [{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  assert.equal(await torsoX(result.frames[0], torso), await torsoX(result.frames[1], torso));
});

test('contract landmarks require exact ordered coverage and contained integer coordinates', async () => {
  const { frames, landmarks } = await makeExtendedLimbFrames();
  const outputDir = path.join(path.dirname(frames[0]), 'invalid');
  const cases = [
    { value: landmarks.slice(0, 1), error: /one landmark per input frame/i },
    { value: [landmarks[0], { ...landmarks[1], frameId: landmarks[0].frameId }], error: /frameId.*unique/i },
    { value: [{ ...landmarks[0], extra: true }, landmarks[1]], error: /landmark.*schema/i },
    { value: [{ ...landmarks[0], source: { x: 64, y: 50 } }, landmarks[1]], error: /source.*inside.*frame/i },
    { value: [{ ...landmarks[0], source: { x: 30.5, y: 50 } }, landmarks[1]], error: /source.*integer/i },
    { value: [{ ...landmarks[0], target: { x: 128, y: 112 } }, landmarks[1]], error: /target.*canonical/i }
  ];
  for (const item of cases) {
    await assert.rejects(normalizeFrames({ inputs: frames, landmarks: item.value, outputDir, config: DEFAULT_CONFIG }), item.error);
    assert.deepEqual(await pngNames(outputDir), []);
  }
});

test('approved landmark overflow rejects the whole batch before output', async () => {
  const { frames, landmarks } = await makeExtendedLimbFrames();
  const outputDir = path.join(path.dirname(frames[0]), 'overflow');
  await assert.rejects(normalizeFrames({ inputs: frames, landmarks, outputDir, config: DEFAULT_CONFIG, scaleFactor: 10 }), /exceeds canonical cell at approved landmark/i);
  assert.deepEqual(await pngNames(outputDir), []);
});

test('normalization snapshots approved landmarks before asynchronous image reads', async () => {
  const { frames, landmarks } = await makeExtendedLimbFrames();
  const pending = normalizeFrames({ inputs: frames, landmarks, outputDir: path.join(path.dirname(frames[0]), 'snapshot'), config: DEFAULT_CONFIG });
  landmarks[0].source.x = 0;
  landmarks[0].target.x = 2;
  const result = await pending;
  assert.deepEqual(result.measurements[0].sourceLandmark, { x: 30, y: 50 });
  assert.deepEqual(result.measurements[0].canonicalLandmark, { x: 64, y: 112 });
});

test('contract normalization binds ordered frame IDs and targets to the validated animation contract', async () => {
  const { frames, landmarks } = await makeExtendedLimbFrames();
  const contract = await animationContract();
  const outputDir = path.join(path.dirname(frames[0]), 'contract-invalid');
  const cases = [
    { value: [landmarks[1], landmarks[0]], error: /ordered.*frame|frame.*order/i },
    { value: [{ ...landmarks[0], frameId: 'invented' }, landmarks[1]], error: /frame.*contract/i },
    { value: [{ ...landmarks[0], target: { x: 63, y: 112 } }, landmarks[1]], error: /target.*contract|pivot/i }
  ];
  for (const item of cases) {
    await assert.rejects(normalizeFrames({ inputs: frames, landmarks: item.value, animationContract: contract, outputDir, config: DEFAULT_CONFIG }), item.error);
    assert.deepEqual(await pngNames(outputDir), []);
  }
});

test('normalization snapshots input ordering and relevant config before asynchronous reads', async () => {
  const { frames, landmarks } = await makeExtendedLimbFrames();
  const expectedInputs = [...frames];
  const contract = await animationContract();
  const config = structuredClone(DEFAULT_CONFIG);
  const pending = normalizeFrames({ inputs: frames, landmarks, animationContract: contract, outputDir: path.join(path.dirname(frames[0]), 'contract-snapshot'), config });
  frames.reverse();
  config.pivot.x = 2;
  config.canonical.width = 8;
  config.background.tolerance = 255;
  const result = await pending;
  assert.deepEqual(result.measurements.map((item) => item.input), expectedInputs);
  assert.deepEqual(result.measurements.map((item) => item.canonicalLandmark), [{ x: 64, y: 112 }, { x: 64, y: 112 }]);
});

test('normalization preserves one scale and plants every frame on the shared baseline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-'));
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  await frame(a, 5, 8, 15, 30);
  await frame(b, 20, 20, 28, 18);

  const result = await normalizeFrames({
    inputs: [a, b],
    outputDir: path.join(dir, 'out'),
    config: DEFAULT_CONFIG,
    scaleFactor: 1
  });

  assert.equal(result.frames.length, 2);
  assert.deepEqual(result.canonicalPivot, { x: 64, y: 112 });
  assert.deepEqual(result.measurements.map((item) => item.bottom), [111, 111]);
  assert.deepEqual(result.measurements.map((item) => item.scaleFactor), [1, 1]);
  assert.deepEqual(result.measurements.map(({ width, height }) => ({ width, height })), [
    { width: 15, height: 30 },
    { width: 28, height: 18 }
  ]);
});

test('component recovery uses four-neighbor connectivity and largest mode masks secondary foreground', async () => {
  const diagonalImage = { width: 2, height: 2 };
  const diagonal = connectedComponents(diagonalImage, (x, y) => x === y);
  assert.deepEqual(diagonal.map((component) => component.length), [1, 1]);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-components-'));
  const input = path.join(dir, 'components.png');
  const data = Buffer.alloc(7 * 7 * 4);
  for (let y = 1; y <= 5; y += 1) for (let x = 1; x <= 5; x += 1) {
    if (x === 1 || x === 5 || y === 1 || y === 5) {
      data.set([26, 32, 63, 255], (y * 7 + x) * 4);
    }
  }
  data.set([255, 0, 0, 255], (3 * 7 + 3) * 4);
  data.set([255, 0, 0, 255], 6 * 4);
  await sharp(data, { raw: { width: 7, height: 7, channels: 4 } }).png().toFile(input);

  const recovered = await extractPrimaryComponent(input, { retentionPolicy: 'largest' });

  assert.equal(recovered.componentCount, 3);
  assert.equal(recovered.pixelCount, 16);
  assert.deepEqual(recovered.bounds, {
    left: 1,
    top: 1,
    right: 5,
    bottom: 5,
    width: 5,
    height: 5
  });
  assert.deepEqual(
    [...recovered.image.data.subarray((2 * recovered.image.width + 2) * 4, (2 * recovered.image.width + 2) * 4 + 4)],
    [0, 0, 0, 0]
  );

  const normalized = await normalizeFrames({
    inputs: [input],
    outputDir: path.join(dir, 'out'),
    config: DEFAULT_CONFIG,
    scaleFactor: 1,
    retentionPolicy: 'largest'
  });
  const output = await readRgba(normalized.frames[0]);
  assert.equal(normalized.measurements[0].componentCount, 3);
  assert.deepEqual(
    [...output.data.subarray((109 * output.width + 64) * 4, (109 * output.width + 64) * 4 + 4)],
    [0, 0, 0, 0]
  );
});

test('opaque dominant-border chroma is removed and output outside the subject is transparent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-chroma-'));
  const input = path.join(dir, 'green.png');
  const data = Buffer.alloc(9 * 7 * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([0, 250, 4, 255], offset);
  for (let y = 2; y <= 4; y += 1) for (let x = 3; x <= 5; x += 1) {
    data.set([26, 32, 63, 255], (y * 9 + x) * 4);
  }
  await sharp(data, { raw: { width: 9, height: 7, channels: 4 } }).png().toFile(input);

  const result = await normalizeFrames({
    inputs: [input],
    outputDir: path.join(dir, 'out'),
    config: { ...DEFAULT_CONFIG, background: { mode: 'border', color: null, tolerance: 5 } }
  });
  const output = await readRgba(result.frames[0]);

  assert.deepEqual(result.measurements[0], {
    ...result.measurements[0],
    width: 3,
    height: 3,
    componentCount: 1,
    retainedComponentCount: 1,
    retainedPixelCount: 9
  });
  assert.deepEqual(pixelAt(output, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(output, 63, 109), [26, 32, 63, 255]);
});

test('configured background color takes precedence over border detection and honors tolerance', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-configured-chroma-'));
  const input = path.join(dir, 'configured.png');
  const data = Buffer.alloc(5 * 5 * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([5, 245, 7, 255], offset);
  for (let x = 0; x < 5; x += 1) data.set([26, 32, 63, 255], x * 4);
  for (let y = 1; y < 4; y += 1) data.set([26, 32, 63, 255], (y * 5) * 4);
  for (let x = 0; x < 4; x += 1) data.set([26, 32, 63, 255], (4 * 5 + x) * 4);
  data.set([26, 32, 63, 255], (2 * 5 + 2) * 4);
  await sharp(data, { raw: { width: 5, height: 5, channels: 4 } }).png().toFile(input);

  const result = await normalizeFrames({
    inputs: [input],
    outputDir: path.join(dir, 'out'),
    config: {
      ...DEFAULT_CONFIG,
      background: { mode: 'border', color: { r: 0, g: 250, b: 4, a: 255 }, tolerance: 7 }
    }
  });

  assert.equal(result.measurements[0].componentCount, 2);
  assert.equal(result.measurements[0].retainedPixelCount, 13);
});

test('default all policy retains detached foreground and uses union bounds', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-detached-'));
  const input = path.join(dir, 'detached.png');
  const data = Buffer.alloc(12 * 5 * 4);
  for (let y = 1; y <= 2; y += 1) for (let x = 1; x <= 2; x += 1) {
    data.set([26, 32, 63, 255], (y * 12 + x) * 4);
  }
  for (let y = 1; y <= 2; y += 1) for (let x = 9; x <= 10; x += 1) {
    data.set([220, 60, 40, 255], (y * 12 + x) * 4);
  }
  await sharp(data, { raw: { width: 12, height: 5, channels: 4 } }).png().toFile(input);

  const result = await normalizeFrames({
    inputs: [input], outputDir: path.join(dir, 'out'), config: DEFAULT_CONFIG
  });
  const output = await readRgba(result.frames[0]);
  const measurement = result.measurements[0];

  assert.deepEqual({
    width: measurement.width,
    height: measurement.height,
    componentCount: measurement.componentCount,
    retainedComponentCount: measurement.retainedComponentCount,
    retainedPixelCount: measurement.retainedPixelCount
  }, { width: 10, height: 2, componentCount: 2, retainedComponentCount: 2, retainedPixelCount: 8 });
  assert.deepEqual(pixelAt(output, measurement.left, measurement.top), [26, 32, 63, 255]);
  assert.deepEqual(pixelAt(output, measurement.left + 9, measurement.top), [220, 60, 40, 255]);
  assert.deepEqual(pixelAt(output, measurement.left + 4, measurement.top), [0, 0, 0, 0]);
});

test('detached foreground union drives overflow while largest remains opt-in', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-union-overflow-'));
  const input = path.join(dir, 'detached.png');
  const allOutput = path.join(dir, 'all');
  const data = Buffer.alloc(10 * 3 * 4);
  for (const x of [0, 1, 8]) data.set([26, 32, 63, 255], (1 * 10 + x) * 4);
  await sharp(data, { raw: { width: 10, height: 3, channels: 4 } }).png().toFile(input);
  const config = { ...DEFAULT_CONFIG, canonical: { width: 6, height: 6 }, pivot: { x: 3, y: 5 } };

  await assert.rejects(
    normalizeFrames({ inputs: [input], outputDir: allOutput, config }),
    /exceeds canonical cell/
  );
  assert.deepEqual(await pngNames(allOutput), []);

  const largest = await normalizeFrames({
    inputs: [input], outputDir: path.join(dir, 'largest'), config, retentionPolicy: 'largest'
  });
  assert.deepEqual({
    width: largest.measurements[0].width,
    componentCount: largest.measurements[0].componentCount,
    retainedComponentCount: largest.measurements[0].retainedComponentCount,
    retainedPixelCount: largest.measurements[0].retainedPixelCount
  }, { width: 2, componentCount: 2, retainedComponentCount: 1, retainedPixelCount: 2 });
});

test('reject-multiple errors before writing any frame in the batch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-reject-multiple-'));
  const valid = path.join(dir, 'valid.png');
  const detached = path.join(dir, 'detached.png');
  const outputDir = path.join(dir, 'out');
  await frame(valid, 4, 4, 3, 3);
  const data = Buffer.alloc(8 * 4 * 4);
  data.set([26, 32, 63, 255], (1 * 8 + 1) * 4);
  data.set([26, 32, 63, 255], (1 * 8 + 6) * 4);
  await sharp(data, { raw: { width: 8, height: 4, channels: 4 } }).png().toFile(detached);

  await assert.rejects(
    normalizeFrames({
      inputs: [valid, detached], outputDir, config: DEFAULT_CONFIG, retentionPolicy: 'reject-multiple'
    }),
    /contains 2 foreground components/
  );
  assert.deepEqual(await pngNames(outputDir), []);
});

test('minimum component size is configurable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-minimum-component-'));
  const input = path.join(dir, 'noise.png');
  const data = Buffer.alloc(8 * 4 * 4);
  data.set([26, 32, 63, 255], (1 * 8 + 1) * 4);
  data.set([26, 32, 63, 255], (1 * 8 + 5) * 4);
  data.set([26, 32, 63, 255], (1 * 8 + 6) * 4);
  await sharp(data, { raw: { width: 8, height: 4, channels: 4 } }).png().toFile(input);

  const result = await normalizeFrames({
    inputs: [input],
    outputDir: path.join(dir, 'out'),
    config: DEFAULT_CONFIG,
    minimumComponentPixels: 2
  });
  assert.deepEqual({
    componentCount: result.measurements[0].componentCount,
    retainedComponentCount: result.measurements[0].retainedComponentCount,
    retainedPixelCount: result.measurements[0].retainedPixelCount
  }, { componentCount: 2, retainedComponentCount: 1, retainedPixelCount: 2 });
});

test('normalization rejects a foreground-free frame before writing any outputs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-empty-'));
  const valid = path.join(dir, 'valid.png');
  const empty = path.join(dir, 'empty.png');
  const outputDir = path.join(dir, 'out');
  await frame(valid, 10, 10, 8, 12);
  await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).png().toFile(empty);

  await assert.rejects(
    normalizeFrames({
      inputs: [valid, empty],
      outputDir,
      config: DEFAULT_CONFIG,
      scaleFactor: 1
    }),
    /contains no foreground/
  );
  assert.deepEqual(await pngNames(outputDir), []);
});

test('one integer scale is applied unchanged to every pose on transparent canonical canvases', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-global-scale-'));
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  await frame(a, 4, 5, 3, 4);
  await frame(b, 30, 25, 5, 2);

  const result = await normalizeFrames({
    inputs: [a, b],
    outputDir: path.join(dir, 'out'),
    config: DEFAULT_CONFIG,
    scaleFactor: 2
  });

  assert.equal(result.scaleFactor, 2);
  assert.deepEqual(result.measurements.map(({ width, height, scaleFactor, bottom }) => ({
    width,
    height,
    scaleFactor,
    bottom
  })), [
    { width: 6, height: 8, scaleFactor: 2, bottom: 111 },
    { width: 10, height: 4, scaleFactor: 2, bottom: 111 }
  ]);
  for (const outputFile of result.frames) {
    const metadata = await sharp(outputFile).metadata();
    const output = await readRgba(outputFile);
    assert.deepEqual({ width: metadata.width, height: metadata.height }, DEFAULT_CONFIG.canonical);
    assert.equal(metadata.hasAlpha, true);
    assert.deepEqual([...output.data.subarray(0, 4)], [0, 0, 0, 0]);
  }
});

test('normalization rejects fractional global scale factors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-fractional-'));
  const input = path.join(dir, 'input.png');
  const outputDir = path.join(dir, 'out');
  await frame(input, 10, 10, 8, 12);

  await assert.rejects(
    normalizeFrames({
      inputs: [input],
      outputDir,
      config: DEFAULT_CONFIG,
      scaleFactor: 1.5
    }),
    /scaleFactor must be a positive integer/
  );
  assert.deepEqual(await pngNames(outputDir), []);
});

test('normalization rejects canonical-cell overflow before writing any outputs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-overflow-'));
  const valid = path.join(dir, 'valid.png');
  const overflow = path.join(dir, 'overflow.png');
  const outputDir = path.join(dir, 'out');
  await frame(valid, 10, 10, 4, 4);
  await frame(overflow, 20, 20, 7, 6);
  const config = {
    ...DEFAULT_CONFIG,
    canonical: { width: 12, height: 12 },
    pivot: { x: 6, y: 10 }
  };

  await assert.rejects(
    normalizeFrames({
      inputs: [valid, overflow],
      outputDir,
      config,
      scaleFactor: 2
    }),
    /exceeds canonical cell at global scale 2/
  );
  assert.deepEqual(await pngNames(outputDir), []);
});
