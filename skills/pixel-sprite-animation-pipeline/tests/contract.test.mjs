import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { createCorrectionContract, loadCorrectionContext, sealCorrectionContract, stableHash } from '../scripts/lib/contract.mjs';
import { exportAnimation } from '../scripts/lib/export.mjs';
import { inspectImage } from '../scripts/lib/inspect.mjs';
import { sha256 } from '../scripts/lib/image.mjs';
import { normalizeFrames } from '../scripts/lib/normalize.mjs';
import { makeAnchor } from './helpers/fixtures.mjs';

async function fixture() {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-contract-'));
  const runDir = path.join(project, '.pixel-sprite-pipeline', 'runs', 'run-1');
  await fs.mkdir(runDir, { recursive: true });
  const source = path.join(runDir, 'source.png');
  await makeAnchor(source);
  const normalized = await normalizeFrames({ inputs: [source], outputDir: path.join(runDir, 'normalized'), config: DEFAULT_CONFIG });
  const exported = await exportAnimation({ frames: normalized.frames, outputDir: path.join(runDir, 'runtime'), config: DEFAULT_CONFIG, columns: 1, durations: [100], name: 'animation' });
  const manifest = { version: 1, runId: 'run-1', config: DEFAULT_CONFIG, inputs: [{ id: 'source.png' }] };
  await fs.writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const provenance = {
    animationContractSha256: 'a'.repeat(64), snapReceiptSha256: 'b'.repeat(64),
    frameApprovalSha256: 'c'.repeat(64), toolProvenanceVerified: false
  };
  const contract = await createCorrectionContract({ runDir, runId: 'run-1', config: DEFAULT_CONFIG, anchorReport: await inspectImage(source), normalized, exported, provenance });
  const manifestSha256 = await sha256(path.join(runDir, 'manifest.json'));
  await fs.writeFile(path.join(runDir, 'report.json'), `${JSON.stringify({ runId: 'run-1', manifestSha256, correctionContract: { path: 'correction-contract-v1.json', sha256: contract.sha256 }, ...provenance }, null, 2)}\n`);
  const receipts = await Promise.all(Array.from({ length: 8 }, () => sealCorrectionContract({ projectDir: project, runDir, runId: 'run-1', contract })));
  const [receipt] = receipts;
  for (const concurrentReceipt of receipts) assert.deepEqual(concurrentReceipt, receipt);
  return { project, runDir, source, normalized, exported, contract, receipt, provenance };
}

test('correction contracts authenticate the complete animation approval chain before repair', async () => {
  const value = await fixture();
  assert.deepEqual(value.contract.document.provenance, value.provenance);
  const loaded = await loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature });
  assert.deepEqual(loaded.provenance, value.provenance);

  const reportFile = path.join(value.runDir, 'report.json');
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  report.frameApprovalSha256 = 'd'.repeat(64);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  await assert.rejects(loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature }), /receipt|approval|provenance|report/i);
});

test('correction contract preserves stable hash compatibility', () => {
  assert.equal(stableHash({ z: 1, a: { y: 2, x: 3 } }), stableHash({ a: { x: 3, y: 2 }, z: 1 }));
});

test('immutable correction contract authenticates ancestors and permits only the declared corrupted target', async () => {
  const value = await fixture();
  const loaded = await loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature });
  assert.equal(loaded.request.normalized.frames[0], value.normalized.frames[0]);
  assert.equal(JSON.stringify(loaded.contract).includes(value.project), false);

  await sharp(value.normalized.frames[0]).extract({ left: 0, top: 0, width: 127, height: 128 }).png().toFile(`${value.normalized.frames[0]}.changed`);
  await fs.rename(`${value.normalized.frames[0]}.changed`, value.normalized.frames[0]);
  await assert.rejects(loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature }), /artifact hash mismatch/);
  const targeted = await loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature, declaredFailure: { code: 'CANVAS_SIZE', stage: 'canonical', frame: 0 } });
  assert.equal(targeted.request.normalized.frames[0], value.normalized.frames[0]);

  const substitute = path.join(value.runDir, 'substitute.png');
  await makeAnchor(substitute);
  await assert.rejects(loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature, declaredFailure: { code: 'CANVAS_SIZE', stage: 'canonical', frame: 0 }, targetOverride: substitute }), /unknown correction request field|caller may not choose/);
});

