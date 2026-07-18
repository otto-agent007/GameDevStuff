import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { assembleRelease } from '../scripts/release/assemble-release.mjs';
import { packagePixelSnapper, probeNativePixelSnapper } from '../scripts/release/package-pixel-snapper.mjs';
import { verifyRelease } from '../scripts/release/verify-release.mjs';
import { validateToolManifest } from '../scripts/lib/tool-manifest.mjs';
import { normalizeComplianceSbom } from '../scripts/release/normalize-compliance.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TARGETS = [
  ['windows-x64', 'x86_64-pc-windows-msvc', 'zip'],
  ['macos-x64', 'x86_64-apple-darwin', 'tar.gz'],
  ['macos-arm64', 'aarch64-apple-darwin', 'tar.gz'],
  ['linux-x64', 'x86_64-unknown-linux-musl', 'tar.gz'],
  ['linux-arm64', 'aarch64-unknown-linux-musl', 'tar.gz']
];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const H = (letter) => letter.repeat(64);
const UPSTREAM = '5743009265051098831ad7298092072325d1149b';
const WORKFLOW = '0123456789abcdef0123456789abcdef01234567';
const RELEASE_TAG = 'pixel-snapper-v1.0.0-commit.5743009';
const FIXTURE_HASH = 'bb9b87994cf22366cad9d0bbaca0a4663921cda521c5c7f1d44de921d8d8c84f';
const PALETTE_HASH = '09349ae9fcc935c5d4a7dd1bebced6bef54f32ae3bf48ff1d92cc61b220859b2';
const PUBLIC_BODY_LIMIT = 25 * 1024 * 1024;
const PUBLIC_ASSET_NAMES = [
  'pixel-snapper-windows-x64.zip', 'pixel-snapper-macos-x64.tar.gz', 'pixel-snapper-macos-arm64.tar.gz',
  'pixel-snapper-linux-x64.tar.gz', 'pixel-snapper-linux-arm64.tar.gz', 'LICENSE-Pixel-Snapper',
  'THIRD-PARTY-NOTICES', 'pixel-snapper.spdx.json', 'build-metadata.json', 'pixel-snapper-tool-manifest.json'
];

function publicMetadata() {
  return { schemaVersion: 1, releaseTag: RELEASE_TAG, assets: PUBLIC_ASSET_NAMES.map((name) => ({ name, sha256: H('a'), size: 1 })) };
}

function fakeStreamResponse({ chunks, contentLength = null, contentEncoding = null, state = {} }) {
  let index = 0;
  return {
    status: 200,
    ok: true,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-length') return contentLength;
        if (name.toLowerCase() === 'content-encoding') return contentEncoding;
        return null;
      }
    },
    body: {
      getReader() {
        state.readerCreated = (state.readerCreated ?? 0) + 1;
        return {
          async read() {
            state.reads = (state.reads ?? 0) + 1;
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          async cancel() { state.cancelled = true; }
        };
      }
    },
    async arrayBuffer() {
      state.arrayBufferCalled = true;
      return Buffer.concat(chunks).buffer;
    }
  };
}

