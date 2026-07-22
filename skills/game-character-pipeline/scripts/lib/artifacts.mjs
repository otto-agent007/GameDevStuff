import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { canonicalJson, portableId, portableRelativePath } from './schema.mjs';

const REVISION_AREAS = new Set(['work', 'edits', 'approved', 'exports', 'reports']);

function bytesHash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function realDirectory(root, label = 'artifact root') {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return fs.realpath(root);
}

function contained(root, target, label) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the artifact root`);
  }
}

async function ensureDirectories(root, relativeDirectory) {
  let current = root;
  if (relativeDirectory === '.') return current;
  for (const component of relativeDirectory.split('/')) {
    current = path.join(current, component);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('artifact parent must be a real directory');
  }
  return current;
}

async function readSingleLinkFile(file, label) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error(`${label} must be a regular single-link file`);
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new Error(`${label} must be a regular single-link file`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.size !== bytes.length) {
      throw new Error(`${label} changed while it was captured`);
    }
    return { bytes, stat: after, sha256: bytesHash(bytes) };
  } finally {
    await handle.close();
  }
}

async function verifyExisting(target, bytes, label) {
  try {
    const existing = await readSingleLinkFile(target, label);
    if (existing.sha256 !== bytesHash(bytes) || !existing.bytes.equals(bytes)) {
      throw new Error('existing immutable artifact differs from requested bytes');
    }
    return existing;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function publishNew(target, bytes) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(temporary, target);
  } finally {
    if (handle) await handle.close();
    await fs.rm(temporary, { force: true });
  }
}

export async function writeImmutableBytes({ root, relative, bytes, reuse = true }) {
  portableRelativePath(relative, 'artifact path');
  const physicalRoot = await realDirectory(root);
  const target = path.join(physicalRoot, ...relative.split('/'));
  contained(physicalRoot, target, 'artifact path');
  await ensureDirectories(physicalRoot, path.posix.dirname(relative));

  if (reuse) {
    const existing = await verifyExisting(target, bytes, 'existing immutable artifact');
    if (existing) return { path: target, relative, sha256: existing.sha256, reused: true };
  }

  try {
    await publishNew(target, bytes);
  } catch (error) {
    if (error.code !== 'EEXIST' || !reuse) throw error;
    const existing = await verifyExisting(target, bytes, 'existing immutable artifact');
    if (!existing) throw error;
    return { path: target, relative, sha256: existing.sha256, reused: true };
  }
  return { path: target, relative, sha256: bytesHash(bytes), reused: false };
}

export async function writeImmutableJson({ root, relative, value, reuse = true }) {
  const bytes = Buffer.from(canonicalJson(value));
  const written = await writeImmutableBytes({ root, relative, bytes, reuse });
  return { ...written, document: value };
}

export async function copyImmutable({ source, root, relative }) {
  portableRelativePath(relative, 'artifact path');
  const captured = await readSingleLinkFile(source, 'immutable source');
  return writeImmutableBytes({ root, relative, bytes: captured.bytes, reuse: true });
}

export async function writeRevision({ root, area, stem, value }) {
  if (!REVISION_AREAS.has(area)) throw new Error('revision area is invalid');
  portableId(stem, 'revision stem');
  for (let revision = 1; revision <= 999999; revision += 1) {
    const relative = `${area}/${stem}-${String(revision).padStart(4, '0')}.json`;
    try {
      const written = await writeImmutableJson({ root, relative, value, reuse: false });
      return { ...written, revision };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('revision space is exhausted');
}
