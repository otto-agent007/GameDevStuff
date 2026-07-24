import fs from 'node:fs/promises';

import {
  deepFreeze,
  exactObject,
  integer,
  portableId,
  portableRelativePath,
  sha256Value,
  uniqueList
} from './schema.mjs';

const HASH = /^[a-f0-9]{64}$/;
const LOOP_MODES = new Set(['loop', 'once', 'hold-last']);
const TRACK_KINDS = new Set(['actor', 'prop', 'effect']);
const CONTACT_KINDS = new Set(['planted-foot', 'custom']);
const SOURCE_KINDS = new Set(['generated-still', 'png-sequence', 'pose-board', 'gif', 'apng', 'webp', 'mp4', 'webm']);
const ENGINE_KINDS = new Set(['generic', 'godot']);
const APPROVAL_STATUSES = new Set(['draft', 'anchor-approved']);
const REQUIRED_GATES = Object.freeze(['canonical-anchor', 'annotated-animation', 'final-preview']);

function string(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a nonempty string`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} must be a sha256`);
  return value;
}

function exactCoordinate(value, label) {
  exactObject(value, ['x', 'y'], label);
  integer(value.x, `${label} x`, { min: 0 });
  integer(value.y, `${label} y`, { min: 0 });
}

function validateCharacter(character) {
  exactObject(character, ['name', 'identity', 'logicalHeight', 'anchors'], 'character');
  string(character.name, 'character name');
  string(character.identity, 'character identity');
  integer(character.logicalHeight, 'character logicalHeight', { min: 1, max: 16384 });
  uniqueList(character.anchors, 'character anchors', { key: ({ id }) => id });
  for (const anchor of character.anchors) {
    exactObject(anchor, ['id', 'role', 'path', 'sha256'], 'anchor');
    portableId(anchor.id, 'anchor ID');
    if (!['canonical', 'trait'].includes(anchor.role)) throw new Error('anchor role is invalid');
    portableRelativePath(anchor.path, 'anchor path');
    hash(anchor.sha256, 'anchor hash');
  }
  if (character.anchors.filter(({ role }) => role === 'canonical').length !== 1) {
    throw new Error('character requires exactly one canonical anchor');
  }
}

function validateCanvas(canvas, character) {
  exactObject(canvas, ['width', 'height', 'pivot', 'baseline'], 'canvas');
  integer(canvas.width, 'canvas width', { min: 1, max: 16384 });
  integer(canvas.height, 'canvas height', { min: 1, max: 16384 });
  exactCoordinate(canvas.pivot, 'canvas pivot');
  integer(canvas.baseline, 'canvas baseline', { min: 0, max: canvas.height - 1 });
  if (canvas.pivot.x >= canvas.width || canvas.pivot.y >= canvas.height) throw new Error('canvas pivot must be inside the canvas');
  if (character.logicalHeight > canvas.height) throw new Error('character logicalHeight must fit the canvas');
}

function validateScale(scale, canvas) {
  exactObject(scale, ['integer', 'runtime'], 'scale');
  integer(scale.integer, 'global scale', { min: 1, max: 64 });
  exactObject(scale.runtime, ['width', 'height'], 'runtime');
  integer(scale.runtime.width, 'runtime width', { min: 1, max: 1048576 });
  integer(scale.runtime.height, 'runtime height', { min: 1, max: 1048576 });
  if (scale.runtime.width !== canvas.width * scale.integer || scale.runtime.height !== canvas.height * scale.integer) {
    throw new Error('runtime dimensions must equal canvas dimensions times global scale');
  }
}

function validatePalette(palette) {
  exactObject(palette, ['rgba', 'sha256'], 'palette');
  if (!Array.isArray(palette.rgba) || palette.rgba.length < 2 || palette.rgba.length > 17) {
    throw new Error('palette must contain transparent plus 1 to 16 opaque colors');
  }
  const colors = palette.rgba.map((color, index) => {
    if (!Array.isArray(color) || color.length !== 4 || color.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      throw new Error(`palette color ${index} must be RGBA bytes`);
    }
    return color.join(',');
  });
  if (new Set(colors).size !== colors.length) throw new Error('palette colors must be unique');
  if (palette.rgba[0][3] !== 0 || palette.rgba.slice(1).some((color) => color[3] !== 255)) {
    throw new Error('palette requires one leading transparent color and opaque remaining colors');
  }
  hash(palette.sha256, 'palette hash');
  if (palette.sha256 !== sha256Value(palette.rgba)) throw new Error('palette hash does not bind ordered RGBA colors');
}