function record(target, rustTarget, archiveFormat) {
  const executable = target === 'windows-x64' ? 'spritefusion-pixel-snapper.exe' : 'spritefusion-pixel-snapper';
  return {
    schemaVersion: 1,
    target,
    rustTarget,
    archive: { name: `pixel-snapper-${target}.${archiveFormat === 'zip' ? 'zip' : 'tar.gz'}`, format: archiveFormat, sha256: hash(`archive-${target}`), size: 100 + target.length },
    executable: { name: executable, sha256: hash(`exe-${target}`), size: 50 + target.length },
    upstream: { repository: 'Hugo-Dz/spritefusion-pixel-snapper', tag: 'v1.0.0', version: '1.0.0', commit: UPSTREAM },
    build: { workflowCommit: WORKFLOW, rustVersion: '1.88.0', cargoVersion: 'cargo 1.88.0', cargoLockSha256: H('a'), cargoSbomVersion: '0.10.0', cargoAboutVersion: '0.8.4', binaryVersion: 'spritefusion-pixel-snapper 1.0.0', helpSha256: H('3') },
    fixture: { inputRgbaSha256: FIXTURE_HASH, rgbaSha256: FIXTURE_HASH, width: 3, height: 3, paletteSha256: PALETTE_HASH },
    files: {
      license: { name: 'LICENSE-Pixel-Snapper', sha256: H('e'), size: 1071 },
      notices: { name: 'THIRD-PARTY-NOTICES', sha256: H('f'), size: 811 },
      sbom: { name: 'pixel-snapper.spdx.json', sha256: H('1'), size: 701 },
      metadata: { name: 'target-metadata.json', sha256: H('2'), size: 601 }
    }
  };
}

function fiveRecords() {
  return TARGETS.map(([target, rustTarget, format]) => record(target, rustTarget, format));
}

test('release assembly rejects a missing native target or mismatched fixture pixels', async () => {
  await assert.rejects(assembleRelease({ inputs: fiveRecords().slice(0, 4), releaseTag: RELEASE_TAG }), /missing release target: linux-arm64/);
  const changed = fiveRecords();
  changed[4].fixture.rgbaSha256 = H('9');
  await assert.rejects(assembleRelease({ inputs: changed, releaseTag: RELEASE_TAG }), /fixture (?:RGBA hash|approved identity) mismatch: linux-arm64/);
});

test('release assembly emits a closed manifest with full commits and exact portable targets', async () => {
  const result = await assembleRelease({ inputs: fiveRecords(), releaseTag: RELEASE_TAG });
  assert.match(result.manifest.upstream.commit, /^[a-f0-9]{40}$/);
  assert.match(result.manifest.build.workflowCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(result.manifest.assets), TARGETS.map(([target]) => target));
  assert.equal(result.manifest.release.tag, RELEASE_TAG);
  await assert.rejects(assembleRelease({ inputs: [...fiveRecords(), { ...fiveRecords()[0], target: 'freebsd-x64' }], releaseTag: RELEASE_TAG }), /unexpected release target/);
  const unknown = fiveRecords(); unknown[0].surprise = true;
  await assert.rejects(assembleRelease({ inputs: unknown, releaseTag: RELEASE_TAG }), /closed schema/);
  const collision = fiveRecords(); collision[1].archive.name = collision[0].archive.name.toUpperCase();
  await assert.rejects(assembleRelease({ inputs: collision, releaseTag: RELEASE_TAG }), /archive identity mismatch|portable asset name collision/);
});

test('assembly binds identical upstream, lock, workflow, toolchain and fixture identities', async () => {
  for (const [field, value, pattern] of [
    ['upstream.commit', 'f'.repeat(40), /upstream identity mismatch/],
    ['build.workflowCommit', 'f'.repeat(40), /workflow identity mismatch/],
    ['build.cargoLockSha256', H('8'), /lockfile identity mismatch/],
    ['build.cargoVersion', 'cargo 1.88.0 (different)', /toolchain identity mismatch/],
    ['fixture.inputRgbaSha256', H('7'), /fixture approved identity mismatch|fixture input hash mismatch/]
  ]) {
    const values = fiveRecords();
    const [parent, child] = field.split('.'); values[2][parent][child] = value;
    await assert.rejects(assembleRelease({ inputs: values, releaseTag: RELEASE_TAG }), pattern);
  }
  const badTag = fiveRecords(); badTag[0].upstream.commit = 'abc';
  await assert.rejects(assembleRelease({ inputs: badTag, releaseTag: RELEASE_TAG }), /full 40-character/);
  await assert.rejects(assembleRelease({ inputs: fiveRecords(), releaseTag: 'pixel-snapper-v1.0.0-commit.fffffff' }), /release tag commit suffix/);
});

