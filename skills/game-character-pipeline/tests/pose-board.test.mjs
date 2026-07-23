import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { decodePoseBoard, recoverPoseBoard } from '../scripts/lib/pose-board.mjs';
import {
  approvePoseSelection,
  loadApprovedPoseSelection,
  writePoseSelection
} from '../scripts/lib/pose-selection.mjs';
import { createProject, createRun } from '../scripts/lib/run-contract.mjs';
import { sha256File, sha256Value } from '../scripts/lib/schema.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectFixture = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');
const BACKGROUND = [0, 255, 0, 255];

function writePixel(pixels, width, x, y, rgba) {
  pixels.set(rgba, ((y * width) + x) * 4);
}

async function writeSyntheticBoard(file) {
  const width = 12;
  const height = 8;
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(BACKGROUND, offset);
  for (const [x, y] of [[4, 1], [5, 1], [6, 1], [7, 1], [5, 2], [6, 2]]) {
    writePixel(pixels, width, x, y, [214, 30, 42, 255]);
  }
  for (const [x, y] of [[0, 4], [1, 4], [2, 4], [1, 5]]) {
    writePixel(pixels, width, x, y, [44, 77, 221, 255]);
  }
  for (const [x, y] of [[9, 5], [10, 5], [9, 6], [10, 6]]) {
    writePixel(pixels, width, x, y, [248, 198, 34, 255]);
  }
  writePixel(pixels, width, 0, 0, [255, 0, 255, 255]);
  writePixel(pixels, width, 11, 0, [255, 0, 255, 255]);
  await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(file);
}

function recoveryContract() {
  return {
    schemaVersion: 1,
    background: { mode: 'color', rgba: BACKGROUND, tolerance: 8 },
    connectivity: 4,
    minimumComponentPixels: 4,
    maxDecodedRgbaBytes: 1024 * 1024,
    padding: 2,
    expectedCandidates: { min: 2, max: 8 },
    allowUnassigned: false,
    groups: []
  };
}

async function poseBoardFixture(t, contractOverrides = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-pose-board-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'pose-board.png');
  const recoveryContractFile = path.join(parent, 'pose-board-recovery.json');
  await writeSyntheticBoard(source);
  await fs.writeFile(
    recoveryContractFile,
    JSON.stringify({ ...recoveryContract(), ...contractOverrides })
  );

  const projectRoot = path.join(parent, 'project');
  const project = await createProject({ root: projectRoot, contractFile: projectFixture });
  const run = await createRun({
    projectRoot,
    project,
    sourceRequest: { actionId: 'idle', kind: 'pose-board' },
    id: 'run-pose-board'
  });
  return { parent, source, recoveryContractFile, project, run };
}

test('pose-board recovery publishes complete immutable evidence before handoff', async (t) => {
  const fixture = await poseBoardFixture(t);
  const recovery = await recoverPoseBoard({
    source: fixture.source,
    recoveryContract: fixture.recoveryContractFile,
    run: fixture.run,
    project: fixture.project
  });

  const expected = [
    'source/pose-board/original.png',
    'source/pose-board/recovery-contract.json',
    'work/pose-board/foreground-mask.png',
    'work/pose-board/candidate-overlay.png',
    'work/pose-board/candidates/candidate-0001.png',
    'reports/pose-board-recovery.json'
  ];
  for (const relative of expected) {
    const file = path.join(fixture.run.root, ...relative.split('/'));
    assert.equal((await fs.lstat(file)).isFile(), true);
  }

  assert.equal(recovery.document.kind, 'pose-board-recovery');
  assert.equal(recovery.document.projectSha256, fixture.project.sha256);
  assert.equal(recovery.document.runSha256, fixture.run.sha256);
  assert.equal(recovery.document.runId, fixture.run.id);
  assert.equal(recovery.document.actionId, 'idle');
  assert.equal(recovery.document.source.sha256, await sha256File(fixture.source));
  assert.equal(
    recovery.document.contract.documentSha256,
    sha256Value(recovery.document.contract.document)
  );
  assert.equal(recovery.document.mask.sha256, await sha256File(path.join(
    fixture.run.root,
    recovery.document.mask.path
  )));
  assert.equal(recovery.document.overlay.sha256, await sha256File(path.join(
    fixture.run.root,
    recovery.document.overlay.path
  )));
  assert.equal(recovery.document.components.length, 3);
  assert.equal(recovery.document.candidates.length, 3);
  for (const candidate of recovery.document.candidates) {
    assert.equal(candidate.sha256, await sha256File(path.join(fixture.run.root, candidate.path)));
  }
  assert.equal(recovery.sha256, await sha256File(recovery.path));

  const retried = await recoverPoseBoard({
    source: fixture.source,
    recoveryContract: fixture.recoveryContractFile,
    run: fixture.run,
    project: fixture.project
  });
  assert.equal(retried.sha256, recovery.sha256);
  assert.equal(retried.reused, true);

  const firstCandidate = path.join(fixture.run.root, recovery.document.candidates[0].path);
  await fs.writeFile(firstCandidate, Buffer.from('changed candidate bytes'));
  await assert.rejects(
    recoverPoseBoard({
      source: fixture.source,
      recoveryContract: fixture.recoveryContractFile,
      run: fixture.run,
      project: fixture.project
    }),
    /existing immutable artifact differs/
  );
});

