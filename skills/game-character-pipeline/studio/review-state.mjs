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

export function reviewDelay(durationMs, speed) {
  if (!Number.isInteger(durationMs) || durationMs < 1) {
    throw new Error('authored duration must be a positive integer');
  }
  if (!SPEEDS.has(speed)) throw new Error('review speed is unsupported');
  return durationMs / speed;
}
