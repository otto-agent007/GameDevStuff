import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { platformKey, selectToolAsset, validateToolManifest } from '../scripts/lib/tool-manifest.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/tool-manifest.fixture.json', import.meta.url));

async function fixtureManifest() {
  return JSON.parse(await fs.readFile(fixturePath, 'utf8'));
}

test('platform mapping is closed and explicit', () => {
  assert.equal(platformKey({ platform: 'win32', arch: 'x64' }), 'windows-x64');
  assert.equal(platformKey({ platform: 'darwin', arch: 'arm64' }), 'macos-arm64');
  assert.throws(() => platformKey({ platform: 'freebsd', arch: 'x64' }), /unsupported Pixel Snapper platform/);
});

test('manifest has a closed schema and returns a frozen copy', async () => {
  const manifest = await fixtureManifest();
  manifest.assets['linux-x64'].unexpected = true;
  assert.throws(() => validateToolManifest(manifest), /invalid pinned Pixel Snapper manifest/);

  delete manifest.assets['linux-x64'].unexpected;
  const validated = validateToolManifest(manifest);
  assert.equal(Object.isFrozen(validated.assets['linux-x64']), true);
  assert.throws(() => { validated.release.tag = 'changed'; }, TypeError);
});

test('asset selection rejects target names outside the reviewed manifest', async () => {
  const manifest = validateToolManifest(await fixtureManifest());
  assert.equal(selectToolAsset(manifest, 'linux-x64').archiveFormat, 'tar.gz');
  assert.throws(() => selectToolAsset(manifest, 'freebsd-x64'), /unsupported Pixel Snapper target/);
});

test('manifest rejects mutable or non-GameDevStuff release URLs', async () => {
  const manifest = await fixtureManifest();
  manifest.assets['linux-x64'].url = 'https://github.com/otto-agent007/GameDevStuff/releases/download/latest/pixel-snapper-linux-x64.tar.gz';
  assert.throws(() => validateToolManifest(manifest), /invalid pinned Pixel Snapper manifest/);

  manifest.assets['linux-x64'].url = 'https://github.com/otto-agent007/GameDevStuff/releases/download/pixel-snapper-v1.2.3-commit.0123456/pixel-snapper-linux-x64.tar.gz';
  manifest.release.url = 'https://example.invalid/releases/tag/pixel-snapper-v1.2.3-commit.0123456';
  assert.throws(() => validateToolManifest(manifest), /invalid pinned Pixel Snapper manifest/);
});
