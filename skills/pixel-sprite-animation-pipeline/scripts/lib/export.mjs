import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { validateAnimationContract } from './animation-contract.mjs';
import { paletteOf, readRgba } from './image.mjs';
import { stableHash } from './state-auth.mjs';

const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SHA256 = /^[a-f0-9]{64}$/;

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function validateSize(size, label) {
  if (!size || typeof size !== 'object') throw new Error(`${label} size is required`);
  requirePositiveInteger(size.width, `${label} width`);
  requirePositiveInteger(size.height, `${label} height`);
}

async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function portableBasename(file) {
  const normalized = file.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function safeStem(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..' && !WINDOWS_RESERVED_STEM.test(value);
}

function safePortableClipStem(value) {
  return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(value) && !WINDOWS_RESERVED_STEM.test(value);
}

function portabilityKey(value) {
  return value.normalize('NFKC').toLowerCase();
}

function portableRelative(value, label) {
  if (typeof value !== 'string' || value === '' || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\\') || value === '.' || value === '..' || value.startsWith('../') || path.posix.normalize(value) !== value) {
    throw new Error(`${label} must be a contained portable relative path`);
  }
  return value;
}

function immutableSnapshot(value, label) {
  try { return structuredClone(value); }
  catch { throw new Error(`${label} must be an immutable structured-clone value`); }
}

function bufferSha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function configurationSnapshot(value, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value))) {
      return `<absolute>/${portableBasename(value)}`;
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('config must be JSON-safe and acyclic');
    const nextAncestors = new Set(ancestors).add(value);
    return value.map((item) => configurationSnapshot(item, nextAncestors));
  }
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('config must be JSON-safe and acyclic');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('config must contain only JSON-safe plain objects');
    }
    const nextAncestors = new Set(ancestors).add(value);
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      configurationSnapshot(value[key], nextAncestors)
    ]));
  }
  throw new Error('config must contain only JSON-safe values');
}

