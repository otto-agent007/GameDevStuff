import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { auditRun } from '../../scripts/lib/audit.mjs';
import { publishExportRevision } from '../../scripts/lib/export-contract.mjs';
import { loadProjectContract } from '../../scripts/lib/project-contract.mjs';
import { sha256File, sha256Value } from '../../scripts/lib/schema.mjs';
import { loadAnimationContract } from '../../../pixel-sprite-animation-pipeline/scripts/lib/animation-contract.mjs';
import { DEFAULT_CONFIG, validateConfig } from '../../../pixel-sprite-animation-pipeline/scripts/lib/config.mjs';
import { exportContractAnimation } from '../../../pixel-sprite-animation-pipeline/scripts/lib/export.mjs';
import { writeFrameApproval } from '../../../pixel-sprite-animation-pipeline/scripts/lib/frame-approval.mjs';
import { inspectImage } from '../../../pixel-sprite-animation-pipeline/scripts/lib/inspect.mjs';
import { normalizeContractFrames } from '../../../pixel-sprite-animation-pipeline/scripts/lib/normalize.mjs';
import { writeSnapReceipt } from '../../../pixel-sprite-animation-pipeline/scripts/lib/snap-receipt.mjs';
import { stableHash } from '../../../pixel-sprite-animation-pipeline/scripts/lib/state-auth.mjs';
import { validateRun } from '../../../pixel-sprite-animation-pipeline/scripts/lib/validate.mjs';

const fixtureRoot = path.resolve(import.meta.dirname);
const HASH = (letter) => letter.repeat(64);

function rectangle(image, x, y, width, height, color) {
  for (let row = y; row < y + height; row += 1) for (let column = x; column < x + width; column += 1) {
    image.data.set(color, (row * image.width + column) * 4);
  }
}

async function renderTrack(file, fixture, frame, trackId) {
  const image = { width: fixture.canvas.width, height: fixture.canvas.height, data: Buffer.alloc(fixture.canvas.width * fixture.canvas.height * 4) };
  const [, outline, brass, highlight, navy, spark] = fixture.palette;
  if (trackId === 'actor') {
    rectangle(image, 12, 8 + frame.pose, 8, 16, brass);
    rectangle(image, 13, 5 + frame.pose, 7, 5, highlight);
    rectangle(image, 12, 4 + frame.pose, 9, 3, navy);
    rectangle(image, 11 + (frame.id.includes('right') ? 1 : 0), 24, 4, 4, outline);
    rectangle(image, 18 - (frame.id.includes('left') ? 1 : 0), 24, 4, 4, outline);
  } else if (trackId === 'satchel') {
    rectangle(image, 20, 14 + frame.pose, 5, 8, navy);
    rectangle(image, 19, 13 + frame.pose, 2, 2, outline);
  } else {
    rectangle(image, 24, 8 + frame.pose, 2, 2, spark);
    rectangle(image, 23, 9 + frame.pose, 4, 1, highlight);
  }
  await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }).png().toFile(file);
}

async function recursiveArtifacts(root, areas) {
  const records = [];
  async function visit(directory, prefix) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const stat = await fs.lstat(file);
      const relative = `${prefix}/${name}`;
      if (stat.isDirectory()) await visit(file, relative);
      else records.push({ path: relative, sha256: await sha256File(file) });
    }
  }
  for (const area of areas) await visit(path.join(root, area), area);
  return records;
}

function landmarks(frame, fixture) {
  const sockets = [{ id: 'hand', x: 20, y: 14 + frame.pose }];
  if (frame.tracks.includes('unlock-spark')) sockets.push({ id: 'effect-origin', x: 24, y: 9 + frame.pose });
  return {
    root: { ...fixture.canvas.pivot }, baseline: fixture.canvas.baseline, sockets,
    contacts: frame.contacts.map((id) => ({ id, x: id === 'left-foot' ? 13 : 20, y: fixture.canvas.baseline })),
    groundTravel: { ...frame.groundTravel }
  };
}

