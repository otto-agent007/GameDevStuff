import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renameWithWindowsRetry, withSetupLock } from '../scripts/lib/setup-lock.mjs';

const TAG = 'pixel-snapper-v1.2.3-commit.0123456';

async function project() { return fs.mkdtemp(path.join(os.tmpdir(), 'pixel-snapper-lock-')); }
function lockRoot(projectDir) { return path.join(projectDir, '.pixel-sprite-pipeline', 'tools', '.locks', TAG); }

test('Windows ticket rename retries transient sharing violations', async () => {
  let attempts = 0;
  const delays = [];
  await renameWithWindowsRetry('ticket', 'moved', {
    platform: 'win32',
    rename: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    },
    sleepImpl: async (delay) => { delays.push(delay); }
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [20, 40]);
});

async function seedTicket(projectDir, owner, name = `ticket-${owner.nonce}`) {
  const ticket = path.join(lockRoot(projectDir), name);
  await fs.mkdir(ticket, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(ticket, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  const publicationToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sequence = { schemaVersion: 1, kind: 'pixel-snapper-setup-sequence', sequence: 1, nonce: owner.nonce, pendingBasename: `.pending-sequence-${owner.nonce}-${publicationToken}`, publicationToken };
  await fs.writeFile(path.join(lockRoot(projectDir), 'sequence-0000000000000001'), `${JSON.stringify(sequence)}\n`, { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  return { ticket, sequence };
}

test('concurrent setup operations are serialized by immutable per-owner tickets', async () => {
  const projectDir = await project();
  let active = 0;
  let maximum = 0;
  const values = await Promise.all(Array.from({ length: 8 }, (_, index) => withSetupLock({
    projectDir, releaseTag: TAG,
    operation: async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return index;
    }
  })));
  assert.equal(maximum, 1);
  assert.deepEqual(values.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual((await fs.readdir(lockRoot(projectDir))).filter((name) => name.startsWith('ticket-')), []);
});

test('two reclaimers cannot delete a newly published owner through a stale-lock ABA', async () => {
  const projectDir = await project();
  const stale = { pid: 424242, createdAt: 1, nonce: '11111111-1111-4111-8111-111111111111' };
  await seedTicket(projectDir, stale);
  let active = 0;
  let maximum = 0;
  const processProbe = (pid) => pid === stale.pid ? 'dead' : 'alive';
  const calls = Array.from({ length: 3 }, (_, index) => withSetupLock({
    projectDir, releaseTag: TAG, processProbe,
    operation: async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 20 : 5));
      active -= 1;
      return index;
    }
  }));
  assert.deepEqual((await Promise.all(calls)).sort(), [0, 1, 2]);
  assert.equal(maximum, 1);
  assert.deepEqual((await fs.readdir(lockRoot(projectDir))).filter((name) => name.startsWith('ticket-')), []);
});

test('a crash before owner publication leaves pending debris that never contends', async () => {
  const projectDir = await project();
  const pending = path.join(lockRoot(projectDir), '.pending-crashed-writer');
  await fs.mkdir(pending, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(pending, 'partial-owner'), '{');
  assert.equal(await withSetupLock({ projectDir, releaseTag: TAG, operation: async () => 'acquired' }), 'acquired');
  assert.ok((await fs.readdir(lockRoot(projectDir))).includes('.pending-crashed-writer'));
});

test('only an old ticket whose process is confirmed dead is reclaimed', async () => {
  const projectDir = await project();
  await seedTicket(projectDir, { pid: 424242, createdAt: 1, nonce: '11111111-1111-4111-8111-111111111111' });
  assert.equal(await withSetupLock({
    projectDir, releaseTag: TAG, now: () => 10 * 60_000 + 2, processProbe: () => 'dead', operation: async () => 'recovered'
  }), 'recovered');
});

test('unknown owner state fails closed and exposes stable lock-contention classification', async () => {
  const projectDir = await project();
  const owner = { pid: 424242, createdAt: 1, nonce: '11111111-1111-4111-8111-111111111111' };
  await seedTicket(projectDir, owner);
  let tick = 10 * 60_000 + 2;
  await assert.rejects(withSetupLock({
    projectDir, releaseTag: TAG,
    now: () => { tick += 31_000; return tick; },
    processProbe: () => 'unknown',
    operation: async () => assert.fail('unknown owner must block')
  }), (error) => error.code === 'PIXEL_SNAPPER_LOCK_CONTENTION' && /unknown/.test(error.message));
  assert.equal(JSON.parse(await fs.readFile(path.join(lockRoot(projectDir), `ticket-${owner.nonce}`, 'owner.json'))).nonce, owner.nonce);
});

test('release touches only the caller ticket whose directory identity and owner still match', async () => {
  const projectDir = await project();
  let ticket;
  await withSetupLock({
    projectDir, releaseTag: TAG,
    operation: async () => {
      const name = (await fs.readdir(lockRoot(projectDir))).find((item) => item.startsWith('ticket-'));
      ticket = path.join(lockRoot(projectDir), name);
      const owner = JSON.parse(await fs.readFile(path.join(ticket, 'owner.json')));
      await fs.writeFile(path.join(ticket, 'owner.json'), `${JSON.stringify({ ...owner, nonce: '22222222-2222-4222-8222-222222222222' })}\n`);
    }
  });
  assert.equal(JSON.parse(await fs.readFile(path.join(ticket, 'owner.json'))).nonce, '22222222-2222-4222-8222-222222222222');
});

test('operation failure releases its ticket and traversal-like tags are rejected', async () => {
  const projectDir = await project();
  await assert.rejects(withSetupLock({ projectDir, releaseTag: TAG, operation: async () => { throw new Error('interrupted'); } }), /interrupted/);
  assert.deepEqual((await fs.readdir(lockRoot(projectDir))).filter((name) => name.startsWith('ticket-')), []);
  await assert.rejects(withSetupLock({ projectDir, releaseTag: '../escape', operation: async () => {} }), /invalid Pixel Snapper release tag/);
});

test('permission bits are enforced only when POSIX uid capability exists', async () => {
  const projectDir = await project();
  const tools = path.join(projectDir, '.pixel-sprite-pipeline', 'tools');
  await fs.mkdir(tools, { recursive: true });
  await fs.chmod(tools, 0o770);
  await assert.rejects(withSetupLock({ projectDir, releaseTag: TAG, operation: async () => {}, getUid: () => process.getuid() }), /unsafe Pixel Snapper setup directory/);
  assert.equal(await withSetupLock({ projectDir, releaseTag: TAG, operation: async () => 'windows-capability', getUid: null }), 'windows-capability');
});

test('a delayed publisher receives a later sequence and cannot overlap an already-active owner', async () => {
  const projectDir = await project();
  let resume;
  let published;
  const pause = new Promise((resolve) => { resume = resolve; });
  const seenPublished = new Promise((resolve) => { published = resolve; });
  let active = 0;
  let maximum = 0;
  const operation = async () => { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 20)); active -= 1; };
  const delayed = withSetupLock({ projectDir, releaseTag: TAG, now: () => 100, hooks: { afterTicketPublished: async () => { published(); await pause; } }, operation });
  await seenPublished;
  const lowerSequence = withSetupLock({ projectDir, releaseTag: TAG, now: () => 100, operation });
  await new Promise((resolve) => setTimeout(resolve, 10));
  resume();
  await Promise.all([delayed, lowerSequence]);
  assert.equal(maximum, 1);
});

