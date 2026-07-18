import fs from 'node:fs/promises';
import path from 'node:path';
import { validateAnimationContract } from './animation-contract.mjs';
import { sha256 } from './image.mjs';
import { verifySnapReceipt } from './snap-receipt.mjs';
import { readSignedState, stableHash, writeSignedState } from './state-auth.mjs';

const DOMAIN = 'pixel-sprite-frame-approval/v1';
const HASH = /^[a-f0-9]{64}$/;

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error(`frame approval ${label} schema is invalid`);
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function validHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`frame approval ${label} must be a sha256`);
}

function validDate(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('frame approval date is invalid');
}

function frameDefinitions(contract) {
  validateAnimationContract(contract?.document);
  if (contract.sha256 !== stableHash(contract.document)) throw new Error('frame approval animation contract hash is invalid');
  return contract.document.clips.flatMap((clip) => clip.frames.map((frame) => ({ id: frame.id, landmarkSemantic: frame.landmarkSemantic })));
}

function portableOutputPath(value) {
  if (typeof value !== 'string' || value === '' || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\\') || value === '.' || value === '..' || value.startsWith('../') || path.posix.normalize(value) !== value) throw new Error('frame approval snap output path escaped the signed receipt directory');
}

async function outputRecords(receipt) {
  const outputs = receipt?.document?.payload?.outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) throw new Error('frame approval requires a truthful snap receipt with outputs');
  const receiptDir = path.dirname(receipt.path);
  const root = await fs.realpath(receiptDir);
  const records = [];
  for (const [index, output] of outputs.entries()) {
    exact(output, ['index', 'path', 'sha256'], 'snap output');
    if (output.index !== index) throw new Error('frame approval snap output order is invalid');
    portableOutputPath(output.path);
    validHash(output.sha256, 'snap output hash');
    let current = root;
    for (const segment of output.path.split('/')) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('frame approval snap output must not contain a symlink');
    }
    const stat = await fs.lstat(current);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('frame approval snap output must be a regular single-link file');
    const physical = await fs.realpath(current);
    const containment = path.relative(root, physical);
    if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error('frame approval snap output escaped the signed receipt directory');
    if (await sha256(current) !== output.sha256) throw new Error('frame approval snap output hash mismatch');
    records.push(output);
  }
  return records;
}

function validateRequestFrames(frames, outputs, definitions) {
  if (!Array.isArray(frames) || frames.length !== outputs.length || definitions.length !== outputs.length) throw new Error('frame approval requires exact ordered frame coverage for every snapped frame');
  return frames.map((frame, index) => {
    exact(frame, ['id', 'path', 'sha256'], 'requested frame');
    if (frame.id !== definitions[index].id || frame.path !== outputs[index].path || frame.sha256 !== outputs[index].sha256) throw new Error('frame approval requested frame order or output hash does not match the snap receipt');
    return frame;
  });
}

function validateApproval(approval, output, definition, index, review) {
  exact(approval, ['frameId', 'landmark', 'approved', 'approvedBy', 'checkpoints'], 'request');
  if (approval.frameId !== definition.id || approval.approved !== true) throw new Error(`frame approval request ${index} does not approve the contracted frame`);
  exact(approval.landmark, ['x', 'y'], 'landmark');
  if (!Number.isInteger(approval.landmark.x) || !Number.isInteger(approval.landmark.y) || approval.landmark.x < 0 || approval.landmark.y < 0) throw new Error('frame approval landmark must be explicit non-negative integer coordinates');
  if (typeof approval.approvedBy !== 'string' || !review.approvers.includes(approval.approvedBy)) throw new Error('frame approval approver is not authorized by the animation contract');
  if (!Array.isArray(approval.checkpoints) || !same(approval.checkpoints, review.checkpoints)) throw new Error('frame approval review checkpoints must exactly match the animation contract');
  return {
    index, id: definition.id, path: output.path, sha256: output.sha256, landmarkSemantic: definition.landmarkSemantic,
    landmark: { x: approval.landmark.x, y: approval.landmark.y }, approved: true, approvedBy: approval.approvedBy, checkpoints: [...approval.checkpoints]
  };
}

