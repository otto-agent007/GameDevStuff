import fs from 'node:fs/promises';
import { stableHash } from './state-auth.mjs';

const HASH = /^[a-f0-9]{64}$/;
const PORTABLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const LOOP_MODES = new Set(['loop', 'once', 'hold-last']);
const TRACK_KINDS = new Set(['actor', 'prop', 'effect']);
const CONTACT_KINDS = new Set(['planted-foot', 'custom']);
const TARGET = Object.freeze({ x: 64, y: 112 });
const SIZES = Object.freeze({ canonical: [128, 128], generation: [1024, 1024], runtime: [256, 256], pixelSize: 8 });

function exact(value, keys, label) {
  const missing = value && typeof value === 'object' && !Array.isArray(value) ? keys.find((key) => !Object.hasOwn(value, key)) : null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || missing) throw new Error(`animation contract ${missing ?? label} schema is invalid`);
}

function exactV2(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`animation contract ${label} schema is invalid`);
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`animation contract unknown ${label} field: ${unknown}`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new Error(`animation contract ${label} is missing field: ${missing}`);
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`animation contract ${label} must be a sha256`);
}

function uniqueStrings(value, label, { nonempty = true } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0) || value.some((item) => typeof item !== 'string' || item === '') || new Set(value).size !== value.length) throw new Error(`animation contract ${label} must be a unique ordered string list`);
}

function portableId(value, label) {
  if (typeof value !== 'string' || !PORTABLE_ID.test(value)) throw new Error(`animation contract ${label} must be a portable ID`);
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`animation contract ${label} must be a boolean`);
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

export function validateAnimationContractV1(document) {
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

function validateCharacterV2(character) {
  exactV2(character, ['id', 'anchorSha256'], 'character');
  portableId(character.id, 'character ID');
  hash(character.anchorSha256, 'character anchor hash');
}

function validateCanvasV2(canvas) {
  exactV2(canvas, ['width', 'height', 'pivot', 'baseline'], 'canvas');
  if (!Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) || canvas.width < 1 || canvas.height < 1 || canvas.width > 16384 || canvas.height > 16384) throw new Error('animation contract canvas dimensions must be positive bounded integers');
  coordinate(canvas.pivot, 'canvas pivot');
  if (canvas.pivot.x >= canvas.width || canvas.pivot.y >= canvas.height) throw new Error('animation contract canvas pivot must be inside the stable canvas');
  if (!Number.isInteger(canvas.baseline) || canvas.baseline < 0 || canvas.baseline >= canvas.height) throw new Error('animation contract canvas baseline must be inside the stable canvas');
}

function validateScaleV2(scale, canvas) {
  exactV2(scale, ['integer', 'runtime'], 'scale');
  if (!Number.isInteger(scale.integer) || scale.integer < 1 || scale.integer > 64) throw new Error('animation contract global scale must be one positive integer');
  exactV2(scale.runtime, ['width', 'height'], 'runtime');
  if (scale.runtime.width !== canvas.width * scale.integer || scale.runtime.height !== canvas.height * scale.integer) throw new Error('animation contract runtime dimensions must equal the stable canvas times global scale');
}

function validateTracksV2(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('animation contract tracks are required');
  const ids = new Set();
  for (const track of tracks) {
    exactV2(track, ['id', 'kind', 'required', 'attachTo'], 'track');
    portableId(track.id, 'track ID');
    if (ids.has(track.id)) throw new Error('animation contract track IDs must be unique and ordered');
    ids.add(track.id);
    if (!TRACK_KINDS.has(track.kind)) throw new Error(`animation contract track kind is invalid: ${track.kind}`);
    boolean(track.required, 'track required');
    if (track.kind === 'actor' && track.attachTo !== null) throw new Error('animation contract actor track cannot attach to a socket');
    if (track.kind !== 'actor') portableId(track.attachTo, 'track attachment socket');
  }
  if (tracks.filter(({ kind }) => kind === 'actor').length !== 1) throw new Error('animation contract requires exactly one actor track');
}

function validateSocketsV2(sockets, tracks) {
  if (!Array.isArray(sockets)) throw new Error('animation contract sockets must be an ordered list');
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const ids = new Set();
  for (const socket of sockets) {
    exactV2(socket, ['id', 'trackId', 'required'], 'socket');
    portableId(socket.id, 'socket ID');
    if (ids.has(socket.id)) throw new Error('animation contract socket IDs must be unique and ordered');
    ids.add(socket.id);
    portableId(socket.trackId, 'socket track ID');
    boolean(socket.required, 'socket required');
    const track = trackById.get(socket.trackId);
    if (!track) throw new Error(`animation contract socket references unknown track: ${socket.trackId}`);
    if (track.kind !== 'actor') throw new Error('animation contract sockets must belong to the actor track');
  }
  for (const track of tracks) {
    if (track.attachTo !== null && !ids.has(track.attachTo)) throw new Error(`animation contract track references unknown socket: ${track.attachTo}`);
  }
}

