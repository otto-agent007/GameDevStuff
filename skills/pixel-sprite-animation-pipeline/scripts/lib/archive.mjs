import fs from 'node:fs/promises';
import path from 'node:path';
import { Gunzip, Inflate } from 'fflate';

const DEFAULT_LIMITS = Object.freeze({ entries: 16, compressed: 25 << 20, total: 100 << 20, perFile: 50 << 20, ratio: 100 });
const RESERVED_STEM = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const INSPECTIONS = new WeakMap();
const CRC_TABLE = makeCrcTable();

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function limitsFor(input) {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error('invalid archive limits');
  const limits = { ...DEFAULT_LIMITS, ...(input ?? {}) };
  for (const key of ['entries', 'compressed', 'total', 'perFile']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_LIMITS[key]) throw new Error('invalid archive limits');
  }
  if (typeof limits.ratio !== 'number' || !Number.isFinite(limits.ratio) || limits.ratio <= 0 || limits.ratio > DEFAULT_LIMITS.ratio) throw new Error('invalid archive limits');
  if (Object.keys(limits).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key))) throw new Error('invalid archive limits');
  return Object.freeze(limits);
}

function archiveBytes(input, compressedLimit) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) throw new Error('invalid archive bytes');
  if (input.byteLength > compressedLimit) throw new Error('archive compressed size limit exceeded');
  return Buffer.from(input);
}

function unsafeName(original) {
  throw new Error(`unsafe archive entry: ${String(original)}`);
}

function normalizePortable(original) {
  if (typeof original !== 'string' || original.length === 0 || /[\0-\x1f\x7f]/.test(original)) unsafeName(original);
  const portable = original.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable) || portable.includes(':')) unsafeName(original);
  const components = portable.split('/');
  if (components.some((component) => component === '' || component === '.' || component === '..' || /[. ]$/.test(component))) unsafeName(original);
  for (const component of components) {
    const stem = component.split('.')[0].replace(/[. ]+$/g, '');
    if (RESERVED_STEM.test(stem)) unsafeName(original);
  }
  return portable.normalize('NFC');
}

function validateExpectedFiles(expectedFiles) {
  if (!Array.isArray(expectedFiles) || expectedFiles.length === 0) throw new Error('archive expected file set mismatch');
  const seen = new Set();
  const names = [];
  for (const expected of expectedFiles) {
    let name;
    try {
      name = normalizePortable(expected);
    } catch {
      throw new Error('archive expected file set mismatch');
    }
    const folded = name.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw new Error('archive expected file set mismatch');
    seen.add(folded);
    names.push(name);
  }
  return names;
}

function validateEntryName(original, seen) {
  const name = normalizePortable(original);
  const folded = name.toLocaleLowerCase('en-US');
  if (seen.has(folded)) throw new Error(`archive case-fold collision: ${name}`);
  seen.add(folded);
  return name;
}

function assertExpectedSet(entries, expectedFiles) {
  const actual = new Set(entries.map(({ name }) => name));
  if (actual.size !== expectedFiles.length || expectedFiles.some((name) => !actual.has(name))) {
    throw new Error('archive expected file set mismatch');
  }
}

function enforceArchiveTotals(entries, compressedSize, limits) {
  if (entries.length > limits.entries) throw new Error('archive entry limit exceeded');
  let total = 0;
  for (const entry of entries) {
    if (entry.size > limits.perFile) throw new Error('archive per-file size limit exceeded');
    total += entry.size;
    if (!Number.isSafeInteger(total) || total > limits.total) throw new Error('archive total size limit exceeded');
  }
  if (total > 0 && total / Math.max(compressedSize, 1) > limits.ratio) throw new Error('archive compression ratio limit exceeded');
  return total;
}

function u16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error('invalid ZIP archive');
  return bytes.readUInt16LE(offset);
}

function u32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error('invalid ZIP archive');
  return bytes.readUInt32LE(offset);
}

function decodeZipName(bytes, flags) {
  if ((flags & 0x800) === 0 && bytes.some((byte) => byte >= 0x80)) throw new Error('invalid ZIP archive');
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error('invalid ZIP archive');
  }
}

function findEndOfCentralDirectory(bytes) {
  const earliest = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (u32(bytes, offset) === 0x06054b50 && offset + 22 + u16(bytes, offset + 20) === bytes.length) return offset;
  }
  throw new Error('invalid ZIP archive');
}

