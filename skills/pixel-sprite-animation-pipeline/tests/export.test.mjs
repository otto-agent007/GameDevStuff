import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { exportAnimation, exportContractAnimation } from '../scripts/lib/export.mjs';
import { sha256 } from '../scripts/lib/image.mjs';
import { stableHash } from '../scripts/lib/state-auth.mjs';

async function makeFrame(file, { width = 128, height = 128, x = 2, color = [255, 0, 0, 255] } = {}) {
  const data = Buffer.alloc(width * height * 4, 0);
  data.set(color, (2 * width + x) * 4);
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
}

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sprite-export-'));
}

const HASH = (letter) => letter.repeat(64);

function contractDocument() {
  const rgba = [[0, 0, 0, 0], [255, 0, 0, 255]];
  const landmarkSemantic = { name: 'character-root', target: { x: 64, y: 112 } };
  return {
    version: 1,
    anchor: { sha256: HASH('a'), traitReferenceSha256: [HASH('b')] },
    sizes: { canonical: [128, 128], generation: [1024, 1024], runtime: [256, 256], pixelSize: 8 },
    pivot: { x: 64, y: 112 },
    baseline: 111,
    palette: { rgba, sha256: stableHash(rgba), snapperPaletteHex: ['ff0000'] },
    clips: [
      {
        id: 'run', loopMode: 'loop', loopTransition: { fromFrameId: 'run-02', toFrameId: 'run-00', reviewCheckpoint: 'motion' },
        frames: [
          { id: 'run-00', pose: 'stride-a', duration: 80, landmarkSemantic },
          { id: 'run-01', pose: 'stride-b', duration: 90, landmarkSemantic },
          { id: 'run-02', pose: 'stride-c', duration: 110, landmarkSemantic }
        ]
      },
      {
        id: 'salute', loopMode: 'hold-last', loopTransition: null,
        frames: [{ id: 'salute-00', pose: 'salute', duration: 240, landmarkSemantic }]
      }
    ],
    review: { checkpoints: ['identity', 'motion'], approvers: ['artist@example.test'] }
  };
}

async function contractFixture() {
  const dir = await temporaryDirectory();
  const definitions = contractDocument().clips.flatMap((clip) => clip.frames);
  const frames = await Promise.all(definitions.map(async (definition, index) => {
    const file = path.join(dir, `${definition.id}.png`);
    await makeFrame(file, { x: 2 + index });
    return file;
  }));
  const measurements = definitions.map((definition, index) => ({
    frameId: definition.id,
    input: path.join(dir, `approved-${definition.id}.png`),
    output: frames[index],
    sourceLandmark: { x: 2 + index, y: 2 },
    canonicalLandmark: { x: 64, y: 112 },
    landmarkDrift: { x: 0, y: 0 },
    left: 0, top: 0, width: 1, height: 1, bottom: 0, scaleFactor: 1,
    componentCount: 1, retainedComponentCount: 1, retainedPixelCount: 1,
    retentionPolicy: 'all', minimumComponentPixels: 1
  }));
  const document = contractDocument();
  return {
    dir,
    normalized: { frames, measurements, canonicalPivot: { x: 64, y: 112 }, scaleFactor: 1 },
    contract: { document, sha256: stableHash(document) },
    outputDir: path.join(dir, 'contract-out'),
    config: DEFAULT_CONFIG,
    columns: 2,
    frameApprovalSha256: HASH('c')
  };
}