test('equal creation times are ordered only by unique publication sequence', async () => {
  const projectDir = await project();
  const order = [];
  await Promise.all(Array.from({ length: 5 }, (_, index) => withSetupLock({ projectDir, releaseTag: TAG, now: () => 500, operation: async () => { order.push(index); await new Promise((resolve) => setTimeout(resolve, 5)); } })));
  assert.equal(new Set(order).size, 5);
  const sequences = (await fs.readdir(lockRoot(projectDir))).filter((name) => name.startsWith('sequence-')).sort();
  assert.equal(sequences.length, 5);
});

test('a ticket that times out before ownership is identity-guardedly removed', async () => {
  const projectDir = await project();
  await seedTicket(projectDir, { pid: process.pid, createdAt: 1, nonce: '11111111-1111-4111-8111-111111111111' });
  let tick = 2;
  await assert.rejects(withSetupLock({ projectDir, releaseTag: TAG, now: () => { tick += 31_000; return tick; }, processProbe: () => 'alive', operation: async () => {} }), (error) => error.code === 'PIXEL_SNAPPER_LOCK_CONTENTION');
  const tickets = (await fs.readdir(lockRoot(projectDir))).filter((name) => name.startsWith('ticket-'));
  assert.deepEqual(tickets, ['ticket-11111111-1111-4111-8111-111111111111']);
});

test('a crash after sequence hardlink publication recovers the owned pending link', async () => {
  const projectDir = await project();
  const owner = { pid: 424242, createdAt: 1, nonce: '11111111-1111-4111-8111-111111111111' };
  const seeded = await seedTicket(projectDir, owner);
  const root = lockRoot(projectDir);
  const sequence = path.join(root, 'sequence-0000000000000001');
  const pending = path.join(root, seeded.sequence.pendingBasename);
  await fs.link(sequence, pending);
  assert.equal((await fs.lstat(sequence)).nlink, 2);
  assert.equal(await withSetupLock({ projectDir, releaseTag: TAG, now: () => 700_000, processProbe: (pid) => pid === owner.pid ? 'dead' : 'alive', operation: async () => 'recovered' }), 'recovered');
  await assert.rejects(fs.lstat(pending), { code: 'ENOENT' });
});

test('a prefix-matching alternate cannot substitute for the exact pending sequence basename', async () => {
  const projectDir = await project();
  const owner = { pid: 424242, createdAt: 1, nonce: '11111111-1111-4111-8111-111111111111' };
  await seedTicket(projectDir, owner);
  const sequence = path.join(lockRoot(projectDir), 'sequence-0000000000000001');
  await fs.link(sequence, path.join(lockRoot(projectDir), `.pending-sequence-${owner.nonce}-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`));
  let tick = 1;
  await assert.rejects(withSetupLock({ projectDir, releaseTag: TAG, now: () => { tick += 31_000; return tick; }, operation: async () => {} }), (error) => error.code === 'PIXEL_SNAPPER_LOCK_CONTENTION');
  assert.equal((await fs.lstat(sequence)).nlink, 2);
});

