import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './image.mjs';
import { readSignedState, writeSignedState } from './state-auth.mjs';

const SNAP_DOMAIN = 'pixel-sprite-snap-receipt/v1';
const MANUAL_DOMAIN = 'pixel-sprite-manual-handoff-receipt/v1';
const ALIGNED_DOMAIN = 'pixel-sprite-aligned-source-receipt/v1';
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
  return { id, manifestSha256: run.manifestSha256 == null ? null : hash(run.manifestSha256, 'snap receipt manifest hash') };
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

function validAlignedDerivation(value) {
  exact(value, ['kind', 'scale', 'canvas', 'paletteSha256'], 'aligned derivation');
  exact(value.canvas, ['width', 'height'], 'aligned canvas');
  if (value.kind !== 'integer-grid-collapse' || !Number.isInteger(value.scale) || value.scale < 1 ||
    !Number.isInteger(value.canvas.width) || value.canvas.width < 1 || !Number.isInteger(value.canvas.height) || value.canvas.height < 1) {
    throw new Error('snap receipt aligned derivation is invalid');
  }
  hash(value.paletteSha256, 'snap receipt aligned palette hash');
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

async function existingReceipt({ projectDir, file, domain, expectedRun, expectedContract, expectedInputs, expectedArgs, expectedIdentity, expectedHandoff, expectedDerivation }) {
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
  if (expectedDerivation && !same(payload.derivation, expectedDerivation)) throw new Error('existing aligned source receipt derivation mismatch');
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

export async function writeAlignedSourceReceipt({ projectDir, run, contract, inputs, outputs, derivation }) {
  const binding = runBinding(run);
  validAlignedDerivation(derivation);
  const file = path.join(run.outputDir ?? run.runDir, 'snap-receipt.json');
  const existing = await existingReceipt({ projectDir, file, domain: ALIGNED_DOMAIN, expectedRun: run, expectedContract: contract, expectedInputs: inputs, expectedDerivation: derivation });
  if (existing) return { ...existing, path: file };
  const payload = {
    version: 1,
    origin: 'verified-aligned-source',
    toolProvenanceVerified: false,
    deterministicProvenanceVerified: true,
    run: binding,
    animationContractSha256: contractHash(contract),
    inputs: await records(inputs, path.dirname(file)),
    outputs: await records(outputs, path.dirname(file), { contained: true }),
    derivation: structuredClone(derivation),
    createdAt: new Date().toISOString()
  };
  let signed;
  try { signed = await writeSignedState({ projectDir, file, domain: ALIGNED_DOMAIN, payload, createKey: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const concurrent = await existingReceipt({ projectDir, file, domain: ALIGNED_DOMAIN, expectedRun: run, expectedContract: contract, expectedInputs: inputs, expectedDerivation: derivation }).catch(() => null);
    if (!concurrent) throw new Error('concurrent aligned source receipt publication conflict');
    return { ...concurrent, path: file };
  }
  return { ...signed, path: file };
}

export async function verifySnapReceipt({ projectDir, file, expectedRun, expectedContract }) {
  const selected = path.resolve(file);
  const before = await fs.lstat(selected);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('snap receipt must be a regular non-symlink single-link file');
  const physical = await fs.realpath(selected);
  const physicalInfo = await fs.lstat(physical);
  if (!physicalInfo.isFile() || physicalInfo.isSymbolicLink() || physicalInfo.dev !== before.dev || physicalInfo.ino !== before.ino) throw new Error('snap receipt file identity is unsafe');
  const raw = JSON.parse(await fs.readFile(physical, 'utf8'));
  exact(raw, ['version', 'payload', 'signature'], 'envelope');
  if (raw.version !== 1 || !HASH.test(raw.signature ?? '')) throw new Error('snap receipt envelope schema is invalid');
  const domain = raw?.payload?.origin === 'manual-handoff' ? MANUAL_DOMAIN : raw?.payload?.origin === 'verified-aligned-source' ? ALIGNED_DOMAIN : SNAP_DOMAIN;
  const document = await readSignedState({ projectDir, file: physical, domain });
  const payload = document.payload;
  if (domain === SNAP_DOMAIN) {
    exact(payload, ['version', 'origin', 'toolProvenanceVerified', 'run', 'animationContractSha256', 'inputs', 'outputs', 'arguments', 'binary', 'createdAt'], 'payload');
    if (payload.version !== 1 || !ORIGINS.has(payload.origin) || payload.toolProvenanceVerified !== true || !Array.isArray(payload.arguments) || payload.arguments.length === 0 || payload.arguments.some((item) => typeof item !== 'string') || !payload.binary || payload.origin !== payload.binary.origin) throw new Error('verified snap receipt provenance is invalid');
    hash(payload.animationContractSha256, 'snap receipt contract hash');
    validBinary(payload.binary);
  } else if (domain === MANUAL_DOMAIN) {
    exact(payload, ['version', 'origin', 'toolProvenanceVerified', 'run', 'handoffSha256', 'inputs', 'outputs', 'arguments', 'binary', 'createdAt'], 'payload');
    if (payload.version !== 1 || payload.origin !== 'manual-handoff' || payload.toolProvenanceVerified !== false || payload.arguments !== null || payload.binary !== null) throw new Error('manual handoff receipt provenance is invalid');
    hash(payload.handoffSha256, 'snap receipt handoff hash');
  } else {
    exact(payload, ['version', 'origin', 'toolProvenanceVerified', 'deterministicProvenanceVerified', 'run', 'animationContractSha256', 'inputs', 'outputs', 'derivation', 'createdAt'], 'payload');
    if (payload.version !== 1 || payload.origin !== 'verified-aligned-source' || payload.toolProvenanceVerified !== false || payload.deterministicProvenanceVerified !== true) throw new Error('aligned source receipt provenance is invalid');
    hash(payload.animationContractSha256, 'snap receipt contract hash');
    validAlignedDerivation(payload.derivation);
  }
  validRun(payload.run);
  validDate(payload.createdAt);
  expectedBinding(payload, expectedRun, domain === MANUAL_DOMAIN ? undefined : expectedContract);
  const after = await fs.lstat(selected);
  if (after.dev !== before.dev || after.ino !== before.ino || await fs.realpath(selected) !== physical) throw new Error('snap receipt file identity changed during verification');
  await verifyRecords(payload.inputs, path.dirname(physical), 'input');
  await verifyRecords(payload.outputs, path.dirname(physical), 'output', { contained: true });
  return { document, path: physical, sha256: document.sha256 };
}

export async function verifyExistingSnapReceipt(options) { return existingReceipt(options); }