test('packager rejects unsafe inputs and writes an atomic five-file archive artifact', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-package-'));
  const files = {};
  for (const [key, name, body] of [
    ['binaryFile', 'spritefusion-pixel-snapper', 'binary'],
    ['licenseFile', 'LICENSE', 'license'],
    ['noticesFile', 'notices', 'notices'],
    ['sbomFile', 'sbom.json', '{"spdxVersion":"SPDX-2.3"}']
  ]) { files[key] = path.join(dir, name); await fs.writeFile(files[key], body, { mode: key === 'binaryFile' ? 0o755 : 0o644 }); }
  const outputDir = path.join(dir, 'out');
  const result = await packagePixelSnapper({
    target: 'linux-x64', rustTarget: 'x86_64-unknown-linux-musl', outputDir, ...files,
    upstream: { repository: 'Hugo-Dz/spritefusion-pixel-snapper', tag: 'v1.0.0', version: '1.0.0', commit: UPSTREAM },
    build: { workflowCommit: WORKFLOW, rustVersion: '1.88.0', cargoVersion: 'cargo 1.88.0', cargoLockSha256: H('a'), cargoSbomVersion: '0.10.0', cargoAboutVersion: '0.8.4', binaryVersion: 'spritefusion-pixel-snapper 1.0.0', helpSha256: H('3') },
    fixture: { inputRgbaSha256: FIXTURE_HASH, rgbaSha256: FIXTURE_HASH, expectedRgbaSha256: FIXTURE_HASH, width: 3, height: 3, paletteSha256: PALETTE_HASH }
  });
  assert.equal(result.archiveEntries.length, 5);
  assert.deepEqual(result.archiveEntries.sort(), ['LICENSE-Pixel-Snapper', 'THIRD-PARTY-NOTICES', 'pixel-snapper.spdx.json', 'spritefusion-pixel-snapper', 'target-metadata.json'].sort());
  assert.deepEqual((await fs.readdir(outputDir)).sort(), [result.record.archive.name, 'target-release-record.json', ...result.archiveEntries].sort());
  await assert.rejects(fs.access(`${outputDir}.stage`), { code: 'ENOENT' });

  const linked = path.join(dir, 'linked-license');
  await fs.symlink(files.licenseFile, linked);
  await assert.rejects(packagePixelSnapper({ target: 'linux-x64', rustTarget: 'x86_64-unknown-linux-musl', outputDir: path.join(dir, 'bad'), ...files, licenseFile: linked, upstream: result.record.upstream, build: result.record.build, fixture: { ...result.record.fixture, expectedRgbaSha256: result.record.fixture.rgbaSha256 } }), /regular non-link file/);
});

test('native fixture probe uses the approved source-compatible 3x3 pixels', { skip: process.platform === 'win32' && 'POSIX executable fixture' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-native-probe-'));
  const binaryFile = path.join(dir, 'spritefusion-pixel-snapper');
  await fs.writeFile(binaryFile, `#!/usr/bin/env node
import fs from 'node:fs';
const [input, output] = process.argv.slice(2);
if (input === '--version') console.log('spritefusion-pixel-snapper 1.0.0');
else if (input === '--help') console.log('USAGE: spritefusion-pixel-snapper INPUT OUTPUT');
else fs.copyFileSync(input, output);
`, { mode: 0o755 });
  const result = await probeNativePixelSnapper({ binaryFile, upstreamVersion: '1.0.0', expectedInputRgbaSha256: FIXTURE_HASH, expectedRgbaSha256: FIXTURE_HASH });
  assert.deepEqual([result.fixture.width, result.fixture.height], [3, 3]);
  assert.equal(result.fixture.paletteSha256, PALETTE_HASH);
});

