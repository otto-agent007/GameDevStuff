import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';

import {
  poseBoardContractHash,
  validatePoseBoardContract
} from '../scripts/lib/pose-board-contract.mjs';
import {
  analyzePoseBoard,
  renderRecoveredCandidate
} from '../scripts/lib/pose-board-recovery.mjs';

function validContract(overrides = {}) {
  return {
    schemaVersion: 1,
    background: { mode: 'color', rgba: [0, 255, 0, 255], tolerance: 8 },
    connectivity: 4,
    minimumComponentPixels: 4,
    maxDecodedRgbaBytes: 1024 * 1024,
    padding: 2,
    expectedCandidates: { min: 2, max: 8 },
    allowUnassigned: false,
    groups: [],
    ...overrides
  };
}

test('pose-board recovery contract is closed, immutable, and hash-bound', () => {
  const input = validContract();
  const selected = validatePoseBoardContract(input);

  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected.background), true);
  assert.equal(Object.isFrozen(selected.expectedCandidates), true);
  assert.equal(Object.isFrozen(selected.groups), true);
  assert.notEqual(selected, input);
  assert.match(poseBoardContractHash(selected), /^[a-f0-9]{64}$/);
  assert.equal(poseBoardContractHash(selected), poseBoardContractHash(structuredClone(input)));

  assert.throws(
    () => validatePoseBoardContract(validContract({ connectivity: 8 })),
    /connectivity/
  );
  assert.throws(
    () => validatePoseBoardContract({ ...validContract(), surprise: true }),
    /unknown pose-board recovery contract field: surprise/
  );
});

test('pose-board recovery contract rejects unsafe nested values and duplicate grouping', () => {
  assert.throws(
    () => validatePoseBoardContract(validContract({
      background: {
        mode: 'color',
        rgba: [0, 255, 0, 255],
        tolerance: 8,
        surprise: true
      }
    })),
    /unknown pose-board background field: surprise/
  );
  assert.throws(
    () => validatePoseBoardContract(validContract({
      background: { mode: 'color', rgba: [0, 255, 0], tolerance: 8 }
    })),
    /RGBA/
  );
  assert.throws(
    () => validatePoseBoardContract(validContract({ padding: 4096 })),
    /padding/
  );
  assert.throws(
    () => validatePoseBoardContract(validContract({
      expectedCandidates: { min: 9, max: 8 }
    })),
    /candidate count range/
  );
  assert.throws(
    () => validatePoseBoardContract(validContract({
      groups: [
        { id: 'actor-one', componentIds: ['component-0001'] },
        { id: 'actor-two', componentIds: ['component-0001'] }
      ]
    })),
    /component membership must be unique/
  );
});

test('pose-board recovery contract closes optional chroma spill removal', () => {
  const selected = validatePoseBoardContract(validContract({
    background: {
      mode: 'border',
      tolerance: 8,
      spill: { minimumDominance: 24 }
    }
  }));
  assert.deepEqual(selected.background.spill, { minimumDominance: 24 });
  assert.equal(Object.isFrozen(selected.background.spill), true);
  assert.throws(
    () => validatePoseBoardContract(validContract({
      background: {
        mode: 'border',
        tolerance: 8,
        spill: { minimumDominance: 0 }
      }
    })),
    /minimumDominance/
  );
  assert.throws(
    () => validatePoseBoardContract(validContract({
      background: {
        mode: 'border',
        tolerance: 8,
        spill: { minimumDominance: 24, surprise: true }
      }
    })),
    /unknown pose-board chroma spill field: surprise/
  );
});

const BACKGROUND = [0, 255, 0, 255];

function writePixel(pixels, width, x, y, rgba) {
  pixels.set(rgba, ((y * width) + x) * 4);
}

async function syntheticBoard({ darkSpill = false } = {}) {
  const width = 12;
  const height = 8;
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(BACKGROUND, offset);

  // Candidate one deliberately crosses the nominal x=6 grid boundary.
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
  writePixel(pixels, width, 3, 3, [0, 250, 4, 255]);
  if (darkSpill) writePixel(pixels, width, 8, 3, [0, 80, 0, 255]);

  const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  return { bytes, pixels, width, height };
}

