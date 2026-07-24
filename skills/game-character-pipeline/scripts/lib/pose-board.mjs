import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import {
  copyImmutable,
  writeImmutableBytes,
  writeImmutableJson
} from './artifacts.mjs';
import {
  analyzePoseBoard,
  renderRecoveredCandidate
} from './pose-board-recovery.mjs';
import { loadApprovedPoseSelection } from './pose-selection.mjs';
import { sha256Value } from './schema.mjs';

const DIGITS = Object.freeze({
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111']
});
const OVERLAY_COLORS = Object.freeze([
  [255, 64, 64, 255],
  [64, 160, 255, 255],
  [255, 210, 48, 255],
  [216, 96, 255, 255],
  [64, 224, 144, 255]
]);

function setPixel(data, width, height, x, y, rgba) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  data.set(rgba, ((y * width) + x) * 4);
}

function drawBox(data, width, height, bounds, rgba) {
  for (let x = bounds.left; x <= bounds.right; x += 1) {
    setPixel(data, width, height, x, bounds.top, rgba);
    setPixel(data, width, height, x, bounds.bottom, rgba);
  }
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    setPixel(data, width, height, bounds.left, y, rgba);
    setPixel(data, width, height, bounds.right, y, rgba);
  }
}

function drawNumber(data, width, height, value, x, y, rgba) {
  let cursor = x;
  for (const digit of String(value)) {
    const glyph = DIGITS[digit];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === '1') {
          setPixel(data, width, height, cursor + column, y + row, rgba);
        }
      }
    }
    cursor += 4;
  }
}