function zipMetadata(bytes, limits) {
  let eocd;
  try {
    eocd = findEndOfCentralDirectory(bytes);
  } catch {
    throw new Error('invalid ZIP archive');
  }
  const disk = u16(bytes, eocd + 4);
  const centralDisk = u16(bytes, eocd + 6);
  const diskEntries = u16(bytes, eocd + 8);
  const count = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== count || count === 0xffff || centralSize === 0xffffffff ||
      centralOffset === 0xffffffff || centralOffset + centralSize !== eocd || count > limits.entries) {
    if (count > limits.entries) throw new Error('archive entry limit exceeded');
    throw new Error('invalid ZIP archive');
  }

  const entries = [];
  const seen = new Set();
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > eocd || u32(bytes, offset) !== 0x02014b50) throw new Error('invalid ZIP archive');
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const checksum = u32(bytes, offset + 16);
    const compressedSize = u32(bytes, offset + 20);
    const size = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const startDisk = u16(bytes, offset + 34);
    const external = u32(bytes, offset + 38);
    const localOffset = u32(bytes, offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (nameLength === 0 || next > eocd || startDisk !== 0 || compressedSize === 0xffffffff || size === 0xffffffff ||
        localOffset === 0xffffffff || (flags & 1) !== 0 || ![0, 8].includes(method)) throw new Error('invalid ZIP archive');
    const original = decodeZipName(bytes.subarray(offset + 46, offset + 46 + nameLength), flags);
    const unixType = (external >>> 16) & 0o170000;
    if (original.endsWith('/') || (external & 0x10) !== 0 || (unixType !== 0 && unixType !== 0o100000)) unsafeName(original);
    const name = validateEntryName(original, seen);
    if (size > limits.perFile) throw new Error('archive per-file size limit exceeded');
    if (size > 0 && size / Math.max(compressedSize, 1) > limits.ratio) throw new Error('archive compression ratio limit exceeded');
    entries.push({
      name,
      original,
      rawName: Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      flags,
      method,
      checksum,
      compressedSize,
      size,
      localOffset,
      executable: /\.exe$/i.test(name) || (((external >>> 16) & 0o111) !== 0)
    });
    offset = next;
  }
  if (offset !== eocd) throw new Error('invalid ZIP archive');
  enforceArchiveTotals(entries, bytes.length, limits);
  return { entries, centralOffset };
}

function zipDataDescriptorEnd(bytes, entry, dataEnd, centralOffset) {
  if ((entry.flags & 0x08) === 0) return dataEnd;
  let offset = dataEnd;
  if (offset + 4 <= centralOffset && u32(bytes, offset) === 0x08074b50) offset += 4;
  if (offset + 12 > centralOffset || u32(bytes, offset) !== entry.checksum ||
      u32(bytes, offset + 4) !== entry.compressedSize || u32(bytes, offset + 8) !== entry.size) {
    throw new Error('invalid ZIP archive');
  }
  return offset + 12;
}

function preflightZipLocalEntries(bytes, entries, centralOffset) {
  const ranges = [];
  for (const entry of entries) {
    const offset = entry.localOffset;
    if (u32(bytes, offset) !== 0x04034b50) throw new Error('invalid ZIP archive');
    const flags = u16(bytes, offset + 6);
    const method = u16(bytes, offset + 8);
    const localChecksum = u32(bytes, offset + 14);
    const localCompressedSize = u32(bytes, offset + 18);
    const localSize = u32(bytes, offset + 22);
    const nameLength = u16(bytes, offset + 26);
    const extraLength = u16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    const descriptor = (flags & 0x08) !== 0;
    const localMetadataMatches = descriptor
      ? [localChecksum, localCompressedSize, localSize].every((value, index) => value === 0 || value === [entry.checksum, entry.compressedSize, entry.size][index])
      : localChecksum === entry.checksum && localCompressedSize === entry.compressedSize && localSize === entry.size;
    if (dataEnd > centralOffset || flags !== entry.flags || method !== entry.method || !localMetadataMatches ||
        nameLength !== entry.rawName.length || !bytes.subarray(nameStart, nameStart + nameLength).equals(entry.rawName)) {
      throw new Error('invalid ZIP archive');
    }
    const rangeEnd = zipDataDescriptorEnd(bytes, entry, dataEnd, centralOffset);
    ranges.push([offset, rangeEnd]);
    entry.compressed = Buffer.from(bytes.subarray(dataStart, dataEnd));
  }
  ranges.sort((left, right) => left[0] - right[0]);
  if (ranges.length > 0 && ranges[0][0] !== 0) throw new Error('invalid ZIP archive');
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] !== ranges[index - 1][1]) throw new Error('invalid ZIP archive');
  }
  if (ranges.length > 0 && ranges.at(-1)[1] !== centralOffset) throw new Error('invalid ZIP archive');
  if (ranges.length === 0 && centralOffset !== 0) throw new Error('invalid ZIP archive');
}

