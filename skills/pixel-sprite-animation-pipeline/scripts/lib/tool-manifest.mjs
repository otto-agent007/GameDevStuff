import fs from 'node:fs/promises';
import path from 'node:path';

const FULL_SHA = /^[a-f0-9]{64}$/;
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const TARGETS = Object.freeze({
  'win32/x64': 'windows-x64',
  'darwin/x64': 'macos-x64',
  'darwin/arm64': 'macos-arm64',
  'linux/x64': 'linux-x64',
  'linux/arm64': 'linux-arm64'
});
const TARGET_KEYS = Object.freeze(Object.values(TARGETS));

function invalid() {
  throw new Error('invalid pinned Pixel Snapper manifest');
}

function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
}

function assertClosedObject(value, keys) {
  assertObject(value);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) invalid();
}

function assertString(value) {
  if (typeof value !== 'string' || value.length === 0) invalid();
}

function assertHash(value) {
  if (typeof value !== 'string' || !FULL_SHA.test(value)) invalid();
}

function assertSize(value) {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
}

function assertUrl(value) {
  assertString(value);
  let parsed;
  try { parsed = new URL(value); } catch { invalid(); }
  if (parsed.protocol !== 'https:') invalid();
}

function immutableReleaseUrl(value, tag) {
  assertUrl(value);
  const parsed = new URL(value);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash ||
    parts.length !== 5 || parts[0] !== 'otto-agent007' || parts[1] !== 'GameDevStuff' || parts[2] !== 'releases' || parts[3] !== 'tag' ||
    parts[4] !== encodeURIComponent(tag) || decodeURIComponent(parts[4]) !== tag) invalid();
}

function immutableAssetUrl(value, tag, archiveName) {
  assertUrl(value);
  const parsed = new URL(value);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash ||
    parts.length !== 6 || parts[0] !== 'otto-agent007' || parts[1] !== 'GameDevStuff' || parts[2] !== 'releases' || parts[3] !== 'download' ||
    parts[4] !== encodeURIComponent(tag) || decodeURIComponent(parts[4]) !== tag || parts[5] !== encodeURIComponent(archiveName) || decodeURIComponent(parts[5]) !== archiveName) invalid();
}

function assertBasename(value) {
  assertString(value);
  if (path.basename(value) !== value || value === '.' || value === '..' || value.includes('\\')) invalid();
}

function validateAsset(asset, target, tag) {
  assertClosedObject(asset, ['url', 'archiveName', 'archiveFormat', 'archiveSize', 'archiveSha256', 'executable', 'executableSize', 'executableSha256']);
  assertBasename(asset.archiveName);
  immutableAssetUrl(asset.url, tag, asset.archiveName);
  if (asset.archiveFormat !== (target === 'windows-x64' ? 'zip' : 'tar.gz')) invalid();
  assertSize(asset.archiveSize);
  assertHash(asset.archiveSha256);
  assertBasename(asset.executable);
  if (target === 'windows-x64' ? !asset.executable.toLowerCase().endsWith('.exe') : asset.executable.toLowerCase().endsWith('.exe')) invalid();
  assertSize(asset.executableSize);
  assertHash(asset.executableSha256);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function platformKey({ platform = process.platform, arch = process.arch } = {}) {
  const key = TARGETS[`${platform}/${arch}`];
  if (!key) throw new Error(`unsupported Pixel Snapper platform: ${platform}/${arch}`);
  return key;
}

export function validateToolManifest(input) {
  assertClosedObject(input, ['schemaVersion', 'release', 'upstream', 'build', 'fixture', 'assets']);
  if (input.schemaVersion !== 1) invalid();

  assertClosedObject(input.release, ['tag', 'url']);
  assertString(input.release.tag);
  if (!/^pixel-snapper-v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?-commit\.[a-f0-9]{7,40}$/.test(input.release.tag)) invalid();
  immutableReleaseUrl(input.release.url, input.release.tag);

  assertClosedObject(input.upstream, ['repository', 'version', 'commit']);
  assertString(input.upstream.repository);
  assertString(input.upstream.version);
  if (typeof input.upstream.commit !== 'string' || !FULL_COMMIT.test(input.upstream.commit)) invalid();

  assertClosedObject(input.build, ['rustVersion', 'cargoLockSha256', 'workflowCommit']);
  assertString(input.build.rustVersion);
  assertHash(input.build.cargoLockSha256);
  if (typeof input.build.workflowCommit !== 'string' || !FULL_COMMIT.test(input.build.workflowCommit)) invalid();

  assertClosedObject(input.fixture, ['inputRgbaSha256', 'rgbaSha256']);
  assertHash(input.fixture.inputRgbaSha256);
  assertHash(input.fixture.rgbaSha256);

  assertClosedObject(input.assets, TARGET_KEYS);
  for (const target of TARGET_KEYS) validateAsset(input.assets[target], target, input.release.tag);
  return deepFreeze(structuredClone(input));
}

export function selectToolAsset(manifest, platform) {
  if (!TARGET_KEYS.includes(platform) || !manifest?.assets?.[platform]) throw new Error(`unsupported Pixel Snapper target: ${platform}`);
  return manifest.assets[platform];
}

export async function loadToolManifest(file) {
  return validateToolManifest(JSON.parse(await fs.readFile(file, 'utf8')));
}