test('release verifier rejects traversal, symlink ambiguity and changed public bytes', async () => {
  await assert.rejects(verifyRelease({ metadata: { schemaVersion: 1, releaseTag: RELEASE_TAG, assets: [{ name: '../escape', sha256: H('a'), size: 1 }] }, fetchImpl: async () => new Response('x') }), /portable release filename/);
  const metadata = publicMetadata();
  await assert.rejects(verifyRelease({ metadata, fetchImpl: async (url) => new Response(url.pathname.endsWith('/checksums.json') ? JSON.stringify(metadata) : 'x') }), /public release asset hash mismatch/);
});

test('release verifier cancels a chunked body immediately when its cumulative bytes exceed the hard limit', async () => {
  const state = {};
  const response = fakeStreamResponse({ chunks: [Buffer.alloc(PUBLIC_BODY_LIMIT), Buffer.from([1]), Buffer.from([2])], state });
  await assert.rejects(verifyRelease({ metadata: publicMetadata(), fetchImpl: async () => response }), /public release asset exceeded size limit: checksums\.json/);
  assert.equal(state.cancelled, true);
  assert.equal(state.reads, 2);
  assert.equal(state.arrayBufferCalled, undefined);
});

test('release verifier rejects oversized, invalid, and dishonest Content-Length values safely', async () => {
  for (const [contentLength, chunks, pattern, shouldCancel, contentEncoding] of [
    [String(PUBLIC_BODY_LIMIT + 1), [Buffer.from('{}')], /declared Content-Length exceeded size limit/, false, null],
    [String(PUBLIC_BODY_LIMIT + 1), [Buffer.from('{}')], /declared Content-Length exceeded size limit/, false, 'gzip'],
    ['not-a-number', [Buffer.from('{}')], /invalid Content-Length/, false, null],
    ['1', [Buffer.from('{}')], /Content-Length mismatch/, true, 'identity']
  ]) {
    const state = {};
    const response = fakeStreamResponse({ chunks, contentLength, contentEncoding, state });
    await assert.rejects(verifyRelease({ metadata: publicMetadata(), fetchImpl: async () => response }), pattern);
    assert.equal(state.cancelled === true, shouldCancel);
    assert.equal(state.arrayBufferCalled, undefined);
    if (!shouldCancel) assert.equal(state.readerCreated, undefined);
  }
});

test('release verifier accepts an exact-limit streamed body before continuing verification', async () => {
  const metadata = publicMetadata();
  const serialized = Buffer.from(JSON.stringify(metadata));
  const exact = Buffer.alloc(PUBLIC_BODY_LIMIT, 0x20);
  serialized.copy(exact);
  let calls = 0;
  await assert.rejects(verifyRelease({
    metadata,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return fakeStreamResponse({ chunks: [exact], contentLength: String(PUBLIC_BODY_LIMIT) });
      throw new Error('exact-limit body accepted');
    }
  }), /exact-limit body accepted/);
  assert.equal(calls, 2);
});

test('release verifier requests identity encoding on every manual redirect and final fetch', async () => {
  const requests = [];
  await assert.rejects(verifyRelease({
    metadata: publicMetadata(),
    fetchImpl: async (url, init) => {
      requests.push({ url: url.href, init });
      if (requests.length === 1) return {
        status: 302,
        ok: false,
        headers: { get: (name) => name.toLowerCase() === 'location' ? 'https://release-assets.githubusercontent.com/github-production-release-asset/1/checksums.json' : null }
      };
      return fakeStreamResponse({ chunks: [Buffer.from('{}')] });
    }
  }), /public checksums metadata mismatch/);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.init.redirect, 'manual');
    assert.equal(request.init.headers['Accept-Encoding'], 'identity');
  }
});