function inflateRawBounded(compressed, declaredSize, maximumSize) {
  const chunks = [];
  let actualSize = 0;
  const inflate = new Inflate((chunk) => {
    actualSize += chunk.length;
    if (actualSize > declaredSize) throw new Error('ZIP entry exceeded declared size');
    if (actualSize > maximumSize) throw new Error('archive per-file or total size limit exceeded');
    chunks.push(Buffer.from(chunk));
  });
  try {
    if (compressed.length === 0) inflate.push(new Uint8Array(0), true);
    for (let offset = 0; offset < compressed.length; offset += 1024) {
      const end = Math.min(offset + 1024, compressed.length);
      inflate.push(compressed.subarray(offset, end), end === compressed.length);
    }
  } catch (error) {
    if (/declared size|size limit/.test(error?.message)) throw error;
    throw new Error('invalid ZIP archive');
  }
  if (actualSize !== declaredSize) throw new Error('ZIP entry declared size mismatch');
  return Buffer.concat(chunks, actualSize);
}

function inflateZipEntries(entries, limits) {
  let actualTotal = 0;
  for (const entry of entries) {
    let data;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw new Error('ZIP stored entry declared size mismatch');
      data = Buffer.from(entry.compressed);
    } else {
      data = inflateRawBounded(entry.compressed, entry.size, Math.min(limits.perFile, limits.total - actualTotal));
    }
    actualTotal += data.length;
    if (data.length !== entry.size) throw new Error('ZIP entry declared size mismatch');
    if (actualTotal > limits.total) throw new Error('archive total size limit exceeded');
    if (crc32(data) !== entry.checksum) throw new Error('invalid ZIP archive');
    entry.data = data;
    delete entry.compressed;
  }
}

function boundedGunzip(bytes, limits) {
  const overhead = (limits.entries * 1024) + 1024;
  const maximum = Math.min(limits.total + overhead, Math.ceil(bytes.length * limits.ratio) + overhead);
  const chunks = [];
  let size = 0;
  const gunzip = new Gunzip((chunk) => {
    size += chunk.length;
    if (size > maximum) throw new Error('archive decompressed size limit exceeded');
    chunks.push(Buffer.from(chunk));
  });
  try {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      const end = Math.min(offset + (64 * 1024), bytes.length);
      gunzip.push(bytes.subarray(offset, end), end === bytes.length);
    }
  } catch (error) {
    if (/archive decompressed size limit exceeded/.test(error?.message)) throw error;
    throw new Error('invalid tar.gz archive');
  }
  return Buffer.concat(chunks, size);
}

function tarString(bytes, start, length) {
  const field = bytes.subarray(start, start + length);
  const nul = field.indexOf(0);
  const content = nul === -1 ? field : field.subarray(0, nul);
  try {
    return UTF8.decode(content);
  } catch {
    throw new Error('invalid tar.gz archive');
  }
}

