import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, zipSync } from 'fflate';
import tar from 'tar-stream';
import { inspectArchive, extractInspectedArchive } from '../scripts/lib/archive.mjs';

const LIMITS = Object.freeze({ entries: 16, compressed: 1 << 20, total: 2 << 20, perFile: 1 << 20, ratio: 100 });

function zipFixture(entries, options = {}) {
  return Buffer.from(zipSync(Object.fromEntries(entries.map(({ name, data = '' }) => [name, Buffer.from(data)])), options));
}

function setZipExternalAttributes(bytes, name, attributes) {
  const copy = Buffer.from(bytes);
  for (let offset = 0; offset <= copy.length - 46; offset += 1) {
    if (copy.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = copy.readUInt16LE(offset + 28);
    const found = copy.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (found === name) {
      copy.writeUInt32LE(attributes >>> 0, offset + 38);
      return copy;
    }
  }
  throw new Error(`missing ZIP entry: ${name}`);
}

function testCrc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function forgeZipDeclaredSize(bytes, name, { size, truncateCompressed = false }) {
  const copy = Buffer.from(bytes);
  for (let offset = 0; offset <= copy.length - 46; offset += 1) {
    if (copy.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = copy.readUInt16LE(offset + 28);
    if (copy.subarray(offset + 46, offset + 46 + nameLength).toString('utf8') !== name) continue;
    const localOffset = copy.readUInt32LE(offset + 42);
    const checksum = testCrc32(Buffer.alloc(size));
    copy.writeUInt32LE(checksum, offset + 16);
    copy.writeUInt32LE(size, offset + 24);
    copy.writeUInt32LE(checksum, localOffset + 14);
    copy.writeUInt32LE(size, localOffset + 22);
    if (truncateCompressed) {
      copy.writeUInt32LE(size, offset + 20);
      copy.writeUInt32LE(size, localOffset + 18);
    }
    return copy;
  }
  throw new Error(`missing ZIP entry: ${name}`);
}

async function tarFixture(entries) {
  const pack = tar.pack();
  const chunks = [];
  pack.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => pack.on('end', resolve).on('error', reject));
  for (const { name, data = '', type = 'file', mode = 0o600, linkname } of entries) {
    pack.entry({ name, type, mode, linkname }, Buffer.from(data));
  }
  pack.finalize();
  await done;
  return Buffer.from(gzipSync(Buffer.concat(chunks)));
}

async function emptyDestination() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-snapper-archive-'));
  await fs.chmod(parent, 0o700);
  return { parent, outputDir: path.join(parent, 'published') };
}