test('metadata expectations remain immutable when failed metadata fields are tampered', async () => {
  const value = await fixture();
  const expected = structuredClone(value.contract.document.expected.metadata);
  const damaged = JSON.parse(await fs.readFile(value.exported.metadata, 'utf8'));
  damaged.frameSize.width = 99;
  damaged.columns = 7;
  damaged.palette.colors = [];
  damaged.sources[0].sha256 = '0'.repeat(64);
  await fs.writeFile(value.exported.metadata, `${JSON.stringify(damaged)}\n`);
  const loaded = await loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature, declaredFailure: { code: 'METADATA_MISMATCH', stage: 'metadata' } });
  assert.deepEqual(loaded.expected.metadata, expected);
  assert.notDeepEqual(loaded.expected.metadata, damaged);
});

test('replacement contract is rejected even when caller supplies its new hash', async () => {
  const value = await fixture();
  await fs.appendFile(value.contract.path, ' ');
  await assert.rejects(loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: await sha256(value.contract.path), receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature, declaredFailure: { code: 'CANVAS_SIZE', stage: 'canonical', frame: 0 } }), /receipt|not bound/);
});

test('signed receipt fails closed when missing stale or jointly replaced with report and contract', async () => {
  const value = await fixture();
  const key = path.join(value.project, '.pixel-sprite-pipeline', 'keys', 'correction-signing-v1.key');
  const keyStat = await fs.lstat(key);
  assert.equal(keyStat.isFile() && !keyStat.isSymbolicLink() && keyStat.nlink === 1, true);
  if (process.platform !== 'win32') assert.equal(keyStat.mode & 0o077, 0);
  assert.equal(JSON.stringify(value.contract.document).includes('correction-signing-v1.key'), false);

  await assert.rejects(loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: '0'.repeat(64), receiptSignature: value.receipt.signature }), /receipt/);
  const receiptPath = value.receipt.path;
  const document = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  document.payload.contractSha256 = '1'.repeat(64);
  document.signature = '2'.repeat(64);
  await fs.writeFile(receiptPath, `${JSON.stringify(document)}\n`);
  await assert.rejects(loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: '1'.repeat(64), receiptSha256: await sha256(receiptPath), receiptSignature: document.signature }), /receipt signature|contract hash/);
});

test('missing project signing key requires explicit revalidation and receipt reissue', async () => {
  const value = await fixture();
  const key = path.join(value.project, '.pixel-sprite-pipeline', 'keys', 'correction-signing-v1.key');
  await fs.rm(key);
  await assert.rejects(
    loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature }),
    /revalidation and explicit receipt reissue/
  );
});

test('signed correction loading rejects group or world-accessible key directories', { skip: process.platform === 'win32' }, async () => {
  const value = await fixture();
  const keys = path.join(value.project, '.pixel-sprite-pipeline', 'keys');
  await fs.chmod(keys, 0o777);
  await assert.rejects(
    loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature }),
    /key directory.*permissions|unsafe.*directory/i
  );
});

test('signed correction loading rejects a group or world-writable project state directory', { skip: process.platform === 'win32' }, async () => {
  const value = await fixture();
  const state = path.join(value.project, '.pixel-sprite-pipeline');
  await fs.chmod(state, 0o777);
  await assert.rejects(
    loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature }),
    /state directory.*permissions|unsafe.*directory/i
  );
});

test('signed correction loading rejects a symlinked project state path component', async () => {
  const value = await fixture();
  const state = path.join(value.project, '.pixel-sprite-pipeline');
  const moved = path.join(value.project, 'moved-pixel-sprite-state');
  await fs.rename(state, moved);
  await fs.symlink(moved, state, 'dir');
  await assert.rejects(
    loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature }),
    /state directory.*real directory|symlink/i
  );
});