test('release verifier ignores compressed wire length after fetch decodes an allowed encoded body', async () => {
  const metadata = publicMetadata();
  const decoded = Buffer.from(JSON.stringify(metadata));
  let calls = 0;
  await assert.rejects(verifyRelease({
    metadata,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return fakeStreamResponse({ chunks: [decoded], contentLength: '17', contentEncoding: 'gzip' });
      throw new Error('encoded body accepted');
    }
  }), /encoded body accepted/);
  assert.equal(calls, 2);
});

test('release verifier still cancels decoded overflow when the response is encoded', async () => {
  const state = {};
  const response = fakeStreamResponse({
    chunks: [Buffer.alloc(PUBLIC_BODY_LIMIT), Buffer.from([1]), Buffer.from([2])],
    contentLength: '17',
    contentEncoding: 'gzip',
    state
  });
  await assert.rejects(verifyRelease({ metadata: publicMetadata(), fetchImpl: async () => response }), /public release asset exceeded size limit: checksums\.json/);
  assert.equal(state.cancelled, true);
  assert.equal(state.reads, 2);
});

test('release verifier rejects malformed or unsupported Content-Encoding before reading', async () => {
  for (const [contentEncoding, pattern] of [['gzip, br', /invalid Content-Encoding/], ['compress', /unsupported Content-Encoding/]]) {
    const state = {};
    const response = fakeStreamResponse({ chunks: [Buffer.from('{}')], contentEncoding, state });
    await assert.rejects(verifyRelease({ metadata: publicMetadata(), fetchImpl: async () => response }), pattern);
    assert.equal(state.readerCreated, undefined);
    assert.equal(state.arrayBufferCalled, undefined);
  }
});

test('cargo-sbom normalization removes volatile time and UUID while retaining locked content', () => {
  const first = {
    SPDXID: 'SPDXRef-DOCUMENT', spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0',
    documentNamespace: 'https://example.invalid/random-one',
    creationInfo: { created: '2026-07-18T01:02:03Z', creators: ['Tool: cargo-sbom-v0.10.0'] },
    packages: [{ SPDXID: 'SPDXRef-Package-a', name: 'a', versionInfo: '1.0.0' }]
  };
  const second = structuredClone(first);
  second.documentNamespace = 'https://example.invalid/random-two';
  second.creationInfo.created = '2030-01-01T00:00:00Z';
  const options = { upstreamCommit: UPSTREAM, cargoLockSha256: H('a') };
  assert.equal(normalizeComplianceSbom(first, options), normalizeComplianceSbom(second, options));
  const normalized = JSON.parse(normalizeComplianceSbom(first, options));
  assert.equal(normalized.creationInfo.created, '1970-01-01T00:00:00Z');
  assert.equal(normalized.documentNamespace, `https://github.com/Hugo-Dz/spritefusion-pixel-snapper/sbom/${UPSTREAM}/${H('a')}`);
  second.packages[0].versionInfo = '2.0.0';
  assert.notEqual(normalizeComplianceSbom(first, options), normalizeComplianceSbom(second, options));
  assert.throws(() => normalizeComplianceSbom({ ...first, surprise: true }, options), /closed SPDX schema/);
});

test('assembly rejects compliance drift between native targets', async () => {
  for (const [field, pattern] of [['notices', /notices mismatch/], ['sbom', /SBOM mismatch/]]) {
    const values = fiveRecords();
    values[3].files[field].sha256 = H('8');
    await assert.rejects(assembleRelease({ inputs: values, releaseTag: RELEASE_TAG }), pattern);
  }
});