test('pose-board analysis recovers whole crossing-boundary components deterministically', async () => {
  const source = await syntheticBoard();
  const before = Buffer.from(source.bytes);
  const analysis = await analyzePoseBoard({ bytes: source.bytes, contract: validContract() });

  assert.equal(analysis.width, 12);
  assert.equal(analysis.height, 8);
  assert.deepEqual(analysis.components.map(({ id }) => id), [
    'component-0001',
    'component-0002',
    'component-0003'
  ]);
  assert.equal(analysis.ignoredNoise.length, 2);
  assert.deepEqual(analysis.proposedOrder, [
    'candidate-0001',
    'candidate-0002',
    'candidate-0003'
  ]);
  assert.deepEqual(
    analysis.candidates.map(({ componentIds }) => componentIds),
    [['component-0001'], ['component-0002'], ['component-0003']]
  );
  assert.deepEqual(analysis.components[0].bounds, {
    left: 4,
    top: 1,
    right: 7,
    bottom: 2,
    width: 4,
    height: 2
  });
  assert.match(analysis.maskSha256, /^[a-f0-9]{64}$/);
  assert.match(analysis.components[0].pixelSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(source.bytes, before);

  const repeat = await analyzePoseBoard({ bytes: source.bytes, contract: validContract() });
  assert.deepEqual(repeat.components, analysis.components);
  assert.deepEqual(repeat.candidates, analysis.candidates);
  assert.equal(repeat.maskSha256, analysis.maskSha256);
});

test('pose-board analysis supports dominant-border background and enforces limits', async () => {
  const source = await syntheticBoard();
  const borderAnalysis = await analyzePoseBoard({
    bytes: source.bytes,
    contract: validContract({
      background: { mode: 'border', tolerance: 8 }
    })
  });
  assert.deepEqual(borderAnalysis.background.rgba, BACKGROUND);
  assert.equal(borderAnalysis.background.mode, 'border');
  assert.equal(borderAnalysis.components.length, 3);

  await assert.rejects(
    analyzePoseBoard({
      bytes: source.bytes,
      contract: validContract({ maxDecodedRgbaBytes: (12 * 8 * 4) - 1 })
    }),
    /decoded RGBA exceeds/
  );
  await assert.rejects(
    analyzePoseBoard({
      bytes: source.bytes,
      contract: validContract({ expectedCandidates: { min: 4, max: 8 } })
    }),
    /candidate count/
  );
  await assert.rejects(
    analyzePoseBoard({
      bytes: source.bytes,
      contract: validContract({
        groups: [{ id: 'unknown-pair', componentIds: ['component-9999'] }]
      })
    }),
    /unknown component ID: component-9999/
  );
});

test('pose-board chroma spill removes dark dominant-channel fringe without eroding subject colors', async () => {
  const source = await syntheticBoard({ darkSpill: true });
  const withoutSpill = await analyzePoseBoard({
    bytes: source.bytes,
    contract: validContract()
  });
  assert.equal(withoutSpill.ignoredNoise.length, 3);

  const withSpill = await analyzePoseBoard({
    bytes: source.bytes,
    contract: validContract({
      background: {
        mode: 'border',
        tolerance: 8,
        spill: { minimumDominance: 24 }
      }
    })
  });
  assert.equal(withSpill.ignoredNoise.length, 2);
  assert.deepEqual(withSpill.background.spill, {
    channel: 'green',
    minimumDominance: 24
  });
  assert.deepEqual(
    withSpill.components.map(({ pixelCount }) => pixelCount),
    [6, 4, 4]
  );
});

test('pose-board grouping uses whole components and exact candidate rendering', async () => {
  const source = await syntheticBoard();
  const analysis = await analyzePoseBoard({
    bytes: source.bytes,
    contract: validContract({
      groups: [{
        id: 'actor-and-prop',
        componentIds: ['component-0002', 'component-0003']
      }]
    })
  });

  assert.equal(analysis.candidates.length, 2);
  assert.deepEqual(
    analysis.candidates.map(({ id, componentIds }) => [id, componentIds]),
    [
      ['candidate-0001', ['component-0001']],
      ['actor-and-prop', ['component-0002', 'component-0003']]
    ]
  );

  const rendered = await renderRecoveredCandidate({
    analysis,
    componentIds: ['component-0001']
  });
  assert.equal(rendered.width, 8);
  assert.equal(rendered.height, 6);
  assert.equal(
    rendered.sha256,
    crypto.createHash('sha256').update(rendered.bytes).digest('hex')
  );
  assert.deepEqual(rendered.componentIds, ['component-0001']);
  assert.deepEqual(rendered.placement, {
    sourceBounds: { left: 4, top: 1, right: 7, bottom: 2, width: 4, height: 2 },
    outputOffset: { x: 2, y: 2 }
  });

  const decoded = await sharp(rendered.bytes).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < rendered.height; y += 1) {
    for (let x = 0; x < rendered.width; x += 1) {
      const outputOffset = ((y * rendered.width) + x) * 4;
      const outputPixel = [...decoded.subarray(outputOffset, outputOffset + 4)];
      const sourceX = x - rendered.placement.outputOffset.x + rendered.placement.sourceBounds.left;
      const sourceY = y - rendered.placement.outputOffset.y + rendered.placement.sourceBounds.top;
      const selected = analysis.components[0].pixels.some(
        (pixel) => pixel.x === sourceX && pixel.y === sourceY
      );
      if (!selected) {
        assert.deepEqual(outputPixel, [0, 0, 0, 0]);
        continue;
      }
      const sourceOffset = ((sourceY * source.width) + sourceX) * 4;
      assert.deepEqual(outputPixel, [...source.pixels.subarray(sourceOffset, sourceOffset + 4)]);
    }
  }

  await assert.rejects(
    renderRecoveredCandidate({
      analysis,
      componentIds: ['component-0001', 'component-0001']
    }),
    /component IDs must be unique/
  );
});
