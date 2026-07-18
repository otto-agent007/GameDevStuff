import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closed, hashBytes, hashValue, parseCli, portableName, safeInteger, stableJson } from './release-common.mjs';
import { assembleRelease, inspectReleaseArchive, validateReleaseRecord } from './assemble-release.mjs';

const REQUIRED_ASSETS = Object.freeze([
  'pixel-snapper-windows-x64.zip',
  'pixel-snapper-macos-x64.tar.gz',
  'pixel-snapper-macos-arm64.tar.gz',
  'pixel-snapper-linux-x64.tar.gz',
  'pixel-snapper-linux-arm64.tar.gz',
  'LICENSE-Pixel-Snapper',
  'THIRD-PARTY-NOTICES',
  'pixel-snapper.spdx.json',
  'build-metadata.json',
  'pixel-snapper-tool-manifest.json'
]);
const MAX_PUBLIC_ASSET_BYTES = 25 * 1024 * 1024;
const ALLOWED_CONTENT_ENCODINGS = new Set(['identity', 'gzip', 'deflate', 'br']);

function validateMetadata(metadata) {
  closed(metadata, ['schemaVersion', 'releaseTag', 'assets'], 'release checksum metadata');
  if (metadata.schemaVersion !== 1 || !/^pixel-snapper-v\d+\.\d+\.\d+-commit\.[a-f0-9]{7}$/.test(metadata.releaseTag)) throw new Error('invalid release checksum metadata');
  if (!Array.isArray(metadata.assets) || metadata.assets.length === 0) throw new Error('release checksum assets are required');
  const names = new Set();
  for (const asset of metadata.assets) {
    closed(asset, ['name', 'sha256', 'size'], 'release checksum asset');
    portableName(asset.name); hashValue(asset.sha256, `${asset.name} hash`); safeInteger(asset.size, `${asset.name} size`);
    const folded = asset.name.normalize('NFC').toLowerCase();
    if (names.has(folded)) throw new Error('portable release filename collision');
    names.add(folded);
  }
  if (names.size !== REQUIRED_ASSETS.length || REQUIRED_ASSETS.some((name) => !names.has(name.toLowerCase()))) throw new Error('public release exact asset set mismatch');
  return metadata;
}

async function fetchPublicAsset({ name, root, fetchImpl }) {
  const url = new URL(encodeURIComponent(name), root);
  let current = url;
  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetchImpl(current, { redirect: 'manual', headers: { 'Accept-Encoding': 'identity' } });
    if (![301, 302, 303, 307, 308].includes(response?.status)) break;
    if (redirects === 3) throw new Error(`public release redirect limit exceeded: ${name}`);
    const location = response.headers?.get?.('location');
    if (!location) throw new Error(`unsafe public release redirect: ${name}`);
    const next = new URL(location, current);
    const githubSamePath = next.hostname === 'github.com' && next.pathname === url.pathname && !next.search;
    const releaseAsset = next.hostname === 'release-assets.githubusercontent.com' && next.pathname.startsWith('/github-production-release-asset/');
    if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hash || (!githubSamePath && !releaseAsset)) throw new Error(`unsafe public release redirect: ${name}`);
    current = next;
  }
  if (!response?.ok) throw new Error(`public release asset unavailable: ${name}`);
  const rawEncoding = response.headers?.get?.('content-encoding');
  let contentEncoding = 'identity';
  if (rawEncoding !== null && rawEncoding !== undefined) {
    contentEncoding = rawEncoding.trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(contentEncoding)) throw new Error(`public release asset has invalid Content-Encoding: ${name}`);
    if (!ALLOWED_CONTENT_ENCODINGS.has(contentEncoding)) throw new Error(`public release asset has unsupported Content-Encoding: ${name}`);
  }
  const rawLength = response.headers?.get?.('content-length');
  let declaredLength = null;
  if (rawLength !== null && rawLength !== undefined) {
    if (!/^\d+$/.test(rawLength)) throw new Error(`public release asset has invalid Content-Length: ${name}`);
    const parsed = BigInt(rawLength);
    if (parsed > BigInt(MAX_PUBLIC_ASSET_BYTES)) throw new Error(`public release asset declared Content-Length exceeded size limit: ${name}`);
    if (contentEncoding === 'identity') {
      declaredLength = Number(parsed);
    }
  }
  if (!response.body && declaredLength === 0) return { bytes: Buffer.alloc(0), url };
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error(`public release asset body unavailable: ${name}`);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      try { await reader.cancel(); } catch {}
      throw new Error(`public release asset body is invalid: ${name}`);
    }
    const next = total + value.byteLength;
    if (next > MAX_PUBLIC_ASSET_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error(`public release asset exceeded size limit: ${name}`);
    }
    if (declaredLength !== null && next > declaredLength) {
      try { await reader.cancel(); } catch {}
      throw new Error(`public release asset Content-Length mismatch: ${name}`);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    total = next;
  }
  if (declaredLength !== null && total !== declaredLength) throw new Error(`public release asset Content-Length mismatch: ${name}`);
  const bytes = Buffer.concat(chunks, total);
  return { bytes, url };
}

