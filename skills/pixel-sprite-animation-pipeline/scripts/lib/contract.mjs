import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { paletteOf, readRgba, sha256 } from './image.mjs';
import { validateAnimationContract } from './animation-contract.mjs';
import { validateConfig } from './config.mjs';
import { verifyFrameApproval } from './frame-approval.mjs';
import { verifySnapReceipt } from './snap-receipt.mjs';
import { readSignedState, stableHash, writeSignedState } from './state-auth.mjs';

export { stableHash } from './state-auth.mjs';

const CONTRACT_FILE = 'correction-contract-v1.json';
const RECEIPT_FILE = 'correction-receipt-v1.json';
const RECEIPT_DOMAIN = 'pixel-sprite-correction-receipt/v1';
const HASH = /^[a-f0-9]{64}$/;

function approvalProvenance(value) {
  if (value === undefined) return undefined;
  const summary = ['animationContractSha256', 'snapReceiptSha256', 'frameApprovalSha256', 'toolProvenanceVerified'];
  const selectors = ['snapReceipt', 'frameApproval'];
  const allowed = [...summary, ...selectors];
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).every((key) => allowed.includes(key)) || summary.some((key) => !Object.hasOwn(value, key)) || selectors.some((key) => Object.hasOwn(value, key)) && selectors.some((key) => !Object.hasOwn(value, key))) throw new Error('correction contract approval provenance schema is invalid');
  for (const key of summary.slice(0, 3)) if (!HASH.test(value[key] ?? '')) throw new Error(`correction contract ${key} is invalid`);
  if (typeof value.toolProvenanceVerified !== 'boolean') throw new Error('correction contract toolProvenanceVerified is invalid');
  if (value.snapReceipt) {
    if (!value.snapReceipt || typeof value.snapReceipt !== 'object' || Array.isArray(value.snapReceipt) || Object.keys(value.snapReceipt).sort().join(',') !== 'path,sha256' || typeof value.snapReceipt.path !== 'string' || !HASH.test(value.snapReceipt.sha256 ?? '') || value.snapReceipt.sha256 !== value.snapReceiptSha256) throw new Error('correction contract snap receipt selector is invalid');
    if (!value.frameApproval || typeof value.frameApproval !== 'object' || Array.isArray(value.frameApproval) || Object.keys(value.frameApproval).sort().join(',') !== 'path,sha256,version' || typeof value.frameApproval.path !== 'string' || !HASH.test(value.frameApproval.sha256 ?? '') || value.frameApproval.sha256 !== value.frameApprovalSha256 || !Number.isInteger(value.frameApproval.version) || value.frameApproval.version < 1) throw new Error('correction contract frame approval selector is invalid');
  }
  return structuredClone(value);
}

function reportMatchesProvenance(report, provenance) {
  if (!provenance) return true;
  for (const key of ['animationContractSha256', 'snapReceiptSha256', 'frameApprovalSha256', 'toolProvenanceVerified']) if (report?.[key] !== provenance[key]) return false;
  if (provenance.snapReceipt && JSON.stringify(report?.snapReceipt) !== JSON.stringify(provenance.snapReceipt)) return false;
  if (provenance.frameApproval && JSON.stringify(report?.frameApproval) !== JSON.stringify(provenance.frameApproval)) return false;
  return true;
}

export function portableContainedPath(physicalRunDir, physicalFile, pathApi = path) {
  const value = pathApi.relative(physicalRunDir, physicalFile);
  if (value === '..' || value.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(value)) throw new Error('correction contract artifact escaped the run');
  return value.replaceAll('\\', '/');
}

async function relative(physicalRunDir, file) { return portableContainedPath(physicalRunDir, await fs.realpath(file)); }

async function imageRecord(physicalRunDir, file, role, extra = {}) {
  const portablePath = await relative(physicalRunDir, file);
  const image = await readRgba(file);
  return { role, path: portablePath, sha256: await sha256(file), width: image.width, height: image.height, palette: paletteOf(image), ...extra };
}

async function fileRecord(physicalRunDir, file, role) {
  const portablePath = await relative(physicalRunDir, file);
  return { role, path: portablePath, sha256: await sha256(file) };
}

