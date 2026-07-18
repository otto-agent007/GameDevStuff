import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { paletteOf, readRgba, sha256 } from './image.mjs';
import { validateConfig } from './config.mjs';

const CONTRACT_FILE = 'correction-contract-v1.json';
const RECEIPT_FILE = 'correction-receipt-v1.json';
const RECEIPT_DOMAIN = 'pixel-sprite-correction-receipt/v1\0';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function stableHash(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

function receiptSignature(key, payload) { return crypto.createHmac('sha256', key).update(RECEIPT_DOMAIN).update(JSON.stringify(stable(payload))).digest('hex'); }

function missingSigningKey() { return new Error('correction signing key is missing; revalidation and explicit receipt reissue are required'); }

function requireOwned(stat, label) {
  if (process.platform !== 'win32' && typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) throw new Error(`${label} must be owned by the current effective uid`);
}

async function requireDirectory(directory, label) {
  let stat;
  try { stat = await fs.lstat(directory); }
  catch (error) {
    if (error.code === 'ENOENT') throw missingSigningKey();
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a symlink`);
  return stat;
}

async function signingKey(projectDir, { create = false } = {}) {
  const project = path.resolve(projectDir);
  await requireDirectory(project, 'correction project directory');
  const stateDir = path.join(project, '.pixel-sprite-pipeline');
  const state = await requireDirectory(stateDir, 'correction state directory');
  requireOwned(state, 'correction state directory');
  if (process.platform !== 'win32' && (state.mode & 0o022) !== 0) throw new Error('correction state directory permissions are unsafe');
  const keysDir = path.join(project, '.pixel-sprite-pipeline', 'keys');
  let createdKeysDirectory = false;
  if (create) {
    try {
      await fs.mkdir(keysDir, { mode: 0o700 });
      createdKeysDirectory = true;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (createdKeysDirectory && process.platform !== 'win32') await fs.chmod(keysDir, 0o700);
  }
  const directory = await requireDirectory(keysDir, 'correction key directory');
  requireOwned(directory, 'correction key directory');
  if (process.platform !== 'win32' && ((directory.mode & 0o077) !== 0 || (createdKeysDirectory && (directory.mode & 0o777) !== 0o700))) throw new Error('correction key directory permissions are unsafe');
  const file = path.join(keysDir, 'correction-signing-v1.key');
  let keyExists = true;
  try { await fs.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') keyExists = false;
    else throw error;
  }
  if (create && !keyExists) {
    const temporary = path.join(keysDir, `.correction-signing-v1.${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(crypto.randomBytes(32));
      if (process.platform !== 'win32') await handle.chmod(0o600);
      await handle.sync();
    } finally { await handle.close(); }
    try { await fs.link(temporary, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await fs.rm(temporary, { force: true }); }
  }
  let stat;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { stat = await fs.lstat(file); }
    catch (error) {
      if (error.code === 'ENOENT') throw missingSigningKey();
      throw error;
    }
    if (stat.nlink === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('correction signing key permissions or file type are unsafe');
  requireOwned(stat, 'correction signing key');
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) throw new Error('correction signing key permissions or file type are unsafe');
  let key;
  try { key = await fs.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') throw missingSigningKey(); throw error; }
  if (key.length < 32) throw new Error('correction signing key is invalid');
  return key;
}

function relative(runDir, file) {
  const value = path.relative(runDir, path.resolve(file)).replaceAll('\\', '/');
  if (value === '..' || value.startsWith('../') || path.isAbsolute(value)) throw new Error('correction contract artifact escaped the run');
  return value;
}

async function imageRecord(runDir, file, role, extra = {}) {
  const image = await readRgba(file);
  return { role, path: relative(runDir, file), sha256: await sha256(file), width: image.width, height: image.height, palette: paletteOf(image), ...extra };
}

async function fileRecord(runDir, file, role) { return { role, path: relative(runDir, file), sha256: await sha256(file) }; }

async function atomicNew(file, contents) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, contents, { flag: 'wx' });
  try { await fs.link(temporary, file); }
  catch (error) {
    if (error.code !== 'EEXIST' || await fs.readFile(file, 'utf8') !== contents) throw error;
  }
  finally { await fs.rm(temporary, { force: true }); }
}

export async function createCorrectionContract({ runDir, runId, config, anchorReport, normalized, exported }) {
  const effective = validateConfig(config);
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.runId !== runId) throw new Error('correction contract run ID mismatch');
  const metadata = JSON.parse(await fs.readFile(exported.metadata, 'utf8'));
  const anchor = await imageRecord(runDir, anchorReport.path, 'approved-anchor');
  const normalizedFrames = await Promise.all(normalized.frames.map(async (file, frame) => imageRecord(runDir, file, 'normalized-frame', {
    frame,
    source: relative(runDir, normalized.measurements[frame].input),
    sourceSha256: await sha256(normalized.measurements[frame].input),
    measurement: Object.fromEntries(['left', 'top', 'width', 'height', 'bottom', 'scaleFactor'].map((key) => [key, normalized.measurements[frame][key]]))
  })));
  const runtimeFrames = await Promise.all(exported.runtimeFrames.map((file, frame) => imageRecord(runDir, file, 'runtime-frame', { frame, sourceSha256: metadata.sources[frame].sha256 })));
  const delivery = {
    name: path.basename(exported.metadata, '.json'),
    columns: metadata.columns,
    rows: metadata.rows,
    durations: metadata.durations,
    frameSize: metadata.frameSize,
    canonicalPivot: metadata.canonicalPivot,
    pivot: metadata.pivot,
    sources: metadata.sources,
    normalizedFrames,
    runtimeFrames,
    sheet: await imageRecord(runDir, exported.sheet, 'sheet'),
    metadata: await fileRecord(runDir, exported.metadata, 'metadata'),
    preview: await fileRecord(runDir, exported.preview, 'preview')
  };
  const document = {
    version: 1,
    runId,
    manifest: { path: 'manifest.json', sha256: await sha256(manifestPath) },
    configSha256: stableHash(effective),
    anchor,
    delivery,
    expected: { metadata }
  };
  const file = path.join(runDir, CONTRACT_FILE);
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  await atomicNew(file, contents);
  return { path: file, sha256: crypto.createHash('sha256').update(contents).digest('hex'), document };
}

