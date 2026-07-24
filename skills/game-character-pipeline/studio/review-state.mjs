const SPEEDS = new Set([0.25, 0.5, 1, 2]);

export const cloneFrameState = (frames) => structuredClone(frames ?? []);

export const activeIndices = (frames) =>
  (frames ?? []).flatMap((frame, index) => frame.included !== false ? [index] : []);

export function playbackIndices(frames, range = {}) {
  const start = Number.isInteger(range.in) ? range.in : 0;
  const end = Number.isInteger(range.out) ? range.out : Math.max(0, frames.length - 1);
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  return activeIndices(frames).filter((index) => index >= low && index <= high);
}

export function nextPlaybackIndex(indices, currentIndex) {
  if (!indices.length) return null;
  return indices.find((index) => index > currentIndex) ?? indices[0];
}

function authoredDuration(frame) {
  const durationMs = frame?.edit?.durationMs ?? frame?.durationMs;
  if (!Number.isInteger(durationMs) || durationMs < 1) {
    throw new Error('authored duration must be a positive integer');
  }
  return durationMs;
}

export function sequenceDurationMs(frames, range = {}) {
  return playbackIndices(frames, range)
    .reduce((total, index) => total + authoredDuration(frames[index]), 0);
}

export function frameStartElapsedMs(frames, frameIndex, range = {}) {
  let elapsedMs = 0;
  for (const index of playbackIndices(frames, range)) {
    if (index >= frameIndex) break;
    elapsedMs += authoredDuration(frames[index]);
  }
  return elapsedMs;
}

export function resolveElapsedFrame(frames, elapsedMs, { range = {}, loop = false } = {}) {
  const indices = playbackIndices(frames, range);
  const totalDurationMs = sequenceDurationMs(frames, range);
  if (!indices.length || totalDurationMs === 0) {
    return { index: null, totalDurationMs: 0, elapsedMs: 0, frameElapsedMs: 0, complete: true };
  }
  const requestedElapsedMs = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const complete = !loop && requestedElapsedMs >= totalDurationMs;
  if (complete) {
    const index = indices.at(-1);
    return {
      index,
      totalDurationMs,
      elapsedMs: totalDurationMs,
      frameElapsedMs: authoredDuration(frames[index]),
      complete: true
    };
  }
  const resolvedElapsedMs = loop ? requestedElapsedMs % totalDurationMs : requestedElapsedMs;
  let frameStartMs = 0;
  for (const index of indices) {
    const durationMs = authoredDuration(frames[index]);
    if (resolvedElapsedMs < frameStartMs + durationMs) {
      return {
        index,
        totalDurationMs,
        elapsedMs: resolvedElapsedMs,
        frameElapsedMs: resolvedElapsedMs - frameStartMs,
        complete: false
      };
    }
    frameStartMs += durationMs;
  }
  throw new Error('elapsed frame resolution failed');
}

export function reviewDelay(durationMs, speed) {
  authoredDuration({ durationMs });
  if (!SPEEDS.has(speed)) throw new Error('review speed is unsupported');
  return durationMs / speed;
}