export async function renderPoseBoardMask(analysis) {
  const rgba = Buffer.alloc(analysis.width * analysis.height * 4);
  for (let index = 0; index < analysis.foregroundMask.length; index += 1) {
    if (analysis.foregroundMask[index] === 0) continue;
    rgba.set([255, 255, 255, 255], index * 4);
  }
  return sharp(rgba, {
    raw: { width: analysis.width, height: analysis.height, channels: 4 }
  }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

export async function renderPoseBoardOverlay(analysis) {
  const rgba = Buffer.from(analysis.sourceRgba);
  for (const [index, candidate] of analysis.candidates.entries()) {
    const color = OVERLAY_COLORS[index % OVERLAY_COLORS.length];
    drawBox(rgba, analysis.width, analysis.height, candidate.bounds, color);
    drawNumber(
      rgba,
      analysis.width,
      analysis.height,
      index + 1,
      candidate.bounds.left,
      candidate.bounds.top,
      color
    );
  }
  return sharp(rgba, {
    raw: { width: analysis.width, height: analysis.height, channels: 4 }
  }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

function evidenceComponent(component) {
  return {
    id: component.id,
    pixelCount: component.pixelCount,
    bounds: component.bounds,
    centroid: component.centroid,
    pixelSha256: component.pixelSha256
  };
}

function validateRunAncestry({ run, project }) {
  if (!run?.root || !run?.document || !run?.sha256) {
    throw new Error('pose-board recovery requires an immutable run');
  }
  if (!project?.document || !project?.sha256) {
    throw new Error('pose-board recovery requires an initialized project');
  }
  if (run.document.projectSha256 !== project.sha256) {
    throw new Error('pose-board recovery project ancestry mismatch');
  }
  if (run.document.sourceRequest?.kind !== 'pose-board') {
    throw new Error('pose-board recovery run kind mismatch');
  }
  const action = project.document.actions.find(
    ({ id }) => id === run.document.sourceRequest.actionId
  );
  if (!action) throw new Error('pose-board recovery action ancestry mismatch');
  return action;
}

export async function recoverPoseBoard({ source, recoveryContract, run, project }) {
  const action = validateRunAncestry({ run, project });
  const capturedSource = await copyImmutable({
    source,
    root: run.root,
    relative: 'source/pose-board/original.png'
  });
  const capturedContract = await copyImmutable({
    source: recoveryContract,
    root: run.root,
    relative: 'source/pose-board/recovery-contract.json'
  });
  let contractDocument;
  try {
    contractDocument = JSON.parse(await fs.readFile(capturedContract.path, 'utf8'));
  } catch (error) {
    throw new Error(`pose-board recovery contract must be valid JSON: ${error.message}`);
  }
  const analysis = await analyzePoseBoard({
    bytes: await fs.readFile(capturedSource.path),
    contract: contractDocument
  });

  const mask = await writeImmutableBytes({
    root: run.root,
    relative: 'work/pose-board/foreground-mask.png',
    bytes: await renderPoseBoardMask(analysis),
    reuse: true
  });
  const overlay = await writeImmutableBytes({
    root: run.root,
    relative: 'work/pose-board/candidate-overlay.png',
    bytes: await renderPoseBoardOverlay(analysis),
    reuse: true
  });
  const candidates = [];
  for (const candidate of analysis.candidates) {
    const rendered = await renderRecoveredCandidate({
      analysis,
      componentIds: candidate.componentIds
    });
    const artifact = await writeImmutableBytes({
      root: run.root,
      relative: `work/pose-board/candidates/${candidate.id}.png`,
      bytes: rendered.bytes,
      reuse: true
    });
    candidates.push({
      id: candidate.id,
      componentIds: candidate.componentIds,
      pixelCount: candidate.pixelCount,
      bounds: candidate.bounds,
      centroid: candidate.centroid,
      width: rendered.width,
      height: rendered.height,
      placement: rendered.placement,
      path: artifact.relative,
      sha256: artifact.sha256
    });
  }

  const reportDocument = {
    schemaVersion: 1,
    kind: 'pose-board-recovery',
    projectSha256: project.sha256,
    runSha256: run.sha256,
    runId: run.id,
    actionId: action.id,
    actionSha256: sha256Value(action),
    source: {
      path: capturedSource.relative,
      sha256: capturedSource.sha256
    },
    contract: {
      path: capturedContract.relative,
      sha256: capturedContract.sha256,
      documentSha256: sha256Value(analysis.contract),
      document: analysis.contract
    },
    canvas: {
      width: analysis.width,
      height: analysis.height
    },
    background: analysis.background,
    mask: {
      path: mask.relative,
      sha256: mask.sha256,
      rawSha256: analysis.maskSha256
    },
    components: analysis.components.map(evidenceComponent),
    ignoredNoise: analysis.ignoredNoise.map(evidenceComponent),
    candidates,
    proposedOrder: analysis.proposedOrder,
    overlay: {
      path: overlay.relative,
      sha256: overlay.sha256
    }
  };
  const report = await writeImmutableJson({
    root: run.root,
    relative: 'reports/pose-board-recovery.json',
    value: reportDocument,
    reuse: true
  });
  return { ...report, analysis };
}

function awaitingSelectionError({ recovery, run, project }) {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..'
  );
  const cliPath = path.join(packageRoot, 'scripts', 'cli.mjs');
  const error = new Error('pose-board intake is awaiting an approved pose selection');
  error.exitCode = 4;
  error.handoff = {
    status: 'awaiting-pose-selection',
    runId: run.id,
    recovery: {
      path: recovery.path,
      sha256: recovery.sha256
    },
    next: {
      kind: 'pose-board-selection',
      cwd: packageRoot,
      argv: [
        process.execPath,
        cliPath,
        'studio',
        '--stage',
        'recovery',
        '--project-dir',
        project.root,
        '--run',
        run.id
      ]
    }
  };
  return error;
}

async function centerCandidate({ rendered, width, height }) {
  const decoded = await sharp(rendered.bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = Buffer.alloc(width * height * 4);
  const offsetX = Math.floor((width - rendered.width) / 2);
  const offsetY = Math.floor((height - rendered.height) / 2);
  for (let y = 0; y < rendered.height; y += 1) {
    const sourceStart = y * rendered.width * 4;
    const destinationStart = (((y + offsetY) * width) + offsetX) * 4;
    decoded.data.copy(
      output,
      destinationStart,
      sourceStart,
      sourceStart + (rendered.width * 4)
    );
  }
  const bytes = await sharp(output, {
    raw: { width, height, channels: 4 }
  }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  return { bytes, offsetX, offsetY };
}

export async function decodePoseBoard({
  source,
  recoveryContract,
  selectionApproval,
  run,
  project
}) {
  const recovery = await recoverPoseBoard({
    source,
    recoveryContract,
    run,
    project
  });
  if (!selectionApproval) throw awaitingSelectionError({ recovery, run, project });
  const approved = await loadApprovedPoseSelection({
    run,
    project,
    recovery,
    file: selectionApproval
  });

  const renderedFrames = [];
  for (const frame of approved.selection.document.frames) {
    const componentIds = frame.tracks.flatMap((track) => track.componentIds);
    const rendered = await renderRecoveredCandidate({
      analysis: recovery.analysis,
      componentIds
    });
    renderedFrames.push({ frame, rendered });
  }
  const width = Math.max(...renderedFrames.map(({ rendered }) => rendered.width));
  const height = Math.max(...renderedFrames.map(({ rendered }) => rendered.height));
  const frames = [];
  let timestampMs = 0;

  for (const [index, { frame, rendered }] of renderedFrames.entries()) {
    const centered = await centerCandidate({ rendered, width, height });
    const artifact = await writeImmutableBytes({
      root: run.root,
      relative: `work/decoded/${frame.id}.png`,
      bytes: centered.bytes,
      reuse: true
    });
    frames.push({
      index,
      id: frame.id,
      path: artifact.relative,
      sha256: artifact.sha256,
      width,
      height,
      timestampMs,
      durationMs: frame.durationMs,
      sourceRect: { x: 0, y: 0, width, height },
      duplicateOf: null
    });
    timestampMs += frame.durationMs;
  }

  return {
    kind: 'pose-board',
    sourceSha256: recovery.document.source.sha256,
    decoder: {
      name: 'pose-board-recovery',
      version: '1',
      arguments: [
        `recovery-sha256=${recovery.sha256}`,
        `selection-approval-sha256=${approved.sha256}`,
        'placement=center-no-resample'
      ]
    },
    canvas: { width, height },
    alpha: true,
    timeBase: { numerator: 1, denominator: 1000 },
    frames,
    diagnostics: [{ code: 'ALPHA_PRESENT', frameId: null }],
    approval: null
  };
}
