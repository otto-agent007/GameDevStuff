import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeIndices,
  cloneFrameState,
  frameStartElapsedMs,
  nextPlaybackIndex,
  playbackIndices,
  resolveElapsedFrame,
  reviewDelay,
  sequenceDurationMs
} from '../studio/review-state.mjs';

const frames = [
  { id: 'contact-a', included: true, edit: { durationMs: 80 } },
  { id: 'pass', included: false, edit: { durationMs: 120 } },
  { id: 'contact-b', included: true, edit: { durationMs: 200 } }
];

test('review state clones nested edits without sharing mutation', () => {
  const clone = cloneFrameState(frames);
  clone[0].edit.durationMs = 96;

  assert.equal(frames[0].edit.durationMs, 80);
});

test('playback range filters active frames inclusively', () => {
  assert.deepEqual(activeIndices(frames), [0, 2]);
  assert.deepEqual(playbackIndices(frames, { in: 1, out: 2 }), [2]);
  assert.equal(nextPlaybackIndex([0, 2], 0), 2);
  assert.equal(nextPlaybackIndex([0, 2], 2), 0);
  assert.equal(nextPlaybackIndex([], 0), null);
});

test('review delay preserves authored duration at selectable speeds', () => {
  assert.equal(reviewDelay(80, 0.5), 160);
  assert.equal(reviewDelay(80, 2), 40);
  assert.throws(() => reviewDelay(80, 3), /review speed/);
});

test('elapsed review resolution preserves each sequence timing', () => {
  const alternate = cloneFrameState(frames);
  alternate[0].edit.durationMs = 200;

  assert.deepEqual(resolveElapsedFrame(frames, 100), {
    index: 2,
    totalDurationMs: 280,
    elapsedMs: 100,
    frameElapsedMs: 20,
    complete: false
  });
  assert.equal(resolveElapsedFrame(alternate, 100).index, 0);
  assert.equal(resolveElapsedFrame(frames, 280).index, 2);
  assert.equal(resolveElapsedFrame(frames, 280).complete, true);
  assert.equal(resolveElapsedFrame(frames, 300, { loop: true }).index, 0);
  assert.equal(sequenceDurationMs(frames), 280);
  assert.equal(frameStartElapsedMs(frames, 2), 80);
});
