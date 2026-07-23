import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeMotion } from '../studio/motion-diagnostics.mjs';

const edit = ({
  root,
  foot,
  contacts = ['left-foot'],
  translation = { x: 0, y: 0 },
  groundTravel = { x: 0, y: 0 }
}) => ({
  translation,
  groundTravel,
  contacts,
  markers: [
    ...(root ? [{ id: 'root', kind: 'root-pivot', ...root }] : []),
    ...(foot ? [{ id: 'left-foot', kind: 'planted-foot', ...foot }] : [])
  ]
});

test('motion analysis plots active world-space root and planted-foot paths', () => {
  const frames = [
    { id: 'contact-a', included: true, edit: edit({ root: { x: 5, y: 5 }, foot: { x: 4, y: 10 } }) },
    {
      id: 'pass',
      included: false,
      edit: edit({ root: { x: 90, y: 90 }, foot: { x: 90, y: 90 } })
    },
    {
      id: 'contact-b',
      included: true,
      edit: edit({
        root: { x: 6, y: 5 },
        foot: { x: 5, y: 10 },
        groundTravel: { x: 1, y: 0 }
      })
    }
  ];

  const analysis = analyzeMotion(frames, { width: 16, height: 16, pivot: { x: 8, y: 12 } });

  assert.deepEqual(analysis.rootPath, [
    { frameIndex: 0, frameId: 'contact-a', x: 5, y: 5 },
    { frameIndex: 2, frameId: 'contact-b', x: 5, y: 5 }
  ]);
  assert.deepEqual(analysis.footPaths['left-foot'], [
    { frameIndex: 0, frameId: 'contact-a', x: 4, y: 10 },
    { frameIndex: 2, frameId: 'contact-b', x: 4, y: 10 }
  ]);
  assert.equal(analysis.issues.some(({ type }) => type === 'foot-slide'), false);
});

test('motion analysis reports continuous foot slide and missing authored markers', () => {
  const frames = [
    { id: 'contact-a', included: true, edit: edit({ root: null, foot: { x: 4, y: 10 } }) },
    { id: 'contact-b', included: true, edit: edit({ root: { x: 6, y: 5 }, foot: { x: 6, y: 10 } }) },
    { id: 'contact-c', included: true, edit: edit({ root: { x: 7, y: 5 }, foot: null }) }
  ];

  const analysis = analyzeMotion(frames, { width: 16, height: 16, pivot: { x: 8, y: 12 } });

  assert.deepEqual(
    analysis.issues.map(({ type, frameIndex }) => [type, frameIndex]),
    [
      ['missing-root', 0],
      ['foot-slide', 1],
      ['missing-contact-marker', 2]
    ]
  );
  assert.deepEqual(analysis.rootPath[0], { frameIndex: 0, frameId: 'contact-a', x: 8, y: 12 });
});
