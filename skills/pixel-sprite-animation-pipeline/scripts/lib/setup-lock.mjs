import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const STALE_MS = 10 * 60_000;
const WAIT_MS = 30_000;
const POLL_MS = 20;
const RELEASE_TAG = /^pixel-snapper-v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?-commit\.[a-f0-9]{7,40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const defaultGetUid = typeof process.getuid === 'function' ? () => process.getuid() : null;

function safeTag(value) {
  if (typeof value !== 'string' || !RELEASE_TAG.test(value) || path.basename(value) !== value || value.includes('\\')) throw new Error('invalid Pixel Snapper release tag');
  return value;
}

function lockError(state) {
  const error = new Error(`setup-in-progress: Pixel Snapper setup lock owner is ${state}`);
  error.code = 'PIXEL_SNAPPER_LOCK_CONTENTION';
  return error;
}

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function sameOwner(left, right) { return left?.nonce === right?.nonce && left?.pid === right?.pid && left?.createdAt === right?.createdAt; }
function sameIdentity(left, right) { return left?.dev === right?.dev && left?.ino === right?.ino; }

function validateOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'createdAt,nonce,pid' ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isFinite(value.createdAt) || value.createdAt < 0 || !UUID.test(value.nonce ?? '')) {
    throw new Error('invalid Pixel Snapper setup lock owner');
  }
  return value;
}

