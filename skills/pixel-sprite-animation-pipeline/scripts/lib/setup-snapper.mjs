import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectArchive, extractInspectedArchive } from './archive.mjs';
import { downloadPinnedAsset } from './download.mjs';
import { withSetupLock } from './setup-lock.mjs';
import { inspectPixelSnapperBinary } from './tool-identity.mjs';
import { platformKey, selectToolAsset, validateToolManifest } from './tool-manifest.mjs';

const STAGE_MARKER = '.pixel-snapper-install-stage.json';
const MOVE_MARKER_SUFFIX = '.marker.json';
const RECEIPT = 'installation-receipt.json';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const defaultGetUid = typeof process.getuid === 'function' ? () => process.getuid() : null;

export class PixelSnapperSetupError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PixelSnapperSetupError';
    this.code = code;
  }
}

function setupError(code, message, cause) {
  return cause instanceof PixelSnapperSetupError ? cause : new PixelSnapperSetupError(code, message, cause);
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sameIdentity(left, right) { return left?.dev === right?.dev && left?.ino === right?.ino; }

async function exists(target) {
  try { await fs.lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function ensureDirectory(directory, getUid) {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await fs.lstat(directory);
  const posix = typeof getUid === 'function';
  if (!info.isDirectory() || info.isSymbolicLink() || (posix && ((info.mode & 0o022) !== 0 || (Number.isInteger(info.uid) && info.uid !== getUid())))) {
    throw new Error(`unsafe Pixel Snapper tool directory: ${directory}`);
  }
}

function installationDir(projectDir, releaseTag, target) {
  return path.join(path.resolve(projectDir), '.pixel-sprite-pipeline', 'tools', 'pixel-snapper', releaseTag, target);
}
function installedExecutable(finalDir, asset) { return path.join(finalDir, asset.executable); }
function stagePrefix(releaseTag, target) { return `.install-${releaseTag}-${target}-`; }

function stageMarker(releaseTag, target, nonce, info) {
  return { schemaVersion: 1, kind: 'pixel-snapper-install-stage', releaseTag, target, nonce, dev: info.dev, ino: info.ino };
}

function validStageMarker(value, { releaseTag, target, name }) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'dev,ino,kind,nonce,releaseTag,schemaVersion,target' &&
    value.schemaVersion === 1 && value.kind === 'pixel-snapper-install-stage' && value.releaseTag === releaseTag && value.target === target &&
    UUID.test(value.nonce ?? '') && Number.isInteger(value.dev) && Number.isInteger(value.ino) && name === `${stagePrefix(releaseTag, target)}${value.nonce}`;
}

async function readStage(stage, expected) {
  const info = await fs.lstat(stage);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe Pixel Snapper install stage');
  const markerPath = path.join(stage, STAGE_MARKER);
  const markerInfo = await fs.lstat(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1) throw new Error('unsafe Pixel Snapper install stage marker');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  if (!validStageMarker(marker, { ...expected, name: expected.name ?? path.basename(stage) }) || marker.dev !== info.dev || marker.ino !== info.ino) throw new Error('Pixel Snapper install stage identity mismatch');
  return { info: { dev: info.dev, ino: info.ino }, marker };
}

async function guardedRemoveStage(stage, expected) {
  const record = await readStage(stage, expected);
  const moved = `${stage}.cleanup-${crypto.randomUUID()}`;
  await fs.rename(stage, moved);
  const movedRecord = await readStage(moved, { ...expected, name: path.basename(stage) }).catch(() => null);
  if (!movedRecord || !sameIdentity(record.info, movedRecord.info)) return false;
  await fs.rm(moved, { recursive: true, force: false });
  return true;
}

async function cleanupInterruptedStages(staging, releaseTag, target) {
  const names = await fs.readdir(staging);
  for (const name of names) {
    if (!name.startsWith(stagePrefix(releaseTag, target)) || name.includes('.cleanup-')) continue;
    try {
      if (!await guardedRemoveStage(path.join(staging, name), { releaseTag, target })) throw new Error('identity changed');
    } catch (error) {
      throw setupError('PIXEL_SNAPPER_RECOVERY_BLOCKED', `Pixel Snapper recovery blocked by untrusted install stage: ${name}`, error);
    }
  }
}

async function createInstallStage(toolsDir, releaseTag, target, getUid, faults) {
  const staging = path.join(toolsDir, '.staging');
  await ensureDirectory(staging, getUid);
  const nonce = crypto.randomUUID();
  const stage = path.join(staging, `${stagePrefix(releaseTag, target)}${nonce}`);
  const pending = path.join(staging, `.pending-install-${nonce}`);
  await fs.mkdir(pending, { mode: 0o700 });
  const info = await fs.lstat(pending);
  try {
    await fs.writeFile(path.join(pending, STAGE_MARKER), `${JSON.stringify(stageMarker(releaseTag, target, nonce, info))}\n`, { flag: 'wx', mode: 0o600 });
    if (typeof faults?.afterStageMarker === 'function') await faults.afterStageMarker({ pending, stage });
    await fs.rename(pending, stage);
  } catch (error) {
    if (!await exists(path.join(pending, STAGE_MARKER))) await fs.rmdir(pending).catch(() => {});
    throw error;
  }
  return { stage, expected: { releaseTag, target } };
}

function receiptIdentity(identity) {
  return Object.fromEntries(['size', 'sha256', 'version', 'helpSha256', 'fixtureRgbaSha256', 'pinnedReleaseTag', 'upstreamCommit'].map((key) => [key, identity[key]]));
}

function expectedReceipt({ manifestSha256, manifest, target, asset, identity }) {
  return {
    schemaVersion: 1, manifest: { sha256: manifestSha256 }, releaseTag: manifest.release.tag, target,
    asset: { archiveName: asset.archiveName, archiveSize: asset.archiveSize, archiveSha256: asset.archiveSha256, executable: asset.executable, executableSize: asset.executableSize, executableSha256: asset.executableSha256 },
    identity: receiptIdentity(identity), installedFiles: [{ path: asset.executable, size: identity.size, sha256: identity.sha256 }]
  };
}

async function inspectManaged(finalDir, manifest, asset) {
  return inspectPixelSnapperBinary({ path: installedExecutable(finalDir, asset), origin: 'managed-cache', managed: { root: finalDir, asset }, manifest, pinnedAsset: asset });
}

async function verifyReceipt(finalDir, expected) {
  const receipt = path.join(finalDir, RECEIPT);
  let info;
  try { info = await fs.lstat(receipt); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Pixel Snapper installation receipt mismatch'); throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Pixel Snapper installation receipt mismatch');
  let actual;
  try { actual = JSON.parse(await fs.readFile(receipt, 'utf8')); } catch { throw new Error('Pixel Snapper installation receipt mismatch'); }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Pixel Snapper installation receipt mismatch');
  return receipt;
}

async function verifyInstalledTool({ finalDir, manifest, manifestSha256, target, asset, status = 'already-installed' }) {
  const root = await fs.lstat(finalDir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('unsafe managed Pixel Snapper installation');
  const names = (await fs.readdir(finalDir)).sort();
  if (JSON.stringify(names) !== JSON.stringify([RECEIPT, asset.executable].sort())) throw new Error('Pixel Snapper installed file inventory mismatch');
  const executableInfo = await fs.lstat(installedExecutable(finalDir, asset));
  if (executableInfo.nlink !== 1) throw new Error('managed Pixel Snapper executable must have one link');
  const identity = await inspectManaged(finalDir, manifest, asset);
  const receipt = await verifyReceipt(finalDir, expectedReceipt({ manifestSha256, manifest, target, asset, identity }));
  return { status, executable: installedExecutable(finalDir, asset), identity, receipt };
}

async function verifyInstalledRecord(finalDir, context) {
  const before = await fs.lstat(finalDir);
  const physical = await fs.realpath(finalDir);
  const verified = await verifyInstalledTool({ ...context, finalDir });
  const after = await fs.lstat(finalDir);
  if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(before, after) || await fs.realpath(finalDir) !== physical) {
    throw new Error('managed Pixel Snapper installation identity changed during verification');
  }
  return { verified, directory: { dev: before.dev, ino: before.ino, physical } };
}

function classifyExecutable(error) {
  if (/probe|fixture/i.test(error?.message ?? '')) return setupError('PIXEL_SNAPPER_PROBE_FAILED', 'Pixel Snapper compatibility or deterministic fixture verification failed', error);
  return setupError('PIXEL_SNAPPER_EXECUTABLE_MISMATCH', 'Pixel Snapper executable identity did not match the pinned asset', error);
}

function moveMarker(reason, nonce, info) {
  return { schemaVersion: 1, kind: 'pixel-snapper-install-move', reason, nonce, dev: info.dev, ino: info.ino };
}

function validMoveMarker(value, reason, nonce) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'dev,ino,kind,nonce,reason,schemaVersion' &&
    value.schemaVersion === 1 && value.kind === 'pixel-snapper-install-move' && value.reason === reason && value.nonce === nonce &&
    UUID.test(value.nonce ?? '') && Number.isInteger(value.dev) && Number.isInteger(value.ino);
}

async function writeSynced(file, contents) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
}

