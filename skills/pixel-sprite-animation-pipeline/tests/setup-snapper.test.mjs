import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { platformKey } from '../scripts/lib/tool-manifest.mjs';
import { setupPixelSnapper } from '../scripts/lib/setup-snapper.mjs';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fixtureHash = hash(Buffer.concat(Array.from({ length: 9 }, () => Buffer.from([16, 32, 48, 255]))));

async function tarGz(name, data) {
  const pack = tar.pack();
  const chunks = [];
  pack.on('data', (chunk) => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => { pack.on('end', resolve); pack.on('error', reject); });
  pack.entry({ name, size: data.length, mode: 0o755 }, data);
  pack.finalize();
  await complete;
  return gzipSync(Buffer.concat(chunks));
}

function response(bytes) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: { async *[Symbol.asyncIterator]() { yield bytes.subarray(0, 17); yield bytes.subarray(17); } }
  };
}

async function setupFixture() {
  if (process.platform === 'win32') throw new Error('test fixture currently requires a POSIX executable target');
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-snapper-setup-'));
  const executable = 'spritefusion-pixel-snapper';
  const script = Buffer.from(`#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[0]==='--version'){console.log('pixel-snapper 1.2.3');process.exit(0)}if(a[0]==='--help'){console.log('usage: pixel-snapper INPUT OUTPUT SIZE');process.exit(0)}fs.copyFileSync(a[0],a[1]);\n`);
  let archive = await tarGz(executable, script);
  const target = platformKey();
  const tag = 'pixel-snapper-v1.2.3-commit.0123456';
  const original = JSON.parse(await fs.readFile(new URL('./fixtures/tool-manifest.fixture.json', import.meta.url)));
  original.fixture = { inputRgbaSha256: fixtureHash, rgbaSha256: fixtureHash };
  original.assets[target] = {
    url: `https://github.com/otto-agent007/GameDevStuff/releases/download/${tag}/pixel-snapper-${target}.tar.gz`,
    archiveName: `pixel-snapper-${target}.tar.gz`,
    archiveFormat: 'tar.gz',
    archiveSize: archive.length,
    archiveSha256: hash(archive),
    executable,
    executableSize: script.length,
    executableSha256: hash(script)
  };
  const manifestPath = path.join(projectDir, 'tool-manifest.json');
  const writeManifest = async () => fs.writeFile(manifestPath, `${JSON.stringify(original, null, 2)}\n`);
  await writeManifest();
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return response(archive); };
  return {
    projectDir,
    target,
    tag,
    archive,
    manifestPath,
    options: { projectDir, manifestPath, fetchImpl },
    fetches: () => fetches,
    manifest: original,
    setArchive: async (bytes, overrides = {}) => {
      archive = bytes;
      Object.assign(original.assets[target], { archiveSize: bytes.length, archiveSha256: hash(bytes) }, overrides);
      await writeManifest();
    },
    finalDir: path.join(projectDir, '.pixel-sprite-pipeline', 'tools', 'pixel-snapper', tag, target)
  };
}

test('concurrent setup publishes one verified installation', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  const calls = await Promise.all(Array.from({ length: 8 }, () => setupPixelSnapper(fixture.options)));
  assert.equal(new Set(calls.map((item) => item.executable)).size, 1);
  assert.equal(calls.filter((item) => item.status === 'installed').length, 1);
  assert.equal(calls.filter((item) => item.status === 'already-installed').length, 7);
  assert.equal(fixture.fetches(), 1);
  assert.ok(calls.every((item) => item.identity.fixtureRgbaSha256 === fixtureHash));
  assert.ok(calls.every((item) => item.receipt.endsWith('installation-receipt.json')));
});

test('idempotent reuse revalidates the receipt, executable hash, and deterministic fixture', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  const first = await setupPixelSnapper(fixture.options);
  const second = await setupPixelSnapper(fixture.options);
  assert.equal(first.status, 'installed');
  assert.equal(second.status, 'already-installed');
  assert.equal(second.identity.sha256, first.identity.sha256);
  assert.equal(fixture.fetches(), 1);
  const receipt = JSON.parse(await fs.readFile(second.receipt));
  assert.equal(receipt.manifest.sha256, hash(await fs.readFile(fixture.manifestPath)));
  assert.equal(receipt.identity.sha256, second.identity.sha256);
});

