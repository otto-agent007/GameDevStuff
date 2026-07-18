import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
export {
  PIXEL_SNAPPER_FIXTURE_HEIGHT as FIXTURE_HEIGHT,
  PIXEL_SNAPPER_FIXTURE_INPUT_RGBA_SHA256 as FIXTURE_INPUT_RGBA_SHA256,
  PIXEL_SNAPPER_FIXTURE_OUTPUT_RGBA_SHA256 as FIXTURE_OUTPUT_RGBA_SHA256,
  PIXEL_SNAPPER_FIXTURE_PALETTE_SHA256 as FIXTURE_PALETTE_SHA256,
  PIXEL_SNAPPER_FIXTURE_WIDTH as FIXTURE_WIDTH,
  pixelSnapperFixtureRgba
} from '../lib/pixel-snapper-fixture.mjs';

export const REQUIRED_TARGETS = Object.freeze([
  'windows-x64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64'
]);
export const RUST_TARGETS = Object.freeze({
  'windows-x64': 'x86_64-pc-windows-msvc',
  'macos-x64': 'x86_64-apple-darwin',
  'macos-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl'
});
export const FULL_HASH = /^[a-f0-9]{64}$/;
export const FULL_COMMIT = /^[a-f0-9]{40}$/;
export const RELEASE_TAG = /^pixel-snapper-v(\d+\.\d+\.\d+)-commit\.([a-f0-9]{7})$/;

export function closed(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${label} must use a closed schema`);
  }
}

export function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function hashFile(file) {
  return hashBytes(await fs.readFile(file));
}

export function portableName(value, label = 'portable release filename') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120 || path.posix.basename(value) !== value || path.win32.basename(value) !== value || value === '.' || value === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
}

export function hashValue(value, label) {
  if (typeof value !== 'string' || !FULL_HASH.test(value)) throw new Error(`${label} must be a full SHA-256`);
}

export function commitValue(value, label) {
  if (typeof value !== 'string' || !FULL_COMMIT.test(value)) throw new Error(`${label} must be a full 40-character commit`);
}

export async function regularUnlinkedFile(file, label) {
  const linked = await fs.lstat(file);
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1) throw new Error(`${label} must be a regular non-link file`);
  return linked;
}

export async function atomicDirectory(outputDir, operation) {
  const parent = path.dirname(path.resolve(outputDir));
  await fs.mkdir(parent, { recursive: true });
  try { await fs.lstat(outputDir); throw new Error(`output already exists: ${outputDir}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = await fs.mkdtemp(path.join(parent, `.${path.basename(outputDir)}.stage-`));
  try {
    const result = await operation(stage);
    await fs.rename(stage, outputDir);
    return result;
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export function stableJson(value) {
  function order(input) {
    if (Array.isArray(input)) return input.map(order);
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map((key) => [key, order(input[key])]));
    return input;
  }
  return `${JSON.stringify(order(value), null, 2)}\n`;
}

export async function writeJson(file, value) {
  await fs.writeFile(file, stableJson(value), { flag: 'wx', mode: 0o644 });
}

export function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`invalid argument: ${key ?? ''}`);
    if (Object.hasOwn(values, key.slice(2))) throw new Error(`duplicate argument: ${key}`);
    values[key.slice(2)] = value;
  }
  return values;
}