test('pose-board recovery rejects changed source and contract ancestry on retry', async (t) => {
  const fixture = await poseBoardFixture(t);
  await recoverPoseBoard({
    source: fixture.source,
    recoveryContract: fixture.recoveryContractFile,
    run: fixture.run,
    project: fixture.project
  });
  const originalSource = await fs.readFile(fixture.source);
  await fs.writeFile(fixture.source, Buffer.concat([originalSource, Buffer.from([0])]));
  await assert.rejects(
    recoverPoseBoard({
      source: fixture.source,
      recoveryContract: fixture.recoveryContractFile,
      run: fixture.run,
      project: fixture.project
    }),
    /existing immutable artifact differs/
  );

  await fs.writeFile(fixture.source, originalSource);
  const changedContract = recoveryContract();
  changedContract.padding = 3;
  await fs.writeFile(fixture.recoveryContractFile, JSON.stringify(changedContract));
  await assert.rejects(
    recoverPoseBoard({
      source: fixture.source,
      recoveryContract: fixture.recoveryContractFile,
      run: fixture.run,
      project: fixture.project
    }),
    /existing immutable artifact differs/
  );
});

function validSelection({ fixture, recovery, frames } = {}) {
  return {
    schemaVersion: 1,
    kind: 'pose-board-selection',
    projectSha256: fixture.project.sha256,
    runId: fixture.run.id,
    actionId: 'idle',
    recoverySha256: recovery.sha256,
    frames: frames ?? recovery.document.candidates.map((candidate, index) => ({
      id: `stride-${String(index + 1).padStart(2, '0')}`,
      candidateId: candidate.id,
      durationMs: 80 + (index * 20),
      tracks: [{ role: 'actor', componentIds: candidate.componentIds }]
    }))
  };
}

test('pose selection validates complete whole-component disposition', async (t) => {
  const fixture = await poseBoardFixture(t);
  const recovery = await recoverPoseBoard({
    source: fixture.source,
    recoveryContract: fixture.recoveryContractFile,
    run: fixture.run,
    project: fixture.project
  });

  const duplicateCandidate = validSelection({ fixture, recovery });
  duplicateCandidate.frames[1].candidateId = duplicateCandidate.frames[0].candidateId;
  await assert.rejects(
    writePoseSelection({
      run: fixture.run,
      project: fixture.project,
      recovery,
      value: duplicateCandidate
    }),
    /candidate IDs must be unique/
  );

  const duplicateComponent = validSelection({ fixture, recovery });
  duplicateComponent.frames[1].tracks[0].componentIds = [
    duplicateComponent.frames[0].tracks[0].componentIds[0]
  ];
  await assert.rejects(
    writePoseSelection({
      run: fixture.run,
      project: fixture.project,
      recovery,
      value: duplicateComponent
    }),
    /component membership must be unique/
  );

  const incomplete = validSelection({ fixture, recovery });
  incomplete.frames.pop();
  await assert.rejects(
    writePoseSelection({
      run: fixture.run,
      project: fixture.project,
      recovery,
      value: incomplete
    }),
    /complete eligible-component disposition/
  );

  const unknown = validSelection({ fixture, recovery });
  unknown.frames[0].tracks[0].componentIds = ['component-9999'];
  await assert.rejects(
    writePoseSelection({
      run: fixture.run,
      project: fixture.project,
      recovery,
      value: unknown
    }),
    /unknown component ID: component-9999/
  );
});

test('pose selection revisions and approvals bind current recovery ancestry', async (t) => {
  const fixture = await poseBoardFixture(t);
  const recovery = await recoverPoseBoard({
    source: fixture.source,
    recoveryContract: fixture.recoveryContractFile,
    run: fixture.run,
    project: fixture.project
  });
  const selection = await writePoseSelection({
    run: fixture.run,
    project: fixture.project,
    recovery,
    value: validSelection({ fixture, recovery })
  });
  assert.equal(selection.revision, 1);
  assert.equal(selection.document.frames.length, 3);
  assert.equal(selection.sha256, await sha256File(selection.path));

  await assert.rejects(
    approvePoseSelection({
      run: fixture.run,
      project: fixture.project,
      recovery: { ...recovery, sha256: '0'.repeat(64) },
      selection,
      approver: 'owner',
      decision: 'approved',
      notes: 'Reviewed numbered poses.',
      clock: () => new Date('2026-07-22T12:00:00.000Z')
    }),
    /recovery ancestry mismatch/
  );

  const approval = await approvePoseSelection({
    run: fixture.run,
    project: fixture.project,
    recovery,
    selection,
    approver: 'owner',
    decision: 'approved',
    notes: 'Reviewed numbered poses.',
    clock: () => new Date('2026-07-22T12:00:00.000Z')
  });
  assert.equal(approval.revision, 1);
  assert.equal(approval.document.selectionSha256, selection.sha256);
  assert.equal(approval.document.recoverySha256, recovery.sha256);
  assert.equal(approval.document.decidedAt, '2026-07-22T12:00:00.000Z');

  const loaded = await loadApprovedPoseSelection({
    run: fixture.run,
    project: fixture.project,
    recovery,
    file: approval.path
  });
  assert.equal(loaded.verified, true);
  assert.deepEqual(loaded.selection.document, selection.document);

  const changed = structuredClone(approval.document);
  changed.recoverySha256 = 'f'.repeat(64);
  await fs.writeFile(approval.path, JSON.stringify(changed));
  await assert.rejects(
    loadApprovedPoseSelection({
      run: fixture.run,
      project: fixture.project,
      recovery,
      file: approval.path
    }),
    /canonical immutable JSON|recovery hash mismatch/
  );
});