test('setup quarantines a changed cached executable until force restore', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  const first = await setupPixelSnapper(fixture.options);
  await fs.appendFile(first.executable, 'tamper');
  await assert.rejects(setupPixelSnapper(fixture.options), (error) => error.code === 'PIXEL_SNAPPER_INSTALLATION_TAMPERED' && /hash mismatch/.test(error.cause?.message ?? ''));
  await assert.rejects(fs.lstat(fixture.finalDir), { code: 'ENOENT' });
  assert.ok((await fs.readdir(path.dirname(fixture.finalDir))).some((name) => name.startsWith(`.${fixture.target}.tampered-`)));
  const restored = await setupPixelSnapper({ ...fixture.options, force: true });
  assert.equal(restored.status, 'installed');
  assert.equal(restored.identity.sha256, first.identity.sha256);
});

test('a changed installation receipt is quarantined and cannot authorize reuse', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  const installed = await setupPixelSnapper(fixture.options);
  const receipt = JSON.parse(await fs.readFile(installed.receipt));
  receipt.identity.sha256 = 'f'.repeat(64);
  await fs.writeFile(installed.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(setupPixelSnapper(fixture.options), (error) => error.code === 'PIXEL_SNAPPER_INSTALLATION_TAMPERED' && /installation receipt mismatch/.test(error.cause?.message ?? ''));
  await assert.rejects(fs.lstat(fixture.finalDir), { code: 'ENOENT' });
});

test('failed setup removes only its owned interrupted stage and never activates partial content', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  const failed = { ...fixture.options, fetchImpl: async () => { throw new Error('network interrupted'); } };
  await assert.rejects(setupPixelSnapper(failed), (error) => error.code === 'PIXEL_SNAPPER_NETWORK_ERROR' && /network interrupted/.test(error.cause?.message ?? ''));
  await assert.rejects(fs.lstat(fixture.finalDir), { code: 'ENOENT' });
  const tools = path.join(fixture.projectDir, '.pixel-sprite-pipeline', 'tools');
  const staging = path.join(tools, '.staging');
  assert.deepEqual(await fs.readdir(staging).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
  assert.equal((await setupPixelSnapper(fixture.options)).status, 'installed');
});

test('force replacement stages and verifies the new installation before activation', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  const first = await setupPixelSnapper(fixture.options);
  const failed = setupPixelSnapper({ ...fixture.options, force: true, fetchImpl: async () => { throw new Error('replacement failed'); } });
  await assert.rejects(failed, (error) => error.code === 'PIXEL_SNAPPER_NETWORK_ERROR' && /replacement failed/.test(error.cause?.message ?? ''));
  assert.equal((await fs.readFile(first.executable)).subarray(0, 2).toString(), '#!');
  assert.equal((await setupPixelSnapper(fixture.options)).status, 'already-installed');
});

