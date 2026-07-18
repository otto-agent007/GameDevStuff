import fs from 'node:fs/promises';
import { stableHash } from './state-auth.mjs';

const HASH = /^[a-f0-9]{64}$/;
const LOOP_MODES = new Set(['loop', 'once', 'hold-last']);
const TARGET = Object.freeze({ x: 64, y: 112 });
const SIZES = Object.freeze({ canonical: [128, 128], generation: [1024, 1024], runtime: [256, 256], pixelSize: 8 });

function exact(value, keys, label) {
  const missing = value && typeof value === 'object' && !Array.isArray(value) ? keys.find((key) => !Object.hasOwn(value, key)) : null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || missing) throw new Error(`animation contract ${missing ?? label} schema is invalid`);
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`animation contract ${label} must be a sha256`);
}

function uniqueStrings(value, label, { nonempty = true } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0) || value.some((item) => typeof item !== 'string' || item === '') || new Set(value).size !== value.length) throw new Error(`animation contract ${label} must be a unique ordered string list`);
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function coordinate(value, label, target = false) {
  exact(value, ['x', 'y'], label);
  if (!Number.isInteger(value.x) || !Number.isInteger(value.y) || (target ? !same(value, TARGET) : value.x < 0 || value.y < 0)) throw new Error(`animation contract ${label} is invalid`);
}

function validateAnchor(anchor) {
  exact(anchor, ['sha256', 'traitReferenceSha256'], 'anchor');
  hash(anchor.sha256, 'anchor hash');
  if (!Array.isArray(anchor.traitReferenceSha256) || anchor.traitReferenceSha256.length === 0 || new Set(anchor.traitReferenceSha256).size !== anchor.traitReferenceSha256.length) throw new Error('animation contract anchor trait references are required');
  for (const item of anchor.traitReferenceSha256) hash(item, 'anchor trait reference hash');
}

function rgba(value) {
  return Array.isArray(value) && value.length === 4 && value.every((component) => Number.isInteger(component) && component >= 0 && component <= 255);
}

function hex(value) { return value.toString(16).padStart(2, '0'); }

function validatePalette(palette) {
  exact(palette, ['rgba', 'sha256', 'snapperPaletteHex'], 'palette');
  if (!Array.isArray(palette.rgba) || palette.rgba.length < 2 || palette.rgba.some((entry) => !rgba(entry)) || new Set(palette.rgba.map((entry) => entry.join(','))).size !== palette.rgba.length) throw new Error('animation contract palette RGBA values are invalid');
  if (palette.rgba[0][3] !== 0 || palette.rgba.slice(1).some((entry) => entry[3] !== 255)) throw new Error('animation contract palette requires one leading transparent RGBA entry and opaque colors');
  if (palette.rgba.length - 1 > 16) throw new Error('animation contract palette exceeds the fixed 16-color Snapper limit');
  if (palette.sha256 !== stableHash(palette.rgba)) throw new Error('animation contract palette hash does not bind its ordered RGBA values');
  if (!Array.isArray(palette.snapperPaletteHex) || !same(palette.snapperPaletteHex, palette.rgba.slice(1).map((entry) => `${hex(entry[0])}${hex(entry[1])}${hex(entry[2])}`))) throw new Error('animation contract snapperPaletteHex must exactly match ordered opaque palette colors');
}

function validateClips(clips, review) {
  if (!Array.isArray(clips) || clips.length === 0) throw new Error('animation contract clips are required');
  const clipIds = new Set();
  const frameIds = new Set();
  for (const clip of clips) {
    exact(clip, ['id', 'loopMode', 'loopTransition', 'frames'], 'clip');
    if (typeof clip.id !== 'string' || clip.id === '' || clipIds.has(clip.id)) throw new Error('animation contract clip IDs must be unique and ordered');
    clipIds.add(clip.id);
    if (!LOOP_MODES.has(clip.loopMode)) throw new Error('animation contract clip loopMode is invalid');
    if (!Array.isArray(clip.frames) || clip.frames.length === 0) throw new Error('animation contract clip frames are required');
    const poses = new Set();
    for (const frame of clip.frames) {
      exact(frame, ['id', 'pose', 'duration', 'landmarkSemantic'], 'frame');
      if (typeof frame.id !== 'string' || frame.id === '' || frameIds.has(frame.id)) throw new Error('animation contract frame IDs must be unique and ordered');
      frameIds.add(frame.id);
      if (typeof frame.pose !== 'string' || frame.pose === '' || poses.has(frame.pose)) throw new Error('animation contract frame pose labels must be unique within each clip');
      poses.add(frame.pose);
      if (!Number.isInteger(frame.duration) || frame.duration < 11 || frame.duration > 65535) throw new Error('animation contract frame duration must be one integer from 11 to 65535');
      exact(frame.landmarkSemantic, ['name', 'target'], 'landmarkSemantic');
      if (typeof frame.landmarkSemantic.name !== 'string' || frame.landmarkSemantic.name === '') throw new Error('animation contract landmarkSemantic name is required');
      coordinate(frame.landmarkSemantic.target, 'landmarkSemantic target', true);
    }
    if (clip.loopMode === 'loop') {
      exact(clip.loopTransition, ['fromFrameId', 'toFrameId', 'reviewCheckpoint'], 'loopTransition');
      const first = clip.frames[0].id;
      const last = clip.frames.at(-1).id;
      if (clip.loopTransition.fromFrameId !== last || clip.loopTransition.toFrameId !== first || typeof clip.loopTransition.reviewCheckpoint !== 'string' || clip.loopTransition.reviewCheckpoint === '' || !review.checkpoints.includes(clip.loopTransition.reviewCheckpoint)) throw new Error('animation contract loopTransition must bind the final frame to the first through a declared review checkpoint');
    } else if (clip.loopTransition !== null) {
      throw new Error('animation contract loopTransition must be null for once and hold-last clips');
    }
  }
}

function validateReview(review) {
  exact(review, ['checkpoints', 'approvers'], 'review');
  uniqueStrings(review.checkpoints, 'review checkpoints');
  uniqueStrings(review.approvers, 'review approvers');
}

export function validateAnimationContract(document) {
  exact(document, ['version', 'anchor', 'sizes', 'pivot', 'baseline', 'palette', 'clips', 'review'], 'document');
  if (document.version !== 1) throw new Error('animation contract version must be 1');
  if (!same(document.sizes, SIZES)) throw new Error('animation contract sizes must fix Pop T canonical, generation, runtime, and pixelSize values');
  coordinate(document.pivot, 'pivot', true);
  if (document.baseline !== 111) throw new Error('animation contract baseline must be 111');
  validateAnchor(document.anchor);
  validateReview(document.review);
  validatePalette(document.palette);
  validateClips(document.clips, document.review);
  return document;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export async function loadAnimationContract(file) {
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  validateAnimationContract(document);
  return deepFreeze({ document, sha256: stableHash(document) });
}

export const POP_T_TARGET = TARGET;
