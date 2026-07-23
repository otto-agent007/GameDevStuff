import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import {
  loadSourceReport,
  requireProductionApproval,
  verifyApproval,
  writeApproval
} from '../scripts/lib/approval.mjs';
import { compareRuns, auditRun, recordProductionValidation } from '../scripts/lib/audit.mjs';
import { writeRevision } from '../scripts/lib/artifacts.mjs';
import { createPixelProductionContract, publishExportRevision } from '../scripts/lib/export-contract.mjs';
import { runPixelProduction } from '../scripts/lib/pixel-pipeline.mjs';
import { decodePoseBoard, recoverPoseBoard } from '../scripts/lib/pose-board.mjs';
import {
  approvePoseSelection,
  writePoseSelection
} from '../scripts/lib/pose-selection.mjs';
import { createProject, createRun } from '../scripts/lib/run-contract.mjs';
import {
  decodeMotionSource,
  registerSourceAdapter
} from '../scripts/lib/source-adapter.mjs';
import { sha256File, sha256Value } from '../scripts/lib/schema.mjs';
import { loadAnimationContract } from '../../pixel-sprite-animation-pipeline/scripts/lib/animation-contract.mjs';
import { writeFrameApproval } from '../../pixel-sprite-animation-pipeline/scripts/lib/frame-approval.mjs';
import { verifySnapReceipt } from '../../pixel-sprite-animation-pipeline/scripts/lib/snap-receipt.mjs';

const BACKGROUND = [0, 255, 0, 255];
const COLORS = {
  transparent: [0, 0, 0, 0],
  red: [214, 30, 42, 255],
  blue: [44, 77, 221, 255],
  yellow: [248, 198, 34, 255]
};
const pixelPipelineCli = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'pixel-sprite-animation-pipeline',
  'scripts',
  'cli.mjs'
);

registerSourceAdapter('pose-board', ({ source, run, project, options }) => decodePoseBoard({
  source,
  recoveryContract: options.recoveryContract,
  selectionApproval: options.selectionApproval,
  run,
  project
}));

function writePixel(pixels, width, x, y, rgba) {
  pixels.set(rgba, ((y * width) + x) * 4);
}