async function moveInstallation(finalDir, reason, verified = null, faults = null) {
  const before = await fs.lstat(finalDir);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('unsafe managed Pixel Snapper installation move');
  const nonce = crypto.randomUUID();
  const moved = path.join(path.dirname(finalDir), `.${path.basename(finalDir)}.${reason}-${nonce}`);
  const marker = moveMarker(reason, nonce, before);
  const markerPath = `${moved}${MOVE_MARKER_SUFFIX}`;
  await writeSynced(markerPath, `${JSON.stringify(marker)}\n`);
  if (typeof faults?.afterMoveMarker === 'function') await faults.afterMoveMarker({ finalDir, moved, markerPath });
  await fs.rename(finalDir, moved);
  const info = await fs.lstat(moved);
  if (!sameIdentity(before, info)) throw new Error('managed Pixel Snapper installation identity changed while moving');
  return { path: moved, markerPath, marker, identity: { dev: info.dev, ino: info.ino }, verified };
}

async function deactivateCanonical(finalDir, reason, faults, originalCause) {
  const before = await fs.lstat(finalDir);
  const physical = await fs.realpath(finalDir);
  try {
    if (typeof faults?.beforeDeactivationMove === 'function') await faults.beforeDeactivationMove({ finalDir, reason });
    return await moveInstallation(finalDir, reason);
  } catch (moveError) {
    try {
      const current = await fs.lstat(finalDir);
      if (!sameIdentity(before, current) || await fs.realpath(finalDir) !== physical) throw new Error('canonical identity changed before invalidation');
      if (typeof faults?.beforeInvalidation === 'function') await faults.beforeInvalidation({ finalDir, reason });
      const marker = { schemaVersion: 1, kind: 'pixel-snapper-canonical-invalidation', reason, nonce: crypto.randomUUID(), dev: current.dev, ino: current.ino };
      await writeSynced(path.join(finalDir, '.pixel-snapper-invalidated.json'), `${JSON.stringify(marker)}\n`);
      const after = await fs.lstat(finalDir);
      if (!sameIdentity(current, after) || await fs.realpath(finalDir) !== physical) throw new Error('canonical identity changed during invalidation');
      return { invalidated: true, marker };
    } catch (invalidationError) {
      throw setupError('PIXEL_SNAPPER_CANONICAL_DEACTIVATION_FAILED', 'Pixel Snapper canonical deactivation and invalidation both failed', new AggregateError([originalCause, moveError, invalidationError], 'canonical deactivation failed'));
    }
  }
}