test('five packaged native artifacts assemble atomically and verify as exact public bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-five-target-'));
  const inputDir = path.join(dir, 'inputs');
  await fs.mkdir(inputDir);
  const shared = {};
  for (const [key, name, body] of [
    ['licenseFile', 'LICENSE', 'approved license'],
    ['noticesFile', 'notices', 'locked notices'],
    ['sbomFile', 'sbom.json', '{"spdxVersion":"SPDX-2.3"}']
  ]) { shared[key] = path.join(dir, name); await fs.writeFile(shared[key], body); }
  const packaged = [];
  for (const [target, rustTarget] of TARGETS) {
    const artifact = path.join(inputDir, `pixel-snapper-build-${target}`);
    const binaryFile = path.join(dir, target === 'windows-x64' ? `bin-${target}.exe` : `bin-${target}`);
    await fs.writeFile(binaryFile, `native-${target}`, { mode: 0o755 });
    const expectedBinaryName = target === 'windows-x64' ? 'spritefusion-pixel-snapper.exe' : 'spritefusion-pixel-snapper';
    const namedBinary = path.join(dir, `${target}-${expectedBinaryName}`);
    await fs.rename(binaryFile, namedBinary);
    // The packager deliberately requires the actual native basename.
    const canonicalBinary = path.join(dir, target, expectedBinaryName);
    await fs.mkdir(path.dirname(canonicalBinary)); await fs.rename(namedBinary, canonicalBinary);
    packaged.push(await packagePixelSnapper({
      target, rustTarget, outputDir: artifact, binaryFile: canonicalBinary, ...shared,
      upstream: record(target, rustTarget, target === 'windows-x64' ? 'zip' : 'tar.gz').upstream,
      build: record(target, rustTarget, target === 'windows-x64' ? 'zip' : 'tar.gz').build,
      fixture: { ...record(target, rustTarget, target === 'windows-x64' ? 'zip' : 'tar.gz').fixture, expectedRgbaSha256: FIXTURE_HASH }
    }));
  }
  const outputDir = path.join(dir, 'release');
  const result = await assembleRelease({ inputDir, outputDir, releaseTag: RELEASE_TAG });
  validateToolManifest(result.manifest);
  assert.equal(result.checksums.assets.length, 10);
  assert.deepEqual((await fs.readdir(outputDir)).sort(), [
    ...packaged.map((value) => value.record.archive.name), 'LICENSE-Pixel-Snapper', 'THIRD-PARTY-NOTICES',
    'pixel-snapper.spdx.json', 'build-metadata.json', 'pixel-snapper-tool-manifest.json', 'checksums.json'
  ].sort());
  const verified = await verifyRelease({
    metadata: result.checksums,
    fetchImpl: async (url) => new Response(await fs.readFile(path.join(outputDir, decodeURIComponent(path.posix.basename(url.pathname)))))
  });
  assert.equal(verified.verified.length, 10);

  const publicBytes = new Map();
  for (const name of await fs.readdir(outputDir)) publicBytes.set(name, await fs.readFile(path.join(outputDir, name)));
  const forgedBuild = JSON.parse(publicBytes.get('build-metadata.json'));
  forgedBuild.targets[0].upstream.commit = 'f'.repeat(40);
  publicBytes.set('build-metadata.json', Buffer.from(`${JSON.stringify(forgedBuild)}\n`));
  const forgedChecksums = JSON.parse(publicBytes.get('checksums.json'));
  const buildDescriptor = forgedChecksums.assets.find(({ name }) => name === 'build-metadata.json');
  buildDescriptor.size = publicBytes.get('build-metadata.json').length;
  buildDescriptor.sha256 = hash(publicBytes.get('build-metadata.json'));
  publicBytes.set('checksums.json', Buffer.from(`${JSON.stringify(forgedChecksums)}\n`));
  await assert.rejects(verifyRelease({
    metadata: forgedChecksums,
    fetchImpl: async (url) => new Response(publicBytes.get(decodeURIComponent(path.posix.basename(url.pathname))))
  }), /public build metadata|upstream identity mismatch|tool manifest/i);

  const archiveForgery = new Map();
  for (const name of await fs.readdir(outputDir)) archiveForgery.set(name, await fs.readFile(path.join(outputDir, name)));
  const forgedArchive = Buffer.from('not a ZIP archive');
  archiveForgery.set('pixel-snapper-windows-x64.zip', forgedArchive);
  const archiveBuild = JSON.parse(archiveForgery.get('build-metadata.json'));
  archiveBuild.targets[0].archive.size = forgedArchive.length;
  archiveBuild.targets[0].archive.sha256 = hash(forgedArchive);
  archiveForgery.set('build-metadata.json', Buffer.from(`${JSON.stringify(archiveBuild)}\n`));
  const archiveManifest = JSON.parse(archiveForgery.get('pixel-snapper-tool-manifest.json'));
  archiveManifest.assets['windows-x64'].archiveSize = forgedArchive.length;
  archiveManifest.assets['windows-x64'].archiveSha256 = hash(forgedArchive);
  archiveForgery.set('pixel-snapper-tool-manifest.json', Buffer.from(`${JSON.stringify(archiveManifest)}\n`));
  const archiveChecksums = JSON.parse(archiveForgery.get('checksums.json'));
  for (const name of ['pixel-snapper-windows-x64.zip', 'build-metadata.json', 'pixel-snapper-tool-manifest.json']) {
    const descriptor = archiveChecksums.assets.find((entry) => entry.name === name);
    descriptor.size = archiveForgery.get(name).length;
    descriptor.sha256 = hash(archiveForgery.get(name));
  }
  archiveForgery.set('checksums.json', Buffer.from(`${JSON.stringify(archiveChecksums)}\n`));
  await assert.rejects(verifyRelease({
    metadata: archiveChecksums,
    fetchImpl: async (url) => new Response(archiveForgery.get(decodeURIComponent(path.posix.basename(url.pathname))))
  }), /invalid ZIP archive/);

  await fs.appendFile(path.join(inputDir, 'pixel-snapper-build-linux-arm64', packaged.at(-1).record.archive.name), 'tampered');
  await assert.rejects(assembleRelease({ inputDir, outputDir: path.join(dir, 'bad-release'), releaseTag: RELEASE_TAG }), /hash or size mismatch/);
  await assert.rejects(fs.access(path.join(dir, 'bad-release')), { code: 'ENOENT' });
});