function validateTracks(tracks) {
  uniqueList(tracks, 'track IDs', { key: ({ id }) => id });
  for (const track of tracks) {
    exactObject(track, ['id', 'kind', 'required', 'attachTo'], 'track');
    portableId(track.id, 'track ID');
    if (!TRACK_KINDS.has(track.kind)) throw new Error(`track kind is invalid: ${track.kind}`);
    boolean(track.required, 'track required');
    if (track.kind === 'actor' && track.attachTo !== null) throw new Error('actor track cannot attach to a socket');
    if (track.kind !== 'actor' && typeof track.attachTo !== 'string') throw new Error('prop and effect tracks require an attachment socket');
  }
  if (tracks.filter(({ kind }) => kind === 'actor').length !== 1) throw new Error('project requires exactly one actor track');
}

function validateSockets(sockets, tracks) {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  uniqueList(sockets, 'sockets', { min: 0, key: ({ id }) => id });
  for (const socket of sockets) {
    exactObject(socket, ['id', 'trackId', 'required'], 'socket');
    portableId(socket.id, 'socket ID');
    portableId(socket.trackId, 'socket track ID');
    boolean(socket.required, 'socket required');
    const track = trackById.get(socket.trackId);
    if (!track) throw new Error(`socket references unknown track: ${socket.trackId}`);
    if (track.kind !== 'actor') throw new Error('v1 sockets must belong to the actor track');
  }
  const socketIds = new Set(sockets.map(({ id }) => id));
  for (const track of tracks) {
    if (track.attachTo !== null && !socketIds.has(track.attachTo)) {
      throw new Error(`unknown attachment socket: ${track.attachTo}`);
    }
  }
}

function validateContacts(contacts, tracks) {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  uniqueList(contacts, 'contacts', { min: 0, key: ({ id }) => id });
  for (const contact of contacts) {
    exactObject(contact, ['id', 'trackId', 'kind', 'required'], 'contact');
    portableId(contact.id, 'contact ID');
    portableId(contact.trackId, 'contact track ID');
    boolean(contact.required, 'contact required');
    if (!CONTACT_KINDS.has(contact.kind)) throw new Error(`contact kind is invalid: ${contact.kind}`);
    const track = trackById.get(contact.trackId);
    if (!track) throw new Error(`contact references unknown track: ${contact.trackId}`);
    if (contact.kind === 'planted-foot' && track.kind !== 'actor') {
      throw new Error('planted-foot contact must belong to the actor track');
    }
  }
}

function validateSources(sources) {
  exactObject(sources, ['allowedKinds', 'defaultStillKind'], 'sources');
  uniqueList(sources.allowedKinds, 'allowed source kinds');
  for (const kind of sources.allowedKinds) {
    if (!SOURCE_KINDS.has(kind)) throw new Error(`unsupported source kind: ${kind}`);
  }
  if (!sources.allowedKinds.includes('png-sequence')) throw new Error('allowed source kinds must include png-sequence');
  if (!sources.allowedKinds.includes(sources.defaultStillKind) || sources.defaultStillKind !== 'generated-still') {
    throw new Error('default still source kind must be allowed generated-still');
  }
}