test('idempotent reuse removes an owned install stage left by an interrupted process', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  await setupPixelSnapper(fixture.options);
  const nonce = crypto.randomUUID();
  const stage = path.join(fixture.projectDir, '.pixel-sprite-pipeline', 'tools', '.staging', `.install-${fixture.tag}-${fixture.target}-${nonce}`);
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  const stageInfo = await fs.lstat(stage);
  await fs.writeFile(path.join(stage, '.pixel-snapper-install-stage.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'pixel-snapper-install-stage',
    releaseTag: fixture.tag,
    target: fixture.target,
    nonce,
    dev: stageInfo.dev,
    ino: stageInfo.ino
  })}\n`);
  await fs.mkdir(path.join(stage, 'content'));
  await fs.writeFile(path.join(stage, 'content', 'partial'), 'partial');
  assert.equal((await setupPixelSnapper(fixture.options)).status, 'already-installed');
  await assert.rejects(fs.lstat(stage), { code: 'ENOENT' });
});

test('reuse rejects unexpected installed files instead of trusting an incomplete inventory', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  await setupPixelSnapper(fixture.options);
  await fs.writeFile(path.join(fixture.finalDir, 'unexpected'), 'unreviewed');
  await assert.rejects(setupPixelSnapper(fixture.options), (error) => error.code === 'PIXEL_SNAPPER_INSTALLATION_TAMPERED' && /installed file inventory mismatch/.test(error.cause?.message ?? ''));
  await assert.rejects(fs.lstat(fixture.finalDir), { code: 'ENOENT' });
});

test('reuse rejects a hard-linked managed executable', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  const installed = await setupPixelSnapper(fixture.options);
  await fs.link(installed.executable, path.join(fixture.projectDir, 'outside-hardlink'));
  await assert.rejects(setupPixelSnapper(fixture.options), (error) => error.code === 'PIXEL_SNAPPER_INSTALLATION_TAMPERED' && /must have one link/.test(error.cause?.message ?? ''));
  await assert.rejects(fs.lstat(fixture.finalDir), { code: 'ENOENT' });
});

test('setup refuses group-writable managed tool state on POSIX', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX permission check'); return; }
  const fixture = await setupFixture();
  const tools = path.join(fixture.projectDir, '.pixel-sprite-pipeline', 'tools');
  await fs.mkdir(tools, { recursive: true });
  await fs.chmod(tools, 0o770);
  await assert.rejects(setupPixelSnapper(fixture.options), /unsafe Pixel Snapper setup directory/);
  assert.equal(fixture.fetches(), 0);
});

test('interrupted-stage cleanup preserves a path replacement whose persisted identity does not match', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  await setupPixelSnapper(fixture.options);
  const nonce = crypto.randomUUID();
  const stage = path.join(fixture.projectDir, '.pixel-sprite-pipeline', 'tools', '.staging', `.install-${fixture.tag}-${fixture.target}-${nonce}`);
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  const originalInfo = await fs.lstat(stage);
  const marker = { schemaVersion: 1, kind: 'pixel-snapper-install-stage', releaseTag: fixture.tag, target: fixture.target, nonce, dev: originalInfo.dev, ino: originalInfo.ino };
  await fs.writeFile(path.join(stage, '.pixel-snapper-install-stage.json'), `${JSON.stringify(marker)}\n`);
  await fs.rename(stage, `${stage}.displaced`);
  await fs.mkdir(stage, { mode: 0o700 });
  await fs.writeFile(path.join(stage, '.pixel-snapper-install-stage.json'), `${JSON.stringify(marker)}\n`);
  await assert.rejects(setupPixelSnapper(fixture.options), (error) => error.code === 'PIXEL_SNAPPER_RECOVERY_BLOCKED');
  assert.equal((await fs.lstat(stage)).isDirectory(), true);
});

test('activation failure restores only a reverified identity-bound backup', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  const installed = await setupPixelSnapper(fixture.options);
  await assert.rejects(setupPixelSnapper({
    ...fixture.options,
    force: true,
    faults: { afterBackup: async () => { throw new Error('injected activation failure'); } }
  }), (error) => error.code === 'PIXEL_SNAPPER_ACTIVATION_FAILED' && /injected activation failure/.test(error.cause?.message ?? ''));
  assert.equal((await setupPixelSnapper(fixture.options)).identity.sha256, installed.identity.sha256);
});

test('rollback refuses a replaced backup and leaves the canonical path inactive', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  await setupPixelSnapper(fixture.options);
  let replacement;
  await assert.rejects(setupPixelSnapper({
    ...fixture.options,
    force: true,
    faults: { afterBackup: async ({ backup }) => {
      await fs.rename(backup.path, `${backup.path}.original`);
      await fs.mkdir(backup.path, { mode: 0o700 });
      replacement = backup.path;
      throw new Error('activate after replacement');
    } }
  }), (error) => error.code === 'PIXEL_SNAPPER_ROLLBACK_FAILED');
  await assert.rejects(fs.lstat(fixture.finalDir), { code: 'ENOENT' });
  assert.equal((await fs.lstat(replacement)).isDirectory(), true);
});

test('rollback refuses a tampered backup and preserves it for diagnosis', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  await setupPixelSnapper(fixture.options);
  let backupPath;
  await assert.rejects(setupPixelSnapper({
    ...fixture.options,
    force: true,
    faults: { afterBackup: async ({ backup }) => {
      backupPath = backup.path;
      await fs.appendFile(path.join(backup.path, fixture.manifest.assets[fixture.target].executable), 'tamper');
      throw new Error('activate after tamper');
    } }
  }), (error) => error.code === 'PIXEL_SNAPPER_ROLLBACK_FAILED');
  await assert.rejects(fs.lstat(fixture.finalDir), { code: 'ENOENT' });
  assert.equal((await fs.lstat(backupPath)).isDirectory(), true);
});

async function seedActivationBackup(fixture, { tamper = false } = {}) {
  const nonce = crypto.randomUUID();
  const backup = path.join(path.dirname(fixture.finalDir), `.${fixture.target}.activation-${nonce}`);
  await fs.cp(fixture.finalDir, backup, { recursive: true });
  if (tamper) await fs.appendFile(path.join(backup, RECEIPT_FOR_TEST), 'tamper');
  const info = await fs.lstat(backup);
  await fs.writeFile(`${backup}.marker.json`, `${JSON.stringify({ schemaVersion: 1, kind: 'pixel-snapper-install-move', reason: 'activation', nonce, dev: info.dev, ino: info.ino })}\n`);
  return backup;
}

const RECEIPT_FOR_TEST = 'installation-receipt.json';

test('valid final installation removes verified activation leftovers with guarded cleanup', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  await setupPixelSnapper(fixture.options);
  const backup = await seedActivationBackup(fixture);
  assert.equal((await setupPixelSnapper(fixture.options)).status, 'already-installed');
  await assert.rejects(fs.lstat(backup), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(`${backup}.marker.json`), { code: 'ENOENT' });
});

test('tampered activation leftovers block recovery with a classified diagnostic', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  await setupPixelSnapper(fixture.options);
  const backup = await seedActivationBackup(fixture, { tamper: true });
  await assert.rejects(setupPixelSnapper(fixture.options), (error) => error.code === 'PIXEL_SNAPPER_RECOVERY_BLOCKED');
  assert.equal((await fs.lstat(backup)).isDirectory(), true);
});

test('setup exposes stable classifications for platform, download, archive, extraction, executable, and probe failures', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }

  const unsupported = await setupFixture();
  await assert.rejects(setupPixelSnapper({ ...unsupported.options, platform: { platform: 'freebsd', arch: 'x64' } }), (error) => error.code === 'PIXEL_SNAPPER_UNSUPPORTED_PLATFORM');

  const network = await setupFixture();
  await assert.rejects(setupPixelSnapper({ ...network.options, fetchImpl: async () => { throw new Error('socket closed'); } }), (error) => error.code === 'PIXEL_SNAPPER_NETWORK_ERROR');

  const missing = await setupFixture();
  await assert.rejects(setupPixelSnapper({ ...missing.options, fetchImpl: async () => ({ status: 404, ok: false, headers: { get: () => null }, body: null }) }), (error) => error.code === 'PIXEL_SNAPPER_RELEASE_NOT_FOUND');

  const integrity = await setupFixture();
  await assert.rejects(setupPixelSnapper({ ...integrity.options, fetchImpl: async () => response(Buffer.alloc(integrity.archive.length)) }), (error) => error.code === 'PIXEL_SNAPPER_ARCHIVE_INTEGRITY');

  const unsafe = await setupFixture();
  const unsafeBytes = await tarGz('../escape', Buffer.from('unsafe'));
  await unsafe.setArchive(unsafeBytes);
  await assert.rejects(setupPixelSnapper(unsafe.options), (error) => error.code === 'PIXEL_SNAPPER_UNSAFE_ARCHIVE');

  const extraction = await setupFixture();
  await assert.rejects(setupPixelSnapper({ ...extraction.options, faults: { beforeExtraction: async () => { throw new Error('injected extraction'); } } }), (error) => error.code === 'PIXEL_SNAPPER_EXTRACTION_FAILED');

  const mismatch = await setupFixture();
  const changedBytes = Buffer.from('#!/usr/bin/env node\nprocess.exit(0)\n');
  await mismatch.setArchive(await tarGz(mismatch.manifest.assets[mismatch.target].executable, changedBytes));
  await assert.rejects(setupPixelSnapper(mismatch.options), (error) => error.code === 'PIXEL_SNAPPER_EXECUTABLE_MISMATCH');

  const probe = await setupFixture();
  const brokenProbe = Buffer.from('#!/usr/bin/env node\nprocess.exit(9)\n');
  await probe.setArchive(await tarGz(probe.manifest.assets[probe.target].executable, brokenProbe), { executableSize: brokenProbe.length, executableSha256: hash(brokenProbe) });
  await assert.rejects(setupPixelSnapper(probe.options), (error) => error.code === 'PIXEL_SNAPPER_PROBE_FAILED');
});

test('pending install-stage debris is never published and never blocks setup', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  const staging = path.join(fixture.projectDir, '.pixel-sprite-pipeline', 'tools', '.staging');
  await fs.mkdir(staging, { recursive: true });
  await fs.mkdir(path.join(staging, `.pending-install-${crypto.randomUUID()}`));
  assert.equal((await setupPixelSnapper(fixture.options)).status, 'installed');
});

test('a crash after stage marker creation leaves only unpublished non-blocking debris', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  await assert.rejects(setupPixelSnapper({ ...fixture.options, faults: { afterStageMarker: async () => { throw new Error('crash after stage marker'); } } }), /crash after stage marker/);
  assert.equal((await setupPixelSnapper(fixture.options)).status, 'installed');
});

test('an orphan prepublished backup marker is harmless and the active installation remains canonical', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  const installed = await setupPixelSnapper(fixture.options);
  await assert.rejects(setupPixelSnapper({ ...fixture.options, force: true, faults: { afterMoveMarker: async () => { throw new Error('crash before backup rename'); } } }), /crash before backup rename/);
  assert.equal((await setupPixelSnapper(fixture.options)).identity.sha256, installed.identity.sha256);
});

test('final verification failure keeps the verified rollback backup until restoration completes', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  const installed = await setupPixelSnapper(fixture.options);
  await assert.rejects(setupPixelSnapper({ ...fixture.options, force: true, faults: { beforeFinalVerification: async () => { throw new Error('injected final verification failure'); } } }), (error) => error.code === 'PIXEL_SNAPPER_ACTIVATION_FAILED');
  assert.equal((await setupPixelSnapper(fixture.options)).identity.sha256, installed.identity.sha256);
});

test('failed verification after recovery rename quarantines the canonical directory before returning', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  await setupPixelSnapper(fixture.options);
  await seedActivationBackup(fixture);
  await fs.rm(fixture.finalDir, { recursive: true });
  await assert.rejects(setupPixelSnapper({ ...fixture.options, faults: { afterRecoveryRename: async ({ finalDir }) => {
    await fs.appendFile(path.join(finalDir, fixture.manifest.assets[fixture.target].executable), 'tamper after recovery rename');
  } } }), (error) => error.code === 'PIXEL_SNAPPER_RECOVERY_BLOCKED');
  await assert.rejects(fs.lstat(fixture.finalDir), { code: 'ENOENT' });
  assert.ok((await fs.readdir(path.dirname(fixture.finalDir))).some((name) => name.includes('recovery-failed')));
});

test('failed recovery move writes an identity-bound invalidation marker into canonical state', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  await setupPixelSnapper(fixture.options);
  await seedActivationBackup(fixture);
  await fs.rm(fixture.finalDir, { recursive: true });
  await assert.rejects(setupPixelSnapper({ ...fixture.options, faults: {
    afterRecoveryRename: async ({ finalDir }) => fs.appendFile(path.join(finalDir, fixture.manifest.assets[fixture.target].executable), 'tamper'),
    beforeDeactivationMove: async () => { throw new Error('move unavailable'); }
  } }), (error) => error.code === 'PIXEL_SNAPPER_RECOVERY_BLOCKED');
  const marker = JSON.parse(await fs.readFile(path.join(fixture.finalDir, '.pixel-snapper-invalidated.json')));
  const info = await fs.lstat(fixture.finalDir);
  assert.equal(marker.dev, info.dev);
  assert.equal(marker.ino, info.ino);
});

test('failed recovery move and invalidation reports canonical deactivation failure honestly', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const fixture = await setupFixture();
  await setupPixelSnapper(fixture.options);
  await seedActivationBackup(fixture);
  await fs.rm(fixture.finalDir, { recursive: true });
  await assert.rejects(setupPixelSnapper({ ...fixture.options, faults: {
    afterRecoveryRename: async ({ finalDir }) => fs.appendFile(path.join(finalDir, fixture.manifest.assets[fixture.target].executable), 'tamper'),
    beforeDeactivationMove: async () => { throw new Error('move unavailable'); },
    beforeInvalidation: async () => { throw new Error('invalidation unavailable'); }
  } }), (error) => error.code === 'PIXEL_SNAPPER_CANONICAL_DEACTIVATION_FAILED' && error.cause instanceof AggregateError);
});

for (const crashPoint of ['afterCleanupDirectoryMove', 'afterCleanupMarkerMove']) {
  test(`guarded backup cleanup recovers interruption ${crashPoint}`, async (t) => {
    if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
    const fixture = await setupFixture();
    await setupPixelSnapper(fixture.options);
    await assert.rejects(setupPixelSnapper({ ...fixture.options, force: true, faults: { [crashPoint]: async () => { throw new Error(crashPoint); } } }), (error) => error.code === 'PIXEL_SNAPPER_RECOVERY_BLOCKED');
    assert.equal((await setupPixelSnapper(fixture.options)).status, 'already-installed');
    assert.deepEqual((await fs.readdir(path.dirname(fixture.finalDir))).filter((name) => name.includes('.cleanup-')), []);
  });
}