export async function verifyRelease({ metadata, fetchImpl = globalThis.fetch, baseUrl }) {
  const checked = validateMetadata(structuredClone(metadata));
  const root = baseUrl ?? `https://github.com/otto-agent007/GameDevStuff/releases/download/${checked.releaseTag}/`;
  const parsedRoot = new URL(root);
  const expectedPath = `/otto-agent007/GameDevStuff/releases/download/${checked.releaseTag}/`;
  if (parsedRoot.protocol !== 'https:' || parsedRoot.hostname !== 'github.com' || parsedRoot.username || parsedRoot.password || parsedRoot.port || parsedRoot.search || parsedRoot.hash || parsedRoot.pathname !== expectedPath) throw new Error('invalid immutable release base URL');
  const publicChecksums = await fetchPublicAsset({ name: 'checksums.json', root: parsedRoot, fetchImpl });
  let publishedMetadata;
  try { publishedMetadata = JSON.parse(publicChecksums.bytes.toString('utf8')); } catch { throw new Error('public checksums metadata is invalid'); }
  if (stableJson(publishedMetadata) !== stableJson(checked)) throw new Error('public checksums metadata mismatch');
  const verified = [];
  const publicBytes = new Map();
  for (const asset of checked.assets) {
    const { bytes, url } = await fetchPublicAsset({ name: asset.name, root: parsedRoot, fetchImpl });
    if (bytes.length !== asset.size || hashBytes(bytes) !== asset.sha256) throw new Error(`public release asset hash mismatch: ${asset.name}`);
    publicBytes.set(asset.name, bytes);
    verified.push({ name: asset.name, size: bytes.length, sha256: asset.sha256, url: url.href });
  }
  let buildMetadata;
  try { buildMetadata = JSON.parse(publicBytes.get('build-metadata.json').toString('utf8')); } catch { throw new Error('public build metadata is invalid'); }
  closed(buildMetadata, ['schemaVersion', 'releaseTag', 'releaseUrl', 'targets'], 'public build metadata');
  if (buildMetadata.schemaVersion !== 1 || buildMetadata.releaseTag !== checked.releaseTag || buildMetadata.releaseUrl !== `https://github.com/otto-agent007/GameDevStuff/releases/tag/${checked.releaseTag}` || !Array.isArray(buildMetadata.targets)) throw new Error('public build metadata identity mismatch');
  const records = buildMetadata.targets.map((record) => validateReleaseRecord(record));
  const expected = await assembleRelease({ inputs: records, releaseTag: checked.releaseTag });
  let publicManifest;
  try { publicManifest = JSON.parse(publicBytes.get('pixel-snapper-tool-manifest.json').toString('utf8')); } catch { throw new Error('public tool manifest is invalid'); }
  if (stableJson(publicManifest) !== stableJson(expected.manifest)) throw new Error('public tool manifest does not match build metadata');
  for (const record of records) {
    for (const descriptor of [record.files.license, record.files.notices, record.files.sbom]) {
      const bytes = publicBytes.get(descriptor.name);
      if (!bytes || bytes.length !== descriptor.size || hashBytes(bytes) !== descriptor.sha256) throw new Error(`public compliance file mismatch: ${record.target}/${descriptor.name}`);
    }
    const archive = publicBytes.get(record.archive.name);
    if (!archive || archive.length !== record.archive.size || hashBytes(archive) !== record.archive.sha256) throw new Error(`public archive identity mismatch: ${record.target}`);
    await inspectReleaseArchive({ record, archiveBytes: archive });
  }
  return { schemaVersion: 1, releaseTag: checked.releaseTag, verified };
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  if (Object.keys(args).some((key) => !['metadata-dir'].includes(key)) || !args['metadata-dir']) throw new Error('usage: verify-release.mjs --metadata-dir DIR');
  const metadata = JSON.parse(await fs.readFile(path.join(args['metadata-dir'], 'checksums.json'), 'utf8'));
  process.stdout.write(stableJson(await verifyRelease({ metadata })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