async function readMoved(moved, reason) {
  const name = path.basename(moved);
  const cleanupMatch = /^(.*)\.cleanup-[a-f0-9-]+$/i.exec(name);
  const baseName = cleanupMatch ? cleanupMatch[1] : name;
  const nonceMatch = new RegExp(`\\.${reason}-([a-f0-9-]+)$`, 'i').exec(baseName);
  if (!nonceMatch || !UUID.test(nonceMatch[1])) throw new Error('invalid Pixel Snapper move name');
  const markerCandidates = [`${moved}${MOVE_MARKER_SUFFIX}`];
  if (cleanupMatch) markerCandidates.push(path.join(path.dirname(moved), `${baseName}${MOVE_MARKER_SUFFIX}`));
  const presentMarkers = [];
  for (const candidate of markerCandidates) if (await exists(candidate)) presentMarkers.push(candidate);
  if (presentMarkers.length !== 1) throw new Error('ambiguous Pixel Snapper move marker');
  const markerPath = presentMarkers[0];
  const markerInfo = await fs.lstat(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1) throw new Error('unsafe Pixel Snapper move marker');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  if (!validMoveMarker(marker, reason, nonceMatch[1])) throw new Error('invalid Pixel Snapper move marker');
  const info = await fs.lstat(moved);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== marker.dev || info.ino !== marker.ino) throw new Error('Pixel Snapper moved directory identity mismatch');
  return { path: moved, markerPath, marker, identity: { dev: info.dev, ino: info.ino } };
}