function compareRgba(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function mergedPalette(framePalettes) {
  const counts = new Map();
  for (const palette of framePalettes) {
    for (const color of palette) {
      const key = color.rgba.join(',');
      counts.set(key, (counts.get(key) ?? 0) + color.count);
    }
  }
  return [...counts].map(([rgba, count]) => ({
    rgba: rgba.split(',').map(Number),
    count
  })).sort((left, right) => right.count - left.count || compareRgba(left.rgba, right.rgba));
}

async function captureFrames(frames, canonical) {
  const captured = [];
  for (const frame of frames) {
    if (typeof frame !== 'string' || frame.trim() === '') throw new Error('each frame must be a nonempty path');
    const bytes = await fs.readFile(frame);
    const image = await readRgba(bytes);
    if (image.width !== canonical.width || image.height !== canonical.height) {
      throw new Error(`frame ${frame} must be ${canonical.width}x${canonical.height}`);
    }
    captured.push({ path: frame, bytes, image, sha256: bufferSha256(bytes) });
  }
  return captured;
}

async function validateExport({ frames, outputDir, config, columns, durations, name, capturedFrames }) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('at least one frame is required');
  }
  if (typeof outputDir !== 'string' || outputDir.trim() === '') {
    throw new Error('outputDir must be a nonempty path');
  }
  requirePositiveInteger(columns, 'columns');
  if (
    !Array.isArray(durations) ||
    durations.length !== frames.length ||
    durations.some((duration) => !Number.isInteger(duration) || duration < 11 || duration > 65535)
  ) {
    throw new Error('durations must contain one integer duration per frame in the range 11..65535');
  }
  if (!safeStem(name)) {
    throw new Error('name must be a safe nonempty filename stem');
  }
  validateSize(config?.canonical, 'canonical');
  validateSize(config?.runtime, 'runtime');
  for (const dimension of ['width', 'height']) {
    if (config.runtime[dimension] % config.canonical[dimension] !== 0) {
      throw new Error(`runtime ${dimension} must be an integer multiple of canonical ${dimension}`);
    }
  }
  const scaleX = config.runtime.width / config.canonical.width;
  const scaleY = config.runtime.height / config.canonical.height;
  if (scaleX !== scaleY) {
    throw new Error('runtime scale must be identical on both axes');
  }
  if (
    !config.pivot ||
    !Number.isFinite(config.pivot.x) ||
    !Number.isFinite(config.pivot.y)
  ) {
    throw new Error('canonical pivot must contain finite x and y values');
  }

  const configSnapshot = configurationSnapshot(config);
  const resolvedOutput = path.resolve(outputDir);
  const digits = Math.max(2, String(frames.length - 1).length);
  const outputNames = frames.map((_, index) => `${name}-${String(index).padStart(digits, '0')}.png`);
  outputNames.push(`${name}-sheet.png`, `${name}.json`, `${name}.webp`);
  const inputs = new Set(frames.map((frame) => path.resolve(frame)));
  for (const outputName of outputNames) {
    if (inputs.has(path.join(resolvedOutput, outputName))) {
      throw new Error('export must not overwrite an input frame');
    }
  }
  if (await exists(resolvedOutput)) {
    throw new Error(`output directory already exists: ${resolvedOutput}`);
  }

  const selectedFrames = capturedFrames ?? await captureFrames(frames, config.canonical);
  if (selectedFrames.length !== frames.length || selectedFrames.some((frame, index) => frame.path !== frames[index])) throw new Error('captured export frame order is invalid');
  const sources = [];
  const framePalettes = [];
  for (let index = 0; index < selectedFrames.length; index += 1) {
    const frame = selectedFrames[index];
    sources.push({
      index,
      id: `source-${String(index).padStart(digits, '0')}`,
      sha256: frame.sha256
    });
    framePalettes.push(paletteOf(frame.image));
  }

  return {
    resolvedOutput,
    digits,
    runtimeScale: scaleX,
    sources,
    capturedFrames: selectedFrames,
    palette: {
      mode: configSnapshot.palette?.mode ?? null,
      colors: mergedPalette(framePalettes)
    },
    configSnapshot
  };
}

async function writePreview({ runtimeFrames, output, width, height, durations }) {
  const pageBytes = width * height * 4;
  const stacked = Buffer.alloc(pageBytes * runtimeFrames.length);
  for (let index = 0; index < runtimeFrames.length; index += 1) {
    const { data, info } = await sharp(runtimeFrames[index])
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height || info.channels !== 4) {
      throw new Error(`rendered frame ${runtimeFrames[index]} has inconsistent dimensions`);
    }
    data.copy(stacked, index * pageBytes);
  }
  await sharp(stacked, {
    raw: {
      width,
      height: height * runtimeFrames.length,
      channels: 4,
      pageHeight: height
    }
  }).webp({ lossless: true, loop: 0, delay: durations }).toFile(output);
}

