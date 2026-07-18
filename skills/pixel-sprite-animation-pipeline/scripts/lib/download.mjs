import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const MAX_ARCHIVE_SIZE = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SHA256 = /^[a-f0-9]{64}$/;
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const RELEASE_TAG = /^pixel-snapper-v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?-commit\.([a-f0-9]{7})$/;

function canonicalSegment(segment) {
  try {
    const decoded = decodeURIComponent(segment);
    return encodeURIComponent(decoded) === segment && decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function parseUrl(value, message) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(message);
  }
  return parsed;
}

function approvedInitialUrl(value) {
  const message = 'unsafe Pixel Snapper download URL';
  const parsed = parseUrl(value, message);
  const parts = parsed.pathname.split('/').filter(Boolean);
  const decoded = parts.map(canonicalSegment);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.port ||
      parsed.search || parsed.hash || parts.length !== 6 || decoded.some((part) => part === null) ||
      decoded[0] !== 'otto-agent007' || decoded[1] !== 'GameDevStuff' || decoded[2] !== 'releases' ||
      decoded[3] !== 'download' || !RELEASE_TAG.test(decoded[4]) || decoded[5].includes('/') || decoded[5].includes('\\')) {
    throw new Error(message);
  }
  return { parsed, revision: RELEASE_TAG.exec(decoded[4])[1] };
}

function approvedRedirect(current, location) {
  const message = 'unsafe Pixel Snapper redirect';
  if (typeof location !== 'string' || location.length === 0) throw new Error(message);
  let next;
  try {
    next = new URL(location, current);
  } catch {
    throw new Error(message);
  }
  const githubRelease = next.hostname === 'github.com' && next.pathname === current.pathname && !next.search;
  const releaseAsset = next.hostname === 'release-assets.githubusercontent.com' && next.pathname.startsWith('/github-production-release-asset/');
  if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hash || (!githubRelease && !releaseAsset)) {
    throw new Error(message);
  }
  return next;
}

function validateRequest({ upstreamCommit, expectedSize, expectedSha256, output }) {
  if (typeof upstreamCommit !== 'string' || !FULL_COMMIT.test(upstreamCommit)) throw new Error('invalid pinned Pixel Snapper upstream commit');
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1) throw new Error('invalid pinned Pixel Snapper archive size');
  if (expectedSize > MAX_ARCHIVE_SIZE) throw new Error('Pixel Snapper archive exceeded maximum size');
  if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) throw new Error('invalid pinned Pixel Snapper archive checksum');
  if (typeof output !== 'string' || output.length === 0) throw new Error('invalid Pixel Snapper download output');
}

async function writeChunk(handle, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten < 1) throw new Error('Pixel Snapper download failed while writing output');
    offset += bytesWritten;
  }
  return bytes;
}

export async function downloadPinnedAsset({ url, upstreamCommit, expectedSize, expectedSha256, fetchImpl = fetch, output }) {
  validateRequest({ upstreamCommit, expectedSize, expectedSha256, output });
  if (typeof fetchImpl !== 'function') throw new Error('invalid Pixel Snapper fetch implementation');
  const approved = approvedInitialUrl(url);
  if (!upstreamCommit.startsWith(approved.revision)) throw new Error('Pixel Snapper release revision mismatch');
  let current = approved.parsed;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(current, { redirect: 'manual' });
    if (REDIRECTS.has(response?.status)) {
      if (redirects === MAX_REDIRECTS) throw new Error('Pixel Snapper redirect limit exceeded');
      current = approvedRedirect(current, response?.headers?.get?.('location'));
      continue;
    }
    if (response?.status === 404) {
      const error = new Error('Pixel Snapper download failed: release asset not found (HTTP 404)');
      error.code = 'PIXEL_SNAPPER_RELEASE_NOT_FOUND';
      throw error;
    }
    if (!response?.ok || !response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
      throw new Error(`Pixel Snapper download failed: HTTP ${response?.status ?? 'unknown'}`);
    }

    const handle = await fs.open(output, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let closed = false;
    try {
      for await (const incoming of response.body) {
        const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
        size += chunk.length;
        if (size > MAX_ARCHIVE_SIZE) throw new Error('Pixel Snapper archive exceeded maximum size');
        if (size > expectedSize) throw new Error('Pixel Snapper archive exceeded pinned size');
        hash.update(chunk);
        await writeChunk(handle, chunk);
      }
      if (size !== expectedSize || hash.digest('hex') !== expectedSha256) {
        throw new Error('Pixel Snapper archive size or checksum mismatch');
      }
      await handle.close();
      closed = true;
      return { output, size, sha256: expectedSha256 };
    } catch (error) {
      if (!closed) await handle.close().catch(() => {});
      await fs.rm(output, { force: true }).catch(() => {});
      throw error;
    }
  }
  throw new Error('Pixel Snapper redirect limit exceeded');
}