async function guardedRemoveMoved(moved, reason, faults = null) {
  const record = await readMoved(moved, reason);
  const alreadyMoved = /\.cleanup-[a-f0-9-]+$/i.test(path.basename(moved));
  const cleanup = alreadyMoved ? moved : `${moved}.cleanup-${crypto.randomUUID()}`;
  const cleanupMarker = `${cleanup}${MOVE_MARKER_SUFFIX}`;
  if (!alreadyMoved) {
    await fs.rename(moved, cleanup);
    if (typeof faults?.afterCleanupDirectoryMove === 'function') await faults.afterCleanupDirectoryMove({ moved, cleanup });
  }
  if (record.markerPath !== cleanupMarker) await fs.rename(record.markerPath, cleanupMarker);
  if (typeof faults?.afterCleanupMarkerMove === 'function') await faults.afterCleanupMarkerMove({ cleanup, cleanupMarker });
  const info = await fs.lstat(cleanup);
  const marker = JSON.parse(await fs.readFile(cleanupMarker, 'utf8'));
  if (!sameIdentity(info, record.identity) || marker.dev !== info.dev || marker.ino !== info.ino) return false;
  await fs.rm(cleanup, { recursive: true, force: false });
  await fs.rm(cleanupMarker, { force: false });
  return true;
}

async function activationLeftovers(finalDir) {
  const parent = path.dirname(finalDir);
  const prefix = `.${path.basename(finalDir)}.activation-`;
  return (await fs.readdir(parent)).filter((name) => name.startsWith(prefix) && !name.endsWith(MOVE_MARKER_SUFFIX)).sort().map((name) => path.join(parent, name));
}

async function verifyMovedInstallation(moved, context, expectedVerified) {
  const record = await readMoved(moved, 'activation');
  const verified = await verifyInstalledTool({ ...context, finalDir: moved });
  if (expectedVerified && JSON.stringify(receiptIdentity(verified.identity)) !== JSON.stringify(receiptIdentity(expectedVerified.identity))) throw new Error('Pixel Snapper backup verification changed');
  return { ...record, verified };
}

async function recoverActivationState(finalDir, context, faults) {
  const leftovers = await activationLeftovers(finalDir);
  if (leftovers.length === 0) return null;
  if (!await exists(finalDir)) {
    const candidate = leftovers.shift();
    try {
      await verifyMovedInstallation(candidate, context);
      await fs.rename(candidate, finalDir);
      await fs.rm(`${candidate}${MOVE_MARKER_SUFFIX}`, { force: false });
      if (typeof faults?.afterRecoveryRename === 'function') await faults.afterRecoveryRename({ finalDir, candidate });
      await verifyInstalledTool({ ...context, finalDir });
    } catch (error) {
      if (await exists(finalDir)) await deactivateCanonical(finalDir, 'recovery-failed', faults, error);
      throw setupError('PIXEL_SNAPPER_RECOVERY_BLOCKED', 'Pixel Snapper activation recovery found an untrusted backup', error);
    }
  }
  for (const leftover of leftovers.length ? leftovers : await activationLeftovers(finalDir)) {
    try {
      await verifyMovedInstallation(leftover, context);
      if (!await guardedRemoveMoved(leftover, 'activation')) throw new Error('backup identity changed during cleanup');
    } catch (error) {
      throw setupError('PIXEL_SNAPPER_RECOVERY_BLOCKED', 'Pixel Snapper activation recovery found an untrusted leftover', error);
    }
  }
  return verifyInstalledTool({ ...context, finalDir });
}

