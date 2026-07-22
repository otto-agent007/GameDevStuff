import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { writeImmutableBytes, writeImmutableJson } from './artifacts.mjs';
import {
  deepFreeze,
  exactObject,
  integer,
  portableId,
  portableRelativePath,
  sha256File,
  sha256Value,
  uniqueList
} from './schema.mjs';

const HASH = /^[a-f0-9]{64}$/;
const MARKER_KINDS = new Set(['root-pivot', 'baseline', 'planted-foot', 'socket', 'prop-grip']);

function text(value, label, { empty = false, max = 128 } = {}) {
  if (typeof value !== 'string' || (!empty && value.length === 0) || value.length > max) {
    throw new Error(`${label} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} must be a sha256`);
  return value;
}

function projectContext(project) {
  const document = project?.document ?? project;
  if (!document || typeof document !== 'object') throw new Error('edit validation requires a project contract');
  return { document, sha256: project?.sha256 ?? sha256Value(document) };
}

function validatePoint(value, label, canvas) {
  exactObject(value, ['x', 'y'], label);
  integer(value.x, `${label} x`, { min: 0, max: canvas.width - 1 });
  integer(value.y, `${label} y`, { min: 0, max: canvas.height - 1 });
  return value;
}

function validateMarker(marker, { project, action }) {
  exactObject(marker, ['id', 'kind', 'x', 'y'], 'edit marker');
  portableId(marker.id, 'edit marker ID');
  if (!MARKER_KINDS.has(marker.kind)) throw new Error(`edit marker kind is invalid: ${marker.kind}`);
  validatePoint({ x: marker.x, y: marker.y }, 'edit marker logical canvas point', project.canvas);
  if (marker.kind === 'root-pivot' && marker.id !== 'root') throw new Error('root pivot marker ID must be root');
  if (marker.kind === 'baseline' && marker.id !== 'baseline') throw new Error('baseline marker ID must be baseline');
  if (marker.kind === 'prop-grip' && marker.id !== 'prop-grip') throw new Error('prop grip marker ID must be prop-grip');
  if (marker.kind === 'socket') {
    const known = project.sockets.some(({ id }) => id === marker.id);
    if (!known) throw new Error(`edit marker references an unknown socket: ${marker.id}`);
    if (!action.sockets.includes(marker.id)) throw new Error(`edit marker socket is not used by the action: ${marker.id}`);
  }
  if (marker.kind === 'planted-foot') {
    const known = project.contacts.some(({ id }) => id === marker.id);
    if (!known) throw new Error(`edit marker references an unknown contact: ${marker.id}`);
    if (!action.contacts.includes(marker.id)) throw new Error(`edit marker contact is not used by the action: ${marker.id}`);
  }
  return marker;
}

function validateTransform(transform) {
  if (transform === null) return null;
  exactObject(transform, ['scale', 'rotationQuarterTurns'], 'edit frame transform');
  integer(transform.scale, 'edit frame transform integer global scale', { min: 1, max: 8 });
  integer(transform.rotationQuarterTurns, 'edit frame transform rotationQuarterTurns', { min: -3, max: 3 });
  return transform;
}

export function validateEditManifest(value, context = {}) {
  const edit = structuredClone(value);
  const { document: project, sha256: projectSha256 } = projectContext(context.project);
  const source = context.source;
  if (!source || !Array.isArray(source.frames)) throw new Error('edit validation requires a motion source');
  const sourceSha256 = sha256Value(source);
  exactObject(edit, ['schemaVersion', 'kind', 'projectSha256', 'sourceSha256', 'actionId', 'frames'], 'edit manifest');
  if (edit.schemaVersion !== 1 || edit.kind !== 'frame-studio-edit') throw new Error('edit manifest identity is invalid');
  if (hash(edit.projectSha256, 'edit project hash') !== projectSha256) throw new Error('edit project hash mismatch');
  if (hash(edit.sourceSha256, 'edit source hash') !== sourceSha256) throw new Error('edit source hash mismatch');
  portableId(edit.actionId, 'edit action ID');
  const action = project.actions.find(({ id }) => id === edit.actionId);
  if (!action) throw new Error(`edit action is unknown: ${edit.actionId}`);
  if (!Array.isArray(edit.frames) || edit.frames.length !== source.frames.length) {
    throw new Error('edit frames must provide exact source coverage in exact source order');
  }

  let clipTransform;
  for (const [index, frame] of edit.frames.entries()) {
    exactObject(
      frame,
      ['frameId', 'included', 'label', 'durationMs', 'translation', 'transform', 'markers', 'contacts', 'groundTravel', 'tracks'],
      'edit frame'
    );
    if (frame.frameId !== source.frames[index].id) throw new Error('edit frames must provide exact source coverage in exact source order');
    portableId(frame.frameId, 'edit frame ID');
    if (typeof frame.included !== 'boolean') throw new Error('edit frame included must be a boolean');
    text(frame.label, 'edit frame label', { empty: true });
    integer(frame.durationMs, 'edit frame durationMs', { min: 1, max: 65535 });
    exactObject(frame.translation, ['x', 'y'], 'edit frame translation');
    integer(frame.translation.x, 'edit frame translation x', { min: -16384, max: 16384 });
    integer(frame.translation.y, 'edit frame translation y', { min: -16384, max: 16384 });
    validateTransform(frame.transform);
    const serializedTransform = JSON.stringify(frame.transform);
    if (clipTransform === undefined) clipTransform = serializedTransform;
    else if (clipTransform !== serializedTransform) throw new Error('edit frame transform must be one integer global transform for the entire clip');

    uniqueList(frame.markers, 'edit frame markers', { min: 0, key: ({ kind, id }) => `${kind}:${id}` });
    for (const marker of frame.markers) validateMarker(marker, { project, action });
    uniqueList(frame.contacts, 'edit frame contacts', { min: 0 });
    for (const contact of frame.contacts) {
      portableId(contact, 'edit frame contact ID');
      if (!action.contacts.includes(contact)) throw new Error(`edit frame references an unknown action contact: ${contact}`);
    }
    exactObject(frame.groundTravel, ['x', 'y'], 'edit frame groundTravel');
    integer(frame.groundTravel.x, 'edit frame groundTravel x', { min: -16384, max: 16384 });
    integer(frame.groundTravel.y, 'edit frame groundTravel y', { min: -16384, max: 16384 });
    if ((frame.groundTravel.x !== 0 || frame.groundTravel.y !== 0) && frame.contacts.length === 0) {
      throw new Error('ground travel requires a declared contact interval');
    }
    uniqueList(frame.tracks, 'edit frame tracks');
    for (const track of frame.tracks) {
      portableId(track, 'edit frame track ID');
      if (!action.tracks.includes(track)) throw new Error(`edit frame references an unknown action track: ${track}`);
    }
    if (!frame.tracks.includes('actor')) throw new Error('edit frame tracks must retain the actor track');
  }
  if (clipTransform !== JSON.stringify(null) && context.allowGlobalTransform !== true) {
    throw new Error('integer global transform requires explicit owner opt-in');
  }
  return deepFreeze(edit);
}

async function readVerifiedFrame(runRoot, frame) {
  portableRelativePath(frame.path, 'render source frame path');
  const root = await fs.realpath(runRoot);
  const selected = path.join(root, ...frame.path.split('/'));
  const physical = await fs.realpath(selected);
  const relative = path.relative(root, physical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('render source frame escaped the run root');
  }
  const stat = await fs.lstat(physical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('render source frame must be a regular single-link file');
  if (await sha256File(physical) !== frame.sha256) throw new Error('render source frame hash mismatch');
  return fs.readFile(physical);
}

async function transformedRgba(bytes, frame, canvas) {
  let decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const transform = frame.transform;
  if (transform) {
    const turns = ((transform.rotationQuarterTurns % 4) + 4) % 4;
    if (turns) {
      decoded = await sharp(decoded.data, { raw: decoded.info }).rotate(turns * 90).raw().toBuffer({ resolveWithObject: true });
    }
    if (transform.scale !== 1) {
      decoded = await sharp(decoded.data, { raw: decoded.info })
        .resize(decoded.info.width * transform.scale, decoded.info.height * transform.scale, { kernel: 'nearest' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    }
  }
  const output = Buffer.alloc(canvas.width * canvas.height * 4);
  const left = Math.trunc((canvas.width - decoded.info.width) / 2) + frame.translation.x;
  const top = Math.trunc((canvas.height - decoded.info.height) / 2) + frame.translation.y;
  for (let y = 0; y < decoded.info.height; y += 1) {
    const targetY = top + y;
    if (targetY < 0 || targetY >= canvas.height) continue;
    for (let x = 0; x < decoded.info.width; x += 1) {
      const targetX = left + x;
      if (targetX < 0 || targetX >= canvas.width) continue;
      const sourceOffset = (y * decoded.info.width + x) * 4;
      const targetOffset = (targetY * canvas.width + targetX) * 4;
      decoded.data.copy(output, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return output;
}

export async function renderEditRevision({ run, project, source, edit, allowGlobalTransform = false }) {
  if (!run?.root) throw new Error('edit rendering requires an immutable run');
  const validated = validateEditManifest(edit, { project, source, allowGlobalTransform });
  const editSha256 = sha256Value(validated);
  const root = `work/revisions/${editSha256}`;
  const renderedFrames = [];
  for (const frameEdit of validated.frames) {
    if (!frameEdit.included) continue;
    const sourceFrame = source.frames.find(({ id }) => id === frameEdit.frameId);
    const bytes = await readVerifiedFrame(run.root, sourceFrame);
    const rgba = await transformedRgba(bytes, frameEdit, source.canvas);
    const png = await sharp(rgba, { raw: { ...source.canvas, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    const relative = `${root}/frames/${frameEdit.frameId}.png`;
    const artifact = await writeImmutableBytes({ root: run.root, relative, bytes: png, reuse: true });
    renderedFrames.push({
      frameId: frameEdit.frameId,
      path: artifact.relative,
      sha256: artifact.sha256,
      durationMs: frameEdit.durationMs,
      markers: frameEdit.markers,
      contacts: frameEdit.contacts,
      groundTravel: frameEdit.groundTravel,
      tracks: frameEdit.tracks
    });
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'rendered-edit',
    editSha256,
    sourceSha256: validated.sourceSha256,
    canvas: structuredClone(source.canvas),
    frames: renderedFrames
  };
  const written = await writeImmutableJson({ root: run.root, relative: `${root}/manifest.json`, value: manifest, reuse: true });
  return deepFreeze({ ...manifest, path: written.relative, sha256: written.sha256 });
}