function validateContactsV2(contacts, tracks) {
  if (!Array.isArray(contacts)) throw new Error('animation contract contacts must be an ordered list');
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const ids = new Set();
  for (const contact of contacts) {
    exactV2(contact, ['id', 'trackId', 'kind', 'required'], 'contact');
    portableId(contact.id, 'contact ID');
    if (ids.has(contact.id)) throw new Error('animation contract contact IDs must be unique and ordered');
    ids.add(contact.id);
    portableId(contact.trackId, 'contact track ID');
    boolean(contact.required, 'contact required');
    if (!CONTACT_KINDS.has(contact.kind)) throw new Error(`animation contract contact kind is invalid: ${contact.kind}`);
    const track = trackById.get(contact.trackId);
    if (!track) throw new Error(`animation contract contact references unknown track: ${contact.trackId}`);
    if (contact.kind === 'planted-foot' && track.kind !== 'actor') throw new Error('animation contract planted-foot contact must belong to the actor track');
  }
}

function validateGroundTravel(value) {
  exactV2(value, ['x', 'y'], 'groundTravel');
  if (!Number.isInteger(value.x) || !Number.isInteger(value.y)) throw new Error('animation contract groundTravel must use integer coordinates');
}

function validateClipsV2(clips, tracks, sockets, contacts) {
  if (!Array.isArray(clips) || clips.length === 0) throw new Error('animation contract clips are required');
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const socketIds = new Set(sockets.map(({ id }) => id));
  const contactIds = new Set(contacts.map(({ id }) => id));
  const clipIds = new Set();
  const frameIds = new Set();
  for (const clip of clips) {
    exactV2(clip, ['id', 'loopMode', 'frames'], 'clip');
    portableId(clip.id, 'clip ID');
    if (clipIds.has(clip.id)) throw new Error('animation contract clip IDs must be unique and ordered');
    clipIds.add(clip.id);
    if (!LOOP_MODES.has(clip.loopMode)) throw new Error('animation contract clip loopMode is invalid');
    if (!Array.isArray(clip.frames) || clip.frames.length === 0) throw new Error('animation contract clip frames are required');
    for (const frame of clip.frames) {
      exactV2(frame, ['id', 'semantic', 'duration', 'tracks', 'sockets', 'contacts', 'groundTravel'], 'frame');
      portableId(frame.id, 'frame ID');
      if (frameIds.has(frame.id)) throw new Error('animation contract frame IDs must be unique and ordered');
      frameIds.add(frame.id);
      if (typeof frame.semantic !== 'string' || frame.semantic.trim() === '') throw new Error('animation contract frame semantic is required');
      if (!Number.isInteger(frame.duration) || frame.duration < 11 || frame.duration > 65535) throw new Error('animation contract frame duration must be one integer from 11 to 65535');
      uniqueStrings(frame.tracks, 'frame tracks');
      uniqueStrings(frame.sockets, 'frame sockets', { nonempty: false });
      uniqueStrings(frame.contacts, 'frame contacts', { nonempty: false });
      for (const id of frame.tracks) if (!trackById.has(id)) throw new Error(`animation contract frame references unknown track: ${id}`);
      if (!frame.tracks.some((id) => trackById.get(id).kind === 'actor')) throw new Error('animation contract frame must include the actor track');
      for (const track of tracks) if (track.required && !frame.tracks.includes(track.id)) throw new Error(`animation contract frame omits required track: ${track.id}`);
      for (const id of frame.sockets) if (!socketIds.has(id)) throw new Error(`animation contract frame references unknown socket: ${id}`);
      for (const id of frame.contacts) if (!contactIds.has(id)) throw new Error(`animation contract frame references unknown contact: ${id}`);
      for (const id of frame.tracks) {
        const attachment = trackById.get(id).attachTo;
        if (attachment !== null && !frame.sockets.includes(attachment)) throw new Error(`animation contract frame omits attachment socket: ${attachment}`);
      }
      validateGroundTravel(frame.groundTravel);
    }
  }
}

export function validateAnimationContractV2(document) {
  exactV2(document, ['version', 'selectionApprovalSha256', 'character', 'canvas', 'scale', 'palette', 'tracks', 'sockets', 'contacts', 'clips', 'review'], 'document');
  if (document.version !== 2) throw new Error('animation contract version must be 2');
  hash(document.selectionApprovalSha256, 'selection approval hash');
  validateCharacterV2(document.character);
  validateCanvasV2(document.canvas);
  validateScaleV2(document.scale, document.canvas);
  validatePalette(document.palette);
  validateTracksV2(document.tracks);
  validateSocketsV2(document.sockets, document.tracks);
  validateContactsV2(document.contacts, document.tracks);
  validateClipsV2(document.clips, document.tracks, document.sockets, document.contacts);
  validateReview(document.review);
  return document;
}

export function validateAnimationContract(document) {
  if (document?.version === 1) return validateAnimationContractV1(document);
  if (document?.version === 2) return validateAnimationContractV2(document);
  throw new Error('animation contract version must be 1 or 2');
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