function validateActions(actions, { tracks, sockets, contacts, sources }) {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const socketIds = new Set(sockets.map(({ id }) => id));
  const contactIds = new Set(contacts.map(({ id }) => id));
  uniqueList(actions, 'actions', { key: ({ id }) => id });
  for (const action of actions) {
    exactObject(action, ['id', 'semantic', 'loopMode', 'poses', 'tracks', 'sockets', 'contacts', 'sources'], 'action');
    portableId(action.id, 'action ID');
    string(action.semantic, 'action semantic description');
    if (!LOOP_MODES.has(action.loopMode)) throw new Error(`action loopMode is invalid: ${action.loopMode}`);
    uniqueList(action.poses, 'action poses');
    action.poses.forEach((pose) => string(pose, 'action pose'));
    uniqueList(action.tracks, 'action tracks');
    for (const id of action.tracks) if (!trackById.has(id)) throw new Error(`action references unknown track: ${id}`);
    if (!action.tracks.some((id) => trackById.get(id).kind === 'actor')) throw new Error('action must include the actor track');
    uniqueList(action.sockets, 'action sockets', { min: 0 });
    for (const id of action.sockets) if (!socketIds.has(id)) throw new Error(`action references unknown socket: ${id}`);
    uniqueList(action.contacts, 'action contacts', { min: 0 });
    for (const id of action.contacts) if (!contactIds.has(id)) throw new Error(`action references unknown contact: ${id}`);
    for (const trackId of action.tracks) {
      const attachment = trackById.get(trackId).attachTo;
      if (attachment && !action.sockets.includes(attachment)) throw new Error(`action omits attachment socket: ${attachment}`);
    }
    exactObject(action.sources, ['preferred', 'fallbacks'], 'action sources');
    const selected = [action.sources.preferred, ...uniqueList(action.sources.fallbacks, 'action source fallbacks')];
    if (new Set(selected).size !== selected.length) throw new Error('action source preferences must be unique');
    for (const kind of selected) {
      if (!sources.allowedKinds.includes(kind)) throw new Error(`action source kind is not allowed: ${kind}`);
    }
  }
}

function validateEngineTargets(engineTargets) {
  uniqueList(engineTargets, 'engine targets', { key: ({ id }) => id });
  for (const target of engineTargets) {
    exactObject(target, ['id', 'kind', 'version'], 'engine target');
    portableId(target.id, 'engine target ID');
    if (!ENGINE_KINDS.has(target.kind)) throw new Error(`engine target kind is invalid: ${target.kind}`);
    if (target.kind === 'generic' && target.version !== null) throw new Error('generic engine target version must be null');
    if (target.kind !== 'generic') string(target.version, 'engine target version');
  }
}

function validateApprovals(approvals) {
  exactObject(approvals, ['status', 'identities', 'requiredGates'], 'approvals');
  if (!APPROVAL_STATUSES.has(approvals.status)) throw new Error(`approval status is invalid: ${approvals.status}`);
  uniqueList(approvals.identities, 'approval identities');
  approvals.identities.forEach((identity) => portableId(identity, 'approval identity'));
  if (JSON.stringify(approvals.requiredGates) !== JSON.stringify(REQUIRED_GATES)) {
    throw new Error('required approval gates must be canonical-anchor, annotated-animation, and final-preview in order');
  }
}

export function validateProjectContract(document) {
  let project;
  try {
    project = structuredClone(document);
  } catch {
    throw new Error('project contract must be structured-cloneable');
  }
  exactObject(
    project,
    ['schemaVersion', 'id', 'character', 'canvas', 'scale', 'palette', 'tracks', 'sockets', 'contacts', 'sources', 'actions', 'engineTargets', 'approvals'],
    'project'
  );
  if (project.schemaVersion !== 1) throw new Error('project schemaVersion must be 1');
  portableId(project.id, 'project ID');
  validateCharacter(project.character);
  validateCanvas(project.canvas, project.character);
  validateScale(project.scale, project.canvas);
  validatePalette(project.palette);
  validateTracks(project.tracks);
  validateSockets(project.sockets, project.tracks);
  validateContacts(project.contacts, project.tracks);
  validateSources(project.sources);
  validateActions(project.actions, project);
  validateEngineTargets(project.engineTargets);
  validateApprovals(project.approvals);
  return deepFreeze(project);
}

export async function loadProjectContract(file) {
  const document = validateProjectContract(JSON.parse(await fs.readFile(file, 'utf8')));
  return deepFreeze({ document, sha256: sha256Value(document) });
}
