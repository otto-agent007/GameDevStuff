import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { copyImmutable, writeImmutableBytes } from './artifacts.mjs';
import { exactObject, integer, portableId, portableRelativePath, sha256Value, uniqueList } from './schema.mjs';

async function containedInput(manifestRoot, relative) {
  portableRelativePath(relative, 'PNG sequence frame path');
  const physicalRoot = await fs.realpath(manifestRoot);
  const selected = path.join(physicalRoot, ...relative.split('/'));
  const physical = await fs.realpath(selected);
  const containment = path.relative(physicalRoot, physical);
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
    throw new Error('PNG sequence frame escaped the manifest directory');
  }
  return selected;
}

function rgbaHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function decodePngArtifact({ run, sourceRelative, frameId, durationMs }) {
  portableId(frameId, 'PNG frame ID');
  integer(durationMs, 'PNG frame durationMs', { min: 1, max: 65535 });
  portableRelativePath(sourceRelative, 'PNG source path');
  const source = path.join(run.root, ...sourceRelative.split('/'));
  const bytes = await fs.readFile(source);
  const metadata = await sharp(bytes, { limitInputPixels: 268435456 }).metadata();
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) throw new Error('PNG sequence source must be one PNG image');
  const { data, info } = await sharp(bytes, { limitInputPixels: 268435456 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error('decoded PNG frame must be RGBA');
  const encoded = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  const output = await writeImmutableBytes({
    root: run.root,
    relative: `work/decoded/${frameId}.png`,
    bytes: encoded,
    reuse: true
  });
  let alpha = false;
  let empty = true;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 255) alpha = true;
    if (data[index] !== 0) empty = false;
  }
  return {
    output,
    width: info.width,
    height: info.height,
    alpha,
    empty,
    rgbaSha256: rgbaHash(data)
  };
}

export async function decodePngSequence({ manifest, run, files }) {
  if (!manifest || files !== undefined) throw new Error('PNG sequence intake requires an explicit sequence manifest');
  const manifestFile = path.resolve(manifest);
  const capturedManifest = await copyImmutable({
    source: manifestFile,
    root: run.root,
    relative: 'source/png-sequence/manifest.json'
  });
  const document = JSON.parse(await fs.readFile(capturedManifest.path, 'utf8'));
  exactObject(document, ['schemaVersion', 'frames'], 'PNG sequence manifest');
  if (document.schemaVersion !== 1) throw new Error('PNG sequence manifest schemaVersion must be 1');
  uniqueList(document.frames, 'PNG sequence frames', { key: ({ id }) => id });

  const definitions = document.frames.map((frame) => {
    exactObject(frame, ['id', 'path', 'durationMs'], 'PNG sequence frame');
    portableId(frame.id, 'PNG sequence frame ID');
    portableRelativePath(frame.path, 'PNG sequence frame path');
    if (!Object.hasOwn(frame, 'durationMs')) throw new Error('PNG sequence frame durationMs is required');
    integer(frame.durationMs, 'PNG sequence frame durationMs', { min: 1, max: 65535 });
    return frame;
  });
  uniqueList(definitions, 'PNG sequence frame paths', { key: ({ path: framePath }) => framePath });

  const sources = [];
  const decoded = [];
  for (const definition of definitions) {
    const input = await containedInput(path.dirname(manifestFile), definition.path);
    const copied = await copyImmutable({
      source: input,
      root: run.root,
      relative: `source/png-sequence/frames/${definition.id}.png`
    });
    sources.push({ id: definition.id, sha256: copied.sha256 });
    decoded.push(await decodePngArtifact({
      run,
      sourceRelative: copied.relative,
      frameId: definition.id,
      durationMs: definition.durationMs
    }));
  }

  const [first] = decoded;
  if (decoded.some((frame) => frame.width !== first.width || frame.height !== first.height)) {
    throw new Error('PNG sequence frames must have identical canvas dimensions');
  }
  const diagnostics = [];
  if (decoded.some(({ alpha }) => alpha)) diagnostics.push({ code: 'ALPHA_PRESENT', frameId: null });
  const firstByRgba = new Map();
  let timestampMs = 0;
  const frames = decoded.map((frame, index) => {
    const definition = definitions[index];
    const duplicateOf = firstByRgba.get(frame.rgbaSha256) ?? null;
    if (duplicateOf === null) firstByRgba.set(frame.rgbaSha256, definition.id);
    else diagnostics.push({ code: 'DUPLICATE_FRAME', frameId: definition.id });
    if (frame.empty) diagnostics.push({ code: 'EMPTY_FRAME', frameId: definition.id });
    const record = {
      index,
      id: definition.id,
      path: frame.output.relative,
      sha256: frame.output.sha256,
      width: frame.width,
      height: frame.height,
      timestampMs,
      durationMs: definition.durationMs,
      sourceRect: { x: 0, y: 0, width: frame.width, height: frame.height },
      duplicateOf
    };
    timestampMs += definition.durationMs;
    return record;
  });

  return {
    kind: 'png-sequence',
    sourceSha256: sha256Value({ manifestSha256: capturedManifest.sha256, frames: sources }),
    decoder: {
      name: 'sharp-png-sequence',
      version: sharp.versions.sharp,
      arguments: ['ensureAlpha', 'png:compressionLevel=9', 'png:adaptiveFiltering=false']
    },
    canvas: { width: first.width, height: first.height },
    alpha: decoded.some(({ alpha }) => alpha),
    timeBase: { numerator: 1, denominator: 1000 },
    frames,
    diagnostics,
    approval: null
  };
}