test('workflow policy is pinned, least-privileged, native, locked and publish never executes binaries', async () => {
  const workflowFile = path.join(ROOT, '.github', 'workflows', 'pixel-snapper-release.yml');
  const source = await fs.readFile(workflowFile, 'utf8');
  const doc = YAML.parse(source);
  assert.deepEqual(doc.permissions, { contents: 'read' });
  assert.deepEqual(doc.jobs.build.permissions, { contents: 'read' });
  assert.deepEqual(doc.jobs.publish.permissions, { contents: 'write' });
  assert.deepEqual(doc.jobs.compliance.permissions, { contents: 'read' });
  assert.equal(doc.on.workflow_dispatch.inputs.immutable_releases_confirmed.type, 'boolean');
  assert.deepEqual(doc.jobs.build.strategy.matrix.include, TARGETS.map(([key, target], index) => ({ key, os: ['windows-2025', 'macos-15-intel', 'macos-15', 'ubuntu-24.04', 'ubuntu-24.04-arm'][index], target })));
  const pins = [...source.matchAll(/uses:\s*([^\s]+)/g)].map((match) => match[1]);
  assert.ok(pins.length >= 5);
  assert.ok(pins.every((pin) => [
    'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093'
  ].includes(pin)));
  for (const required of ['rustup toolchain install 1.88.0', 'cargo build --locked --release --target', 'cargo-sbom@0.10.0', 'cargo-about@0.8.4', 'rev-parse', '08c1323a65243400a4a6ce7ac0051ad116e39869f3276630c2a16a02cc2e05b4', 'Image too small (minimum 3x3)', 'immutable_releases_confirmed', '--json isImmutable', 'gh release create', 'verify-release.mjs', 'normalize-compliance.mjs']) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(source, /X-GitHub-Api-Version: 2026-03-10/);
  assert.match(source, /needs:\s*compliance/);
  assert.match(source, /pixel-snapper-compliance/);
  assert.equal([...source.matchAll(/secrets\.IMMUTABLE_RELEASES_TOKEN/g)].length, 1);
  assert.doesNotMatch(source.slice(source.indexOf('\n  build:'), source.indexOf('\n  publish:')), /cargo sbom|cargo about generate/);
  const publish = source.slice(source.indexOf('\n  publish:'));
  assert.doesNotMatch(publish, /--version|--help|target[/\\]release|spritefusion-pixel-snapper(?:\.exe)?/);
  assert.match(source, /upstream_commit:[\s\S]*release_tag:/);
  const license = await fs.readFile(path.join(ROOT, 'skills/pixel-sprite-animation-pipeline/references/pixel-snapper-upstream.LICENSE'));
  assert.equal(license.length, 1075);
  assert.notEqual(license.at(-1), 10);
  const attributes = await fs.readFile(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attributes, /^skills\/pixel-sprite-animation-pipeline\/references\/pixel-snapper-upstream\.LICENSE -text$/m);
});