async function restoreVerifiedBackup({ backup, finalDir, context, faults, activationError }) {
  try {
    if (typeof faults?.beforeRollback === 'function') await faults.beforeRollback({ backup, finalDir });
    const checked = await verifyMovedInstallation(backup.path, context, backup.verified);
    if (!sameIdentity(checked.identity, backup.identity)) throw new Error('Pixel Snapper backup directory identity changed');
    if (await exists(finalDir)) await moveInstallation(finalDir, 'failed-activation');
    await fs.rename(backup.path, finalDir);
    await fs.rm(backup.markerPath, { force: false });
    await verifyInstalledTool({ ...context, finalDir });
  } catch (error) {
    if (await exists(finalDir)) await deactivateCanonical(finalDir, 'rollback-failed', faults, error);
    throw setupError('PIXEL_SNAPPER_ROLLBACK_FAILED', 'Pixel Snapper rollback failed verification; canonical installation left inactive', new AggregateError([activationError, error], 'activation and rollback failed'));
  }
}

function classifyDownload(error) {
  if (error?.code === 'PIXEL_SNAPPER_RELEASE_NOT_FOUND') return setupError(error.code, 'Pinned Pixel Snapper release asset was not found; verify the reviewed release exists', error);
  if (/redirect/i.test(error?.message ?? '')) return setupError('PIXEL_SNAPPER_REDIRECT_ERROR', 'Pixel Snapper download redirect was rejected by the pinned host policy', error);
  if (/size|checksum|maximum/i.test(error?.message ?? '')) return setupError('PIXEL_SNAPPER_ARCHIVE_INTEGRITY', 'Pixel Snapper archive size or checksum did not match the pinned manifest', error);
  return setupError('PIXEL_SNAPPER_NETWORK_ERROR', 'Pixel Snapper download failed; check network access and the pinned release URL', error);
}

