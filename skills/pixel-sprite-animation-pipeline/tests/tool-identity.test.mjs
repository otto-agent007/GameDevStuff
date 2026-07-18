import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePixelSnapper } from '../scripts/lib/tool-identity.mjs';
import { validateToolManifest } from '../scripts/lib/tool-manifest.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/tool-manifest.fixture.json', import.meta.url));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fixturePixels = Buffer.concat(Array.from({ length: 9 }, () => Buffer.from([16, 32, 48, 255])));

async function manifestFor(executable, target = 'linux-x64') {
  const manifest = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  const body = executable.toLowerCase().endsWith('.exe')
    ? '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Pixel Snapper 1.2.3"; elif [ "$1" = "--help" ]; then echo "usage: pixel-snapper INPUT OUTPUT 16"; else cp "$1" "$2"; fi\n'
    : `#!/usr/bin/env node\nimport fs from 'node:fs/promises';\nconst [input, output] = process.argv.slice(2);\nif (input === '--version') { console.log('Pixel Snapper 1.2.3'); } else if (input === '--help') { console.log('usage: pixel-snapper INPUT OUTPUT 16'); } else { await fs.copyFile(input, output); }\n`;
  await fs.writeFile(executable, body, { mode: 0o700 });
  const stat = await fs.stat(executable);
  const asset = manifest.assets[target];
  asset.executable = path.basename(executable);
  asset.executableSize = stat.size;
  asset.executableSha256 = hash(await fs.readFile(executable));
  manifest.fixture.inputRgbaSha256 = hash(fixturePixels);
  manifest.fixture.rgbaSha256 = hash(fixturePixels);
  return validateToolManifest(manifest);
}

async function managedBinaryFixture() {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-snapper-'));
  const executable = path.join(projectDir, '.pixel-sprite-pipeline', 'tools', 'pixel-snapper', 'pixel-snapper-v1.2.3-commit.0123456', 'linux-x64', 'snapper');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  const manifest = structuredClone(await manifestFor(executable));
  return {
    executable,
    resolveOptions: {
      projectDir,
      config: { snapper: { executable: 'spritefusion-pixel-snapper', args: ['16'] } },
      configProvenance: { snapperExecutable: 'default' },
      manifest,
      env: {},
      pathValue: '',
      platform: { platform: 'linux', arch: 'x64' }
    }
  };
}

async function externalBinaryFixture() {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-snapper-'));
  const executable = path.join(projectDir, 'external-snapper');
  const manifest = await manifestFor(path.join(projectDir, 'pinned-snapper'));
  await fs.writeFile(executable, '#!/usr/bin/env node\nimport fs from \'node:fs/promises\';\nconst [input, output] = process.argv.slice(2);\nif (input === \'--version\') console.log(\'external\'); else if (input === \'--help\') console.log(\'help\'); else await fs.copyFile(input, output);\n', { mode: 0o700 });
  return {
    projectDir,
    config: { snapper: { executable: 'spritefusion-pixel-snapper', args: ['16'] } },
    configProvenance: { snapperExecutable: 'default' },
    manifest,
    env: { PIXEL_SNAPPER_BIN: executable },
    pathValue: '',
    platform: { platform: 'linux', arch: 'x64' }
  };
}

test('managed cache is rejected after executable replacement', async () => {
  const fixture = await managedBinaryFixture();
  await fs.appendFile(fixture.executable, 'tampered');
  await assert.rejects(resolvePixelSnapper(fixture.resolveOptions), /managed Pixel Snapper hash mismatch/);
});

test('external binary records no pinned identity unless its hash matches', async () => {
  const resolved = await resolvePixelSnapper(await externalBinaryFixture());
  assert.equal(resolved.origin, 'environment');
  assert.equal(resolved.pinnedReleaseTag, null);
  assert.equal(resolved.upstreamCommit, null);
});

test('PATH lookup is deterministic and records its origin', async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'path-snapper-'));
  const binDir = path.join(projectDir, 'bin');
  const executable = path.join(binDir, 'spritefusion-pixel-snapper');
  await fs.mkdir(binDir);
  const manifest = structuredClone(await manifestFor(executable));
  const resolved = await resolvePixelSnapper({
    projectDir,
    config: { snapper: { executable: 'spritefusion-pixel-snapper', args: ['16'] } },
    configProvenance: { snapperExecutable: 'default' },
    manifest,
    env: {}, pathValue: binDir, platform: { platform: 'linux', arch: 'x64' }
  });
  assert.equal(resolved.origin, 'path');
  assert.equal(resolved.path, executable);
});