export async function runClockworkCourier(root) {
  const fixture = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'source', 'fixture.json'), 'utf8'));
  const project = await loadProjectContract(path.join(fixtureRoot, 'project.json'));
  const work = path.join(root, 'production');
  const snapped = path.join(work, 'snapped');
  await fs.mkdir(snapped, { recursive: true });
  await fs.mkdir(path.join(root, '.pixel-sprite-pipeline'), { mode: 0o700 });
  const anchor = path.join(fixtureRoot, 'source', 'canonical-anchor.svg');
  const frames = fixture.clips.flatMap((clip) => clip.frames.map((frame) => ({ ...frame, clipId: clip.id, loopMode: clip.loopMode })));
  const outputs = [];
  for (const frame of frames) for (const trackId of frame.tracks) {
    const file = path.join(snapped, `${frame.id}--${trackId}.png`);
    await renderTrack(file, fixture, frame, trackId);
    outputs.push(file);
  }
  const tracks = [
    { id: 'actor', kind: 'actor', required: true, attachTo: null },
    { id: 'satchel', kind: 'prop', required: true, attachTo: 'hand' },
    { id: 'unlock-spark', kind: 'effect', required: false, attachTo: 'effect-origin' }
  ];
  const contractDocument = {
    version: 2, selectionApprovalSha256: HASH('5'),
    character: { id: project.document.id, anchorSha256: await sha256File(anchor) },
    canvas: fixture.canvas, scale: fixture.scale,
    palette: { rgba: fixture.palette, sha256: stableHash(fixture.palette), snapperPaletteHex: fixture.palette.slice(1).map((color) => color.slice(0, 3).map((part) => part.toString(16).padStart(2, '0')).join('')) },
    tracks,
    sockets: [{ id: 'hand', trackId: 'actor', required: true }, { id: 'effect-origin', trackId: 'actor', required: true }],
    contacts: [{ id: 'left-foot', trackId: 'actor', kind: 'planted-foot', required: true }, { id: 'right-foot', trackId: 'actor', kind: 'planted-foot', required: true }],
    clips: fixture.clips.map((clip) => ({ id: clip.id, loopMode: clip.loopMode, frames: clip.frames.map((frame) => ({
      id: frame.id, semantic: frame.semantic, duration: frame.duration, tracks: frame.tracks,
      sockets: frame.tracks.includes('unlock-spark') ? ['hand', 'effect-origin'] : ['hand'],
      contacts: frame.contacts, groundTravel: frame.groundTravel
    })) })),
    review: { checkpoints: ['canonical-anchor', 'annotated-animation', 'final-preview'], approvers: ['owner'] }
  };
  const contractFile = path.join(work, 'animation-contract-v2.json');
  await fs.writeFile(contractFile, JSON.stringify(contractDocument));
  const contract = await loadAnimationContract(contractFile);
  const receipt = await writeSnapReceipt({
    projectDir: root, run: { id: 'fixture-production', outputDir: snapped, manifestSha256: stableHash({ fixture: 1 }) }, contract,
    inputs: outputs, outputs, args: ['16', '--palette', contractDocument.palette.snapperPaletteHex.join(',')],
    identity: { origin: 'managed-cache', sha256: HASH('a'), size: 1, version: 'fixture-1', helpSha256: HASH('b'), fixtureRgbaSha256: HASH('c'), pinnedReleaseTag: null, upstreamCommit: null }
  });
  const approval = await writeFrameApproval({
    projectDir: root, runDir: snapped, contract, snapReceipt: receipt,
    frames: outputs.map((file, index) => ({ frameId: frames.flatMap((frame) => frame.tracks.map(() => frame.id))[index], trackId: frames.flatMap((frame) => frame.tracks)[index], path: path.basename(file), sha256: receipt.document.payload.outputs[index].sha256 })),
    approvals: frames.map((frame) => ({ frameId: frame.id, landmarks: landmarks(frame, fixture), approved: true, approvedBy: 'owner', checkpoints: contractDocument.review.checkpoints })),
    version: 1
  });
  const config = validateConfig({ ...structuredClone(DEFAULT_CONFIG), canonical: { width: 32, height: 32 }, generation: { width: 256, height: 256 }, runtime: { width: 64, height: 64 }, pivot: { x: 16, y: 27 } });
  const normalized = await normalizeContractFrames({ contract, frameApproval: approval, outputDir: path.join(work, 'normalized') });
  const exported = await exportContractAnimation({ normalized, contract, outputDir: path.join(work, 'export'), config, columns: 4, frameApprovalSha256: approval.sha256 });
  const report = await validateRun({
    anchorReport: await inspectImage(anchor), normalized, exported, config, animationContract: contract,
    frameApproval: { projectDir: root, file: approval.path, snapReceipt: { path: receipt.path, sha256: receipt.sha256 }, version: 1 }
  });
  const runRoot = path.join(root, 'run');
  await fs.mkdir(path.join(runRoot, 'exports'), { recursive: true });
  const run = { id: path.basename(root), root: runRoot, sha256: sha256Value({ fixture: 1 }), document: { projectSha256: project.sha256, createdAt: new Date().toISOString() } };
  const bindings = { projectSha256: project.sha256, sourceSha256: HASH('3'), editSha256: HASH('4'), selectionApprovalSha256: HASH('5'), snapReceiptSha256: receipt.sha256, frameApprovalSha256: approval.sha256 };
  const published = await publishExportRevision({ run, bindings, pixelExport: { root: work, artifacts: await recursiveArtifacts(work, ['normalized', 'export']) }, validationReport: report });
  const audit = await auditRun({ run, project, expected: { exportManifest: published.path, validationReport: report, envelope: { runId: run.id, createdAt: run.document.createdAt, approvedBy: 'owner', approvedAt: run.document.createdAt } } });
  return { audit, exports: { clips: contractDocument.clips.map(({ id, loopMode }) => ({ id, loopMode })) }, report };
}