async function writeInstallationReceipt({ content, manifestSha256, manifest, target, asset, identity }) {
  const receipt = path.join(content, RECEIPT);
  await fs.writeFile(receipt, `${JSON.stringify(expectedReceipt({ manifestSha256, manifest, target, asset, identity }), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export async function setupPixelSnapper({ projectDir, manifestPath, fetchImpl = fetch, force = false, platform, getUid = defaultGetUid, faults } = {}) {
  if (typeof projectDir !== 'string' || projectDir.length === 0 || typeof manifestPath !== 'string' || manifestPath.length === 0 || typeof fetchImpl !== 'function' || typeof force !== 'boolean' || (getUid !== null && typeof getUid !== 'function')) {
    throw new Error('invalid Pixel Snapper setup request');
  }
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = validateToolManifest(JSON.parse(manifestBytes.toString('utf8')));
  let target;
  try { target = platformKey(platform); }
  catch (error) { throw setupError('PIXEL_SNAPPER_UNSUPPORTED_PLATFORM', `Pixel Snapper has no pinned asset for ${platform?.platform ?? process.platform}/${platform?.arch ?? process.arch}`, error); }
  const asset = selectToolAsset(manifest, target);
  const manifestSha256 = sha256(manifestBytes);
  const finalDir = installationDir(projectDir, manifest.release.tag, target);
  const context = { manifest, manifestSha256, target, asset };

  try {
    return await withSetupLock({ projectDir, releaseTag: manifest.release.tag, getUid, operation: async () => {
      const toolsDir = path.join(path.resolve(projectDir), '.pixel-sprite-pipeline', 'tools');
      await ensureDirectory(path.join(toolsDir, 'pixel-snapper'), getUid);
      await ensureDirectory(path.dirname(finalDir), getUid);
      const staging = path.join(toolsDir, '.staging');
      await ensureDirectory(staging, getUid);
      await cleanupInterruptedStages(staging, manifest.release.tag, target);

      let active = null;
      let activeRecord = null;
      if (await exists(finalDir)) {
        try { activeRecord = await verifyInstalledRecord(finalDir, context); active = activeRecord.verified; }
        catch (error) {
          await moveInstallation(finalDir, 'tampered');
          if (!force) throw setupError('PIXEL_SNAPPER_INSTALLATION_TAMPERED', 'Managed Pixel Snapper installation failed revalidation and was quarantined', error);
        }
      }
      const recovered = await recoverActivationState(finalDir, context, faults);
      if (recovered) { activeRecord = await verifyInstalledRecord(finalDir, context); active = activeRecord.verified; }
      if (active && !force) return active;

      const owned = await createInstallStage(toolsDir, manifest.release.tag, target, getUid, faults);
      let backup = null;
      let content = path.join(owned.stage, 'content');
      try {
        let archive;
        try {
          archive = await downloadPinnedAsset({ url: asset.url, upstreamCommit: manifest.upstream.commit, expectedSize: asset.archiveSize, expectedSha256: asset.archiveSha256, fetchImpl, output: path.join(owned.stage, 'download') });
        } catch (error) { throw classifyDownload(error); }

        let inspection;
        try { inspection = inspectArchive({ bytes: await fs.readFile(archive.output), format: asset.archiveFormat, expectedFiles: [asset.executable] }); }
        catch (error) { throw setupError('PIXEL_SNAPPER_UNSAFE_ARCHIVE', 'Pixel Snapper archive failed closed safety inspection', error); }
        try {
          if (typeof faults?.beforeExtraction === 'function') await faults.beforeExtraction({ content });
          await extractInspectedArchive({ inspection, outputDir: content });
        } catch (error) { throw setupError('PIXEL_SNAPPER_EXTRACTION_FAILED', 'Pixel Snapper archive extraction failed before activation', error); }

        let stagedIdentity;
        try { stagedIdentity = await inspectManaged(content, manifest, asset); }
        catch (error) { throw classifyExecutable(error); }
        await writeInstallationReceipt({ content, ...context, identity: stagedIdentity });

        if (active) {
          const sourceInfo = await fs.lstat(finalDir);
          const sourcePhysical = await fs.realpath(finalDir);
          if (sourcePhysical !== activeRecord.directory.physical || !sameIdentity(sourceInfo, activeRecord.directory)) throw new Error('active Pixel Snapper identity changed after verification');
          backup = await moveInstallation(finalDir, 'activation', active, faults);
          if (!sameIdentity(sourceInfo, backup.identity)) throw new Error('active Pixel Snapper identity changed before backup publication');
        }

        try {
          if (typeof faults?.afterBackup === 'function') await faults.afterBackup({ backup, finalDir });
          await fs.rename(content, finalDir);
          if (typeof faults?.afterActivation === 'function') await faults.afterActivation({ backup, finalDir });
          if (typeof faults?.beforeFinalVerification === 'function') await faults.beforeFinalVerification({ backup, finalDir });
          var installed = await verifyInstalledTool({ ...context, finalDir, status: 'installed' });
        } catch (activationError) {
          if (backup) {
            await restoreVerifiedBackup({ backup, finalDir, context, faults, activationError });
            throw setupError('PIXEL_SNAPPER_ACTIVATION_FAILED', 'Pixel Snapper activation failed; the previous verified installation was restored', activationError);
          }
          if (await exists(finalDir)) await deactivateCanonical(finalDir, 'failed-activation', faults, activationError);
          throw setupError('PIXEL_SNAPPER_ACTIVATION_FAILED', 'Pixel Snapper activation failed before a verified installation became active', activationError);
        }

        if (backup) {
          try {
            if (!await guardedRemoveMoved(backup.path, 'activation', faults)) throw new Error('verified backup identity changed during cleanup');
          } catch (error) {
            throw setupError('PIXEL_SNAPPER_RECOVERY_BLOCKED', 'Verified activation backup cleanup was interrupted or changed', error);
          }
        }
        return installed;
      } finally {
        if (await exists(owned.stage)) {
          try {
            if (!await guardedRemoveStage(owned.stage, owned.expected)) throw new Error('stage identity changed during cleanup');
          } catch (error) {
            throw setupError('PIXEL_SNAPPER_RECOVERY_BLOCKED', 'Pixel Snapper owned stage could not be safely cleaned', error);
          }
        }
      }
    }});
  } catch (error) {
    if (error instanceof PixelSnapperSetupError) throw error;
    if (error?.code === 'PIXEL_SNAPPER_LOCK_CONTENTION') throw setupError(error.code, error.message, error);
    throw error;
  }
}