test('release workflow verifies committed license bytes independent of checkout line endings', async () => {
  const workflowFile = path.join(ROOT, '.github', 'workflows', 'pixel-snapper-release.yml');
  const source = await fs.readFile(workflowFile, 'utf8');
  const referencePath = 'skills/pixel-sprite-animation-pipeline/references/pixel-snapper-upstream.LICENSE';

  assert.doesNotMatch(source, /cmp upstream\/LICENSE/);
  assert.match(source, /git -C upstream rev-parse "\$\{UPSTREAM_COMMIT\}:LICENSE"/);
  assert.match(source, new RegExp(`git -C release-tools rev-parse "HEAD:${referencePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('release workflow isolates Cargo hardlinks before native probes and packaging', async () => {
  const workflowFile = path.join(ROOT, '.github', 'workflows', 'pixel-snapper-release.yml');
  const source = await fs.readFile(workflowFile, 'utf8');

  assert.match(source, /const cargoBinary = path\.join\("upstream", "target", process\.env\.RUST_TARGET, "release"/);
  assert.match(source, /const isolatedBinary = path\.join\("native-input", executableName\)/);
  assert.match(source, /fs\.copyFileSync\(cargoBinary, isolatedBinary, fs\.constants\.COPYFILE_EXCL\)/);
  assert.match(source, /if \(!windows\) fs\.chmodSync\(isolatedBinary, 0o755\)/);
  assert.match(source, /binaryFile: isolatedBinary/);
});

test('approved release documents pin immutable v1.0.0 commit and retain the former README-only commit only as history', async () => {
  const approvedCommit = '5743009265051098831ad7298092072325d1149b';
  const releaseTag = 'pixel-snapper-v1.0.0-commit.5743009';
  const formerReviewedCommit = 'a' + 'e20461f60fb39e75d15f184bab1ebec1219511c';
  const obsoleteReleaseTag = ['pixel-snapper', 'v1.0.0', `commit.${'a' + 'e20461'}`].join('-');
  const files = [
    'docs/superpowers/specs/2026-07-18-pixel-snapper-binary-integration-design.md',
    'docs/superpowers/plans/2026-07-18-pixel-snapper-binary-integration.md',
    'skills/pixel-sprite-animation-pipeline/references/pixel-snapper-release-checklist.md'
  ];
  for (const file of files) {
    const source = await fs.readFile(path.join(ROOT, file), 'utf8');
    assert.match(source, new RegExp(approvedCommit));
    assert.match(source, new RegExp(releaseTag));
    assert.doesNotMatch(source, new RegExp(obsoleteReleaseTag));
    for (const line of source.split(/\\r?\\n/).filter((candidate) => candidate.includes(formerReviewedCommit))) {
      assert.match(line, /historical context, not the release pin/i);
    }
  }
});
