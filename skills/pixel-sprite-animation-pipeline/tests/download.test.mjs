import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { downloadPinnedAsset } from '../scripts/lib/download.mjs';

const URL = 'https://github.com/otto-agent007/GameDevStuff/releases/download/pixel-snapper-v1.2.3-commit.0123456/pixel-snapper-windows-x64.zip';
const UPSTREAM_COMMIT = `0123456${'a'.repeat(33)}`;

function response({ status = 200, body = Buffer.from('pixel-snapper'), location, ok = status >= 200 && status < 300 } = {}) {
  return {
    status,
    ok,
    body: body === null ? null : Readable.from(Array.isArray(body) ? body : [body]),
    headers: { get: (name) => name.toLowerCase() === 'location' ? location ?? null : null }
  };
}

function scriptedFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.ok(responses.length > 0, 'unexpected fetch call');
    return responses.shift();
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function requestFor(bytes = Buffer.from('pixel-snapper')) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-snapper-download-'));
  return {
    directory,
    request: {
      url: URL,
      upstreamCommit: UPSTREAM_COMMIT,
      expectedSize: bytes.length,
      expectedSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      output: path.join(directory, 'tool.zip')
    }
  };
}

test('download streams a pinned asset with manual redirects and restrictive permissions', async () => {
  const bytes = Buffer.from('verified archive');
  const { request } = await requestFor(bytes);
  const redirected = 'https://release-assets.githubusercontent.com/github-production-release-asset/12345/tool.zip?sp=opaque';
  const fetchImpl = scriptedFetch([
    response({ status: 302, location: redirected, body: null }),
    response({ body: [bytes.subarray(0, 4), bytes.subarray(4)] })
  ]);

  const result = await downloadPinnedAsset({ ...request, fetchImpl });

  assert.deepEqual(result, { output: request.output, size: bytes.length, sha256: request.expectedSha256 });
  assert.deepEqual(await fs.readFile(request.output), bytes);
  if (process.platform !== 'win32') assert.equal((await fs.stat(request.output)).mode & 0o777, 0o600);
  assert.deepEqual(fetchImpl.calls.map(({ options }) => options), [{ redirect: 'manual' }, { redirect: 'manual' }]);
});

test('download rejects downgrade and foreign redirect hosts before creating output', async () => {
  for (const location of [
    'http://release-assets.githubusercontent.com/tool.zip',
    'https://evil.example/tool.zip',
    'https://release-assets.githubusercontent.com.evil.example/tool.zip'
  ]) {
    const { directory, request } = await requestFor();
    const fetchImpl = scriptedFetch([response({ status: 302, location, body: null })]);
    await assert.rejects(downloadPinnedAsset({ ...request, fetchImpl }), /unsafe Pixel Snapper redirect/);
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('download rejects unsafe initial URLs and excessive redirects without creating output', async () => {
  const { directory, request } = await requestFor();
  await assert.rejects(downloadPinnedAsset({ ...request, url: 'https://example.com/tool.zip', fetchImpl: scriptedFetch([]) }), /unsafe Pixel Snapper download URL/);
  assert.deepEqual(await fs.readdir(directory), []);

  const redirects = Array.from({ length: 4 }, (_, index) => response({
    status: 302,
    location: `https://release-assets.githubusercontent.com/github-production-release-asset/12345/tool-${index}.zip`,
    body: null
  }));
  await assert.rejects(downloadPinnedAsset({ ...request, fetchImpl: scriptedFetch(redirects) }), /redirect limit exceeded/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('download binds the release tag to a separately validated full upstream commit before fetch', async () => {
  for (const [upstreamCommit, error] of [
    [undefined, /invalid pinned Pixel Snapper upstream commit/],
    ['0123456', /invalid pinned Pixel Snapper upstream commit/],
    [`7654321${'a'.repeat(33)}`, /release revision mismatch/]
  ]) {
    const { directory, request } = await requestFor();
    const fetchImpl = scriptedFetch([]);
    await assert.rejects(downloadPinnedAsset({ ...request, upstreamCommit, fetchImpl }), error);
    assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('download removes partial output when pinned size, hard size, or checksum validation fails', async () => {
  const cases = [
    { bytes: Buffer.from('too long'), expectedSize: 3, expectedSha256: '0'.repeat(64), error: /exceeded pinned size/ },
    { bytes: Buffer.from('short'), expectedSize: 6, expectedSha256: '0'.repeat(64), error: /size or checksum mismatch/ },
    { bytes: Buffer.from('wrong hash'), expectedSize: 10, expectedSha256: '0'.repeat(64), error: /size or checksum mismatch/ },
    { bytes: Buffer.alloc((25 * 1024 * 1024) + 1), expectedSize: (25 * 1024 * 1024) + 1, expectedSha256: '0'.repeat(64), error: /exceeded maximum size/ }
  ];
  for (const item of cases) {
    const { directory, request } = await requestFor();
    await assert.rejects(downloadPinnedAsset({
      ...request,
      expectedSize: item.expectedSize,
      expectedSha256: item.expectedSha256,
      fetchImpl: scriptedFetch([response({ body: item.bytes })])
    }), item.error);
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('download rejects HTTP failures and absent bodies without creating output', async () => {
  for (const failed of [response({ status: 404, body: null }), response({ status: 200, body: null })]) {
    const { directory, request } = await requestFor();
    await assert.rejects(downloadPinnedAsset({ ...request, fetchImpl: scriptedFetch([failed]) }), /download failed/);
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('download exposes a stable missing-release code for HTTP 404', async () => {
  const fixture = await requestFor();
  const fetchImpl = async () => ({ status: 404, ok: false, headers: { get: () => null }, body: null });
  await assert.rejects(downloadPinnedAsset({ ...fixture.request, fetchImpl }), (error) => {
    assert.equal(error.code, 'PIXEL_SNAPPER_RELEASE_NOT_FOUND');
    assert.match(error.message, /release.*not found/i);
    return true;
  });
});

test('download never overwrites an existing output', async () => {
  const bytes = Buffer.from('verified archive');
  const { request } = await requestFor(bytes);
  await fs.writeFile(request.output, 'existing');
  await assert.rejects(downloadPinnedAsset({ ...request, fetchImpl: scriptedFetch([response({ body: bytes })]) }), /EEXIST/);
  assert.equal(await fs.readFile(request.output, 'utf8'), 'existing');
});
