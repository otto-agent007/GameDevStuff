import fs from 'node:fs/promises';
import path from 'node:path';

import { writeImmutableJson } from './artifacts.mjs';
import {
  deepFreeze,
  exactObject,
  integer,
  portableId,
  portableRelativePath,
  sha256File,
  uniqueList
} from './schema.mjs';

const HASH = /^[a-f0-9]{64}$/;
const DIAGNOSTICS = new Set([
  'ZERO_DELAY',
  'DUPLICATE_FRAME',
  'EMPTY_FRAME',
  'PARTIAL_SOURCE_RECT',
  'DISPOSAL_RESTORE_BACKGROUND',
  'DISPOSAL_RESTORE_PREVIOUS',
  'ALPHA_PRESENT',
  'VARIABLE_FRAME_RATE'
]);
const adapters = new Map();

function string(value, label) {
  if (typeof value !== 'string' || value === '') throw new Error(`${label} must be a nonempty string`);
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} must be a sha256`);
  return value;
}

async function verifyFrameArtifact(runRoot, frame) {
  portableRelativePath(frame.path, 'motion source frame path');
  const root = await fs.realpath(runRoot);
  const selected = path.join(root, ...frame.path.split('/'));
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('motion source frame must be a regular single-link file');
  }
  const physical = await fs.realpath(selected);
  const relative = path.relative(root, physical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('motion source frame escaped the run root');
  }
  if (await sha256File(selected) !== frame.sha256) throw new Error('motion source frame hash mismatch');
}

export function registerSourceAdapter(kind, decode) {
  portableId(kind, 'motion source kind');
  if (typeof decode !== 'function') throw new Error('motion source adapter must be a function');
  if (adapters.has(kind)) throw new Error(`motion source adapter is already registered: ${kind}`);
  adapters.set(kind, decode);
}

export async function validateMotionSourceResult(value, { run, expectedKind } = {}) {
  const result = structuredClone(value);
  exactObject(
    result,
    ['kind', 'sourceSha256', 'decoder', 'canvas', 'alpha', 'timeBase', 'frames', 'diagnostics', 'approval'],
    'motion source result'
  );
  portableId(result.kind, 'motion source result kind');
  if (expectedKind && result.kind !== expectedKind) throw new Error('motion source adapter returned the wrong kind');
  hash(result.sourceSha256, 'motion source hash');
  exactObject(result.decoder, ['name', 'version', 'arguments'], 'motion source decoder');
  string(result.decoder.name, 'motion source decoder name');
  string(result.decoder.version, 'motion source decoder version');
  if (!Array.isArray(result.decoder.arguments) || result.decoder.arguments.some((argument) => typeof argument !== 'string')) {
    throw new Error('motion source decoder arguments must be strings');
  }
  exactObject(result.canvas, ['width', 'height'], 'motion source canvas');
  integer(result.canvas.width, 'motion source canvas width', { min: 1, max: 16384 });
  integer(result.canvas.height, 'motion source canvas height', { min: 1, max: 16384 });
  if (typeof result.alpha !== 'boolean') throw new Error('motion source alpha must be a boolean');
  exactObject(result.timeBase, ['numerator', 'denominator'], 'motion source timeBase');
  integer(result.timeBase.numerator, 'motion source timeBase numerator', { min: 1 });
  integer(result.timeBase.denominator, 'motion source timeBase denominator', { min: 1 });
  if (result.approval !== null) throw new Error('new motion source approval must be null');

  uniqueList(result.frames, 'motion source frames', { key: ({ id }) => id });
  const seenIds = new Set();
  let nextTimestamp = 0;
  for (const [index, frame] of result.frames.entries()) {
    exactObject(
      frame,
      ['index', 'id', 'path', 'sha256', 'width', 'height', 'timestampMs', 'durationMs', 'sourceRect', 'duplicateOf'],
      'motion source frame'
    );
    if (frame.index !== index) throw new Error('motion source frame indices must be complete and ordered');
    portableId(frame.id, 'motion source frame ID');
    portableRelativePath(frame.path, 'motion source frame path');
    hash(frame.sha256, 'motion source frame hash');
    if (frame.width !== result.canvas.width || frame.height !== result.canvas.height) {
      throw new Error('motion source frames must match the declared canvas');
    }
    integer(frame.timestampMs, 'motion source frame timestampMs', { min: 0 });
    integer(frame.durationMs, 'motion source frame durationMs', { min: 1, max: 65535 });
    if (frame.timestampMs !== nextTimestamp) throw new Error('motion source frame timestamps must preserve ordered durations');
    nextTimestamp += frame.durationMs;
    exactObject(frame.sourceRect, ['x', 'y', 'width', 'height'], 'motion source frame sourceRect');
    integer(frame.sourceRect.x, 'motion source frame sourceRect x', { min: 0 });
    integer(frame.sourceRect.y, 'motion source frame sourceRect y', { min: 0 });
    integer(frame.sourceRect.width, 'motion source frame sourceRect width', { min: 1 });
    integer(frame.sourceRect.height, 'motion source frame sourceRect height', { min: 1 });
    if (
      frame.sourceRect.x + frame.sourceRect.width > result.canvas.width ||
      frame.sourceRect.y + frame.sourceRect.height > result.canvas.height
    ) throw new Error('motion source frame sourceRect exceeds the canvas');
    if (frame.duplicateOf !== null && (!seenIds.has(frame.duplicateOf) || frame.duplicateOf === frame.id)) {
      throw new Error('motion source duplicateOf must reference an earlier frame');
    }
    seenIds.add(frame.id);
    if (!run?.root) throw new Error('motion source validation requires a run root');
    await verifyFrameArtifact(run.root, frame);
  }

  if (!Array.isArray(result.diagnostics)) throw new Error('motion source diagnostics must be an array');
  for (const diagnostic of result.diagnostics) {
    exactObject(diagnostic, ['code', 'frameId'], 'motion source diagnostic');
    if (!DIAGNOSTICS.has(diagnostic.code)) throw new Error(`motion source diagnostic code is invalid: ${diagnostic.code}`);
    if (diagnostic.frameId !== null && !seenIds.has(diagnostic.frameId)) {
      throw new Error('motion source diagnostic references an unknown frame');
    }
  }
  return deepFreeze(result);
}

export async function decodeMotionSource({ kind, source, run, options = {} }) {
  const decode = adapters.get(kind);
  if (!decode) throw new Error(`unregistered motion source kind: ${kind}`);
  if (run?.document?.sourceRequest?.kind !== kind) throw new Error('motion source kind does not match the immutable run request');
  const candidate = await decode({ kind, source, run, options });
  const result = await validateMotionSourceResult(candidate, { run, expectedKind: kind });
  await writeImmutableJson({ root: run.root, relative: 'reports/source.json', value: result, reuse: true });
  return result;
}