function tarOctal(bytes, start, length) {
  const raw = bytes.subarray(start, start + length);
  if ((raw[0] & 0x80) !== 0) throw new Error('invalid tar.gz archive');
  const text = raw.toString('ascii').replace(/\0.*$/s, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error('invalid tar.gz archive');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error('invalid tar.gz archive');
  return value;
}

function isZeroBlock(bytes, offset) {
  for (let index = offset; index < offset + 512; index += 1) if (bytes[index] !== 0) return false;
  return true;
}

function verifyTarChecksum(bytes, offset) {
  const expected = tarOctal(bytes, offset + 148, 8);
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : bytes[offset + index];
  if (sum !== expected) throw new Error('invalid tar.gz archive');
}

function parseTar(bytes, compressedSize, limits) {
  const entries = [];
  const seen = new Set();
  let offset = 0;
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 512 > bytes.length) throw new Error('invalid tar.gz archive');
    if (isZeroBlock(bytes, offset)) {
      if (offset + 1024 > bytes.length || !isZeroBlock(bytes, offset + 512)) throw new Error('invalid tar.gz archive');
      for (let index = offset + 1024; index < bytes.length; index += 1) if (bytes[index] !== 0) throw new Error('invalid tar.gz archive');
      ended = true;
      break;
    }
    verifyTarChecksum(bytes, offset);
    if (entries.length >= limits.entries) throw new Error('archive entry limit exceeded');
    const type = bytes[offset + 156];
    const rawName = tarString(bytes, offset, 100);
    const prefix = tarString(bytes, offset + 345, 155);
    const original = prefix ? `${prefix}/${rawName}` : rawName;
    if (type !== 0 && type !== 0x30) unsafeName(original);
    const size = tarOctal(bytes, offset + 124, 12);
    const mode = tarOctal(bytes, offset + 100, 8);
    const name = validateEntryName(original, seen);
    if (size > limits.perFile) throw new Error('archive per-file size limit exceeded');
    const dataStart = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    const next = dataStart + paddedSize;
    if (next > bytes.length) throw new Error('invalid tar.gz archive');
    for (let index = dataStart + size; index < next; index += 1) if (bytes[index] !== 0) throw new Error('invalid tar.gz archive');
    entries.push({ name, size, executable: (mode & 0o111) !== 0, data: Buffer.from(bytes.subarray(dataStart, dataStart + size)) });
    offset = next;
  }
  if (!ended) throw new Error('invalid tar.gz archive');
  enforceArchiveTotals(entries, compressedSize, limits);
  return entries;
}

function inspectZip(bytes, expectedFiles, limits) {
  const { entries, centralOffset } = zipMetadata(bytes, limits);
  assertExpectedSet(entries, expectedFiles);
  preflightZipLocalEntries(bytes, entries, centralOffset);
  inflateZipEntries(entries, limits);
  return entries;
}

function inspectTarGz(bytes, expectedFiles, limits) {
  const tarBytes = boundedGunzip(bytes, limits);
  const entries = parseTar(tarBytes, bytes.length, limits);
  assertExpectedSet(entries, expectedFiles);
  return entries;
}