async function writeBoard(file) {
  const width = 12;
  const height = 8;
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(BACKGROUND, offset);
  for (const [color, points] of [
    [COLORS.red, [[4, 1], [5, 1], [6, 1], [7, 1], [5, 2], [6, 2]]],
    [COLORS.blue, [[0, 4], [1, 4], [2, 4], [1, 5]]],
    [COLORS.yellow, [[9, 5], [10, 5], [9, 6], [10, 6]]]
  ]) {
    for (const [x, y] of points) writePixel(pixels, width, x, y, color);
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(file);
}

async function writeAnchor(file) {
  const width = 8;
  const height = 6;
  const pixels = Buffer.alloc(width * height * 4);
  for (const [x, y] of [[2, 2], [3, 2], [4, 2], [5, 2], [3, 3], [4, 3]]) {
    writePixel(pixels, width, x, y, COLORS.red);
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(file);
}

async function writeProjectContract(root, anchor) {
  const palette = [
    COLORS.transparent,
    COLORS.red,
    COLORS.blue,
    COLORS.yellow
  ];
  const document = {
    schemaVersion: 1,
    id: 'pose-board-proof',
    character: {
      name: 'Pose Board Proof',
      identity: 'A synthetic primary-color actor used only for workflow verification.',
      logicalHeight: 6,
      anchors: [{
        id: 'canonical-right',
        role: 'canonical',
        path: 'source/anchors/canonical-right.png',
        sha256: await sha256File(anchor)
      }]
    },
    canvas: {
      width: 8,
      height: 6,
      pivot: { x: 4, y: 5 },
      baseline: 5
    },
    scale: {
      integer: 1,
      runtime: { width: 8, height: 6 }
    },
    palette: {
      rgba: palette,
      sha256: sha256Value(palette)
    },
    tracks: [{
      id: 'actor',
      kind: 'actor',
      required: true,
      attachTo: null
    }],
    sockets: [],
    contacts: [],
    sources: {
      allowedKinds: ['generated-still', 'png-sequence', 'pose-board'],
      defaultStillKind: 'generated-still'
    },
    actions: [{
      id: 'idle',
      semantic: 'Cycle through three recovered synthetic poses.',
      loopMode: 'loop',
      poses: ['stride-01', 'stride-02', 'stride-03'],
      tracks: ['actor'],
      sockets: [],
      contacts: [],
      sources: {
        preferred: 'pose-board',
        fallbacks: ['png-sequence']
      }
    }],
    engineTargets: [
      { id: 'generic-json', kind: 'generic', version: null }
    ],
    approvals: {
      status: 'anchor-approved',
      identities: ['owner'],
      requiredGates: ['canonical-anchor', 'annotated-animation', 'final-preview']
    }
  };
  const file = path.join(root, 'project-contract.json');
  await fs.writeFile(file, JSON.stringify(document));
  return file;
}

async function createFixture(root, runId) {
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(path.join(projectRoot, 'source', 'anchors'), { recursive: true });
  const anchor = path.join(projectRoot, 'source', 'anchors', 'canonical-right.png');
  await writeAnchor(anchor);
  const contractFile = await writeProjectContract(root, anchor);
  const project = await createProject({ root: projectRoot, contractFile });
  const run = await createRun({
    projectRoot,
    project,
    sourceRequest: { actionId: 'idle', kind: 'pose-board' },
    id: runId,
    clock: () => new Date('2026-07-22T12:00:00.000Z')
  });
  const board = path.join(root, 'pose-board.png');
  await writeBoard(board);
  const recoveryContract = path.join(root, 'pose-board-recovery.json');
  await fs.writeFile(recoveryContract, JSON.stringify({
    schemaVersion: 1,
    background: { mode: 'color', rgba: BACKGROUND, tolerance: 8 },
    connectivity: 4,
    minimumComponentPixels: 4,
    maxDecodedRgbaBytes: 1024 * 1024,
    padding: 2,
    expectedCandidates: { min: 3, max: 3 },
    allowUnassigned: false,
    groups: []
  }));
  return { projectRoot, project, run, board, recoveryContract };
}

function studioEdit({ project, source }) {
  return {
    schemaVersion: 1,
    kind: 'frame-studio-edit',
    projectSha256: project.sha256,
    sourceSha256: sha256Value(source),
    actionId: 'idle',
    frames: source.frames.map((frame) => ({
      frameId: frame.id,
      included: true,
      label: frame.id,
      durationMs: frame.durationMs,
      translation: { x: 0, y: 0 },
      transform: null,
      markers: [],
      contacts: [],
      groundTravel: { x: 0, y: 0 },
      tracks: ['actor']
    }))
  };
}

async function runPoseBoardProof(root, runId) {
  const fixture = await createFixture(root, runId);
  await assert.rejects(
    decodeMotionSource({
      kind: 'pose-board',
      source: fixture.board,
      run: fixture.run,
      project: fixture.project,
      options: { recoveryContract: fixture.recoveryContract }
    }),
    (error) => error.exitCode === 4 &&
      error.handoff.status === 'awaiting-pose-selection'
  );
  const recovery = await recoverPoseBoard({
    source: fixture.board,
    recoveryContract: fixture.recoveryContract,
    run: fixture.run,
    project: fixture.project
  });
  const selectionValue = {
    schemaVersion: 1,
    kind: 'pose-board-selection',
    projectSha256: fixture.project.sha256,
    runId: fixture.run.id,
    actionId: 'idle',
    recoverySha256: recovery.sha256,
    frames: recovery.document.candidates.map((candidate, index) => ({
      id: `stride-${String(index + 1).padStart(2, '0')}`,
      candidateId: candidate.id,
      durationMs: 80 + (index * 20),
      tracks: [{ role: 'actor', componentIds: candidate.componentIds }]
    }))
  };
  const poseSelection = await writePoseSelection({
    run: fixture.run,
    project: fixture.project,
    recovery,
    value: selectionValue
  });
  const poseApproval = await approvePoseSelection({
    run: fixture.run,
    project: fixture.project,
    recovery,
    selection: poseSelection,
    approver: 'owner',
    decision: 'approved',
    notes: 'Synthetic recovery sequence approved.',
    clock: () => new Date('2026-07-22T12:01:00.000Z')
  });
  await decodeMotionSource({
    kind: 'pose-board',
    source: fixture.board,
    run: fixture.run,
    project: fixture.project,
    options: {
      recoveryContract: fixture.recoveryContract,
      selectionApproval: poseApproval.path
    }
  });

  const source = (await loadSourceReport(fixture.run)).document;
  const edit = studioEdit({ project: fixture.project, source });
  await writeRevision({
    root: fixture.run.root,
    area: 'edits',
    stem: 'studio-edit',
    value: {
      schemaVersion: 1,
      kind: 'studio-edit',
      runId: fixture.run.id,
      stage: 'selection',
      sourceSha256: sha256Value(source),
      previousSha256: sha256Value({
        schemaVersion: 1,
        kind: 'studio-edit-root',
        runId: fixture.run.id,
        stage: 'selection',
        sourceSha256: sha256Value(source)
      }),
      edit
    }
  });
  const selectionApproval = await writeApproval({
    run: fixture.run,
    project: fixture.project,
    editRevision: 1,
    approver: 'owner',
    decision: 'approved',
    notes: 'Aligned source frames approved.',
    clock: () => new Date('2026-07-22T12:02:00.000Z')
  });
  const verifiedSelection = await verifyApproval({
    run: fixture.run,
    file: selectionApproval.path,
    project: fixture.project,
    source,
    edit
  });
  requireProductionApproval(verifiedSelection);
  const productionContract = await createPixelProductionContract({
    run: fixture.run,
    project: fixture.project,
    selectionApproval: verifiedSelection,
    edit
  });
  const output = path.join(fixture.run.root, 'work', 'pixel-production');
  const handoff = await runPixelProduction({
    run: fixture.run,
    project: fixture.project,
    selectionApproval: verifiedSelection,
    contract: productionContract,
    pipelineCli: pixelPipelineCli,
    output
  });
  assert.equal(handoff.exitCode, 4);
  assert.equal(handoff.next.kind, 'post-snap-frame-approval');

  const receipt = await verifySnapReceipt({
    projectDir: fixture.run.root,
    file: handoff.receipt.path,
    expectedContract: await loadAnimationContract(productionContract.path)
  });
  const animationContract = await loadAnimationContract(productionContract.path);
  const frameApproval = await writeFrameApproval({
    projectDir: fixture.run.root,
    runDir: path.dirname(receipt.path),
    contract: animationContract,
    snapReceipt: { path: receipt.path, sha256: receipt.sha256 },
    frames: receipt.document.payload.outputs.map((outputRecord, index) => ({
      frameId: animationContract.document.clips[0].frames[index].id,
      trackId: 'actor',
      path: outputRecord.path,
      sha256: outputRecord.sha256
    })),
    approvals: animationContract.document.clips[0].frames.map((frame) => ({
      frameId: frame.id,
      landmarks: {
        root: { ...animationContract.document.canvas.pivot },
        baseline: animationContract.document.canvas.baseline,
        sockets: [],
        contacts: [],
        groundTravel: { x: 0, y: 0 }
      },
      approved: true,
      approvedBy: 'owner',
      checkpoints: [...animationContract.document.review.checkpoints]
    })),
    version: 1
  });
  const delegated = await runPixelProduction({
    run: fixture.run,
    project: fixture.project,
    selectionApproval: verifiedSelection,
    contract: productionContract,
    pipelineCli: pixelPipelineCli,
    output,
    snapReceipt: { path: receipt.path },
    frameApproval: { path: frameApproval.path }
  });
  assert.equal(delegated.exitCode, 0);

  const published = await publishExportRevision({
    run: fixture.run,
    bindings: {
      projectSha256: fixture.project.sha256,
      sourceSha256: sha256Value(source),
      editSha256: sha256Value(edit),
      selectionApprovalSha256: verifiedSelection.sha256,
      snapReceiptSha256: delegated.receipt.sha256,
      frameApprovalSha256: delegated.frameApproval.sha256
    },
    pixelExport: delegated.exports,
    validationReport: delegated.report
  });
  await recordProductionValidation({
    run: fixture.run,
    exportRevision: published.revision,
    exportManifestSha256: published.sha256,
    validationReport: delegated.report
  });
  const audit = await auditRun({
    run: fixture.run,
    project: fixture.project,
    expected: {
      exportManifest: published.path,
      validationReport: delegated.report,
      envelope: {
        runId: fixture.run.id,
        createdAt: fixture.run.document.createdAt,
        approvedBy: 'owner',
        approvedAt: '2026-07-22T12:02:00.000Z'
      }
    }
  });
  return {
    ...fixture,
    source,
    recovery,
    selectedFrameCount: selectionValue.frames.length,
    receipt,
    delegated,
    audit
  };
}

test('crossing-boundary pose boards produce one snapped input per selected frame reproducibly', async (t) => {
  const leftRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pose-board-proof-a-'));
  const rightRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pose-board-proof-b-'));
  t.after(() => Promise.all(
    [leftRoot, rightRoot].map((root) => fs.rm(root, { recursive: true, force: true }))
  ));

  const left = await runPoseBoardProof(leftRoot, 'pose-board-proof-a');
  const right = await runPoseBoardProof(rightRoot, 'pose-board-proof-b');
  const wholeBoardSha256 = await sha256File(left.board);

  assert.equal(left.audit.passed, true, JSON.stringify(left.audit.failures));
  assert.equal(right.audit.passed, true, JSON.stringify(right.audit.failures));
  assert.equal(
    left.receipt.document.payload.inputs.length,
    left.selectedFrameCount
  );
  assert.equal(
    left.receipt.document.payload.outputs.length,
    left.selectedFrameCount
  );
  assert.equal(
    left.receipt.document.payload.inputs.some(
      ({ sha256 }) => sha256 === wholeBoardSha256
    ),
    false
  );
  assert.deepEqual(
    left.receipt.document.payload.inputs.map(({ sha256 }) => sha256),
    left.source.frames.map(({ sha256 }) => sha256)
  );
  assert.deepEqual(
    compareRuns(left.audit, right.audit).changedDeterministicArtifacts,
    []
  );
});
