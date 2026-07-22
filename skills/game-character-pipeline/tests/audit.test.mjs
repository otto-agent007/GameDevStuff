import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { auditRun, compareRuns } from '../scripts/lib/audit.mjs';
import { publishExportRevision } from '../scripts/lib/export-contract.mjs';
import { sha256File, sha256Value } from '../scripts/lib/schema.mjs';

const HASH = (letter) => letter.repeat(64);

async function runtimePng(file, interpolation = false) {
  const source = Buffer.from([
    10, 20, 30, 255, 50, 60, 70, 255,
    80, 90, 100, 255, 120, 130, 140, 255
  ]);
  await sharp(source, { raw: { width: 2, height: 2, channels: 4 } })
    .resize(4, 4, { kernel: interpolation ? sharp.kernel.cubic : sharp.kernel.nearest })
    .png()
    .toFile(file);
}

async function fixture({ runId = 'run-a', createdAt = '2026-07-21T12:00:00.000Z', mutation } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'character-audit-'));
  const runRoot = path.join(temporary, 'run');
  const pixelRoot = path.join(temporary, 'pixel');
  await fs.mkdir(path.join(runRoot, 'exports'), { recursive: true });
  await fs.mkdir(path.join(pixelRoot, 'tracks', 'actor'), { recursive: true });
  await fs.mkdir(path.join(pixelRoot, 'clips', 'walk'), { recursive: true });
  const actor = path.join(pixelRoot, 'tracks', 'actor', 'walk-1.png');
  const combined = path.join(pixelRoot, 'clips', 'walk', 'walk-00.png');
  await runtimePng(actor, mutation === 'interpolation');
  await fs.copyFile(actor, combined);
  for (const name of ['walk-sheet.png', 'walk-contact-sheet.png', 'walk.json', 'walk.webp']) {
    await fs.writeFile(path.join(pixelRoot, 'clips', 'walk', name), `stable-${name}`);
  }
  const artifact = async (relative) => ({ file: relative, sha256: await sha256File(path.join(pixelRoot, relative)) });
  const frame = {
    id: 'walk-1', semantic: 'contact', duration: mutation === 'timing' ? 0 : 80, tracks: ['actor'],
    root: mutation === 'drift' ? { x: 0, y: 1 } : { x: 1, y: 1 }, baseline: 1,
    sockets: {}, contacts: {}, groundTravel: { x: 0, y: 0 },
    outputs: [{ trackId: 'actor', kind: 'actor', attachTo: null, sourceSha256: HASH('8'), normalizedSha256: HASH('9'), ...await artifact('tracks/actor/walk-1.png') }],
    combined: await artifact('clips/walk/walk-00.png')
  };
  const contract = {
    version: 2, selectionApprovalSha256: HASH('5'), character: { id: 'hero', anchorSha256: HASH('4') },
    canvas: { width: 2, height: 2, pivot: { x: 1, y: 1 }, baseline: 1 },
    scale: { integer: 2, runtime: { width: 4, height: 4 } },
    palette: { rgba: [[0, 0, 0, 0], [10, 20, 30, 255]], sha256: HASH('a'), snapperPaletteHex: ['0a141e'] },
    tracks: [{ id: 'actor', kind: 'actor', required: true, attachTo: null }], sockets: [], contacts: [],
    clips: [{ id: 'walk', loopMode: 'loop', frames: [{ id: 'walk-1', semantic: 'contact', duration: 80, tracks: ['actor'], sockets: [], contacts: [], groundTravel: { x: 0, y: 0 } }] }],
    review: { checkpoints: ['final-preview'], approvers: ['owner'] }
  };
  const engineIndex = {
    version: 2, animationContractSha256: HASH('b'), animationContract: contract,
    selectionApprovalSha256: HASH('5'), frameApprovalSha256: HASH('6'), snapReceiptSha256: HASH('7'),
    character: contract.character, canvas: contract.canvas, scale: contract.scale, palette: contract.palette,
    tracks: contract.tracks, sockets: [], contacts: [],
    clips: [{
      id: 'walk', loopMode: 'loop', restart: 'loop', frames: [frame],
      sheet: await artifact('clips/walk/walk-sheet.png'), contactSheet: await artifact('clips/walk/walk-contact-sheet.png'),
      metadata: await artifact('clips/walk/walk.json'), preview: await artifact('clips/walk/walk.webp')
    }]
  };
  await fs.writeFile(path.join(pixelRoot, 'animation-contract-export.json'), JSON.stringify(engineIndex));
  const names = [
    'animation-contract-export.json', 'tracks/actor/walk-1.png', 'clips/walk/walk-00.png',
    'clips/walk/walk-sheet.png', 'clips/walk/walk-contact-sheet.png', 'clips/walk/walk.json', 'clips/walk/walk.webp'
  ];
  const artifacts = await Promise.all(names.map(async (relative) => ({ path: relative, sha256: await sha256File(path.join(pixelRoot, relative)) })));
  const run = { id: runId, root: runRoot, sha256: sha256Value({ runId }), document: { projectSha256: HASH('2'), createdAt } };
  const project = { sha256: HASH('2'), document: { id: 'hero', canvas: contract.canvas, scale: contract.scale } };
  const bindings = {
    projectSha256: project.sha256, sourceSha256: HASH('3'), editSha256: HASH('4'), selectionApprovalSha256: HASH('5'),
    snapReceiptSha256: HASH('7'), frameApprovalSha256: HASH('6')
  };
  const validationReport = mutation === 'clipping'
    ? { passed: false, failures: [{ code: 'CLIPPED_FOREGROUND' }], warnings: [], measurements: {} }
    : { passed: true, failures: [], warnings: [], measurements: { scale: 2 } };
  const published = await publishExportRevision({ run, bindings, pixelExport: { root: pixelRoot, artifacts }, validationReport });
  if (mutation === 'broken-hash') await fs.appendFile(path.join(path.dirname(published.path), 'clips', 'walk', 'walk-00.png'), 'tamper');
  return {
    temporary, run, project,
    expected: { exportManifest: published.path, validationReport, envelope: { runId, createdAt, approvedBy: 'owner', approvedAt: createdAt } }
  };
}

test('two equivalent runs have identical deterministic artifact hashes', async (t) => {
  const leftFixture = await fixture({ runId: 'run-left', createdAt: '2026-07-21T12:00:00.000Z' });
  const rightFixture = await fixture({ runId: 'run-right', createdAt: '2026-07-22T12:00:00.000Z' });
  t.after(() => Promise.all([leftFixture, rightFixture].map(({ temporary }) => fs.rm(temporary, { recursive: true, force: true }))));
  const left = await auditRun(leftFixture);
  const right = await auditRun(rightFixture);
  assert.equal(left.passed, true, JSON.stringify(left.failures));
  assert.equal(right.passed, true, JSON.stringify(right.failures));
  assert.deepEqual(compareRuns(left, right).changedDeterministicArtifacts, []);
  assert.notDeepEqual(compareRuns(left, right).envelopeDifferences, []);
});

test('audit fails on interpolation, timing defaults, drift, clipping, and broken hashes', async (t) => {
  for (const mutation of ['interpolation', 'timing', 'drift', 'clipping', 'broken-hash']) {
    const value = await fixture({ mutation });
    t.after(() => fs.rm(value.temporary, { recursive: true, force: true }));
    const report = await auditRun(value);
    assert.equal(report.passed, false, `${mutation} unexpectedly passed`);
    assert.equal(report.failures.length > 0, true);
  }
});