export async function sealCorrectionContract({ projectDir, runDir, runId, contract }) {
  const key = await signingKey(path.resolve(projectDir), { create: true });
  const receiptPath = path.join(runDir, RECEIPT_FILE);
  try {
    const existing = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    const signature = receiptSignature(key, existing.payload);
    if (existing.version !== 1 || existing.signature !== signature || existing.payload.runId !== runId || existing.payload.contractSha256 !== contract.sha256) throw new Error('existing correction receipt is invalid');
    return { path: receiptPath, sha256: await sha256(receiptPath), signature };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const reportPath = path.join(runDir, 'report.json');
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  if (report.runId !== runId || report.correctionContract?.sha256 !== contract.sha256) throw new Error('correction receipt requires the immutable report binding');
  const payload = {
    version: 1,
    projectId: stableHash({ root: await fs.realpath(projectDir) }),
    runId,
    manifestSha256: contract.document.manifest.sha256,
    configSha256: contract.document.configSha256,
    reportSha256: await sha256(reportPath),
    contractSha256: contract.sha256,
    inventorySha256: stableHash({ anchor: contract.document.anchor, delivery: contract.document.delivery, expected: contract.document.expected }),
    createdAt: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString('hex')
  };
  const signature = receiptSignature(key, payload);
  const contents = `${JSON.stringify({ version: 1, payload, signature }, null, 2)}\n`;
  try { await atomicNew(receiptPath, contents); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    const existingSignature = receiptSignature(key, existing.payload);
    if (existing.version !== 1 || existing.signature !== existingSignature || existing.payload.runId !== runId || existing.payload.contractSha256 !== contract.sha256) throw new Error('concurrent correction receipt publication conflict');
    return { path: receiptPath, sha256: await sha256(receiptPath), signature: existingSignature };
  }
  return { path: receiptPath, sha256: crypto.createHash('sha256').update(contents).digest('hex'), signature };
}

function targetPath(contract, failure) {
  if (!failure) return null;
  if (String(failure.stage ?? failure.target ?? '').includes('sheet')) return contract.delivery.sheet.path;
  if (String(failure.stage ?? failure.target ?? '').includes('preview')) return contract.delivery.preview.path;
  if (failure.code === 'FRAME_BLEED') return contract.delivery.sheet.path;
  if (failure.code === 'PREVIEW_MISMATCH' || (failure.code === 'FRAME_COUNT' && failure.stage !== 'metadata')) return contract.delivery.preview.path;
  if (['METADATA_MISMATCH', 'TIMING_MISMATCH', 'SOURCE_HASH_MISMATCH'].includes(failure.code) || failure.stage?.startsWith('metadata')) return contract.delivery.metadata.path;
  if (failure.stage === 'runtime' || ['BACKGROUND_REMAINS', 'INTERMEDIATE_COLORS'].includes(failure.code)) return contract.delivery.runtimeFrames[failure.frame ?? 0]?.path;
  return contract.delivery.normalizedFrames[failure.frame ?? 0]?.path;
}

async function secureArtifact(runDir, record, { allowHashMismatch = false } = {}) {
  const file = path.join(runDir, ...record.path.split('/'));
  const root = await fs.realpath(runDir);
  let current = root;
  for (const segment of record.path.split('/')) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('correction contract artifact must not contain symlinks');
  }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('correction contract artifact must be a regular single-link file');
  const containment = path.relative(root, await fs.realpath(file));
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error('correction contract artifact escaped the run');
  if (!allowHashMismatch && await sha256(file) !== record.sha256) throw new Error(`correction contract artifact hash mismatch: ${record.role}`);
  if (!allowHashMismatch && record.width !== undefined) {
    const image = await readRgba(file);
    if (image.width !== record.width || image.height !== record.height || JSON.stringify(paletteOf(image)) !== JSON.stringify(record.palette)) throw new Error(`correction contract image measurements mismatch: ${record.role}`);
  }
  return file;
}