async function requireRunDirectory(runDir) {
  const stat = await fs.lstat(runDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('frame approval run directory must be a real directory');
  return fs.realpath(runDir);
}

async function verifiedReceipt({ projectDir, snapReceipt, contract }) {
  if (!snapReceipt?.path) throw new Error('frame approval requires a signed snap receipt file');
  const receipt = await verifySnapReceipt({ projectDir, file: snapReceipt.path, expectedContract: contract });
  if (snapReceipt.sha256 !== undefined && snapReceipt.sha256 !== receipt.sha256) throw new Error('frame approval selected snap receipt hash does not match its signed file');
  return receipt;
}

export async function writeFrameApproval({ projectDir, runDir, contract, snapReceipt, frames, approvals, version }) {
  if (!Number.isInteger(version) || version < 1 || !Array.isArray(approvals)) throw new Error('frame approval requires one approval for every snapped frame');
  const physicalRunDir = await requireRunDirectory(runDir);
  const definitions = frameDefinitions(contract);
  const receipt = await verifiedReceipt({ projectDir, snapReceipt, contract });
  if (path.dirname(receipt.path) !== physicalRunDir) throw new Error('frame approval snap receipt must be selected from the signed run directory');
  const outputs = await outputRecords(receipt);
  validateRequestFrames(frames, outputs, definitions);
  if (approvals.length !== outputs.length) throw new Error('frame approval requires one approval for every snapped frame');
  const approvedFrames = outputs.map((output, index) => validateApproval(approvals[index], output, definitions[index], index, contract.document.review));
  if (!approvedFrames.every((frame) => frame.approvedBy === approvedFrames[0].approvedBy)) throw new Error('frame approval requires one authorized approver identity for the selected revision');
  const payload = {
    version: 1, approvalVersion: version, animationContractSha256: contract.sha256, snapReceiptSha256: receipt.sha256,
    frames: approvedFrames, approvedBy: approvedFrames[0].approvedBy, createdAt: new Date().toISOString()
  };
  const file = path.join(physicalRunDir, `frame-approval-${String(version).padStart(2, '0')}.json`);
  const signed = await writeSignedState({ projectDir, file, domain: DOMAIN, payload, createKey: true });
  return { ...signed, path: file };
}

async function validatePayload(payload, contract, receipt, version) {
  exact(payload, ['version', 'approvalVersion', 'animationContractSha256', 'snapReceiptSha256', 'frames', 'approvedBy', 'createdAt'], 'payload');
  if (payload.version !== 1 || !Number.isInteger(payload.approvalVersion) || payload.approvalVersion < 1 || payload.approvalVersion !== version) throw new Error('frame approval version selection is invalid');
  if (payload.animationContractSha256 !== contract.sha256) throw new Error('frame approval animation contract binding mismatch');
  if (payload.snapReceiptSha256 !== receipt.sha256) throw new Error('frame approval snap receipt binding mismatch');
  validDate(payload.createdAt);
  const definitions = frameDefinitions(contract);
  const outputs = await outputRecords(receipt);
  if (!Array.isArray(payload.frames) || payload.frames.length !== outputs.length || definitions.length !== outputs.length) throw new Error('frame approval frame coverage is invalid');
  if (typeof payload.approvedBy !== 'string' || !contract.document.review.approvers.includes(payload.approvedBy)) throw new Error('frame approval approver is not authorized by the animation contract');
  payload.frames.forEach((frame, index) => {
    exact(frame, ['index', 'id', 'path', 'sha256', 'landmarkSemantic', 'landmark', 'approved', 'approvedBy', 'checkpoints'], 'frame');
    const expected = outputs[index];
    const definition = definitions[index];
    if (frame.index !== index || frame.id !== definition.id || frame.path !== expected.path || frame.sha256 !== expected.sha256 || !same(frame.landmarkSemantic, definition.landmarkSemantic) || frame.approved !== true || frame.approvedBy !== payload.approvedBy) throw new Error('frame approval frame order, contract, or output hash binding mismatch');
    exact(frame.landmark, ['x', 'y'], 'landmark');
    if (!Number.isInteger(frame.landmark.x) || !Number.isInteger(frame.landmark.y) || frame.landmark.x < 0 || frame.landmark.y < 0) throw new Error('frame approval landmark is invalid');
    if (!same(frame.checkpoints, contract.document.review.checkpoints)) throw new Error('frame approval review checkpoints mismatch');
  });
}

export async function verifyFrameApproval({ projectDir, file, contract, snapReceipt, version }) {
  if (!Number.isInteger(version) || version < 1) throw new Error('frame approval version selection is required');
  frameDefinitions(contract);
  const receipt = await verifiedReceipt({ projectDir, snapReceipt, contract });
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('frame approval must be an immutable regular file');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  exact(raw, ['version', 'payload', 'signature'], 'envelope');
  if (raw.version !== 1 || !HASH.test(raw.signature ?? '')) throw new Error('frame approval envelope schema is invalid');
  const document = await readSignedState({ projectDir, file, domain: DOMAIN });
  await validatePayload(document.payload, contract, receipt, version);
  if (path.basename(file) !== `frame-approval-${String(document.payload.approvalVersion).padStart(2, '0')}.json`) throw new Error('frame approval must use its immutable numbered versioned filename');
  return { document, path: file, sha256: document.sha256 };
}
