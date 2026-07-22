import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPixelProductionContract, publishExportRevision } from '../scripts/lib/export-contract.mjs';
import { sha256File, sha256Value } from '../scripts/lib/schema.mjs';

const HASH = (letter) => letter.repeat(64);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'character-export-contract-'));
  const run = { id: 'run-1', root: path.join(root, 'run'), sha256: HASH('1') };
  await fs.mkdir(path.join(run.root, 'exports'), { recursive: true });
  const pixelRoot = path.join(root, 'pixel-export');
  await fs.mkdir(path.join(pixelRoot, 'clips', 'walk'), { recursive: true });
  const files = ['animation-contract-export.json', 'clips/walk/walk-00.png'];
  await fs.writeFile(path.join(pixelRoot, files[0]), '{"version":2}\n');
  await fs.writeFile(path.join(pixelRoot, files[1]), 'runtime-frame');
  const artifacts = await Promise.all(files.map(async (relative) => ({ path: relative, sha256: await sha256File(path.join(pixelRoot, relative)) })));
  return {
    run,
    bindings: {
      projectSha256: HASH('2'), sourceSha256: HASH('3'), editSha256: HASH('4'), selectionApprovalSha256: HASH('5'),
      snapReceiptSha256: HASH('6'), frameApprovalSha256: HASH('7')
    },
    pixelExport: { root: pixelRoot, artifacts },
    validationReport: { passed: true, failures: [], warnings: [], measurements: { scale: 2 } }
  };
}

test('verified pixel outputs publish into a new provenance-bound export revision', async () => {
  const value = await fixture();
  const result = await publishExportRevision(value);
  assert.equal(path.relative(value.run.root, result.path), path.join('exports', 'revision-0001', 'manifest.json'));
  assert.equal(result.document.selectionApprovalSha256, value.bindings.selectionApprovalSha256);
  assert.deepEqual(result.document.artifacts.map(({ path: artifactPath }) => artifactPath), ['animation-contract-export.json', 'clips/walk/walk-00.png', 'validation-report.json']);
  for (const artifact of result.document.artifacts) assert.equal(await sha256File(path.join(path.dirname(result.path), artifact.path)), artifact.sha256);
});

test('export publication rejects a changed declared artifact before creating a revision', async () => {
  const value = await fixture();
  await fs.appendFile(path.join(value.pixelExport.root, value.pixelExport.artifacts[1].path), 'tamper');
  await assert.rejects(publishExportRevision(value), /artifact hash mismatch/);
  assert.deepEqual(await fs.readdir(path.join(value.run.root, 'exports')), []);
});

test('production contract binds the canonical anchor and approved actor derivatives', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'character-pixel-contract-'));
  const projectRoot = path.join(root, 'project');
  const runRoot = path.join(projectRoot, '.game-character-pipeline', 'runs', 'run-1');
  await fs.mkdir(path.join(projectRoot, 'source', 'anchors'), { recursive: true });
  await fs.mkdir(path.join(runRoot, 'work', 'approved'), { recursive: true });
  const anchor = path.join(projectRoot, 'source', 'anchors', 'hero.png');
  const derivative = path.join(runRoot, 'work', 'approved', 'walk-1.png');
  await fs.writeFile(anchor, 'anchor');
  await fs.writeFile(derivative, 'approved-frame');
  const anchorSha256 = await sha256File(anchor);
  const derivativeSha256 = await sha256File(derivative);
  const palette = [[0, 0, 0, 0], [18, 34, 51, 255]];
  const project = {
    root: projectRoot,
    sha256: HASH('2'),
    document: {
      id: 'hero',
      character: { anchors: [{ id: 'hero', role: 'canonical', path: 'source/anchors/hero.png', sha256: anchorSha256 }] },
      canvas: { width: 16, height: 16, pivot: { x: 8, y: 14 }, baseline: 13 },
      scale: { integer: 2, runtime: { width: 32, height: 32 } },
      palette: { rgba: palette, sha256: sha256Value(palette) },
      tracks: [{ id: 'actor', kind: 'actor', required: true, attachTo: null }],
      sockets: [], contacts: [],
      actions: [{ id: 'walk', semantic: 'walk forward', loopMode: 'loop', tracks: ['actor'], sockets: [], contacts: [] }],
      approvals: { requiredGates: ['canonical-anchor', 'annotated-animation', 'final-preview'], identities: ['owner'] }
    }
  };
  const run = { id: 'run-1', root: runRoot, sha256: HASH('1'), document: { sourceRequest: { actionId: 'walk' } } };
  const selectionApproval = {
    verified: true, path: path.join(runRoot, 'approved.json'), sha256: HASH('3'),
    document: { decision: 'approved', selectedFrames: [{ frameId: 'walk-1', derivativeSha256 }], derivatives: [{ frameId: 'walk-1', path: 'work/approved/walk-1.png', sha256: derivativeSha256 }] }
  };
  const edit = { actionId: 'walk', frames: [{ frameId: 'walk-1', included: true, label: 'contact', durationMs: 80, tracks: ['actor'], contacts: [], groundTravel: { x: 0, y: 0 } }] };

  const result = await createPixelProductionContract({ run, project, selectionApproval, edit });
  assert.equal(result.document.version, 2);
  assert.equal(result.document.character.anchorSha256, anchorSha256);
  assert.equal(result.document.selectionApprovalSha256, selectionApproval.sha256);
  assert.equal(result.inputs.document.anchor.sha256, anchorSha256);
  assert.deepEqual(result.inputs.document.frames.map(({ frameId, trackId, sha256 }) => [frameId, trackId, sha256]), [['walk-1', 'actor', derivativeSha256]]);
  assert.equal(await sha256File(result.path), result.sha256);
});