export async function loadCorrectionContext({ projectDir, runId, contractSha256, receiptSha256, receiptSignature: suppliedSignature, declaredFailure, ...unknown }) {
  if (Object.keys(unknown).length > 0) throw new Error('caller may not choose correction ancestor paths');
  const runDir = path.join(path.resolve(projectDir), '.pixel-sprite-pipeline', 'runs', runId);
  const key = await signingKey(path.resolve(projectDir));
  const receiptPath = path.join(runDir, RECEIPT_FILE);
  if (!/^[a-f0-9]{64}$/.test(receiptSha256 ?? '') || await sha256(receiptPath) !== receiptSha256) throw new Error('correction receipt hash mismatch');
  await secureArtifact(runDir, { role: 'signed-receipt', path: RECEIPT_FILE, sha256: receiptSha256 });
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  const verifiedSignature = receiptSignature(key, receipt.payload);
  if (receipt.version !== 1 || !/^[a-f0-9]{64}$/.test(receipt.signature ?? '') || !crypto.timingSafeEqual(Buffer.from(receipt.signature, 'hex'), Buffer.from(verifiedSignature, 'hex')) || suppliedSignature !== receipt.signature) throw new Error('correction receipt signature mismatch');
  const reportPath = path.join(runDir, 'report.json');
  const reportHash = await sha256(reportPath);
  await secureArtifact(runDir, { role: 'immutable-report', path: 'report.json', sha256: reportHash });
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  if (report.runId !== runId || report.correctionContract?.path !== CONTRACT_FILE || report.correctionContract?.sha256 !== contractSha256) throw new Error('correction contract is not bound by the immutable run report');
  const contractPath = path.join(runDir, CONTRACT_FILE);
  if (await sha256(contractPath) !== contractSha256) throw new Error('correction contract hash mismatch');
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  if (contract.version !== 1 || contract.runId !== runId) throw new Error('correction contract run binding mismatch');
  const manifestPath = await secureArtifact(runDir, { ...contract.manifest, role: 'manifest' });
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const config = validateConfig(manifest.config);
  const inventorySha256 = stableHash({ anchor: contract.anchor, delivery: contract.delivery, expected: contract.expected });
  if (receipt.payload?.version !== 1 || receipt.payload.projectId !== stableHash({ root: await fs.realpath(projectDir) }) || receipt.payload.runId !== runId || receipt.payload.manifestSha256 !== contract.manifest.sha256 || receipt.payload.configSha256 !== contract.configSha256 || receipt.payload.reportSha256 !== reportHash || receipt.payload.contractSha256 !== contractSha256 || receipt.payload.inventorySha256 !== inventorySha256) throw new Error('correction receipt binding mismatch');
  if (manifest.runId !== runId || report.manifestSha256 !== contract.manifest.sha256 || stableHash(config) !== contract.configSha256) throw new Error('correction contract manifest/config mismatch');
  const selectedTarget = targetPath(contract, declaredFailure);
  const records = [contract.anchor, ...contract.delivery.normalizedFrames, ...contract.delivery.runtimeFrames, contract.delivery.sheet, contract.delivery.metadata, contract.delivery.preview];
  const paths = new Map();
  for (const record of records) paths.set(record.path, await secureArtifact(runDir, record, { allowHashMismatch: record.path === selectedTarget }));
  for (const frame of contract.delivery.normalizedFrames) {
    const sourceRecord = { role: 'normalization-source', path: frame.source, sha256: frame.sourceSha256 };
    paths.set(frame.source, await secureArtifact(runDir, sourceRecord));
  }
  const normalized = {
    frames: contract.delivery.normalizedFrames.map((record) => paths.get(record.path)),
    canonicalPivot: contract.delivery.canonicalPivot,
    scaleFactor: 1,
    measurements: contract.delivery.normalizedFrames.map((record) => ({ input: paths.get(record.source), output: paths.get(record.path), ...record.measurement }))
  };
  return {
    runDir, contractPath, contract, config, manifest, report, reportSha256: reportHash, receipt, receiptSha256,
    expected: { metadata: structuredClone(contract.expected.metadata), preview: { runtimeFrames: contract.delivery.runtimeFrames.map((record) => paths.get(record.path)), durations: contract.delivery.durations }, sheet: { runtimeFrames: contract.delivery.runtimeFrames.map((record) => paths.get(record.path)), columns: contract.delivery.columns, frameSize: contract.delivery.frameSize } },
    request: {
      anchorReport: { path: paths.get(contract.anchor.path), sha256: contract.anchor.sha256 },
      normalized,
      exported: { runtimeFrames: contract.delivery.runtimeFrames.map((record) => paths.get(record.path)), sheet: paths.get(contract.delivery.sheet.path), metadata: paths.get(contract.delivery.metadata.path), preview: paths.get(contract.delivery.preview.path) },
      semanticEvidence: []
    }
  };
}
