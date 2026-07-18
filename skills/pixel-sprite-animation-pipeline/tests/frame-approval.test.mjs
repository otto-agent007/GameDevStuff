import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAnimationContract } from '../scripts/lib/animation-contract.mjs';
import { writeFrameApproval, verifyFrameApproval } from '../scripts/lib/frame-approval.mjs';
import { writeManualHandoffReceipt, writeSnapReceipt } from '../scripts/lib/snap-receipt.mjs';
import { stableHash, writeSignedState } from '../scripts/lib/state-auth.mjs';

const HASH = (letter) => letter.repeat(64);

function contractDocument() {
  const rgba = [[0, 0, 0, 0], [18, 34, 51, 255], [255, 255, 255, 255]];
  return {
    version: 1, anchor: { sha256: HASH('a'), traitReferenceSha256: [HASH('b')] },
    sizes: { canonical: [128, 128], generation: [1024, 1024], runtime: [256, 256], pixelSize: 8 }, pivot: { x: 64, y: 112 }, baseline: 111,
    palette: { rgba, sha256: stableHash(rgba), snapperPaletteHex: ['122233', 'ffffff'] },
    clips: [{ id: 'idle', loopMode: 'loop', loopTransition: { fromFrameId: 'idle-02', toFrameId: 'idle-01', reviewCheckpoint: 'motion' }, frames: [
      { id: 'idle-01', pose: 'rest', duration: 100, landmarkSemantic: { name: 'character-root', target: { x: 64, y: 112 } } },
      { id: 'idle-02', pose: 'breathe', duration: 120, landmarkSemantic: { name: 'character-root', target: { x: 64, y: 112 } } }
    ] }],
    review: { checkpoints: ['identity', 'motion'], approvers: ['artist@example.test'] }
  };
}

async function fixture() {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-frame-approval-'));
  const runDir = path.join(projectDir, 'run');
  await fs.mkdir(path.join(projectDir, '.pixel-sprite-pipeline'), { recursive: true, mode: 0o700 });
  await fs.mkdir(runDir);
  const contractFile = path.join(projectDir, 'animation-contract.json');
  await fs.writeFile(contractFile, `${JSON.stringify(contractDocument(), null, 2)}\n`);
  const contract = await loadAnimationContract(contractFile);
  const input = path.join(projectDir, 'source.png');
  const outputOne = path.join(runDir, 'idle-01.png');
  const outputTwo = path.join(runDir, 'idle-02.png');
  await Promise.all([fs.writeFile(input, 'source'), fs.writeFile(outputOne, 'snapped-1'), fs.writeFile(outputTwo, 'snapped-2')]);
  const snapReceipt = await writeSnapReceipt({
    projectDir, run: { id: 'run-1', outputDir: runDir, manifestSha256: HASH('d') }, contract,
    inputs: [input], outputs: [outputOne, outputTwo], args: ['16'],
    identity: { origin: 'managed-cache', sha256: HASH('e'), size: 1, version: '1.2.3', helpSha256: HASH('f'), fixtureRgbaSha256: HASH('0'), pinnedReleaseTag: null, upstreamCommit: null }
  });
  const frames = snapReceipt.document.payload.outputs.map((output, index) => ({ id: contract.document.clips[0].frames[index].id, path: output.path, sha256: output.sha256 }));
  const approvals = [
    { frameId: 'idle-01', landmark: { x: 61, y: 109 }, approved: true, approvedBy: 'artist@example.test', checkpoints: ['identity', 'motion'] },
    { frameId: 'idle-02', landmark: { x: 62, y: 110 }, approved: true, approvedBy: 'artist@example.test', checkpoints: ['identity', 'motion'] }
  ];
  return { projectDir, runDir, contract, snapReceipt, frames, approvals };
}

test('frame approval is created only after snap and covers every ordered output hash', async () => {
  const value = await fixture();
  const approval = await writeFrameApproval({ ...value, version: 1 });
  assert.equal(approval.document.payload.snapReceiptSha256, value.snapReceipt.sha256);
  assert.deepEqual(approval.document.payload.frames.map((item) => item.landmark), [{ x: 61, y: 109 }, { x: 62, y: 110 }]);
  await assert.rejects(writeFrameApproval({ ...value, approvals: value.approvals.slice(1), version: 2 }), /approval for every snapped frame/);
});

test('frame approval rejects a symlinked signed snap receipt', async (t) => {
  const value = await fixture();
  const alias = path.join(value.runDir, 'snap-receipt-alias.json');
  try { await fs.symlink(path.basename(value.snapReceipt.path), alias); }
  catch (error) { if (error.code === 'EPERM') { t.skip('file links unavailable'); return; } throw error; }

  await assert.rejects(
    writeFrameApproval({ ...value, snapReceipt: { ...value.snapReceipt, path: alias }, version: 1 }),
    /snap receipt.*regular|symlink|single-link/i
  );
});