async function ensureDirectory(directory, mode, getUid) {
  try { await fs.mkdir(directory, { mode }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await fs.lstat(directory);
  const posix = typeof getUid === 'function';
  if (!info.isDirectory() || info.isSymbolicLink() || (posix && ((info.mode & 0o022) !== 0 || (Number.isInteger(info.uid) && info.uid !== getUid())))) {
    throw new Error(`unsafe Pixel Snapper setup directory: ${directory}`);
  }
}

async function ensureLockRoot(projectDir, releaseTag, getUid) {
  const project = path.resolve(projectDir);
  const info = await fs.lstat(project);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Pixel Snapper project directory must be a real directory');
  let current = project;
  for (const component of ['.pixel-sprite-pipeline', 'tools', '.locks', safeTag(releaseTag)]) {
    current = path.join(current, component);
    await ensureDirectory(current, 0o700, getUid);
  }
  return current;
}

async function writeOwner(file, owner) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readTicket(ticket, expectedNonce) {
  const info = await fs.lstat(ticket);
  const physical = await fs.realpath(ticket);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe Pixel Snapper setup ticket');
  const ownerFile = path.join(ticket, 'owner.json');
  const ownerInfo = await fs.lstat(ownerFile);
  if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.nlink !== 1) throw new Error('unsafe Pixel Snapper setup ticket owner');
  const owner = validateOwner(JSON.parse(await fs.readFile(ownerFile, 'utf8')));
  if (expectedNonce && owner.nonce !== expectedNonce) throw new Error('Pixel Snapper setup ticket owner mismatch');
  return { path: ticket, info: { dev: info.dev, ino: info.ino }, physical, owner };
}

async function publishTicket(root, owner) {
  const pending = path.join(root, `.pending-${owner.nonce}`);
  const ticket = path.join(root, `ticket-${owner.nonce}`);
  await fs.mkdir(pending, { mode: 0o700 });
  try {
    await writeOwner(path.join(pending, 'owner.json'), owner);
    validateOwner(JSON.parse(await fs.readFile(path.join(pending, 'owner.json'), 'utf8')));
    await fs.rename(pending, ticket);
    return await readTicket(ticket, owner.nonce);
  } catch (error) {
    await fs.rm(pending, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function sequenceBinding(sequence, nonce, publicationToken) {
  return {
    schemaVersion: 1,
    kind: 'pixel-snapper-setup-sequence',
    sequence,
    nonce,
    pendingBasename: `.pending-sequence-${nonce}-${publicationToken}`,
    publicationToken
  };
}

function validateSequenceBinding(value, expectedSequence) {
  const keys = 'kind,nonce,pendingBasename,publicationToken,schemaVersion,sequence';
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys ||
      value.schemaVersion !== 1 || value.kind !== 'pixel-snapper-setup-sequence' || value.sequence !== expectedSequence ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !UUID.test(value.nonce ?? '') || !UUID.test(value.publicationToken ?? '') ||
      value.pendingBasename !== `.pending-sequence-${value.nonce}-${value.publicationToken}` || path.basename(value.pendingBasename) !== value.pendingBasename) {
    throw new Error('invalid Pixel Snapper setup sequence binding');
  }
  return value;
}

async function readSequence(sequencePath, expectedSequence) {
  const info = await fs.lstat(sequencePath);
  if (!info.isFile() || info.isSymbolicLink() || ![1, 2].includes(info.nlink)) throw new Error('unsafe sequence tombstone');
  const binding = validateSequenceBinding(JSON.parse(await fs.readFile(sequencePath, 'utf8')), expectedSequence);
  return { info, binding };
}

function sameSequenceBinding(left, right) {
  return left?.schemaVersion === right?.schemaVersion && left?.kind === right?.kind && left?.sequence === right?.sequence &&
    left?.nonce === right?.nonce && left?.pendingBasename === right?.pendingBasename && left?.publicationToken === right?.publicationToken;
}

async function verifyPublishedSequence(sequencePath, expectedInfo, expectedBinding, expectedLinks) {
  const current = await readSequence(sequencePath, expectedBinding.sequence);
  if (!sameIdentity(current.info, expectedInfo) || current.info.nlink !== expectedLinks || !sameSequenceBinding(current.binding, expectedBinding)) {
    throw new Error('Pixel Snapper setup sequence publication changed');
  }
  return current;
}

async function allocateSequence(root, nonce, hooks) {
  while (true) {
    const numbers = (await fs.readdir(root)).flatMap((name) => {
      const match = /^sequence-(\d{16})$/.exec(name);
      return match ? [Number(match[1])] : [];
    });
    const next = (numbers.length === 0 ? 0 : Math.max(...numbers)) + 1;
    if (!Number.isSafeInteger(next)) throw new Error('Pixel Snapper setup sequence exhausted');
    const publicationToken = crypto.randomUUID();
    const binding = sequenceBinding(next, nonce, publicationToken);
    const pending = path.join(root, binding.pendingBasename);
    const file = path.join(root, `sequence-${String(next).padStart(16, '0')}`);
    await writeOwnerBytes(pending, `${JSON.stringify(binding)}\n`);
    try {
      await fs.link(pending, file);
      const published = await readSequence(file, next);
      if (published.info.nlink !== 2 || !sameSequenceBinding(published.binding, binding)) throw new Error('Pixel Snapper setup sequence binding mismatch');
      try {
        if (typeof hooks?.afterSequenceLinked === 'function') await hooks.afterSequenceLinked({ sequencePath: file, pendingPath: pending, binding });
      } finally {
        try {
          await fs.unlink(pending);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await verifyPublishedSequence(file, published.info, binding, 1);
        }
      }
      await verifyPublishedSequence(file, published.info, binding, 1);
      return next;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await fs.unlink(pending).catch((unlinkError) => { if (unlinkError.code !== 'ENOENT') throw unlinkError; });
    }
  }
}

async function writeOwnerBytes(file, contents) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
}

export function defaultProcessProbe(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    if (error?.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

async function moveAndRemoveTicket(ticket, record, suffix) {
  const moved = path.join(path.dirname(ticket), `.${path.basename(ticket)}.${suffix}-${crypto.randomUUID()}`);
  try { await fs.rename(ticket, moved); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  try {
    const current = await readTicket(moved, record.owner.nonce);
    if (!sameIdentity(current.info, record.info) || !sameOwner(current.owner, record.owner)) {
      await fs.rename(moved, ticket).catch(() => {});
      return false;
    }
    await fs.rm(moved, { recursive: true, force: false });
    return true;
  } catch {
    await fs.rename(moved, ticket).catch(() => {});
    return false;
  }
}

function normalizeProcessState(state) { return ['alive', 'dead', 'unknown'].includes(state) ? state : 'unknown'; }

async function recoverSequenceLink(root, sequencePath, initial, ticket, { now, processProbe }) {
  const pendingPath = path.join(root, initial.binding.pendingBasename);
  const pendingInfo = await fs.lstat(pendingPath);
  if (!pendingInfo.isFile() || pendingInfo.isSymbolicLink() || pendingInfo.nlink !== 2 || initial.info.nlink !== 2 || !sameIdentity(initial.info, pendingInfo)) {
    throw new Error('unproven sequence hardlink');
  }
  const pendingBinding = validateSequenceBinding(JSON.parse(await fs.readFile(pendingPath, 'utf8')), initial.binding.sequence);
  if (!sameSequenceBinding(initial.binding, pendingBinding) || pendingBinding.nonce !== ticket.owner.nonce) throw new Error('sequence hardlink binding mismatch');

  const sequenceCurrent = await readSequence(sequencePath, initial.binding.sequence);
  const pendingCurrent = await fs.lstat(pendingPath);
  if (sequenceCurrent.info.nlink !== 2 || pendingCurrent.nlink !== 2 || !sameIdentity(initial.info, sequenceCurrent.info) ||
      !sameIdentity(initial.info, pendingCurrent) || !sameSequenceBinding(initial.binding, sequenceCurrent.binding)) {
    throw new Error('sequence hardlink identity changed before recovery');
  }
  const currentTicket = await readTicket(ticket.path, initial.binding.nonce);
  const currentState = normalizeProcessState(await processProbe(currentTicket.owner.pid, currentTicket.owner));
  if (!sameIdentity(ticket.info, currentTicket.info) || !sameOwner(ticket.owner, currentTicket.owner) ||
      currentState !== 'dead' || now() - currentTicket.owner.createdAt <= STALE_MS) {
    throw new Error('sequence publisher changed before recovery');
  }
  await fs.unlink(pendingPath);
  await verifyPublishedSequence(sequencePath, initial.info, initial.binding, 1);
}

async function contenders(root, { now, processProbe }) {
  const names = (await fs.readdir(root)).filter((name) => /^sequence-\d{16}$/.test(name)).sort();
  const records = [];
  for (const name of names) {
    const sequence = Number(name.slice('sequence-'.length));
    let binding;
    let ticket;
    let publicationState;
    try {
      const sequencePath = path.join(root, name);
      const published = await readSequence(sequencePath, sequence);
      binding = published.binding;
      if (published.info.nlink === 2) {
        ticket = await readTicket(path.join(root, `ticket-${binding.nonce}`), binding.nonce);
        const state = normalizeProcessState(await processProbe(ticket.owner.pid, ticket.owner));
        if (state === 'dead' && now() - ticket.owner.createdAt > STALE_MS) await recoverSequenceLink(root, sequencePath, published, ticket, { now, processProbe });
        else publicationState = state;
      }
    } catch {
      records.push({ invalid: true, sequence, owner: { nonce: name, pid: -1 } });
      continue;
    }
    const ticketPath = path.join(root, `ticket-${binding.nonce}`);
    try {
      records.push({ ...(ticket ?? await readTicket(ticketPath, binding.nonce)), sequence, publishing: publicationState !== undefined, publicationState });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      records.push({ path: ticketPath, invalid: true, sequence, owner: { nonce: binding.nonce, pid: -1 } });
    }
  }
  return records.sort((left, right) => left.sequence - right.sequence);
}

async function acquireTicket(root, mine, { now, processProbe }) {
  const startedAt = now();
  while (true) {
    const ordered = await contenders(root, { now, processProbe });
    let blockedState = 'unknown';
    let retry = false;
    for (const ticket of ordered) {
      if (ticket.invalid) break;
      if (sameOwner(ticket.owner, mine.owner)) return;
      if (ticket.publishing) {
        blockedState = ticket.publicationState;
        break;
      }
      const state = normalizeProcessState(await processProbe(ticket.owner.pid, ticket.owner));
      if (state === 'dead' && now() - ticket.owner.createdAt > STALE_MS) {
        await moveAndRemoveTicket(ticket.path, ticket, 'reclaim');
        retry = true;
        break;
      }
      blockedState = state;
      break;
    }
    if (retry) continue;
    if (now() - startedAt >= WAIT_MS) throw lockError(blockedState);
    await sleep(POLL_MS);
  }
}

async function releaseTicket(mine) {
  let current;
  try { current = await readTicket(mine.path, mine.owner.nonce); }
  catch (error) { if (error.code === 'ENOENT') return; return; }
  if (!sameIdentity(current.info, mine.info) || !sameOwner(current.owner, mine.owner)) return;
  await moveAndRemoveTicket(mine.path, mine, 'release');
}

export async function withSetupLock({ projectDir, releaseTag, operation, now = Date.now, processProbe = defaultProcessProbe, getUid = defaultGetUid, hooks } = {}) {
  if (typeof projectDir !== 'string' || projectDir.length === 0 || typeof operation !== 'function' || typeof now !== 'function' || typeof processProbe !== 'function' || (getUid !== null && typeof getUid !== 'function')) {
    throw new Error('invalid Pixel Snapper setup lock request');
  }
  const root = await ensureLockRoot(projectDir, releaseTag, getUid);
  const owner = { pid: process.pid, createdAt: now(), nonce: crypto.randomUUID() };
  const mine = await publishTicket(root, owner);
  try {
    if (typeof hooks?.afterTicketPublished === 'function') await hooks.afterTicketPublished({ ticket: mine.path, owner });
    mine.sequence = await allocateSequence(root, owner.nonce, hooks);
    await acquireTicket(root, mine, { now, processProbe });
    return await operation();
  } finally {
    await releaseTicket(mine);
  }
}