async function renderAnimation({ frames, outputDir, config, columns, durations, name, capturedFrames }) {
  const {
    resolvedOutput,
    digits,
    runtimeScale,
    sources,
    capturedFrames: selectedFrames,
    palette,
    configSnapshot
  } = await validateExport({
    frames, outputDir, config, columns, durations, name, capturedFrames
  });
  const parent = path.dirname(resolvedOutput);
  await fs.mkdir(parent, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(parent, '.sprite-export-stage-'));

  try {
    const runtimeFrames = [];
    for (let index = 0; index < frames.length; index += 1) {
      const output = path.join(stagingDir, `${name}-${String(index).padStart(digits, '0')}.png`);
      await sharp(selectedFrames[index].bytes)
        .resize(config.runtime.width, config.runtime.height, { kernel: sharp.kernel.nearest })
        .png()
        .toFile(output);
      runtimeFrames.push(output);
    }

    const rows = Math.ceil(frames.length / columns);
    const sheetName = `${name}-sheet.png`;
    const sheet = path.join(stagingDir, sheetName);
    await sharp({
      create: {
        width: columns * config.runtime.width,
        height: rows * config.runtime.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).composite(runtimeFrames.map((input, index) => ({
      input,
      left: (index % columns) * config.runtime.width,
      top: Math.floor(index / columns) * config.runtime.height
    }))).png().toFile(sheet);

    const previewName = `${name}.webp`;
    const preview = path.join(stagingDir, previewName);
    await writePreview({
      runtimeFrames,
      output: preview,
      width: config.runtime.width,
      height: config.runtime.height,
      durations
    });

    const metadataName = `${name}.json`;
    const metadata = path.join(stagingDir, metadataName);
    const document = {
      name,
      frameSize: { width: config.runtime.width, height: config.runtime.height },
      canonicalPivot: { x: config.pivot.x, y: config.pivot.y },
      pivot: { x: config.pivot.x * runtimeScale, y: config.pivot.y * runtimeScale },
      columns,
      rows,
      durations: [...durations],
      sheet: sheetName,
      preview: previewName,
      sources,
      palette,
      config: configSnapshot,
      frames: runtimeFrames.map((file, index) => ({
        index,
        file: path.basename(file),
        x: (index % columns) * config.runtime.width,
        y: Math.floor(index / columns) * config.runtime.height,
        width: config.runtime.width,
        height: config.runtime.height,
        duration: durations[index]
      }))
    };
    await fs.writeFile(metadata, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });

    await fs.rename(stagingDir, resolvedOutput);
    return {
      runtimeFrames: runtimeFrames.map((file) => path.join(resolvedOutput, path.basename(file))),
      sheet: path.join(resolvedOutput, sheetName),
      metadata: path.join(resolvedOutput, metadataName),
      preview: path.join(resolvedOutput, previewName)
    };
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function exportAnimation(args) {
  const selected = {
    frames: Array.isArray(args?.frames) ? [...args.frames] : args?.frames,
    outputDir: args?.outputDir,
    config: immutableSnapshot(args?.config, 'config'),
    columns: args?.columns,
    durations: Array.isArray(args?.durations) ? [...args.durations] : args?.durations,
    name: args?.name
  };
  return renderAnimation(selected);
}

function snapshotContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract) || Object.keys(contract).length !== 2 || !Object.hasOwn(contract, 'document') || !Object.hasOwn(contract, 'sha256')) throw new Error('contract export animation contract schema is invalid');
  const document = immutableSnapshot(contract.document, 'animation contract');
  validateAnimationContract(document);
  if (contract.sha256 !== stableHash(document)) throw new Error('contract export animation contract hash is invalid');
  return { document, sha256: contract.sha256 };
}

function snapshotMeasurements(normalized, definitions) {
  if (!normalized || typeof normalized !== 'object' || !Array.isArray(normalized.frames) || !Array.isArray(normalized.measurements) || normalized.frames.length !== definitions.length || normalized.measurements.length !== definitions.length) {
    throw new Error('contract export requires exact ordered normalized frame coverage');
  }
  const frames = [...normalized.frames];
  const measurements = immutableSnapshot(normalized.measurements, 'normalization measurements');
  const coordinate = (value, { nonnegative = false } = {}) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 && Number.isInteger(value.x) && Number.isInteger(value.y) && (!nonnegative || (value.x >= 0 && value.y >= 0));
  for (let index = 0; index < definitions.length; index += 1) {
    if (measurements[index]?.frameId !== definitions[index].id) throw new Error(`contract export normalized frame order does not match contract at index ${index}`);
    if (!coordinate(measurements[index].sourceLandmark, { nonnegative: true }) || !coordinate(measurements[index].canonicalLandmark, { nonnegative: true }) || !coordinate(measurements[index].landmarkDrift)) throw new Error(`contract export landmark measurements are incomplete for frame ${definitions[index].id}`);
    if (measurements[index].canonicalLandmark.x !== definitions[index].landmarkSemantic.target.x || measurements[index].canonicalLandmark.y !== definitions[index].landmarkSemantic.target.y || measurements[index].landmarkDrift.x !== 0 || measurements[index].landmarkDrift.y !== 0) throw new Error(`contract export landmark measurements drift from the contract for frame ${definitions[index].id}`);
  }
  return { frames, measurements };
}