export function inspectArchive({ bytes: input, format, expectedFiles: expectedInput, limits: inputLimits } = {}) {
  const limits = limitsFor(inputLimits);
  const bytes = archiveBytes(input, limits.compressed);
  const expectedFiles = validateExpectedFiles(expectedInput);
  let entries;
  if (format === 'zip') entries = inspectZip(bytes, expectedFiles, limits);
  else if (format === 'tar.gz') entries = inspectTarGz(bytes, expectedFiles, limits);
  else throw new Error(`unsupported archive format: ${String(format)}`);

  const inspection = Object.freeze({ format, files: Object.freeze(entries.map(({ name }) => name)) });
  INSPECTIONS.set(inspection, entries.map((entry) => Object.freeze({ ...entry, data: Buffer.from(entry.data) })));
  return inspection;
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function assertDestinationAbsent(fsImpl, destination) {
  try {
    await fsImpl.lstat(destination);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`EEXIST: archive output already exists: ${destination}`);
}

async function verifySecureParent(fsImpl, parent, expectedIdentity) {
  const resolved = path.resolve(parent);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const paths = [current, ...components.map((component) => {
    current = path.join(current, component);
    return current;
  })];
  for (const candidate of paths) {
    let info;
    try {
      info = await fsImpl.lstat(candidate);
    } catch {
      throw new Error(`unsafe archive output parent: ${resolved}`);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe archive output parent: ${resolved}`);
  }
  const info = await fsImpl.lstat(resolved);
  const physical = await fsImpl.realpath(resolved);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (physical !== resolved || (currentUid !== null && Number.isInteger(info.uid) && info.uid !== currentUid) || (info.mode & 0o022) !== 0) {
    throw new Error(`unsafe archive output parent: ${resolved}`);
  }
  if (expectedIdentity && (!sameIdentity(info, expectedIdentity) || physical !== expectedIdentity.physical)) {
    throw new Error(`unsafe archive output parent changed: ${resolved}`);
  }
  return { dev: info.dev, ino: info.ino, physical };
}

function stageDirectories(stage, entries) {
  const directories = new Set();
  for (const entry of entries) {
    let parent = path.dirname(path.join(stage, ...entry.name.split('/')));
    while (parent !== stage) {
      directories.add(parent);
      parent = path.dirname(parent);
    }
  }
  return [...directories].sort((left, right) => left.split(path.sep).length - right.split(path.sep).length);
}

async function writeExclusive(fsImpl, destination, data, mode) {
  const handle = await fsImpl.open(destination, 'wx', mode);
  try {
    await handle.writeFile(data);
    if (typeof handle.sync === 'function') await handle.sync();
  } finally {
    await handle.close();
  }
}

async function walkStage(fsImpl, root, relative = '') {
  const directory = relative ? path.join(root, ...relative.split('/')) : root;
  const names = await fsImpl.readdir(directory);
  const found = [];
  for (const name of names) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const child = path.join(root, ...childRelative.split('/'));
    const info = await fsImpl.lstat(child);
    if (info.isSymbolicLink()) throw new Error('unsafe staged archive entry');
    if (info.isDirectory()) {
      found.push({ name: childRelative, type: 'directory', info });
      found.push(...await walkStage(fsImpl, root, childRelative));
    } else if (info.isFile()) {
      found.push({ name: childRelative, type: 'file', info });
    } else {
      throw new Error('unsafe staged archive entry');
    }
  }
  return found;
}

async function verifyStage(fsImpl, stage, identity, entries) {
  const stageInfo = await fsImpl.lstat(stage);
  const physical = await fsImpl.realpath(stage);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink() || !sameIdentity(stageInfo, identity) || physical !== path.resolve(stage) ||
      (stageInfo.mode & 0o077) !== 0 || (currentUid !== null && Number.isInteger(stageInfo.uid) && stageInfo.uid !== currentUid)) {
    throw new Error('unsafe staged archive directory');
  }

  const expected = new Map();
  for (const directory of stageDirectories(stage, entries)) {
    expected.set(path.relative(stage, directory).split(path.sep).join('/'), { type: 'directory' });
  }
  for (const entry of entries) expected.set(entry.name, { type: 'file', entry });
  const found = await walkStage(fsImpl, stage);
  if (found.length !== expected.size) throw new Error('staged archive entry set mismatch');
  for (const item of found) {
    const wanted = expected.get(item.name);
    if (!wanted || wanted.type !== item.type) throw new Error('staged archive entry set mismatch');
    const candidate = path.join(stage, ...item.name.split('/'));
    const candidatePhysical = await fsImpl.realpath(candidate);
    if (!candidatePhysical.startsWith(`${physical}${path.sep}`)) throw new Error('unsafe staged archive entry');
    if (item.type === 'directory') {
      if ((item.info.mode & 0o077) !== 0) throw new Error('unsafe staged archive directory');
    } else {
      const expectedMode = wanted.entry.executable ? 0o700 : 0o600;
      if (item.info.nlink !== 1 || item.info.size !== wanted.entry.data.length || (item.info.mode & 0o777) !== expectedMode ||
          !Buffer.from(await fsImpl.readFile(candidate)).equals(wanted.entry.data)) {
        throw new Error('staged archive entry verification failed');
      }
    }
  }
}

async function removeOwnedDirectory(fsImpl, target, identity, expectedPhysical) {
  try {
    const info = await fsImpl.lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || !sameIdentity(info, identity)) return false;
    if (await fsImpl.realpath(target) !== expectedPhysical) return false;
    await fsImpl.rm(target, { recursive: true, force: false });
    return true;
  } catch {
    // Refuse broader cleanup when identity or reachability changed during a race.
    return false;
  }
}

async function verifyOwnedReservation(fsImpl, reservation, expectedIdentity) {
  const info = await fsImpl.lstat(reservation);
  const physical = await fsImpl.realpath(reservation);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!info.isDirectory() || info.isSymbolicLink() || physical !== path.resolve(reservation) || (info.mode & 0o077) !== 0 ||
      (currentUid !== null && Number.isInteger(info.uid) && info.uid !== currentUid)) {
    throw new Error('unsafe archive output reservation');
  }
  if (expectedIdentity && (!sameIdentity(info, expectedIdentity) || physical !== expectedIdentity.physical)) {
    throw new Error('archive output reservation changed');
  }
  return { dev: info.dev, ino: info.ino, physical };
}

async function transferStageIntoReservation(fsImpl, stage, reservation, reservationIdentity, entries) {
  const reservationDirectories = stageDirectories(reservation, entries);
  for (const directory of reservationDirectories) {
    await verifyOwnedReservation(fsImpl, reservation, reservationIdentity);
    await fsImpl.mkdir(directory, { recursive: false, mode: 0o700 });
    const info = await fsImpl.lstat(directory);
    const physical = await fsImpl.realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        !physical.startsWith(`${reservationIdentity.physical}${path.sep}`)) {
      throw new Error('unsafe archive output reservation entry');
    }
  }
  for (const entry of entries) {
    await verifyOwnedReservation(fsImpl, reservation, reservationIdentity);
    const source = path.join(stage, ...entry.name.split('/'));
    const destination = path.join(reservation, ...entry.name.split('/'));
    const sourceData = Buffer.from(await fsImpl.readFile(source));
    if (!sourceData.equals(entry.data)) throw new Error('staged archive entry changed during publication');
    await writeExclusive(fsImpl, destination, sourceData, entry.executable ? 0o700 : 0o600);
    await fsImpl.unlink(source);
  }
}

export async function extractInspectedArchive({ inspection, outputDir, fsImpl = fs } = {}) {
  const entries = INSPECTIONS.get(inspection);
  if (!entries) throw new Error('invalid archive inspection');
  if (typeof outputDir !== 'string' || outputDir.length === 0) throw new Error('invalid archive output directory');
  const output = path.resolve(outputDir);
  const parent = path.dirname(output);
  const parentIdentity = await verifySecureParent(fsImpl, parent);
  await assertDestinationAbsent(fsImpl, output);

  const stagePrefix = path.join(parent, `.${path.basename(output)}.stage-`);
  let stage;
  let stageIdentity;
  let stagePhysical;
  let reservationIdentity;
  try {
    stage = await fsImpl.mkdtemp(stagePrefix);
    if (path.dirname(stage) !== parent || !path.basename(stage).startsWith(path.basename(stagePrefix)) || stage.length <= stagePrefix.length) {
      throw new Error('unsafe staged archive directory');
    }
    const initialStageInfo = await fsImpl.lstat(stage);
    stageIdentity = { dev: initialStageInfo.dev, ino: initialStageInfo.ino };
    stagePhysical = await fsImpl.realpath(stage);
    if (stagePhysical !== path.resolve(stage)) throw new Error('unsafe staged archive directory');
    await fsImpl.chmod(stage, 0o700);

    for (const directory of stageDirectories(stage, entries)) await fsImpl.mkdir(directory, { mode: 0o700 });
    for (const entry of entries) {
      const destination = path.join(stage, ...entry.name.split('/'));
      await writeExclusive(fsImpl, destination, entry.data, entry.executable ? 0o700 : 0o600);
    }

    await verifyStage(fsImpl, stage, stageIdentity, entries);
    await verifySecureParent(fsImpl, parent, parentIdentity);
    await assertDestinationAbsent(fsImpl, output);
    await fsImpl.mkdir(output, { recursive: false, mode: 0o700 });
    reservationIdentity = await verifyOwnedReservation(fsImpl, output);
    await verifySecureParent(fsImpl, parent, parentIdentity);
    await transferStageIntoReservation(fsImpl, stage, output, reservationIdentity, entries);
    await verifyOwnedReservation(fsImpl, output, reservationIdentity);
    await verifyStage(fsImpl, output, reservationIdentity, entries);
    if (!await removeOwnedDirectory(fsImpl, stage, stageIdentity, stagePhysical)) throw new Error('failed to remove owned archive stage');
    await verifySecureParent(fsImpl, parent, parentIdentity);
    await verifyOwnedReservation(fsImpl, output, reservationIdentity);
    await verifyStage(fsImpl, output, reservationIdentity, entries);
    return { outputDir: output, files: entries.map((entry) => path.join(output, ...entry.name.split('/'))) };
  } catch (error) {
    if (stageIdentity) await removeOwnedDirectory(fsImpl, stage, stageIdentity, stagePhysical);
    if (reservationIdentity) await removeOwnedDirectory(fsImpl, output, reservationIdentity, reservationIdentity.physical);
    throw error;
  }
}