test('approval verification rejects tampered, extra, missing, duplicate, and mismatched ordered frames', async () => {
  const value = await fixture();
  const approval = await writeFrameApproval({ ...value, version: 1 });
  await assert.rejects(verifyFrameApproval({ projectDir: value.projectDir, file: approval.path, contract: value.contract, snapReceipt: value.snapReceipt }), /version selection/i);
  await verifyFrameApproval({ projectDir: value.projectDir, file: approval.path, contract: value.contract, snapReceipt: value.snapReceipt, version: 1 });

  const tampered = JSON.parse(await fs.readFile(approval.path, 'utf8'));
  tampered.payload.frames[0].landmark.x = 63;
  await fs.writeFile(approval.path, `${JSON.stringify(tampered)}\n`);
  await assert.rejects(verifyFrameApproval({ projectDir: value.projectDir, file: approval.path, contract: value.contract, snapReceipt: value.snapReceipt, version: 1 }), /signature/i);

  const second = await fixture();
  const signed = await writeFrameApproval({ ...second, version: 1 });
  for (const mutate of [
    (payload) => { payload.extra = true; },
    (payload) => { payload.frames.pop(); },
    (payload) => { payload.frames[1].id = payload.frames[0].id; },
    (payload) => { [payload.frames[0], payload.frames[1]] = [payload.frames[1], payload.frames[0]]; }
  ]) {
    const payload = structuredClone(signed.document.payload);
    mutate(payload);
    const file = path.join(second.runDir, `malformed-${crypto.randomUUID()}.json`);
    await writeSignedState({ projectDir: second.projectDir, file, domain: 'pixel-sprite-frame-approval/v1', payload });
    await assert.rejects(verifyFrameApproval({ projectDir: second.projectDir, file, contract: second.contract, snapReceipt: second.snapReceipt, version: 1 }), /schema|frame|order|coverage|approval/i);
  }
});

test('numbered approval revisions are immutable and selected explicitly', async () => {
  const value = await fixture();
  const first = await writeFrameApproval({ ...value, version: 1 });
  const second = await writeFrameApproval({ ...value, version: 2, approvals: value.approvals.map((item) => ({ ...item, landmark: { ...item.landmark, x: item.landmark.x + 1 } })) });
  assert.match(first.path, /frame-approval-01\.json$/);
  assert.match(second.path, /frame-approval-02\.json$/);
  await assert.rejects(writeFrameApproval({ ...value, version: 1 }), /EEXIST|immutable|versioned/i);
  await assert.rejects(verifyFrameApproval({ projectDir: value.projectDir, file: second.path, contract: value.contract, snapReceipt: value.snapReceipt, version: 1 }), /version selection/i);

  const relocated = await fixture();
  const signed = await writeFrameApproval({ ...relocated, version: 1 });
  const renamed = path.join(relocated.runDir, 'chosen-approval.json');
  await fs.rename(signed.path, renamed);
  await assert.rejects(verifyFrameApproval({ projectDir: relocated.projectDir, file: renamed, contract: relocated.contract, snapReceipt: relocated.snapReceipt, version: 1 }), /numbered|versioned/i);
});

test('frame approvals reject a signed escaped output chain but retain manual approval provenance', async () => {
  const escaped = await fixture();
  const outside = path.join(escaped.projectDir, 'escaped.png');
  await fs.copyFile(path.join(escaped.runDir, 'idle-01.png'), outside);
  const payload = structuredClone(escaped.snapReceipt.document.payload);
  payload.outputs[0].path = '../escaped.png';
  const receiptFile = path.join(escaped.runDir, 'escaped-receipt.json');
  await writeSignedState({ projectDir: escaped.projectDir, file: receiptFile, domain: 'pixel-sprite-snap-receipt/v1', payload });
  const escapedFrames = structuredClone(escaped.frames);
  escapedFrames[0].path = '../escaped.png';
  await assert.rejects(writeFrameApproval({ ...escaped, snapReceipt: { path: receiptFile }, frames: escapedFrames, version: 1 }), /output|contained|escape/i);

  const manual = await fixture();
  const handoff = path.join(manual.runDir, 'handoff.json');
  await fs.writeFile(handoff, '{"version":1}\n');
  const receipt = await writeManualHandoffReceipt({
    projectDir: manual.projectDir, run: { id: 'manual-1', outputDir: manual.runDir, manifestSha256: HASH('d') }, handoff,
    inputs: [path.join(manual.projectDir, 'source.png')], outputs: [path.join(manual.runDir, 'idle-01.png'), path.join(manual.runDir, 'idle-02.png')]
  });
  const approval = await writeFrameApproval({ ...manual, snapReceipt: receipt, version: 1 });
  assert.equal(receipt.document.payload.toolProvenanceVerified, false);
  assert.equal(approval.document.payload.snapReceiptSha256, receipt.sha256);
});
