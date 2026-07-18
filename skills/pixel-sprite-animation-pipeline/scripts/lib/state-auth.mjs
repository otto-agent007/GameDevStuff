import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function missingSigningKey() {
  return new Error('correction signing key is missing; revalidation and explicit receipt reissue are required');
}

function requireOwned(stat, label) {
  if (process.platform !== 'win32' && typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) throw new Error(`${label} must be owned by the current effective uid`);
}

async function requireDirectory(directory, label) {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') throw missingSigningKey();
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a symlink`);
  return stat;
}

async function signingKey(projectDir, { create = false } = {}) {
  const project = path.resolve(projectDir);
  await requireDirectory(project, 'correction project directory');
  const stateDir = path.join(project, '.pixel-sprite-pipeline');
  const state = await requireDirectory(stateDir, 'correction state directory');
  requireOwned(state, 'correction state directory');
  if (process.platform !== 'win32' && (state.mode & 0o022) !== 0) throw new Error('correction state directory permissions are unsafe');
  const keysDir = path.join(project, '.pixel-sprite-pipeline', 'keys');
  let createdKeysDirectory = false;
  if (create) {
    try {
      await fs.mkdir(keysDir, { mode: 0o700 });
      createdKeysDirectory = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (createdKeysDirectory && process.platform !== 'win32') await fs.chmod(keysDir, 0o700);
  }
  const directory = await requireDirectory(keysDir, 'correction key directory');
  requireOwned(directory, 'correction key directory');
  if (process.platform !== 'win32' && ((directory.mode & 0o077) !== 0 || (createdKeysDirectory && (directory.mode & 0o777) !== 0o700))) throw new Error('correction key directory permissions are unsafe');
  const file = path.join(keysDir, 'correction-signing-v1.key');
  let keyExists = true;
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') keyExists = false;
    else throw error;
  }
  if (create && !keyExists) {
    const temporary = path.join(keysDir, `.correction-signing-v1.${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(crypto.randomBytes(32));
      if (process.platform !== 'win32') await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  let stat;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT') throw missingSigningKey();
      throw error;
    }
    if (stat.nlink === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('correction signing key permissions or file type are unsafe');
  requireOwned(stat, 'correction signing key');
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) throw new Error('correction signing key permissions or file type are unsafe');
  let key;
  try {
    key = await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw missingSigningKey();
    throw error;
  }
  if (key.length < 32) throw new Error('correction signing key is invalid');
  return key;
}

async function atomicNew(file, contents) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, contents, { flag: 'wx' });
  try {
    await fs.link(temporary, file);
  } catch (error) {
    if (error.code !== 'EEXIST' || await fs.readFile(file, 'utf8') !== contents) throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function writeSignedState({ projectDir, file, domain, payload, createKey = false }) {
  const key = await signingKey(projectDir, { create: createKey });
  const signature = crypto.createHmac('sha256', key).update(`${domain}\0`).update(JSON.stringify(stable(payload))).digest('hex');
  const document = { version: 1, payload, signature };
  await atomicNew(file, `${JSON.stringify(document, null, 2)}\n`);
  return { document, sha256: stableHash(document) };
}

export async function readSignedState({ projectDir, file, domain }) {
  const key = await signingKey(projectDir);
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  const expected = crypto.createHmac('sha256', key).update(`${domain}\0`).update(JSON.stringify(stable(document.payload))).digest('hex');
  const left = Buffer.from(document.signature ?? '', 'hex');
  const right = Buffer.from(expected, 'hex');
  if (document.version !== 1 || left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw new Error('signed state signature mismatch');
  return { ...document, sha256: stableHash(document) };
}