test('signed correction loading rejects signing keys and key directories owned by another uid', { skip: process.platform === 'win32' || typeof process.geteuid !== 'function' || typeof process.getegid !== 'function' || process.geteuid() !== 0 }, async (context) => {
  const keyValue = await fixture();
  const key = path.join(keyValue.project, '.pixel-sprite-pipeline', 'keys', 'correction-signing-v1.key');
  try { await fs.chown(key, 1, process.getegid()); }
  catch (error) {
    if (['EINVAL', 'EPERM', 'ENOSYS'].includes(error.code)) {
      context.skip(`filesystem cannot create a wrong-owner fixture: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    loadCorrectionContext({ projectDir: keyValue.project, runId: 'run-1', contractSha256: keyValue.contract.sha256, receiptSha256: keyValue.receipt.sha256, receiptSignature: keyValue.receipt.signature }),
    /signing key.*owned|owner/i
  );

  const directoryValue = await fixture();
  const keys = path.join(directoryValue.project, '.pixel-sprite-pipeline', 'keys');
  await fs.chown(keys, 1, process.getegid());
  await assert.rejects(
    loadCorrectionContext({ projectDir: directoryValue.project, runId: 'run-1', contractSha256: directoryValue.contract.sha256, receiptSha256: directoryValue.receipt.sha256, receiptSignature: directoryValue.receipt.signature }),
    /key directory.*owned|owner/i
  );
});

test('secure existing state directory key directory and signing key remain usable', async () => {
  const value = await fixture();
  const state = path.join(value.project, '.pixel-sprite-pipeline');
  const keys = path.join(state, 'keys');
  const key = path.join(keys, 'correction-signing-v1.key');
  const [stateStat, keysStat, keyStat] = await Promise.all([fs.lstat(state), fs.lstat(keys), fs.lstat(key)]);
  assert.equal(stateStat.isDirectory() && !stateStat.isSymbolicLink(), true);
  assert.equal(keysStat.isDirectory() && !keysStat.isSymbolicLink(), true);
  assert.equal(keyStat.isFile() && !keyStat.isSymbolicLink() && keyStat.nlink === 1, true);
  if (process.platform !== 'win32') {
    assert.equal(stateStat.mode & 0o022, 0);
    assert.equal(keysStat.mode & 0o777, 0o700);
    assert.equal(keyStat.mode & 0o777, 0o600);
    if (typeof process.geteuid === 'function') assert.deepEqual([stateStat.uid, keysStat.uid, keyStat.uid], [process.geteuid(), process.geteuid(), process.geteuid()]);
  }
  const loaded = await loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature });
  assert.equal(loaded.contract.runId, 'run-1');
});

test('an existing owner-only key directory remains usable without republishing the key', { skip: process.platform === 'win32' }, async () => {
  const value = await fixture();
  const keys = path.join(value.project, '.pixel-sprite-pipeline', 'keys');
  await fs.chmod(keys, 0o500);
  const resealed = await sealCorrectionContract({ projectDir: value.project, runDir: value.runDir, runId: 'run-1', contract: value.contract });
  assert.deepEqual(resealed, value.receipt);
  const loaded = await loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature });
  assert.equal(loaded.contract.runId, 'run-1');
});

test('signed correction loading rejects a key directory symlink', async () => {
  const value = await fixture();
  const state = path.join(value.project, '.pixel-sprite-pipeline');
  const keys = path.join(state, 'keys');
  const moved = path.join(state, 'moved-keys');
  await fs.rename(keys, moved);
  await fs.symlink(moved, keys, 'dir');
  await assert.rejects(
    loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature }),
    /key directory.*real directory|symlink/i
  );
});

test('signed correction loading requires an existing key to remain exactly 0600', { skip: process.platform === 'win32' }, async () => {
  const value = await fixture();
  const key = path.join(value.project, '.pixel-sprite-pipeline', 'keys', 'correction-signing-v1.key');
  await fs.chmod(key, 0o400);
  await assert.rejects(
    loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature }),
    /signing key permissions.*unsafe/i
  );
});

test('signed correction loading rejects a multiply-linked signing key', async () => {
  const value = await fixture();
  const key = path.join(value.project, '.pixel-sprite-pipeline', 'keys', 'correction-signing-v1.key');
  await fs.link(key, path.join(value.project, 'linked-signing-key'));
  await assert.rejects(
    loadCorrectionContext({ projectDir: value.project, runId: 'run-1', contractSha256: value.contract.sha256, receiptSha256: value.receipt.sha256, receiptSignature: value.receipt.signature }),
    /signing key permissions or file type are unsafe/i
  );
});

test('contract containment compares canonical physical paths while recording slash-portable paths', async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-contract-alias-'));
  const runDir = path.join(project, '.pixel-sprite-pipeline', 'runs', 'alias-run');
  await fs.mkdir(runDir, { recursive: true });
  const source = path.join(runDir, 'source.png');
  await makeAnchor(source);
  const normalized = await normalizeFrames({ inputs: [source], outputDir: path.join(runDir, 'normalized'), config: DEFAULT_CONFIG });
  const exported = await exportAnimation({ frames: normalized.frames, outputDir: path.join(runDir, 'runtime'), config: DEFAULT_CONFIG, columns: 1, durations: [100], name: 'animation' });
  await fs.writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify({ version: 1, runId: 'alias-run', config: DEFAULT_CONFIG, inputs: [] })}\n`);
  const alias = path.join(project, 'physical-run-alias');
  try { await fs.symlink(runDir, alias, 'dir'); }
  catch (error) {
    if (['EPERM', 'ENOSYS'].includes(error.code)) { context.skip('directory aliases unavailable'); return; }
    throw error;
  }
  const anchorReport = await inspectImage(path.join(alias, 'source.png'));
  const contract = await createCorrectionContract({ runDir, runId: 'alias-run', config: DEFAULT_CONFIG, anchorReport, normalized, exported });
  assert.equal(contract.document.anchor.path, 'source.png');
  assert.ok(contract.document.delivery.normalizedFrames.every((frame) => !frame.path.includes('\\')));
});

test('contract containment rejects an external original anchor instead of confusing it with the staged approved anchor', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-contract-external-'));
  const runDir = path.join(project, '.pixel-sprite-pipeline', 'runs', 'external-run');
  await fs.mkdir(runDir, { recursive: true });
  const staged = path.join(runDir, 'approved-anchor.png');
  const external = path.join(project, 'original-anchor.png');
  await makeAnchor(staged);
  await makeAnchor(external);
  const normalized = await normalizeFrames({ inputs: [staged], outputDir: path.join(runDir, 'normalized'), config: DEFAULT_CONFIG });
  const exported = await exportAnimation({ frames: normalized.frames, outputDir: path.join(runDir, 'runtime'), config: DEFAULT_CONFIG, columns: 1, durations: [100], name: 'animation' });
  await fs.writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify({ version: 1, runId: 'external-run', config: DEFAULT_CONFIG, inputs: [] })}\n`);
  await assert.rejects(
    createCorrectionContract({ runDir, runId: 'external-run', config: DEFAULT_CONFIG, anchorReport: await inspectImage(external), normalized, exported }),
    /artifact escaped the run/
  );
});

test('Windows canonical containment is case-insensitive, slash-portable, and drive-safe', async () => {
  const module = await import('../scripts/lib/contract.mjs');
  assert.equal(typeof module.portableContainedPath, 'function');
  assert.equal(
    module.portableContainedPath('C:\\Users\\RUNNER~1\\project\\run', 'c:\\users\\runner~1\\project\\run\\source\\anchor.png', path.win32),
    'source/anchor.png'
  );
  assert.throws(() => module.portableContainedPath('C:\\project\\run', 'D:\\project\\run\\anchor.png', path.win32), /artifact escaped the run/);
  assert.throws(() => module.portableContainedPath('C:\\project\\run', 'C:\\project\\run-sibling\\anchor.png', path.win32), /artifact escaped the run/);
});
