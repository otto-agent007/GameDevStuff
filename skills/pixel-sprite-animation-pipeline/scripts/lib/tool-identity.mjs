import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { readRgba, sha256 } from './image.mjs';
import { platformKey, selectToolAsset, validateToolManifest } from './tool-manifest.mjs';
import {
  PIXEL_SNAPPER_FIXTURE_HEIGHT, PIXEL_SNAPPER_FIXTURE_INPUT_RGBA_SHA256,
  PIXEL_SNAPPER_FIXTURE_WIDTH, pixelSnapperFixtureRgba
} from './pixel-snapper-fixture.mjs';

const FIXTURE_RGBA = pixelSnapperFixtureRgba();

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function executableName(config) {
  return config?.snapper?.executable ?? 'spritefusion-pixel-snapper';
}

function isPath(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('/') || value.includes('\\');
}

function pathEntries(pathValue, platform) {
  return String(pathValue ?? '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean);
}

function pathCandidates(name, pathValue, platform, env) {
  const names = [name];
  if (platform === 'win32' && path.extname(name) === '' && String(env.PATHEXT ?? '').split(';').some((item) => item.toUpperCase() === '.EXE')) names.push(`${name}.exe`);
  return pathEntries(pathValue, platform).flatMap((directory) => names.map((candidate) => path.join(directory, candidate)));
}

export function pixelSnapperPathCandidates(name, pathValue, platform, env = {}) {
  return pathCandidates(name, pathValue, platform, env);
}

function managedExecutable(projectDir, manifest, target, asset) {
  return path.join(projectDir, '.pixel-sprite-pipeline', 'tools', 'pixel-snapper', manifest.release.tag, target, asset.executable);
}

function candidateList({ projectDir, config, configProvenance, manifest, env, pathValue, platform }) {
  const candidates = [];
  const configured = executableName(config);
  const target = platformKey(platform);
  const asset = selectToolAsset(manifest, target);
  if (typeof env.PIXEL_SNAPPER_BIN === 'string' && env.PIXEL_SNAPPER_BIN !== '') {
    candidates.push({ path: isPath(env.PIXEL_SNAPPER_BIN) ? path.resolve(projectDir, env.PIXEL_SNAPPER_BIN) : env.PIXEL_SNAPPER_BIN, origin: 'environment', explicit: true, pinnedAsset: asset });
  } else if (configProvenance?.snapperExecutable && configProvenance.snapperExecutable !== 'default') {
    candidates.push({ path: isPath(configured) ? path.resolve(projectDir, configured) : configured, origin: 'project-config', explicit: true, pinnedAsset: asset });
  } else {
    const root = path.dirname(managedExecutable(projectDir, manifest, target, asset));
    candidates.push({ path: path.join(root, asset.executable), origin: 'managed-cache', managed: { root, asset }, pinnedAsset: asset });
  }
  if (!candidates.some((candidate) => candidate.explicit)) {
    for (const candidate of pathCandidates(configured, pathValue, platform.platform, env)) candidates.push({ path: candidate, origin: 'path', pinnedAsset: asset });
  }
  return candidates;
}

async function secureExecutable(selected, { managedRoot } = {}) {
  const resolved = path.resolve(selected);
  if (managedRoot) {
    try {
      await fs.lstat(path.join(managedRoot, '.pixel-snapper-invalidated.json'));
      throw new Error('managed Pixel Snapper installation is explicitly invalidated');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const logicalRoot = path.resolve(managedRoot);
    const relative = path.relative(logicalRoot, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('managed Pixel Snapper escaped its installation directory');
    let current = logicalRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('managed Pixel Snapper must not contain symlinks');
    }
  }
  const linked = await fs.lstat(resolved);
  if (!linked.isFile() || linked.isSymbolicLink()) throw new Error('Pixel Snapper executable must be a regular non-symlink file');
  const physicalPath = await fs.realpath(resolved);
  const stat = await fs.stat(physicalPath);
  if (!stat.isFile()) throw new Error('Pixel Snapper executable must be a regular file');
  if (managedRoot) {
    const root = await fs.realpath(managedRoot);
    const relative = path.relative(root, physicalPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('managed Pixel Snapper escaped its installation directory');
  }
  return { physicalPath, stat };
}

function probe(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) throw new Error(`Pixel Snapper probe failed (${args.join(' ')}): ${result.stderr || result.error?.message || `exit status ${result.status}`}`);
  return result;
}

async function runFixtureProbe(executable, fixture) {
  if (!fixture) return null;
  if (fixture.inputRgbaSha256 !== PIXEL_SNAPPER_FIXTURE_INPUT_RGBA_SHA256 || fixture.inputRgbaSha256 !== hashBuffer(FIXTURE_RGBA)) throw new Error('Pixel Snapper fixture input hash mismatch');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-snapper-probe-'));
  const input = path.join(directory, 'input.png');
  const output = path.join(directory, 'output.png');
  try {
    await sharp(FIXTURE_RGBA, { raw: { width: PIXEL_SNAPPER_FIXTURE_WIDTH, height: PIXEL_SNAPPER_FIXTURE_HEIGHT, channels: 4 } }).png().toFile(input);
    const result = spawnSync(executable, [input, output, '16'], { encoding: 'utf8', shell: false });
    if (result.error || result.status !== 0) throw new Error(`Pixel Snapper fixture probe failed: ${result.stderr || result.error?.message || `exit status ${result.status}`}`);
    const rgba = await readRgba(output);
    const actual = hashBuffer(rgba.data);
    if (actual !== fixture.rgbaSha256) throw new Error('Pixel Snapper fixture RGBA hash mismatch');
    return actual;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function inspectPixelSnapperBinary({ path: selected, origin, managed, manifest, pinnedAsset }) {
  const secure = await secureExecutable(selected, { managedRoot: managed?.root });
  const value = await sha256(secure.physicalPath);
  if (managed && (secure.stat.size !== managed.asset.executableSize || value !== managed.asset.executableSha256)) throw new Error('managed Pixel Snapper hash mismatch');
  const version = probe(secure.physicalPath, ['--version']);
  const help = probe(secure.physicalPath, ['--help']);
  const fixtureRgbaSha256 = await runFixtureProbe(secure.physicalPath, manifest.fixture);
  const pinned = pinnedAsset?.executableSha256 === value && pinnedAsset.executableSize === secure.stat.size;
  return {
    origin,
    path: selected,
    physicalPath: secure.physicalPath,
    size: secure.stat.size,
    sha256: value,
    version: version.stdout.trim(),
    helpSha256: hashText(help.stdout),
    fixtureRgbaSha256,
    pinnedReleaseTag: pinned ? manifest.release.tag : null,
    upstreamCommit: pinned ? manifest.upstream.commit : null
  };
}

export async function resolvePixelSnapper({ projectDir = process.cwd(), config, configProvenance = { snapperExecutable: 'default' }, manifest, env = process.env, pathValue = env.PATH ?? '', platform = { platform: process.platform, arch: process.arch } }) {
  if (!manifest) throw new Error('pinned Pixel Snapper manifest is required');
  const validatedManifest = validateToolManifest(manifest);
  const candidates = candidateList({ projectDir, config, configProvenance, manifest: validatedManifest, env, pathValue, platform });
  for (const candidate of candidates) {
    if (candidate.explicit) return inspectPixelSnapperBinary({ ...candidate, manifest: validatedManifest });
    try {
      return await inspectPixelSnapperBinary({ ...candidate, manifest: validatedManifest });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}