function rebaseArtifact(file, from, to) {
  const relative = path.relative(from, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('contract export artifact escaped its staging directory');
  return path.join(to, relative);
}

function snapshotMeasurement(measurement, normalizedSha256) {
  const frameId = measurement?.frameId;
  const coordinate = (value) => value && Number.isInteger(value.x) && Number.isInteger(value.y) ? { x: value.x, y: value.y } : null;
  return {
    frameId,
    normalizedSha256,
    sourceLandmark: coordinate(measurement?.sourceLandmark),
    canonicalLandmark: coordinate(measurement?.canonicalLandmark),
    landmarkDrift: coordinate(measurement?.landmarkDrift),
    bounds: {
      left: measurement?.left ?? null,
      top: measurement?.top ?? null,
      width: measurement?.width ?? null,
      height: measurement?.height ?? null,
      bottom: measurement?.bottom ?? null
    }
  };
}

function v2GeometryConfig(contract, config) {
  const expected = {
    canonical: { width: contract.document.canvas.width, height: contract.document.canvas.height },
    runtime: { ...contract.document.scale.runtime },
    pivot: { ...contract.document.canvas.pivot }
  };
  if (!config || !jsonLikeEqual(config.canonical, expected.canonical) || !jsonLikeEqual(config.runtime, expected.runtime) || !jsonLikeEqual(config.pivot, expected.pivot)) throw new Error('v2 contract export config geometry does not match the animation contract');
  return expected;
}

function jsonLikeEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

async function capturedV2Normalized(contract, normalized, config, frameApprovalSha256) {
  if (!normalized || normalized.version !== 2 || normalized.animationContractSha256 !== contract.sha256 || normalized.selectionApprovalSha256 !== contract.document.selectionApprovalSha256 || normalized.frameApprovalSha256 !== frameApprovalSha256 || !SHA256.test(normalized.snapReceiptSha256 ?? '') || !Array.isArray(normalized.frames)) throw new Error('v2 contract export normalized provenance binding is invalid');
  const definitions = contract.document.clips.flatMap((clip) => clip.frames.map((frame) => ({ ...frame, loopMode: clip.loopMode })));
  if (normalized.frames.length !== definitions.length) throw new Error('v2 contract export requires exact ordered normalized frame coverage');
  const trackById = new Map(contract.document.tracks.map((track) => [track.id, track]));
  const palette = new Set(contract.document.palette.rgba.map((color) => color.join(',')));
  const frames = [];
  for (const [index, definition] of definitions.entries()) {
    const frame = immutableSnapshot(normalized.frames[index], `v2 normalized frame ${index}`);
    if (frame.id !== definition.id || frame.semantic !== definition.semantic || frame.duration !== definition.duration || frame.loopMode !== definition.loopMode || frame.scale !== contract.document.scale.integer || !jsonLikeEqual(frame.root, contract.document.canvas.pivot) || frame.baseline !== contract.document.canvas.baseline || !jsonLikeEqual(frame.groundTravel, definition.groundTravel) || !jsonLikeEqual(Object.keys(frame.tracks ?? {}), definition.tracks)) throw new Error(`v2 contract export normalized frame order or metadata drift at ${index}`);
    if (!jsonLikeEqual(Object.keys(frame.sockets ?? {}), definition.sockets) || !jsonLikeEqual(Object.keys(frame.contacts ?? {}), definition.contacts)) throw new Error(`v2 contract export normalized landmark coverage drift for ${definition.id}`);
    const tracks = {};
    for (const trackId of definition.tracks) {
      const record = frame.tracks[trackId];
      const track = trackById.get(trackId);
      if (!record || record.kind !== track.kind || record.attachTo !== track.attachTo || typeof record.path !== 'string' || !SHA256.test(record.sourceSha256 ?? '') || !SHA256.test(record.normalizedSha256 ?? '')) throw new Error(`v2 contract export normalized track binding is invalid for ${definition.id}/${trackId}`);
      const captured = (await captureFrames([record.path], config.canonical))[0];
      if (captured.sha256 !== record.normalizedSha256) throw new Error(`v2 contract export normalized track hash changed for ${definition.id}/${trackId}`);
      const drift = paletteOf(captured.image).filter(({ rgba }) => !palette.has(rgba.join(',')));
      if (drift.length > 0) throw new Error(`v2 contract export normalized track palette drift for ${definition.id}/${trackId}`);
      tracks[trackId] = { record, track, captured };
    }
    if (!frame.combined || typeof frame.combined.path !== 'string' || !SHA256.test(frame.combined.sha256 ?? '')) throw new Error(`v2 contract export combined frame binding is invalid for ${definition.id}`);
    const combined = (await captureFrames([frame.combined.path], config.canonical))[0];
    if (combined.sha256 !== frame.combined.sha256) throw new Error(`v2 contract export combined frame hash changed for ${definition.id}`);
    frames.push({ definition, frame, tracks, combined });
  }
  return frames;
}

async function artifactRecord(file, root) {
  return { file: portableRelative(path.relative(root, file).replaceAll('\\', '/'), 'v2 export artifact path'), sha256: bufferSha256(await fs.readFile(file)) };
}

async function exportContractAnimationV2({ contract, normalized, outputDir, config, columns, frameApprovalSha256 }) {
  if (typeof outputDir !== 'string' || outputDir.trim() === '') throw new Error('outputDir must be a nonempty path');
  if (!SHA256.test(frameApprovalSha256 ?? '')) throw new Error('contract export selected frame approval sha256 is required');
  requirePositiveInteger(columns, 'columns');
  v2GeometryConfig(contract, config);
  const captured = await capturedV2Normalized(contract, normalized, config, frameApprovalSha256);
  const resolvedOutput = path.resolve(outputDir);
  if (await exists(resolvedOutput)) throw new Error(`output directory already exists: ${resolvedOutput}`);
  const parent = path.dirname(resolvedOutput);
  await fs.mkdir(parent, { recursive: true });
  const stage = await fs.mkdtemp(path.join(parent, '.sprite-contract-v2-stage-'));
  try {
    const stagedTracks = Object.fromEntries(contract.document.tracks.map((track) => [track.id, { kind: track.kind, attachTo: track.attachTo, frames: [] }]));
    for (const item of captured) {
      for (const trackId of item.definition.tracks) {
        const selected = item.tracks[trackId];
        const directory = path.join(stage, 'tracks', trackId);
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, `${item.definition.id}.png`);
        await sharp(selected.captured.bytes).resize(config.runtime.width, config.runtime.height, { kernel: sharp.kernel.nearest }).png().toFile(file);
        stagedTracks[trackId].frames.push({ id: item.definition.id, file });
      }
    }

    const stagedClips = {};
    const clipIndex = [];
    let offset = 0;
    for (const clip of contract.document.clips) {
      const selected = captured.slice(offset, offset + clip.frames.length);
      offset += clip.frames.length;
      const clipDir = path.join(stage, 'clips', clip.id);
      const rendered = await renderAnimation({
        frames: selected.map((item) => item.combined.path),
        durations: clip.frames.map((frame) => frame.duration),
        outputDir: clipDir,
        config,
        columns,
        name: clip.id,
        capturedFrames: selected.map((item) => item.combined)
      });
      const contactSheet = path.join(clipDir, `${clip.id}-contact-sheet.png`);
      await fs.copyFile(rendered.sheet, contactSheet, fs.constants.COPYFILE_EXCL);
      const frameRecords = [];
      for (const [frameIndex, item] of selected.entries()) {
        const runtimeCombined = rendered.runtimeFrames[frameIndex];
        const outputs = [];
        for (const trackId of item.definition.tracks) {
          const trackFrame = stagedTracks[trackId].frames.find((frame) => frame.id === item.definition.id);
          outputs.push({
            trackId,
            kind: item.tracks[trackId].track.kind,
            attachTo: item.tracks[trackId].track.attachTo,
            sourceSha256: item.tracks[trackId].record.sourceSha256,
            normalizedSha256: item.tracks[trackId].record.normalizedSha256,
            ...await artifactRecord(trackFrame.file, stage)
          });
        }
        frameRecords.push({
          id: item.definition.id,
          semantic: item.definition.semantic,
          duration: item.definition.duration,
          tracks: [...item.definition.tracks],
          root: { ...item.frame.root },
          baseline: item.frame.baseline,
          sockets: structuredClone(item.frame.sockets),
          contacts: structuredClone(item.frame.contacts),
          groundTravel: { ...item.frame.groundTravel },
          outputs,
          combined: await artifactRecord(runtimeCombined, stage)
        });
      }
      const restart = clip.loopMode === 'loop' ? 'loop' : 'stop';
      clipIndex.push({
        id: clip.id,
        loopMode: clip.loopMode,
        restart,
        frames: frameRecords,
        sheet: await artifactRecord(rendered.sheet, stage),
        contactSheet: await artifactRecord(contactSheet, stage),
        metadata: await artifactRecord(rendered.metadata, stage),
        preview: await artifactRecord(rendered.preview, stage)
      });
      stagedClips[clip.id] = { ...rendered, contactSheet, frames: frameRecords, loopMode: clip.loopMode, restart };
    }
    const indexName = 'animation-contract-export.json';
    const indexFile = path.join(stage, indexName);
    const index = {
      version: 2,
      animationContractSha256: contract.sha256,
      animationContract: contract.document,
      selectionApprovalSha256: contract.document.selectionApprovalSha256,
      frameApprovalSha256,
      snapReceiptSha256: normalized.snapReceiptSha256,
      character: contract.document.character,
      canvas: contract.document.canvas,
      scale: contract.document.scale,
      palette: contract.document.palette,
      tracks: contract.document.tracks,
      sockets: contract.document.sockets,
      contacts: contract.document.contacts,
      clips: clipIndex
    };
    await fs.writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(stage, resolvedOutput);
    const rebase = (file) => rebaseArtifact(file, stage, resolvedOutput);
    const clips = Object.fromEntries(Object.entries(stagedClips).map(([id, clip]) => [id, {
      ...clip,
      runtimeFrames: clip.runtimeFrames.map(rebase),
      sheet: rebase(clip.sheet),
      metadata: rebase(clip.metadata),
      preview: rebase(clip.preview),
      contactSheet: rebase(clip.contactSheet)
    }]));
    const tracks = Object.fromEntries(Object.entries(stagedTracks).map(([id, track]) => [id, { ...track, frames: track.frames.map((frame) => ({ id: frame.id, file: rebase(frame.file) })) }]));
    return { version: 2, clips, tracks, metadata: path.join(resolvedOutput, indexName) };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function exportContractAnimation(args) {
  const contract = snapshotContract(args?.contract);
  const config = immutableSnapshot(args?.config, 'config');
  const outputDir = args?.outputDir;
  const columns = args?.columns ?? 8;
  const frameApprovalSha256 = args?.frameApprovalSha256;
  if (contract.document.version === 2) return exportContractAnimationV2({ contract, normalized: args?.normalized, outputDir, config, columns, frameApprovalSha256 });
  if (typeof outputDir !== 'string' || outputDir.trim() === '') throw new Error('outputDir must be a nonempty path');
  if (!SHA256.test(frameApprovalSha256 ?? '')) throw new Error('contract export selected frame approval sha256 is required');
  requirePositiveInteger(columns, 'columns');
  const definitions = contract.document.clips.flatMap((clip) => clip.frames);
  const normalized = snapshotMeasurements(args?.normalized, definitions);
  const portableClipKeys = new Set();
  for (const clip of contract.document.clips) {
    if (!safePortableClipStem(clip.id)) throw new Error(`contract export requires a portable safe clip ID: ${clip.id}`);
    const key = portabilityKey(clip.id);
    if (portableClipKeys.has(key)) throw new Error(`contract export clip IDs must be portable and unique: ${clip.id}`);
    portableClipKeys.add(key);
  }
  const resolvedOutput = path.resolve(outputDir);
  if (await exists(resolvedOutput)) throw new Error(`output directory already exists: ${resolvedOutput}`);

  // Capture each normalized frame exactly once. Every hash, palette check, and
  // runtime resize below consumes this immutable byte snapshot.
  const captured = await captureFrames(normalized.frames, config.canonical);
  const contractColors = new Set(contract.document.palette.rgba.map((rgba) => rgba.join(',')));
  for (const frame of captured) {
    const unexpected = paletteOf(frame.image).filter(({ rgba }) => !contractColors.has(rgba.join(',')));
    if (unexpected.length > 0) throw new Error('contract export normalized frame palette is outside the frozen animation contract palette');
  }

  const byId = new Map(definitions.map((definition, index) => [definition.id, { definition, index, captured: captured[index] }]));
  const parent = path.dirname(resolvedOutput);
  await fs.mkdir(parent, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(parent, '.sprite-contract-stage-'));
  try {
    const stagedClips = {};
    const clipIndex = [];
    for (const clip of contract.document.clips) {
      const selected = clip.frames.map((frame) => byId.get(frame.id));
      if (selected.some((item) => !item)) throw new Error(`contract export is missing a required frame for clip ${clip.id}`);
      const frames = selected.map((item) => item.captured.path);
      const durations = clip.frames.map((frame) => frame.duration);
      const clipDir = path.join(stagingDir, clip.id);
      const rendered = await renderAnimation({ frames, durations, outputDir: clipDir, config, columns, name: clip.id, capturedFrames: selected.map((item) => item.captured) });
      const runtime = rendered.runtimeFrames.map((file, index) => ({ id: clip.frames[index].id, file }));
      stagedClips[clip.id] = { ...rendered, frames: runtime, durations: [...durations], loopMode: clip.loopMode };
      clipIndex.push({
        id: clip.id,
        loopMode: clip.loopMode,
        frames: runtime.map((frame, index) => ({ id: frame.id, duration: durations[index], file: portableRelative(path.posix.join(clip.id, path.basename(frame.file)), 'runtime frame path') })),
        sheet: portableRelative(path.posix.join(clip.id, path.basename(rendered.sheet)), 'sheet path'),
        metadata: portableRelative(path.posix.join(clip.id, path.basename(rendered.metadata)), 'clip metadata path'),
        preview: portableRelative(path.posix.join(clip.id, path.basename(rendered.preview)), 'preview path')
      });
    }
    const indexName = 'animation-contract-export.json';
    const indexFile = path.join(stagingDir, indexName);
    const index = {
      version: 1,
      animationContractSha256: contract.sha256,
      animationContract: contract.document,
      frameApprovalSha256,
      palette: contract.document.palette,
      clips: clipIndex,
      measurements: normalized.measurements.map((measurement, index) => snapshotMeasurement(measurement, captured[index].sha256))
    };
    await fs.writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(stagingDir, resolvedOutput);
    const clips = Object.fromEntries(Object.entries(stagedClips).map(([id, clip]) => [id, {
      ...clip,
      runtimeFrames: clip.runtimeFrames.map((file) => rebaseArtifact(file, stagingDir, resolvedOutput)),
      sheet: rebaseArtifact(clip.sheet, stagingDir, resolvedOutput),
      metadata: rebaseArtifact(clip.metadata, stagingDir, resolvedOutput),
      preview: rebaseArtifact(clip.preview, stagingDir, resolvedOutput),
      frames: clip.frames.map((frame) => ({ id: frame.id, file: rebaseArtifact(frame.file, stagingDir, resolvedOutput) }))
    }]));
    return { clips, metadata: path.join(resolvedOutput, indexName) };
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