async function v2ContractFixture() {
  const dir = await temporaryDirectory();
  const rgba = [[0, 0, 0, 0], [255, 0, 0, 255], [0, 0, 255, 255]];
  const document = {
    version: 2, selectionApprovalSha256: HASH('c'),
    character: { id: 'clockwork-courier', anchorSha256: HASH('d') },
    canvas: { width: 16, height: 16, pivot: { x: 8, y: 14 }, baseline: 13 },
    scale: { integer: 2, runtime: { width: 32, height: 32 } },
    palette: { rgba, sha256: stableHash(rgba), snapperPaletteHex: ['ff0000', '0000ff'] },
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
  const frames = [];
  for (const [frameIndex, definition] of document.clips[0].frames.entries()) {
    const tracks = {};
    const layers = [];
    for (const [trackIndex, trackId] of definition.tracks.entries()) {
      const file = path.join(dir, `${definition.id}--${trackId}.png`);
      await makeFrame(file, { width: 16, height: 16, x: 4 + frameIndex + trackIndex, color: rgba[trackIndex + 1] });
      const normalizedSha256 = await sha256(file);
      tracks[trackId] = {
        kind: document.tracks.find((track) => track.id === trackId).kind,
        attachTo: document.tracks.find((track) => track.id === trackId).attachTo,
        sourcePath: path.join(dir, `source-${definition.id}--${trackId}.png`),
        sourceSha256: HASH(String(trackIndex + 1)), path: file, normalizedSha256
      };
      layers.push({ input: file });
    }
    const combinedPath = path.join(dir, `${definition.id}.png`);
    await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toFile(combinedPath);
    frames.push({
      id: definition.id, semantic: definition.semantic, duration: definition.duration, loopMode: 'loop', scale: 2,
      root: { x: 8, y: 14 }, baseline: 13, sockets: { hand: { x: 12, y: 8 } },
      contacts: { 'left-foot': { x: 8 + frameIndex, y: 13 } }, groundTravel: { ...definition.groundTravel },
      tracks, combined: { path: combinedPath, sha256: await sha256(combinedPath) }
    });
  }
  const normalized = {
    version: 2, animationContractSha256: contract.sha256, selectionApprovalSha256: document.selectionApprovalSha256,
    frameApprovalSha256: HASH('e'), snapReceiptSha256: HASH('f'), frames
  };
  const config = { ...DEFAULT_CONFIG, canonical: { width: 16, height: 16 }, runtime: { width: 32, height: 32 }, pivot: { x: 8, y: 14 } };
  return { dir, normalized, contract, outputDir: path.join(dir, 'contract-v2-out'), config, columns: 2, frameApprovalSha256: HASH('e') };
}

test('v2 contract export emits track frames and engine-neutral provenance', async () => {
  const fixture = await v2ContractFixture();
  const result = await exportContractAnimation(fixture);
  const index = JSON.parse(await fs.readFile(result.metadata, 'utf8'));

  assert.equal(index.version, 2);
  assert.equal(index.selectionApprovalSha256, fixture.contract.document.selectionApprovalSha256);
  assert.equal(index.frameApprovalSha256, fixture.normalized.frameApprovalSha256);
  assert.equal(index.snapReceiptSha256, fixture.normalized.snapReceiptSha256);
  assert.equal(index.clips[0].restart, 'loop');
  assert.deepEqual(index.clips[0].frames.map(({ id, semantic, duration, tracks }) => ({ id, semantic, duration, tracks })), [
    { id: 'walk-contact', semantic: 'contact', duration: 80, tracks: ['actor', 'satchel'] },
    { id: 'walk-pass', semantic: 'passing', duration: 120, tracks: ['actor', 'satchel'] }
  ]);
  assert.ok(index.clips[0].frames.every((frame) => frame.outputs.every((output) => /^[a-f0-9]{64}$/.test(output.sha256))));
  assert.deepEqual(Object.keys(result.tracks), ['actor', 'satchel']);
  assert.equal(result.tracks.actor.frames.length, 2);
  await fs.access(result.clips.walk.contactSheet);
});

test('contract export preserves exact clip order, frame IDs, nonuniform durations, loop modes, and bindings', async () => {
  const fixture = await contractFixture();
  const result = await exportContractAnimation(fixture);

  assert.deepEqual(Object.keys(result.clips), ['run', 'salute']);
  assert.deepEqual(result.clips.run.frames.map((item) => item.id), ['run-00', 'run-01', 'run-02']);
  assert.deepEqual(result.clips.run.durations, [80, 90, 110]);
  assert.equal(result.clips.run.loopMode, 'loop');
  assert.deepEqual((await sharp(result.clips.run.preview, { animated: true }).metadata()).delay, [80, 90, 110]);
  assert.deepEqual(result.clips.salute.durations, [240]);
  assert.equal(result.clips.salute.loopMode, 'hold-last');

  const index = JSON.parse(await fs.readFile(result.metadata, 'utf8'));
  assert.deepEqual(Object.keys(index), ['version', 'animationContractSha256', 'animationContract', 'frameApprovalSha256', 'palette', 'clips', 'measurements']);
  assert.equal(index.animationContractSha256, fixture.contract.sha256);
  assert.deepEqual(index.animationContract, fixture.contract.document);
  assert.equal(index.frameApprovalSha256, fixture.frameApprovalSha256);
  assert.deepEqual(index.palette, fixture.contract.document.palette);
  assert.deepEqual(index.clips.map(({ id }) => id), ['run', 'salute']);
  assert.deepEqual(index.clips[0].frames.map(({ id, duration }) => ({ id, duration })), [
    { id: 'run-00', duration: 80 }, { id: 'run-01', duration: 90 }, { id: 'run-02', duration: 110 }
  ]);
  assert.ok(index.clips.flatMap((clip) => [clip.sheet, clip.metadata, clip.preview, ...clip.frames.map((frame) => frame.file)]).every((file) => !path.isAbsolute(file) && !file.includes('\\') && !file.startsWith('../')));
  assert.doesNotMatch(JSON.stringify(index), new RegExp(fixture.dir.replaceAll('\\', '\\\\')));
});

test('contract export rejects missing, extra, reordered, and unsafe frames before atomic publication', async (t) => {
  for (const [label, mutate, pattern] of [
    ['missing', (fixture) => { fixture.normalized.frames.pop(); fixture.normalized.measurements.pop(); }, /exact ordered normalized frame coverage/i],
    ['extra', (fixture) => { fixture.normalized.frames.push(fixture.normalized.frames[0]); fixture.normalized.measurements.push({ ...fixture.normalized.measurements[0], frameId: 'extra' }); }, /exact ordered normalized frame coverage/i],
    ['reordered', (fixture) => { fixture.normalized.measurements.reverse(); }, /frame order/i],
    ['missing landmark', (fixture) => { delete fixture.normalized.measurements[0].sourceLandmark; }, /landmark measurements/i],
    ['unsafe clip', (fixture) => { fixture.contract.document.clips[0].id = '../escape'; fixture.contract.sha256 = stableHash(fixture.contract.document); }, /safe.*clip/i],
    ['trailing punctuation', (fixture) => { fixture.contract.document.clips[0].id = 'idle.'; fixture.contract.sha256 = stableHash(fixture.contract.document); }, /portable.*clip|safe.*clip/i],
    ['reserved clip', (fixture) => { fixture.contract.document.clips[0].id = 'CON'; fixture.contract.sha256 = stableHash(fixture.contract.document); }, /portable.*clip|safe.*clip/i],
    ['case-fold collision', (fixture) => { fixture.contract.document.clips[0].id = 'Idle'; fixture.contract.document.clips[1].id = 'idle'; fixture.contract.sha256 = stableHash(fixture.contract.document); }, /portable.*unique|collision/i]
  ]) await t.test(label, async () => {
    const fixture = await contractFixture();
    mutate(fixture);
    await assert.rejects(exportContractAnimation(fixture), pattern);
    await assert.rejects(fs.access(fixture.outputDir), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(fixture.dir)).filter((entry) => entry.includes('.sprite-contract-stage-')), []);
  });
});

