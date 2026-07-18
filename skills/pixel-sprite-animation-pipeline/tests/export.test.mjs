import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { exportAnimation } from '../scripts/lib/export.mjs';
import { sha256 } from '../scripts/lib/image.mjs';

async function makeFrame(file, { width = 128, height = 128, x = 2, color = [255, 0, 0, 255] } = {}) {
  const data = Buffer.alloc(width * height * 4, 0);
  data.set(color, (2 * width + x) * 4);
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
}

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sprite-export-'));
}

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
