import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAnimationContract } from '../scripts/lib/animation-contract.mjs';
import { stableHash } from '../scripts/lib/state-auth.mjs';

const HASH = (letter) => letter.repeat(64);

export function contractDocument() {
  return {
    version: 1,
    anchor: { sha256: HASH('a'), traitReferenceSha256: [HASH('b')] },
    sizes: { canonical: [128, 128], generation: [1024, 1024], runtime: [256, 256], pixelSize: 8 },
    pivot: { x: 64, y: 112 },
    baseline: 111,
    palette: {
      rgba: [[0, 0, 0, 0], [18, 34, 51, 255], [255, 255, 255, 255]],
      sha256: stableHash([[0, 0, 0, 0], [18, 34, 51, 255], [255, 255, 255, 255]]),
      snapperPaletteHex: ['122233', 'ffffff']
    },
    clips: [{
      id: 'idle', loopMode: 'loop', loopTransition: { fromFrameId: 'idle-02', toFrameId: 'idle-01', reviewCheckpoint: 'motion' },
      frames: [
        { id: 'idle-01', pose: 'rest', duration: 100, landmarkSemantic: { name: 'character-root', target: { x: 64, y: 112 } } },
        { id: 'idle-02', pose: 'breathe', duration: 120, landmarkSemantic: { name: 'character-root', target: { x: 64, y: 112 } } }
      ]
    }],
    review: { checkpoints: ['identity', 'motion'], approvers: ['artist@example.test'] }
  };
}

export async function writeContract(document = contractDocument()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-animation-contract-'));
  const file = path.join(directory, 'animation-contract.json');
  await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  return file;
}

test('Pop T contract rejects implicit timing, palette, or landmark semantics', async () => {
  for (const field of ['clips', 'snapperPaletteHex', 'landmarkSemantic']) {
    const document = contractDocument();
    if (field === 'clips') delete document.clips;
    if (field === 'snapperPaletteHex') delete document.palette.snapperPaletteHex;
    if (field === 'landmarkSemantic') delete document.clips[0].frames[0].landmarkSemantic;
    await assert.rejects(loadAnimationContract(await writeContract(document)), new RegExp(field));
  }
});

test('contract freezes and hashes one closed Pop T animation document', async () => {
  const document = contractDocument();
  const contract = await loadAnimationContract(await writeContract(document));
  assert.equal(contract.sha256, stableHash(document));
  assert.ok(Object.isFrozen(contract));
  assert.ok(Object.isFrozen(contract.document.clips[0].frames[0].landmarkSemantic.target));
  assert.throws(() => { contract.document.baseline = 112; }, TypeError);
});

test('contract rejects extra, duplicate, unordered, or invalid fixed values', async () => {
  const extra = contractDocument();
  extra.unapproved = true;
  await assert.rejects(loadAnimationContract(await writeContract(extra)), /schema|contract/i);

  const duplicate = contractDocument();
  duplicate.clips[0].frames[1].id = 'idle-01';
  await assert.rejects(loadAnimationContract(await writeContract(duplicate)), /unique|frame/i);

  const malformedClip = contractDocument();
  malformedClip.clips[0].frames.reverse();
  malformedClip.clips[0].frames[0].duration = 10;
  await assert.rejects(loadAnimationContract(await writeContract(malformedClip)), /duration|frame/i);

  const invalid = contractDocument();
  invalid.sizes.pixelSize = 7;
  await assert.rejects(loadAnimationContract(await writeContract(invalid)), /sizes|pixelSize/i);
});

test('contract closes pose semantics and loop-transition review bindings', async () => {
  const duplicatePose = contractDocument();
  duplicatePose.clips[0].frames[1].pose = duplicatePose.clips[0].frames[0].pose;
  await assert.rejects(loadAnimationContract(await writeContract(duplicatePose)), /pose|unique/i);

  const missing = contractDocument();
  delete missing.clips[0].loopTransition;
  await assert.rejects(loadAnimationContract(await writeContract(missing)), /loopTransition/i);

  const mismatched = contractDocument();
  mismatched.clips[0].loopTransition.fromFrameId = 'idle-01';
  await assert.rejects(loadAnimationContract(await writeContract(mismatched)), /loopTransition|frame/i);

  const unknownCheckpoint = contractDocument();
  unknownCheckpoint.clips[0].loopTransition.reviewCheckpoint = 'unknown';
  await assert.rejects(loadAnimationContract(await writeContract(unknownCheckpoint)), /checkpoint|loopTransition/i);

  const once = contractDocument();
  once.clips[0].loopMode = 'once';
  once.clips[0].loopTransition = { fromFrameId: 'idle-02', toFrameId: 'idle-01', reviewCheckpoint: 'motion' };
  await assert.rejects(loadAnimationContract(await writeContract(once)), /loopTransition/i);
});