test('an extra hardlink beyond the exact pending sequence fails closed', async () => {
  const projectDir = await project();
  const owner = { pid: 424242, createdAt: 1, nonce: '11111111-1111-4111-8111-111111111111' };
  const seeded = await seedTicket(projectDir, owner);
  const root = lockRoot(projectDir);
  const sequence = path.join(root, 'sequence-0000000000000001');
  await fs.link(sequence, path.join(root, seeded.sequence.pendingBasename));
  await fs.link(sequence, path.join(root, '.unrelated-hardlink'));
  let tick = 1;
  await assert.rejects(withSetupLock({ projectDir, releaseTag: TAG, now: () => { tick += 31_000; return tick; }, processProbe: () => 'dead', operation: async () => {} }), (error) => error.code === 'PIXEL_SNAPPER_LOCK_CONTENTION');
  assert.equal((await fs.lstat(sequence)).nlink, 3);
});

test('sequence publication JSON rejects extra fields', async () => {
  const projectDir = await project();
  const owner = { pid: 424242, createdAt: 1, nonce: '11111111-1111-4111-8111-111111111111' };
  const seeded = await seedTicket(projectDir, owner);
  const sequence = path.join(lockRoot(projectDir), 'sequence-0000000000000001');
  await fs.writeFile(sequence, `${JSON.stringify({ ...seeded.sequence, extra: true })}\n`);
  let tick = 1;
  await assert.rejects(withSetupLock({ projectDir, releaseTag: TAG, now: () => { tick += 31_000; return tick; }, operation: async () => {} }), (error) => error.code === 'PIXEL_SNAPPER_LOCK_CONTENTION');
});

test('a contender never unlinks a healthy publisher pending sequence', async () => {
  const projectDir = await project();
  let linked;
  let resume;
  const linkedPromise = new Promise((resolve) => { linked = resolve; });
  const pause = new Promise((resolve) => { resume = resolve; });
  let active = 0;
  let maximum = 0;
  const operation = async () => { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 15)); active -= 1; };
  const publisher = withSetupLock({ projectDir, releaseTag: TAG, hooks: { afterSequenceLinked: async () => { linked(); await pause; } }, operation });
  await linkedPromise;
  const contender = withSetupLock({ projectDir, releaseTag: TAG, processProbe: () => 'alive', operation });
  await new Promise((resolve) => setTimeout(resolve, 15));
  resume();
  await Promise.all([publisher, contender]);
  assert.equal(maximum, 1);
});

test('recovery rechecks the bound publisher state immediately before unlinking', async () => {
  const projectDir = await project();
  const owner = { pid: 424242, createdAt: 1, nonce: '11111111-1111-4111-8111-111111111111' };
  const seeded = await seedTicket(projectDir, owner);
  const sequence = path.join(lockRoot(projectDir), 'sequence-0000000000000001');
  const pending = path.join(lockRoot(projectDir), seeded.sequence.pendingBasename);
  await fs.link(sequence, pending);
  let probes = 0;
  let tick = 700_000;
  await assert.rejects(withSetupLock({
    projectDir,
    releaseTag: TAG,
    now: () => { tick += 31_000; return tick; },
    processProbe: (pid) => pid === owner.pid && ++probes === 1 ? 'dead' : 'alive',
    operation: async () => assert.fail('publisher state changed to alive')
  }), (error) => error.code === 'PIXEL_SNAPPER_LOCK_CONTENTION');
  assert.equal((await fs.lstat(sequence)).nlink, 2);
  assert.equal((await fs.lstat(pending)).nlink, 2);
});

test('an unknown two-link publisher cannot be reclaimed by a later acquisition probe', async () => {
  const projectDir = await project();
  const owner = { pid: 424242, createdAt: 1, nonce: '11111111-1111-4111-8111-111111111111' };
  const seeded = await seedTicket(projectDir, owner);
  const root = lockRoot(projectDir);
  const sequence = path.join(root, 'sequence-0000000000000001');
  const pending = path.join(root, seeded.sequence.pendingBasename);
  const ticket = path.join(root, `ticket-${owner.nonce}`);
  await fs.link(sequence, pending);
  let probes = 0;
  let tick = 700_000;
  await assert.rejects(withSetupLock({
    projectDir,
    releaseTag: TAG,
    now: () => { tick += 31_000; return tick; },
    processProbe: (pid) => pid !== owner.pid ? 'alive' : probes++ % 2 === 0 ? 'unknown' : 'dead',
    operation: async () => assert.fail('unknown publisher must block')
  }), (error) => error.code === 'PIXEL_SNAPPER_LOCK_CONTENTION');
  assert.equal((await fs.lstat(sequence)).nlink, 2);
  assert.equal((await fs.lstat(pending)).nlink, 2);
  assert.ok((await fs.lstat(ticket)).isDirectory());
});