test('ZIP preflight and extraction produce only the complete expected regular-file set', async () => {
  const bytes = zipFixture([{ name: 'pixel-snapper.exe', data: 'binary' }, { name: 'LICENSE.txt', data: 'license' }]);
  const inspection = inspectArchive({ bytes, format: 'zip', expectedFiles: ['pixel-snapper.exe', 'LICENSE.txt'], limits: LIMITS });
  assert.equal(Object.isFrozen(inspection), true);
  const { outputDir } = await emptyDestination();

  const result = await extractInspectedArchive({ inspection, outputDir });

  assert.deepEqual(result.files.map((file) => path.relative(outputDir, file)), ['pixel-snapper.exe', 'LICENSE.txt']);
  assert.equal(await fs.readFile(path.join(outputDir, 'pixel-snapper.exe'), 'utf8'), 'binary');
  assert.equal(await fs.readFile(path.join(outputDir, 'LICENSE.txt'), 'utf8'), 'license');
  assert.equal((await fs.stat(path.join(outputDir, 'pixel-snapper.exe'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(outputDir, 'LICENSE.txt'))).mode & 0o777, 0o600);
});

test('tar.gz preflight preserves safe nested files and archive executable metadata', async () => {
  const bytes = await tarFixture([
    { name: 'bin/pixel-snapper', data: 'binary', mode: 0o755 },
    { name: 'share/data.bin', data: 'data', mode: 0o644 }
  ]);
  const inspection = inspectArchive({ bytes, format: 'tar.gz', expectedFiles: ['bin/pixel-snapper', 'share/data.bin'], limits: LIMITS });
  const { outputDir } = await emptyDestination();

  await extractInspectedArchive({ inspection, outputDir });

  assert.equal(await fs.readFile(path.join(outputDir, 'bin/pixel-snapper'), 'utf8'), 'binary');
  assert.equal((await fs.stat(path.join(outputDir, 'bin/pixel-snapper'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(outputDir, 'share/data.bin'))).mode & 0o777, 0o600);
});

test('archive preflight writes nothing for a case-fold or Unicode-normalization collision', async () => {
  for (const entries of [
    [{ name: 'Tool.exe', data: 'a' }, { name: 'tool.exe', data: 'b' }],
    [{ name: 'caf\u00e9.txt', data: 'a' }, { name: 'cafe\u0301.txt', data: 'b' }]
  ]) {
    const { parent } = await emptyDestination();
    const bytes = zipFixture(entries);
    assert.throws(() => inspectArchive({ bytes, format: 'zip', expectedFiles: [entries[0].name], limits: LIMITS }), /case-fold collision/);
    assert.deepEqual(await fs.readdir(parent), []);
  }
});

test('archive rejects traversal, absolute paths, ADS, reserved names, and hostile components', async () => {
  const unsafe = [
    '../tool.exe', 'safe/../../tool.exe', '/absolute/tool.exe', 'C:/tool.exe', 'C:tool.exe',
    '\\\\server\\share\\tool.exe', 'safe\\..\\tool.exe', 'tool.exe:stream', 'CON', 'aux.txt', 'CON .txt', 'COM1 .bin',
    'safe/NUL.dat', 'trailing./tool.exe', 'trailing /tool.exe', 'double//tool.exe', './tool.exe',
    'control\u0001/tool.exe'
  ];
  for (const name of unsafe) {
    const bytes = zipFixture([{ name, data: 'x' }]);
    assert.throws(() => inspectArchive({ bytes, format: 'zip', expectedFiles: ['tool.exe'], limits: LIMITS }), /unsafe archive entry/,
      `expected unsafe path rejection for ${JSON.stringify(name)}`);
  }
});

test('archive rejects ZIP and TAR links and all non-regular entries', async () => {
  const regularZip = zipFixture([{ name: 'tool', data: 'target' }]);
  const symlinkZip = setZipExternalAttributes(regularZip, 'tool', (0o120777 << 16) >>> 0);
  assert.throws(() => inspectArchive({ bytes: symlinkZip, format: 'zip', expectedFiles: ['tool'], limits: LIMITS }), /unsafe archive entry/);

  for (const type of ['symlink', 'link', 'directory', 'fifo', 'character-device', 'block-device']) {
    const bytes = await tarFixture([{ name: 'tool', type, linkname: 'target' }]);
    assert.throws(() => inspectArchive({ bytes, format: 'tar.gz', expectedFiles: ['tool'], limits: LIMITS }), /unsafe archive entry/,
      `expected rejection for TAR ${type}`);
  }
});

test('archive enforces entry, compressed, total, per-file, and compression-ratio limits', async () => {
  const two = zipFixture([{ name: 'a', data: 'a' }, { name: 'b', data: 'b' }], { level: 0 });
  assert.throws(() => inspectArchive({ bytes: two, format: 'zip', expectedFiles: ['a', 'b'], limits: { ...LIMITS, entries: 1 } }), /entry limit/);
  assert.throws(() => inspectArchive({ bytes: two, format: 'zip', expectedFiles: ['a', 'b'], limits: { ...LIMITS, compressed: two.length - 1 } }), /compressed size limit/);
  assert.throws(() => inspectArchive({ bytes: two, format: 'zip', expectedFiles: ['a', 'b'], limits: { ...LIMITS, total: 1 } }), /total size limit/);

  const large = zipFixture([{ name: 'tool', data: Buffer.alloc(4096) }]);
  assert.throws(() => inspectArchive({ bytes: large, format: 'zip', expectedFiles: ['tool'], limits: { ...LIMITS, perFile: 4095 } }), /per-file size limit/);
  assert.throws(() => inspectArchive({ bytes: large, format: 'zip', expectedFiles: ['tool'], limits: { ...LIMITS, ratio: 2 } }), /compression ratio limit/);

  const tarBomb = await tarFixture([{ name: 'tool', data: Buffer.alloc(8192) }]);
  assert.throws(() => inspectArchive({ bytes: tarBomb, format: 'tar.gz', expectedFiles: ['tool'], limits: { ...LIMITS, ratio: 2 } }), /compression ratio limit/);
});

test('ZIP rejects DEFLATE and stored streams that expand beyond forged declared sizes', () => {
  const deflated = zipFixture([{ name: 'tool.exe', data: Buffer.alloc(4096) }]);
  const stored = zipFixture([{ name: 'tool.exe', data: Buffer.alloc(4096) }], { level: 0 });
  for (const bytes of [
    forgeZipDeclaredSize(deflated, 'tool.exe', { size: 1 }),
    forgeZipDeclaredSize(stored, 'tool.exe', { size: 1, truncateCompressed: true })
  ]) {
    assert.throws(() => inspectArchive({ bytes, format: 'zip', expectedFiles: ['tool.exe'], limits: LIMITS }), /declared size|invalid ZIP archive/);
  }
});

test('archive callers cannot weaken the built-in safety ceilings', () => {
  const bytes = zipFixture([{ name: 'tool.exe', data: 'binary' }]);
  for (const limits of [
    { compressed: (25 << 20) + 1 },
    { total: (100 << 20) + 1 },
    { perFile: (50 << 20) + 1 },
    { entries: 17 },
    { ratio: 101 }
  ]) {
    assert.throws(() => inspectArchive({ bytes, format: 'zip', expectedFiles: ['tool.exe'], limits }), /invalid archive limits/);
  }
});

test('archive rejects missing, unexpected, duplicate, corrupt, and unsupported inputs', async () => {
  const bytes = zipFixture([{ name: 'tool.exe', data: 'binary' }]);
  assert.throws(() => inspectArchive({ bytes, format: 'zip', expectedFiles: ['tool.exe', 'LICENSE'], limits: LIMITS }), /expected file set/);
  assert.throws(() => inspectArchive({ bytes, format: 'zip', expectedFiles: [], limits: LIMITS }), /expected file set/);
  assert.throws(() => inspectArchive({ bytes, format: 'rar', expectedFiles: ['tool.exe'], limits: LIMITS }), /unsupported archive format/);
  assert.throws(() => inspectArchive({ bytes: Buffer.from('not a zip'), format: 'zip', expectedFiles: ['tool.exe'], limits: LIMITS }), /invalid ZIP archive/);

  const corrupted = Buffer.from(bytes);
  corrupted[0] ^= 0xff;
  assert.throws(() => inspectArchive({ bytes: corrupted, format: 'zip', expectedFiles: ['tool.exe'], limits: LIMITS }), /invalid ZIP archive/);
});

test('failed archive preflight never creates an output directory and inspections cannot be forged', async () => {
  const { parent, outputDir } = await emptyDestination();
  const bytes = zipFixture([{ name: '../tool.exe', data: 'x' }]);
  assert.throws(() => inspectArchive({ bytes, format: 'zip', expectedFiles: ['tool.exe'], limits: LIMITS }), /unsafe archive entry/);
  await assert.rejects(fs.access(outputDir));
  await assert.rejects(extractInspectedArchive({ inspection: Object.freeze({}), outputDir }), /invalid archive inspection/);
  await assert.rejects(fs.access(outputDir));
});

test('extraction refuses existing destinations instead of overwriting them', async () => {
  const bytes = zipFixture([{ name: 'tool.exe', data: 'binary' }]);
  const inspection = inspectArchive({ bytes, format: 'zip', expectedFiles: ['tool.exe'], limits: LIMITS });
  const { outputDir } = await emptyDestination();
  await fs.mkdir(outputDir);
  await fs.writeFile(path.join(outputDir, 'tool.exe'), 'existing');
  await assert.rejects(extractInspectedArchive({ inspection, outputDir }), /EEXIST/);
  assert.equal(await fs.readFile(path.join(outputDir, 'tool.exe'), 'utf8'), 'existing');
});

test('extraction rejects symlinked ancestors and insecure final parents', async (context) => {
  const bytes = zipFixture([{ name: 'tool.exe', data: 'binary' }]);
  const inspection = inspectArchive({ bytes, format: 'zip', expectedFiles: ['tool.exe'], limits: LIMITS });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-snapper-parent-'));
  const secure = path.join(root, 'secure');
  await fs.mkdir(secure, { mode: 0o700 });
  const linked = path.join(root, 'linked');
  await fs.symlink(secure, linked, 'dir');
  await assert.rejects(extractInspectedArchive({ inspection, outputDir: path.join(linked, 'published') }), /unsafe archive output parent/);
  assert.deepEqual(await fs.readdir(secure), []);

  await fs.chmod(secure, 0o777);
  const mode = (await fs.stat(secure)).mode & 0o777;
  if (mode !== 0o777) context.skip(`filesystem did not retain insecure mode: ${mode.toString(8)}`);
  else await assert.rejects(extractInspectedArchive({ inspection, outputDir: path.join(secure, 'published') }), /unsafe archive output parent/);
});

test('staged extraction preserves a destination that appears immediately before publication', async () => {
  const bytes = zipFixture([{ name: 'tool.exe', data: 'binary' }]);
  const inspection = inspectArchive({ bytes, format: 'zip', expectedFiles: ['tool.exe'], limits: LIMITS });
  const { parent, outputDir } = await emptyDestination();
  const fsImpl = {
    ...fs,
    mkdir: async (destination, options) => {
      if (path.resolve(destination) === outputDir) {
        await assert.rejects(fs.access(destination));
        await fs.mkdir(destination, { mode: 0o700 });
        await fs.writeFile(path.join(destination, 'sentinel'), 'do not replace');
      }
      return fs.mkdir(destination, options);
    }
  };

  await assert.rejects(extractInspectedArchive({ inspection, outputDir, fsImpl }), /EEXIST|ENOTEMPTY/);

  assert.equal(await fs.readFile(path.join(outputDir, 'sentinel'), 'utf8'), 'do not replace');
  assert.deepEqual((await fs.readdir(parent)).sort(), ['published']);
});

test('atomic reservation preserves a competing empty destination directory', async () => {
  const bytes = zipFixture([{ name: 'tool.exe', data: 'binary' }]);
  const inspection = inspectArchive({ bytes, format: 'zip', expectedFiles: ['tool.exe'], limits: LIMITS });
  const { parent, outputDir } = await emptyDestination();
  let competitorCreated = false;
  const fsImpl = {
    ...fs,
    mkdir: async (destination, options) => {
      if (path.resolve(destination) === outputDir) {
        await assert.rejects(fs.access(destination));
        await fs.mkdir(destination, { mode: 0o700 });
        competitorCreated = true;
      }
      return fs.mkdir(destination, options);
    }
  };

  await assert.rejects(extractInspectedArchive({ inspection, outputDir, fsImpl }), /EEXIST/);

  assert.equal(competitorCreated, true);
  assert.deepEqual(await fs.readdir(outputDir), []);
  assert.deepEqual((await fs.readdir(parent)).sort(), ['published']);
});

test('staged extraction detects parent identity replacement before publication', async () => {
  const bytes = zipFixture([{ name: 'tool.exe', data: 'binary' }]);
  const inspection = inspectArchive({ bytes, format: 'zip', expectedFiles: ['tool.exe'], limits: LIMITS });
  const { parent, outputDir } = await emptyDestination();
  let stageCreated = false;
  const fsImpl = {
    ...fs,
    mkdtemp: async (...args) => {
      const stage = await fs.mkdtemp(...args);
      stageCreated = true;
      return stage;
    },
    lstat: async (candidate) => {
      const info = await fs.lstat(candidate);
      if (!stageCreated || path.resolve(candidate) !== parent) return info;
      return {
        dev: info.dev,
        ino: info.ino + 1,
        mode: info.mode,
        uid: info.uid,
        isDirectory: () => info.isDirectory(),
        isSymbolicLink: () => info.isSymbolicLink()
      };
    }
  };

  await assert.rejects(extractInspectedArchive({ inspection, outputDir, fsImpl }), /output parent changed/);

  assert.deepEqual(await fs.readdir(parent), []);
  await assert.rejects(fs.access(outputDir));
});