test('resolver refuses operation without a validated pinned manifest', async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-required-'));
  await assert.rejects(resolvePixelSnapper({
    projectDir,
    config: { snapper: { executable: 'spritefusion-pixel-snapper', args: ['16'] } },
    configProvenance: { snapperExecutable: 'default' },
    env: {}, pathValue: '', platform: { platform: 'linux', arch: 'x64' }
  }), /pinned Pixel Snapper manifest is required/);
  const malformed = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  malformed.unreviewed = true;
  await assert.rejects(resolvePixelSnapper({
    projectDir,
    config: { snapper: { executable: 'spritefusion-pixel-snapper', args: ['16'] } },
    configProvenance: { snapperExecutable: 'default' }, manifest: malformed,
    env: {}, pathValue: '', platform: { platform: 'linux', arch: 'x64' }
  }), /invalid pinned Pixel Snapper manifest/);
});

test('explicit missing binary failures propagate instead of becoming handoffs', async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'explicit-snapper-'));
  const manifest = await manifestFor(path.join(projectDir, 'pinned-snapper'));
  await assert.rejects(resolvePixelSnapper({
    projectDir,
    config: { snapper: { executable: 'spritefusion-pixel-snapper', args: ['16'] } },
    configProvenance: { snapperExecutable: 'default' }, manifest,
    env: { PIXEL_SNAPPER_BIN: path.join(projectDir, 'missing') }, pathValue: '', platform: { platform: 'linux', arch: 'x64' }
  }), { code: 'ENOENT' });
  await assert.rejects(resolvePixelSnapper({
    projectDir,
    config: { snapper: { executable: path.join(projectDir, 'configured-missing'), args: ['16'] } },
    configProvenance: { snapperExecutable: 'profile' }, manifest,
    env: {}, pathValue: '', platform: { platform: 'linux', arch: 'x64' }
  }), { code: 'ENOENT' });
});

test('managed cache rejects a symlinked executable even when it points to matching bytes', async (t) => {
  const fixture = await managedBinaryFixture();
  const outside = path.join(path.dirname(fixture.executable), 'outside');
  await fs.copyFile(fixture.executable, outside);
  await fs.rm(fixture.executable);
  try { await fs.symlink(outside, fixture.executable); } catch (error) { if (error.code === 'EPERM') { t.skip('symlinks unavailable'); return; } throw error; }
  await assert.rejects(resolvePixelSnapper(fixture.resolveOptions), /must not contain symlinks/);
});

test('Windows PATH lookup adds exe only when PATHEXT permits it', async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-path-snapper-'));
  const binDir = path.join(projectDir, 'bin');
  const executable = path.join(binDir, 'spritefusion-pixel-snapper.exe');
  await fs.mkdir(binDir);
  const manifest = await manifestFor(executable, 'windows-x64');
  const resolved = await resolvePixelSnapper({
    projectDir,
    config: { snapper: { executable: 'spritefusion-pixel-snapper', args: ['16'] } },
    configProvenance: { snapperExecutable: 'default' }, manifest,
    env: { PATHEXT: '.COM;.EXE' }, pathValue: binDir, platform: { platform: 'win32', arch: 'x64' }
  });
  assert.equal(resolved.origin, 'path');
  assert.equal(resolved.path, executable);
});

test('a hash pinned for another target does not receive current-platform attribution', async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-target-snapper-'));
  const executable = path.join(projectDir, 'external-snapper');
  const manifest = structuredClone(await manifestFor(executable));
  const bytes = await fs.readFile(executable);
  const stat = await fs.stat(executable);
  manifest.assets['linux-x64'] = { ...manifest.assets['linux-x64'], executableSha256: 'd111111111111111111111111111111111111111111111111111111111111111' };
  manifest.assets['macos-x64'] = { ...manifest.assets['macos-x64'], executableSize: stat.size, executableSha256: hash(bytes) };
  const resolved = await resolvePixelSnapper({
    projectDir,
    config: { snapper: { executable: 'spritefusion-pixel-snapper', args: ['16'] } },
    configProvenance: { snapperExecutable: 'default' }, manifest,
    env: { PIXEL_SNAPPER_BIN: executable }, pathValue: '', platform: { platform: 'linux', arch: 'x64' }
  });
  assert.equal(resolved.pinnedReleaseTag, null);
  assert.equal(resolved.upstreamCommit, null);
});