test('pose-board intake hands off for approval then resumes to centered motion frames', async (t) => {
  const fixture = await poseBoardFixture(t, { allowUnassigned: true });
  await assert.rejects(
    decodePoseBoard({
      source: fixture.source,
      recoveryContract: fixture.recoveryContractFile,
      run: fixture.run,
      project: fixture.project
    }),
    (error) => {
      assert.equal(error.exitCode, 4);
      assert.equal(error.handoff.status, 'awaiting-pose-selection');
      assert.equal(error.handoff.runId, fixture.run.id);
      assert.match(error.handoff.recovery.sha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(error.handoff.next.argv.slice(-6), [
        'studio',
        '--stage',
        'recovery',
        '--project-dir',
        fixture.project.root,
        '--run',
        fixture.run.id
      ].slice(-6));
      return true;
    }
  );

  const recovery = await recoverPoseBoard({
    source: fixture.source,
    recoveryContract: fixture.recoveryContractFile,
    run: fixture.run,
    project: fixture.project
  });
  const selectedCandidates = [
    recovery.document.candidates[0],
    recovery.document.candidates[2]
  ];
  const selection = await writePoseSelection({
    run: fixture.run,
    project: fixture.project,
    recovery,
    value: validSelection({
      fixture,
      recovery,
      frames: selectedCandidates.map((candidate, index) => ({
        id: `stride-${String(index + 1).padStart(2, '0')}`,
        candidateId: candidate.id,
        durationMs: index === 0 ? 80 : 120,
        tracks: [{ role: 'actor', componentIds: candidate.componentIds }]
      }))
    })
  });
  const approval = await approvePoseSelection({
    run: fixture.run,
    project: fixture.project,
    recovery,
    selection,
    approver: 'owner',
    decision: 'approved',
    notes: 'Use poses one and three.',
    clock: () => new Date('2026-07-22T12:00:00.000Z')
  });
  const result = await decodePoseBoard({
    source: fixture.source,
    recoveryContract: fixture.recoveryContractFile,
    selectionApproval: approval.path,
    run: fixture.run,
    project: fixture.project
  });

  assert.equal(result.kind, 'pose-board');
  assert.deepEqual(result.frames.map(({ id }) => id), ['stride-01', 'stride-02']);
  assert.deepEqual(result.frames.map(({ durationMs }) => durationMs), [80, 120]);
  assert.deepEqual(result.frames.map(({ timestampMs }) => timestampMs), [0, 80]);
  assert.equal(new Set(result.frames.map(({ width }) => width)).size, 1);
  assert.equal(new Set(result.frames.map(({ height }) => height)).size, 1);

  for (const [index, frame] of result.frames.entries()) {
    const candidate = selectedCandidates[index];
    const candidatePixels = await sharp(path.join(fixture.run.root, candidate.path))
      .ensureAlpha()
      .raw()
      .toBuffer();
    const outputPixels = await sharp(path.join(fixture.run.root, frame.path))
      .ensureAlpha()
      .raw()
      .toBuffer();
    const offsetX = Math.floor((result.canvas.width - candidate.width) / 2);
    const offsetY = Math.floor((result.canvas.height - candidate.height) / 2);
    for (let y = 0; y < result.canvas.height; y += 1) {
      for (let x = 0; x < result.canvas.width; x += 1) {
        const outputOffset = ((y * result.canvas.width) + x) * 4;
        const candidateX = x - offsetX;
        const candidateY = y - offsetY;
        if (
          candidateX < 0 ||
          candidateX >= candidate.width ||
          candidateY < 0 ||
          candidateY >= candidate.height
        ) {
          assert.deepEqual([...outputPixels.subarray(outputOffset, outputOffset + 4)], [0, 0, 0, 0]);
          continue;
        }
        const candidateOffset = ((candidateY * candidate.width) + candidateX) * 4;
        assert.deepEqual(
          [...outputPixels.subarray(outputOffset, outputOffset + 4)],
          [...candidatePixels.subarray(candidateOffset, candidateOffset + 4)]
        );
      }
    }
  }
});