async function atomicNew(file, contents) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, contents, { flag: 'wx' });
  try { await fs.link(temporary, file); }
  catch (error) {
    if (error.code !== 'EEXIST' || await fs.readFile(file, 'utf8') !== contents) throw error;
  }
  finally { await fs.rm(temporary, { force: true }); }
}

export async function createCorrectionContract({ runDir, runId, config, anchorReport, normalized, exported, provenance }) {
  const effective = validateConfig(config);
  const selectedProvenance = approvalProvenance(provenance);
  const physicalRunDir = await fs.realpath(runDir);
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.runId !== runId) throw new Error('correction contract run ID mismatch');
  if (manifest.animationContract) {
    if (!selectedProvenance?.snapReceipt || !selectedProvenance?.frameApproval || selectedProvenance.animationContractSha256 !== manifest.animationContract.sha256 || stableHash(manifest.animationContract.document) !== manifest.animationContract.sha256) throw new Error('correction contract requires the immutable animation approval provenance chain');
  }
  const metadata = JSON.parse(await fs.readFile(exported.metadata, 'utf8'));
  const anchor = await imageRecord(physicalRunDir, anchorReport.path, 'approved-anchor');
  const normalizedFrames = await Promise.all(normalized.frames.map(async (file, frame) => imageRecord(physicalRunDir, file, 'normalized-frame', {
    frame,
    source: await relative(physicalRunDir, normalized.measurements[frame].input),
    sourceSha256: await sha256(normalized.measurements[frame].input),
    measurement: Object.fromEntries(['frameId', 'sourceLandmark', 'canonicalLandmark', 'landmarkDrift', 'left', 'top', 'width', 'height', 'bottom', 'scaleFactor', 'componentCount', 'retainedComponentCount', 'retainedPixelCount', 'retentionPolicy', 'minimumComponentPixels'].filter((key) => normalized.measurements[frame][key] !== undefined).map((key) => [key, structuredClone(normalized.measurements[frame][key])]))
  })));
  let delivery;
  if (exported.clips !== undefined) {
    const clips = [];
    for (const [id, clip] of Object.entries(exported.clips)) clips.push({
      id,
      loopMode: clip.loopMode,
      durations: [...clip.durations],
      runtimeFrames: await Promise.all(clip.runtimeFrames.map((file, frame) => imageRecord(physicalRunDir, file, 'runtime-frame', { frame, frameId: clip.frames[frame]?.id }))),
      sheet: await imageRecord(physicalRunDir, clip.sheet, 'sheet'),
      metadata: await fileRecord(physicalRunDir, clip.metadata, 'clip-metadata'),
      preview: await fileRecord(physicalRunDir, clip.preview, 'preview')
    });
    delivery = {
      kind: 'contract-animation',
      canonicalPivot: normalized.canonicalPivot,
      normalizedFrames,
      clips,
      metadata: await fileRecord(physicalRunDir, exported.metadata, 'contract-index')
    };
  } else {
    const runtimeFrames = await Promise.all(exported.runtimeFrames.map((file, frame) => imageRecord(physicalRunDir, file, 'runtime-frame', { frame, sourceSha256: metadata.sources[frame].sha256 })));
    delivery = {
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
      sheet: await imageRecord(physicalRunDir, exported.sheet, 'sheet'),
      metadata: await fileRecord(physicalRunDir, exported.metadata, 'metadata'),
      preview: await fileRecord(physicalRunDir, exported.preview, 'preview')
    };
  }
  const document = {
    version: 1,
    runId,
    manifest: { path: 'manifest.json', sha256: await sha256(manifestPath) },
    configSha256: stableHash(effective),
    ...(selectedProvenance ? { provenance: selectedProvenance } : {}),
    anchor,
    delivery,
    expected: exported.clips !== undefined ? { contractIndex: metadata } : { metadata }
  };
  const file = path.join(runDir, CONTRACT_FILE);
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  await atomicNew(file, contents);
  return { path: file, sha256: crypto.createHash('sha256').update(contents).digest('hex'), document };
}