test('exports nearest-neighbor runtime frames, a transparent partial sheet row, metadata, and a lossless loop', async () => {
  const dir = await temporaryDirectory();
  const frames = await Promise.all([0, 1, 2].map(async (index) => {
    const file = path.join(dir, `frame-${index}.png`);
    await makeFrame(file, { x: 2 + index, color: [255, index * 20, 0, 255] });
    return file;
  }));
  const outputDir = path.join(dir, 'out');
  const privateTool = path.join(dir, 'private-tools', 'spritefusion-pixel-snapper');
  const config = {
    ...DEFAULT_CONFIG,
    snapper: { ...DEFAULT_CONFIG.snapper, executable: privateTool }
  };
  const result = await exportAnimation({
    frames,
    outputDir,
    config,
    columns: 2,
    durations: [80, 120, 160],
    name: 'test-run'
  });

  assert.deepEqual(result.runtimeFrames.map((file) => path.basename(file)), [
    'test-run-00.png',
    'test-run-01.png',
    'test-run-02.png'
  ]);
  const runtime = await sharp(result.runtimeFrames[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual({ width: runtime.info.width, height: runtime.info.height }, { width: 256, height: 256 });
  const alphaAt = (x, y) => runtime.data[(y * runtime.info.width + x) * 4 + 3];
  assert.equal(alphaAt(4, 4), 255);
  assert.equal(alphaAt(5, 5), 255);
  assert.equal(alphaAt(6, 4), 0);

  const sheet = await sharp(result.sheet).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual({ width: sheet.info.width, height: sheet.info.height }, { width: 512, height: 512 });
  assert.equal(sheet.data[((300 * sheet.info.width) + 300) * 4 + 3], 0);

  const metadata = JSON.parse(await fs.readFile(result.metadata, 'utf8'));
  assert.deepEqual(metadata.frames, [
    { index: 0, file: 'test-run-00.png', x: 0, y: 0, width: 256, height: 256, duration: 80 },
    { index: 1, file: 'test-run-01.png', x: 256, y: 0, width: 256, height: 256, duration: 120 },
    { index: 2, file: 'test-run-02.png', x: 0, y: 256, width: 256, height: 256, duration: 160 }
  ]);
  assert.deepEqual(metadata.sources, await Promise.all(frames.map(async (file, index) => ({
    index,
    id: `source-${String(index).padStart(2, '0')}`,
    sha256: await sha256(file)
  }))));
  assert.deepEqual(metadata.palette, {
    mode: 'preserve-anchor',
    colors: [
      { rgba: [0, 0, 0, 0], count: (128 * 128 * 3) - 3 },
      { rgba: [255, 0, 0, 255], count: 1 },
      { rgba: [255, 20, 0, 255], count: 1 },
      { rgba: [255, 40, 0, 255], count: 1 }
    ]
  });
  assert.deepEqual(metadata.config, {
    background: { color: null, mode: 'border', tolerance: 0 },
    canonical: { height: 128, width: 128 },
    correction: { generativeAttempts: 2, skillProposalEvidence: 3 },
    foreground: { minimumComponentPixels: 1, retentionPolicy: 'all' },
    generation: { height: 1024, width: 1024 },
    palette: { mode: 'preserve-anchor' },
    pivot: { x: 64, y: 112 },
    runtime: { height: 256, width: 256 },
    snapper: { args: ['16'], executable: '<absolute>/spritefusion-pixel-snapper' }
  });
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(dir.replaceAll('\\', '\\\\')));
  assert.deepEqual({
    name: metadata.name,
    frameSize: metadata.frameSize,
    canonicalPivot: metadata.canonicalPivot,
    pivot: metadata.pivot,
    columns: metadata.columns,
    rows: metadata.rows,
    durations: metadata.durations,
    sheet: metadata.sheet,
    preview: metadata.preview
  }, {
    name: 'test-run',
    frameSize: { width: 256, height: 256 },
    canonicalPivot: { x: 64, y: 112 },
    pivot: { x: 128, y: 224 },
    columns: 2,
    rows: 2,
    durations: [80, 120, 160],
    sheet: 'test-run-sheet.png',
    preview: 'test-run.webp'
  });

  const preview = await sharp(result.preview, { animated: true }).metadata();
  assert.equal(preview.pages, 3);
  assert.equal(preview.loop, 0);
  assert.deepEqual(preview.delay, [80, 120, 160]);
  assert.equal(preview.width, 256);
  assert.equal(preview.pageHeight, 256);
});

test('validates every argument before creating the output directory', async (t) => {
  const dir = await temporaryDirectory();
  const frame = path.join(dir, 'frame.png');
  const wrongSize = path.join(dir, 'wrong.png');
  await makeFrame(frame);
  await makeFrame(wrongSize, { width: 127 });

  const cases = [
    ['nonempty frames', { frames: [] }, /at least one frame is required/],
    ['integer columns', { columns: 0 }, /columns must be a positive integer/],
    ['duration count', { durations: [] }, /one integer duration per frame in the range 11\.\.65535/],
    ['zero duration', { durations: [0] }, /one integer duration per frame in the range 11\.\.65535/],
    ['duration below reliable WebP limit', { durations: [10] }, /one integer duration per frame in the range 11\.\.65535/],
    ['fractional duration', { durations: [11.5] }, /one integer duration per frame in the range 11\.\.65535/],
    ['duration above WebP limit', { durations: [65536] }, /one integer duration per frame in the range 11\.\.65535/],
    ['finite durations', { durations: [Number.NaN] }, /one integer duration per frame in the range 11\.\.65535/],
    ['safe name', { name: '../escape' }, /name must be a safe nonempty filename stem/],
    ['matching canonical dimensions', { frames: [wrongSize] }, /must be 128x128/],
    ['integer horizontal scale', { config: { ...DEFAULT_CONFIG, runtime: { width: 255, height: 256 } } }, /runtime width must be an integer multiple/],
    ['integer vertical scale', { config: { ...DEFAULT_CONFIG, runtime: { width: 256, height: 255 } } }, /runtime height must be an integer multiple/],
    ['uniform scale', { config: { ...DEFAULT_CONFIG, runtime: { width: 256, height: 384 } } }, /runtime scale must be identical on both axes/]
  ];

  for (const [label, overrides, pattern] of cases) {
    await t.test(label, async () => {
      const outputDir = path.join(dir, `out-${label.replaceAll(' ', '-')}`);
      await assert.rejects(exportAnimation({
        frames: [frame],
        outputDir,
        config: DEFAULT_CONFIG,
        columns: 1,
        durations: [80],
        name: 'valid',
        ...overrides
      }), pattern);
      await assert.rejects(fs.access(outputDir), { code: 'ENOENT' });
    });
  }
});

test('accepts the minimum and maximum supported WebP frame durations', async () => {
  const dir = await temporaryDirectory();
  const frames = await Promise.all([0, 1].map(async (index) => {
    const file = path.join(dir, `boundary-${index}.png`);
    await makeFrame(file, { x: 2 + index });
    return file;
  }));
  const result = await exportAnimation({
    frames,
    outputDir: path.join(dir, 'out'),
    config: DEFAULT_CONFIG,
    columns: 2,
    durations: [11, 65535],
    name: 'duration-boundaries'
  });
  const metadata = JSON.parse(await fs.readFile(result.metadata, 'utf8'));
  assert.deepEqual(metadata.durations, [11, 65535]);
  assert.deepEqual((await sharp(result.preview, { animated: true }).metadata()).delay, [11, 65535]);
});

test('preserves legacy flat-export filename stems while contract clip IDs use stricter portability rules', async () => {
  const dir = await temporaryDirectory();
  const frame = path.join(dir, 'frame.png');
  await makeFrame(frame);
  const result = await exportAnimation({ frames: [frame], outputDir: path.join(dir, 'legacy'), config: DEFAULT_CONFIG, columns: 1, durations: [80], name: 'legacy-' });
  assert.equal(path.basename(result.metadata), 'legacy-.json');
});

test('rejects Windows reserved device stems on every platform before writing', async (t) => {
  const dir = await temporaryDirectory();
  const frame = path.join(dir, 'frame.png');
  await makeFrame(frame);
  for (const name of ['CON', 'con.anything', 'NUL', 'aux.png', 'PRN', 'COM1', 'com9.anim', 'LPT1', 'lpt9.preview']) {
    await t.test(name, async () => {
      const outputDir = path.join(dir, `out-${name}`);
      await assert.rejects(exportAnimation({
        frames: [frame], outputDir, config: DEFAULT_CONFIG, columns: 1, durations: [80], name
      }), /name must be a safe nonempty filename stem/);
      await assert.rejects(fs.access(outputDir), { code: 'ENOENT' });
    });
  }
});

test('rejects an export that could overwrite an input or existing output', async () => {
  const dir = await temporaryDirectory();
  const input = path.join(dir, 'same-00.png');
  await makeFrame(input);
  await assert.rejects(exportAnimation({
    frames: [input], outputDir: dir, config: DEFAULT_CONFIG, columns: 1, durations: [80], name: 'same'
  }), /must not overwrite an input frame/);

  const outputDir = path.join(dir, 'existing');
  await fs.mkdir(outputDir);
  await fs.writeFile(path.join(outputDir, 'keep.txt'), 'keep');
  await assert.rejects(exportAnimation({
    frames: [input], outputDir, config: DEFAULT_CONFIG, columns: 1, durations: [80], name: 'other'
  }), /output directory already exists/);
  assert.equal(await fs.readFile(path.join(outputDir, 'keep.txt'), 'utf8'), 'keep');
});

test('rendering failure leaves no output directory or staging debris', async () => {
  const dir = await temporaryDirectory();
  const frame = path.join(dir, 'frame.png');
  await makeFrame(frame);
  const outputDir = path.join(dir, 'out');
  const validPng = await fs.readFile(frame);
  // Sharp can read dimensions from this header, but decoding the pixels fails.
  await fs.writeFile(frame, validPng.subarray(0, 80));

  await assert.rejects(exportAnimation({
    frames: [frame], outputDir, config: DEFAULT_CONFIG, columns: 1, durations: [80], name: 'failed'
  }));
  await assert.rejects(fs.access(outputDir), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(dir)).filter((entry) => entry.includes('.sprite-export-stage-')), []);
});
