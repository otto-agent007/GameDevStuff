import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './image.mjs';
import { readSignedState, writeSignedState } from './state-auth.mjs';

const SNAP_DOMAIN = 'pixel-sprite-snap-receipt/v1';
const MANUAL_DOMAIN = 'pixel-sprite-manual-handoff-receipt/v1';
const HASH = /^[a-f0-9]{64}$/;
const ORIGINS = new Set(['environment', 'project-config', 'managed-cache', 'path']);

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`snap receipt ${label} schema is invalid`);
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} must be a sha256`);
  return value;
}

function runBinding(run) {
  if (!run || typeof run !== 'object') throw new Error('snap receipt run is required');
  const id = run.runId ?? run.id ?? null;
  if (id !== null && (typeof id !== 'string' || id === '')) throw new Error('snap receipt run ID is invalid');
  const outputDir = run.outputDir ?? run.runDir;
  if (typeof outputDir !== 'string' || outputDir === '') throw new Error('snap receipt output directory is required');
  return { id, manifestSha256: run.manifestSha256 === undefined ? null : hash(run.manifestSha256, 'snap receipt manifest hash') };
}

function validRun(binding) {
  exact(binding, ['id', 'manifestSha256'], 'run');
  if (binding.id !== null && (typeof binding.id !== 'string' || binding.id === '')) throw new Error('snap receipt run schema is invalid');
  if (binding.manifestSha256 !== null) hash(binding.manifestSha256, 'snap receipt manifest hash');
}

function contractHash(contract) {
  if (!contract || typeof contract !== 'object') throw new Error('snap receipt contract is required');
  return hash(contract.sha256, 'snap receipt contract hash');
}

function portableOutputPath(value) {
  if (typeof value !== 'string' || value === '' || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\\') || value === '.' || value === '..' || path.posix.normalize(value) !== value || value.startsWith('../')) throw new Error('snap receipt output path must be a portable path contained by the receipt directory');
  return value;
}

async function containedOutput(receiptDir, relative) {
  portableOutputPath(relative);
  const root = await fs.realpath(receiptDir);
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('snap receipt output artifact must not contain a symlink');
  }
  const stat = await fs.lstat(current);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('snap receipt output artifact must be a regular single-link file');
  const physical = await fs.realpath(current);
  const containment = path.relative(root, physical);
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error('snap receipt output artifact escaped the receipt directory');
  return current;
}

async function records(files, receiptDir, { contained = false } = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('snap receipt files are required');
  const output = [];
  for (let index = 0; index < files.length; index += 1) {
    if (typeof files[index] !== 'string' || files[index] === '') throw new Error('snap receipt file path is invalid');
    const absolute = path.resolve(files[index]);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('snap receipt artifact must be a regular single-link file');
    const relative = path.relative(receiptDir, absolute).replaceAll('\\', '/');
    const record = { index, path: relative, sha256: await sha256(absolute) };
    if (contained) await containedOutput(receiptDir, record.path);
    output.push(record);
  }
  return output;
}

function binaryRecord(identity) {
  if (!identity || typeof identity !== 'object') throw new Error('verified Pixel Snapper identity is required');
  if (!ORIGINS.has(identity.origin)) throw new Error('verified Pixel Snapper identity origin is invalid');
  hash(identity.sha256, 'verified Pixel Snapper binary hash');
  const record = {
    origin: identity.origin,
    sha256: identity.sha256,
    size: identity.size,
    version: identity.version,
    helpSha256: identity.helpSha256,
    fixtureRgbaSha256: identity.fixtureRgbaSha256,
    pinnedReleaseTag: identity.pinnedReleaseTag ?? null,
    upstreamCommit: identity.upstreamCommit ?? null
  };
  validBinary(record);
  return record;
}

function validBinary(binary) {
  exact(binary, ['origin', 'sha256', 'size', 'version', 'helpSha256', 'fixtureRgbaSha256', 'pinnedReleaseTag', 'upstreamCommit'], 'binary');
  if (!ORIGINS.has(binary.origin) || !Number.isInteger(binary.size) || binary.size < 1 || typeof binary.version !== 'string' || binary.version === '') throw new Error('snap receipt binary identity is invalid');
  for (const key of ['sha256', 'helpSha256', 'fixtureRgbaSha256']) hash(binary[key], `snap receipt binary ${key}`);
  const pinned = binary.pinnedReleaseTag;
  const commit = binary.upstreamCommit;
  if ((pinned === null) !== (commit === null)) throw new Error('snap receipt binary pin is invalid');
  if (pinned !== null) {
    const tag = typeof pinned === 'string' && /^pixel-snapper-v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?-commit\.([a-f0-9]{7})$/.exec(pinned);
    if (!tag || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit) || tag[1] !== commit.slice(0, 7)) throw new Error('snap receipt binary pin is invalid');
  }
}

function validDate(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('snap receipt date is invalid');
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function expectedBinding(payload, expectedRun, expectedContract) {
  if (expectedRun && !same(payload.run, runBinding(expectedRun))) throw new Error('snap receipt run binding mismatch');
  if (expectedContract && payload.animationContractSha256 !== contractHash(expectedContract)) throw new Error('snap receipt contract binding mismatch');
}

async function verifyRecords(recordsValue, receiptDir, label, { contained = false } = {}) {
  if (!Array.isArray(recordsValue) || recordsValue.length === 0) throw new Error(`snap receipt ${label} record is invalid`);
  for (const [index, item] of recordsValue.entries()) {
    exact(item, ['index', 'path', 'sha256'], `${label} record`);
    if (item.index !== index || typeof item.path !== 'string' || item.path === '' || path.isAbsolute(item.path) || path.win32.isAbsolute(item.path) || item.path.includes('\\') || path.posix.normalize(item.path) !== item.path || (contained && (item.path === '.' || item.path === '..' || item.path.startsWith('../')))) throw new Error(`snap receipt ${label} record is invalid`);
    hash(item.sha256, `snap receipt ${label} hash`);
  }
  for (const record of recordsValue) {
    const file = contained ? await containedOutput(receiptDir, record.path) : path.resolve(receiptDir, record.path);
    const actual = await sha256(file);
    if (actual !== record.sha256) throw new Error(`${label} hash mismatch`);
  }
}

async function existingReceipt({ projectDir, file, domain, expectedRun, expectedContract, expectedInputs, expectedArgs, expectedIdentity, expectedHandoff }) {
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const existing = await verifySnapReceipt({ projectDir, file, expectedRun, expectedContract });
  const payload = existing.document.payload;
  if (expectedInputs && !same(payload.inputs, await records(expectedInputs, path.dirname(file)))) throw new Error('existing snap receipt input binding mismatch');
  if (expectedArgs && !same(payload.arguments, [...expectedArgs])) throw new Error('existing snap receipt argument binding mismatch');
  if (expectedIdentity && !same(payload.binary, binaryRecord(expectedIdentity))) throw new Error('existing snap receipt binary identity mismatch');
  if (expectedHandoff && payload.handoffSha256 !== await sha256(expectedHandoff)) throw new Error('existing manual handoff receipt binding mismatch');
  return existing;
}

export async function writeSnapReceipt({ projectDir, run, contract, inputs, outputs, args, identity }) {
  const binding = runBinding(run);
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) throw new Error('snap receipt arguments must be strings');
  const file = path.join(run.outputDir ?? run.runDir, 'snap-receipt.json');
  const existing = await existingReceipt({ projectDir, file, domain: SNAP_DOMAIN, expectedRun: run, expectedContract: contract, expectedInputs: inputs, expectedArgs: args, expectedIdentity: identity });
  if (existing) return { ...existing, path: file };
  const payload = {
    version: 1, origin: identity.origin, toolProvenanceVerified: true, run: binding,
    animationContractSha256: contractHash(contract), inputs: await records(inputs, path.dirname(file)), outputs: await records(outputs, path.dirname(file), { contained: true }),
    arguments: [...args], binary: binaryRecord(identity), createdAt: new Date().toISOString()
  };
  let signed;
  try { signed = await writeSignedState({ projectDir, file, domain: SNAP_DOMAIN, payload, createKey: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const concurrent = await existingReceipt({ projectDir, file, domain: SNAP_DOMAIN, expectedRun: run, expectedContract: contract, expectedInputs: inputs, expectedArgs: args, expectedIdentity: identity }).catch(() => null);
    if (!concurrent) throw new Error('concurrent snap receipt publication conflict');
    return { ...concurrent, path: file };
  }
  return { ...signed, path: file };
}

export async function writeManualHandoffReceipt({ projectDir, run, handoff, inputs, outputs }) {
  const binding = runBinding(run);
  const file = path.join(run.outputDir ?? run.runDir, 'manual-handoff-receipt.json');
  const existing = await existingReceipt({ projectDir, file, domain: MANUAL_DOMAIN, expectedRun: run, expectedHandoff: handoff });
  if (existing) return { ...existing, path: file };
  const payload = {
    version: 1, origin: 'manual-handoff', toolProvenanceVerified: false, run: binding,
    handoffSha256: await sha256(handoff), inputs: await records(inputs, path.dirname(file)), outputs: await records(outputs, path.dirname(file), { contained: true }),
    arguments: null, binary: null, createdAt: new Date().toISOString()
  };
  let signed;
  try { signed = await writeSignedState({ projectDir, file, domain: MANUAL_DOMAIN, payload, createKey: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const concurrent = await existingReceipt({ projectDir, file, domain: MANUAL_DOMAIN, expectedRun: run, expectedHandoff: handoff }).catch(() => null);
    if (!concurrent) throw new Error('concurrent manual handoff receipt publication conflict');
    return { ...concurrent, path: file };
  }
  return { ...signed, path: file };
}

export async function verifySnapReceipt({ projectDir, file, expectedRun, expectedContract }) {
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  exact(raw, ['version', 'payload', 'signature'], 'envelope');
  if (raw.version !== 1 || !HASH.test(raw.signature ?? '')) throw new Error('snap receipt envelope schema is invalid');
  const domain = raw?.payload?.origin === 'manual-handoff' ? MANUAL_DOMAIN : SNAP_DOMAIN;
  const document = await readSignedState({ projectDir, file, domain });
  const payload = document.payload;
  if (domain === SNAP_DOMAIN) {
    exact(payload, ['version', 'origin', 'toolProvenanceVerified', 'run', 'animationContractSha256', 'inputs', 'outputs', 'arguments', 'binary', 'createdAt'], 'payload');
    if (payload.version !== 1 || !ORIGINS.has(payload.origin) || payload.toolProvenanceVerified !== true || !Array.isArray(payload.arguments) || payload.arguments.length === 0 || payload.arguments.some((item) => typeof item !== 'string') || !payload.binary || payload.origin !== payload.binary.origin) throw new Error('verified snap receipt provenance is invalid');
    hash(payload.animationContractSha256, 'snap receipt contract hash');
    validBinary(payload.binary);
  } else {
    exact(payload, ['version', 'origin', 'toolProvenanceVerified', 'run', 'handoffSha256', 'inputs', 'outputs', 'arguments', 'binary', 'createdAt'], 'payload');
    if (payload.version !== 1 || payload.origin !== 'manual-handoff' || payload.toolProvenanceVerified !== false || payload.arguments !== null || payload.binary !== null) throw new Error('manual handoff receipt provenance is invalid');
    hash(payload.handoffSha256, 'snap receipt handoff hash');
  }
  validRun(payload.run);
  validDate(payload.createdAt);
  expectedBinding(payload, expectedRun, domain === SNAP_DOMAIN ? expectedContract : undefined);
  await verifyRecords(payload.inputs, path.dirname(file), 'input');
  await verifyRecords(payload.outputs, path.dirname(file), 'output', { contained: true });
  return { document, path: file, sha256: document.sha256 };
}

export async function verifyExistingSnapReceipt(options) { return existingReceipt(options); }