export async function sealCorrectionContract({ projectDir, runDir, runId, contract }) {
  const receiptPath = path.join(runDir, RECEIPT_FILE);
  const reportPath = path.join(runDir, 'report.json');
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  if (report.runId !== runId || report.correctionContract?.sha256 !== contract.sha256 || !reportMatchesProvenance(report, contract.document.provenance)) throw new Error('correction receipt requires the immutable report and approval provenance binding');
  const manifest = JSON.parse(await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8'));
  await authenticateApprovalAncestry({ projectDir, runDir, runId, manifest, manifestSha256: contract.document.manifest.sha256, provenance: contract.document.provenance, report });
  let receiptExists = true;
  try { await fs.lstat(receiptPath); }
  catch (error) {
    if (error.code === 'ENOENT') receiptExists = false;
    else throw error;
  }
  if (receiptExists) {
    try {
      const existing = await readSignedState({ projectDir: path.resolve(projectDir), file: receiptPath, domain: RECEIPT_DOMAIN });
      if (existing.payload.runId !== runId || existing.payload.contractSha256 !== contract.sha256) throw new Error('existing correction receipt is invalid');
      return { path: receiptPath, sha256: await sha256(receiptPath), signature: existing.signature };
    } catch (error) {
      if (error.message === 'signed state signature mismatch') throw new Error('existing correction receipt is invalid');
      throw error;
    }
  }
  const payload = {
    version: 1,
    projectId: stableHash({ root: await fs.realpath(projectDir) }),
    runId,
    manifestSha256: contract.document.manifest.sha256,
    configSha256: contract.document.configSha256,
    reportSha256: await sha256(reportPath),
    contractSha256: contract.sha256,
    inventorySha256: stableHash({ provenance: contract.document.provenance ?? null, anchor: contract.document.anchor, delivery: contract.document.delivery, expected: contract.document.expected }),
    createdAt: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString('hex')
  };
  let published;
  try { published = await writeSignedState({ projectDir: path.resolve(projectDir), file: receiptPath, domain: RECEIPT_DOMAIN, payload, createKey: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try { existing = await readSignedState({ projectDir: path.resolve(projectDir), file: receiptPath, domain: RECEIPT_DOMAIN }); }
    catch { throw new Error('concurrent correction receipt publication conflict'); }
    if (existing.payload.runId !== runId || existing.payload.contractSha256 !== contract.sha256) throw new Error('concurrent correction receipt publication conflict');
    return { path: receiptPath, sha256: await sha256(receiptPath), signature: existing.signature };
  }
  return { path: receiptPath, sha256: await sha256(receiptPath), signature: published.document.signature };
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

function contractTargetPath(delivery, failure) {
  if (!failure) return null;
  const flatRuntime = delivery.clips.flatMap((clip) => clip.runtimeFrames);
  const clip = failure.clipId ? delivery.clips.find((item) => item.id === failure.clipId) : delivery.clips[0];
  const stage = String(failure.stage ?? failure.target ?? '');
  if (stage.includes('sheet') || failure.code === 'FRAME_BLEED') return clip?.sheet.path;
  if (stage.includes('preview') || failure.code === 'PREVIEW_MISMATCH') return clip?.preview.path;
  if (stage.includes('metadata') || ['METADATA_MISMATCH', 'TIMING_MISMATCH', 'SOURCE_HASH_MISMATCH'].includes(failure.code)) return delivery.metadata.path;
  if (stage === 'runtime' || ['BACKGROUND_REMAINS', 'INTERMEDIATE_COLORS'].includes(failure.code)) return flatRuntime[failure.frame ?? 0]?.path;
  return delivery.normalizedFrames[failure.frame ?? 0]?.path;
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

async function containedSelector(runDir, relative, label) {
  if (typeof relative !== 'string' || relative === '' || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\') || relative === '..' || relative.startsWith('../') || path.posix.normalize(relative) !== relative) throw new Error(`${label} path escaped the immutable run`);
  const root = await fs.realpath(runDir);
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`${label} selector does not exist`); throw error; }
    if (stat.isSymbolicLink()) throw new Error(`${label} must not contain symlinks`);
  }
  const stat = await fs.lstat(current);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error(`${label} must be a regular single-link file`);
  const containment = path.relative(root, await fs.realpath(current));
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error(`${label} escaped the immutable run`);
  return current;
}

async function authenticateApprovalAncestry({ projectDir, runDir, runId, manifest, manifestSha256, provenance, report }) {
  const selected = approvalProvenance(provenance);
  if (!selected?.snapReceipt || !selected?.frameApproval) {
    if (manifest.animationContract) throw new Error('contracted correction ancestry selectors are required');
    return selected;
  }
  if (!manifest.animationContract || stableHash(manifest.animationContract.document) !== manifest.animationContract.sha256 || selected.animationContractSha256 !== manifest.animationContract.sha256) throw new Error('contracted correction animation contract ancestry mismatch');
  validateAnimationContract(manifest.animationContract.document);
  if (!reportMatchesProvenance(report, selected)) throw new Error('contracted correction report ancestry mismatch');
  const receiptFile = await containedSelector(runDir, selected.snapReceipt.path, 'contracted correction snap receipt');
  const approvalFile = await containedSelector(runDir, selected.frameApproval.path, 'contracted correction frame approval');
  const verifiedReceipt = await verifySnapReceipt({
    projectDir,
    file: receiptFile,
    expectedRun: { runId, runDir, manifestSha256 },
    expectedContract: manifest.animationContract
  });
  if (verifiedReceipt.sha256 !== selected.snapReceipt.sha256 || verifiedReceipt.sha256 !== selected.snapReceiptSha256 || verifiedReceipt.document.payload.toolProvenanceVerified !== selected.toolProvenanceVerified) throw new Error('contracted correction snap receipt ancestry mismatch');
  const verifiedApproval = await verifyFrameApproval({
    projectDir,
    file: approvalFile,
    contract: manifest.animationContract,
    snapReceipt: { path: receiptFile, sha256: verifiedReceipt.sha256 },
    version: selected.frameApproval.version
  });
  if (verifiedApproval.sha256 !== selected.frameApproval.sha256 || verifiedApproval.sha256 !== selected.frameApprovalSha256) throw new Error('contracted correction frame approval ancestry mismatch');
  return { ...selected, verifiedReceipt, verifiedApproval, receiptFile, approvalFile };
}

export async function loadCorrectionContext({ projectDir, runId, contractSha256, receiptSha256, receiptSignature: suppliedSignature, declaredFailure, ...unknown }) {
  if (Object.keys(unknown).length > 0) throw new Error('caller may not choose correction ancestor paths');
  const runDir = path.join(path.resolve(projectDir), '.pixel-sprite-pipeline', 'runs', runId);
  const receiptPath = path.join(runDir, RECEIPT_FILE);
  if (!/^[a-f0-9]{64}$/.test(receiptSha256 ?? '') || await sha256(receiptPath) !== receiptSha256) throw new Error('correction receipt hash mismatch');
  await secureArtifact(runDir, { role: 'signed-receipt', path: RECEIPT_FILE, sha256: receiptSha256 });
  let receipt;
  try { receipt = await readSignedState({ projectDir: path.resolve(projectDir), file: receiptPath, domain: RECEIPT_DOMAIN }); }
  catch (error) {
    if (error.message === 'signed state signature mismatch') throw new Error('correction receipt signature mismatch');
    throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.signature ?? '') || suppliedSignature !== receipt.signature) throw new Error('correction receipt signature mismatch');
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
  const provenance = approvalProvenance(contract.provenance);
  if (!reportMatchesProvenance(report, provenance)) throw new Error('correction contract approval provenance does not match the immutable report');
  const inventorySha256 = stableHash({ provenance: provenance ?? null, anchor: contract.anchor, delivery: contract.delivery, expected: contract.expected });
  if (receipt.payload?.version !== 1 || receipt.payload.projectId !== stableHash({ root: await fs.realpath(projectDir) }) || receipt.payload.runId !== runId || receipt.payload.manifestSha256 !== contract.manifest.sha256 || receipt.payload.configSha256 !== contract.configSha256 || receipt.payload.reportSha256 !== reportHash || receipt.payload.contractSha256 !== contractSha256 || receipt.payload.inventorySha256 !== inventorySha256) throw new Error('correction receipt binding mismatch');
  if (manifest.runId !== runId || report.manifestSha256 !== contract.manifest.sha256 || stableHash(config) !== contract.configSha256) throw new Error('correction contract manifest/config mismatch');
  const ancestry = await authenticateApprovalAncestry({ projectDir: path.resolve(projectDir), runDir, runId, manifest, manifestSha256: contract.manifest.sha256, provenance, report });
  if (contract.delivery.kind === 'contract-animation') {
    const selectedTarget = contractTargetPath(contract.delivery, declaredFailure);
    const records = [contract.anchor, ...contract.delivery.normalizedFrames, contract.delivery.metadata, ...contract.delivery.clips.flatMap((clip) => [...clip.runtimeFrames, clip.sheet, clip.metadata, clip.preview])];
    const paths = new Map();
    for (const record of records) paths.set(record.path, await secureArtifact(runDir, record, { allowHashMismatch: record.path === selectedTarget }));
    for (const frame of contract.delivery.normalizedFrames) paths.set(frame.source, await secureArtifact(runDir, { role: 'normalization-source', path: frame.source, sha256: frame.sourceSha256 }));
    const normalized = {
      frames: contract.delivery.normalizedFrames.map((record) => paths.get(record.path)),
      canonicalPivot: contract.delivery.canonicalPivot,
      scaleFactor: 1,
      measurements: contract.delivery.normalizedFrames.map((record) => ({ input: paths.get(record.source), output: paths.get(record.path), ...structuredClone(record.measurement) }))
    };
    const clips = Object.fromEntries(contract.delivery.clips.map((clip) => [clip.id, {
      runtimeFrames: clip.runtimeFrames.map((record) => paths.get(record.path)),
      sheet: paths.get(clip.sheet.path), metadata: paths.get(clip.metadata.path), preview: paths.get(clip.preview.path),
      frames: clip.runtimeFrames.map((record) => ({ id: record.frameId, file: paths.get(record.path) })), durations: [...clip.durations], loopMode: clip.loopMode
    }]));
    return {
      runDir, contractPath, contract, config, manifest, report, reportSha256: reportHash, receipt, receiptSha256, provenance, ancestry,
      contractAnimation: true, selectedTarget,
      request: {
        anchorReport: { path: paths.get(contract.anchor.path), sha256: contract.anchor.sha256 }, normalized,
        exported: { clips, metadata: paths.get(contract.delivery.metadata.path) }, semanticEvidence: [],
        animationContract: manifest.animationContract,
        frameApproval: { projectDir: path.resolve(projectDir), file: ancestry.approvalFile, snapReceipt: { path: ancestry.receiptFile, sha256: ancestry.verifiedReceipt.sha256 }, version: provenance.frameApproval.version }
      },
      repairEligibility: { authenticated: true, automatic: false, reason: 'Corrected snapped pixels require a new signed receipt and frame approval revision.' }
    };
  }
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
    runDir, contractPath, contract, config, manifest, report, reportSha256: reportHash, receipt, receiptSha256, provenance,
    expected: { metadata: structuredClone(contract.expected.metadata), preview: { runtimeFrames: contract.delivery.runtimeFrames.map((record) => paths.get(record.path)), durations: contract.delivery.durations }, sheet: { runtimeFrames: contract.delivery.runtimeFrames.map((record) => paths.get(record.path)), columns: contract.delivery.columns, frameSize: contract.delivery.frameSize } },
    request: {
      anchorReport: { path: paths.get(contract.anchor.path), sha256: contract.anchor.sha256 },
      normalized,
      exported: { runtimeFrames: contract.delivery.runtimeFrames.map((record) => paths.get(record.path)), sheet: paths.get(contract.delivery.sheet.path), metadata: paths.get(contract.delivery.metadata.path), preview: paths.get(contract.delivery.preview.path) },
      semanticEvidence: []
    }
  };
}
