import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { validateAnimationContract } from './animation-contract.mjs';
import { extractPrimaryComponent, foregroundPredicate } from './components.mjs';
import { verifyFrameApproval } from './frame-approval.mjs';
import { captureRgba, paletteOf, readRgba } from './image.mjs';
import { canonicalPath, sameCanonicalPath } from './path-security.mjs';
import { stableHash } from './state-auth.mjs';

const CORRECTIONS = Object.freeze({
  CANVAS_SIZE: 'repad',
  NON_INTEGER_SCALE: 'nearest-rescale',
  INTERMEDIATE_COLORS: 'nearest-rescale',
  BACKGROUND_REMAINS: 'rekey',
  PIVOT_DRIFT: 'realign',
  BASELINE_DRIFT: 'realign',
  LANDMARK_DRIFT: 'realign',
  SOCKET_ATTACHMENT: 'realign',
  GROUND_TRAVEL_CONTACT: 'realign',
  GLOBAL_SCALE_DRIFT: 'nearest-rescale',
  PALETTE_DRIFT: 'palette-remap-review',
  CLIPPED_FOREGROUND: 'stop-for-regeneration',
  FRAME_BLEED: 'repad',
  TIMING_MISMATCH: 'reexport-metadata',
  METADATA_MISMATCH: 'reexport-metadata',
  PREVIEW_MISMATCH: 'reexport-preview',
  IDENTITY_DRIFT: 'stop-for-regeneration',
  DUPLICATE_POSE: 'stop-for-regeneration',
  LOOP_SEAM: 'timing-or-transition-review',
  NONCYCLIC_RESTART: 'reexport-metadata'
});

const SEMANTIC_CODES = new Set(['IDENTITY_DRIFT', 'DUPLICATE_POSE', 'LOOP_SEAM']);

export async function sourcePathsMatch(actual, expected, options = {}) {
  return sameCanonicalPath(actual, expected, options);
}

export function classifyFailures(report) {
  if (!report || !Array.isArray(report.failures)) throw new Error('report failures must be an array');
  return report.failures.map((failure) => {
    let correction = CORRECTIONS[failure.code] ?? 'stop-for-review';
    if (failure.code === 'PIVOT_DRIFT' || failure.code === 'BASELINE_DRIFT') {
      const stage = String(failure.stage ?? failure.target ?? '').toLowerCase();
      if (stage.includes('metadata')) correction = 'reexport-metadata';
      else if (stage.includes('preview')) correction = 'reexport-preview';
      else if (stage.includes('sheet')) correction = 'reexport-sheet';
      else correction = 'realign';
    }
    if (failure.code === 'FRAME_COUNT') correction = failure.stage === 'metadata' && failure.trustedArtifact === true ? 'reexport-metadata' : 'stop-for-review';
    if (failure.code === 'SOURCE_HASH_MISMATCH') correction = failure.stage === 'metadata' && failure.trustedArtifact === true ? 'reexport-metadata' : 'stop-for-review';
    return { ...failure, correction };
  });
}

export function validateIntegerScale({ source, output }) {
  const validSize = (size) => size && Number.isInteger(size.width) && size.width > 0 && Number.isInteger(size.height) && size.height > 0;
  if (!validSize(source) || !validSize(output)) return [{ code: 'NON_INTEGER_SCALE', source, output }];
  const sx = output.width / source.width;
  const sy = output.height / source.height;
  return Number.isInteger(sx) && sx > 0 && Number.isInteger(sy) && sy > 0 && sx === sy
    ? []
    : [{ code: 'NON_INTEGER_SCALE', source, output }];
}

function rgbaKey(rgba) {
  return rgba.join(',');
}

function paletteKeys(palette) {
  return new Set((palette ?? []).map((entry) => rgbaKey(entry.rgba)));
}

function paletteCounts(images) {
  const counts = new Map();
  for (const image of images) for (const entry of paletteOf(image)) {
    const key = rgbaKey(entry.rgba);
    counts.set(key, (counts.get(key) ?? 0) + entry.count);
  }
  return counts;
}

function samePaletteCounts(recorded, actual) {
  if (!Array.isArray(recorded) || recorded.length !== actual.size) return false;
  const seen = new Set();
  for (const entry of recorded) {
    const key = Array.isArray(entry?.rgba) ? rgbaKey(entry.rgba) : null;
    if (!key || seen.has(key) || actual.get(key) !== entry.count) return false;
    seen.add(key);
  }
  return true;
}

function alphaBounds(image) {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? null : { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

function redactedExecutable(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value))
    ? `<absolute>/${value.replaceAll('\\', '/').split('/').at(-1)}`
    : value;
}

function relevantConfig(config) {
  return {
    background: config.background,
    canonical: config.canonical,
    correction: config.correction,
    foreground: config.foreground,
    generation: config.generation,
    palette: config.palette,
    pivot: config.pivot,
    runtime: config.runtime,
    snapper: { args: config.snapper?.args, executable: redactedExecutable(config.snapper?.executable) }
  };
}

function jsonEqual(left, right) {
  const sort = (value) => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]))
    : value;
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right));
}

function rawHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function decodeAnimatedPreview(input) {
  // Keep libvips away from the staging pathname. Its Windows file cache can
  // retain a path-backed animated image after the JS pipeline has completed,
  // blocking the correction directory's atomic rename and cleanup.
  const rawPipeline = sharp(input, { animated: true }).ensureAlpha().raw();
  let decoded;
  try { decoded = await rawPipeline.toBuffer({ resolveWithObject: true }); }
  finally { rawPipeline.destroy(); }
  const metadataPipeline = sharp(input, { animated: true });
  try { return { ...decoded, metadata: await metadataPipeline.metadata() }; }
  finally { metadataPipeline.destroy(); }
}

async function captureImage(file) {
  const bytes = await fs.readFile(file);
  return { bytes, image: await readRgba(bytes), sha256: rawHash(bytes) };
}

async function captureJson(file) {
  const bytes = await fs.readFile(file);
  return { bytes, document: JSON.parse(bytes.toString('utf8')), sha256: rawHash(bytes) };
}

async function capturePreview(file) {
  const bytes = await fs.readFile(file);
  return { bytes, decoded: await decodeAnimatedPreview(bytes), sha256: rawHash(bytes) };
}

async function retainedForeground(file, image, config, { configuredBackground = true } = {}) {
  return extractPrimaryComponent(file, {
    image,
    isForeground: foregroundPredicate(image, { color: configuredBackground ? config.background?.color : null, tolerance: config.background?.tolerance ?? 0 }),
    retentionPolicy: config.foreground?.retentionPolicy ?? 'all',
    minimumComponentPixels: config.foreground?.minimumComponentPixels ?? 1
  });
}

function sameRgbAt(image, offset, color, tolerance) {
  return Math.max(
    Math.abs(image.data[offset] - color.r),
    Math.abs(image.data[offset + 1] - color.g),
    Math.abs(image.data[offset + 2] - color.b)
  ) <= tolerance;
}

function backgroundEvidence(image, config) {
  const color = config.background?.color;
  const tolerance = config.background?.tolerance ?? 0;
  let opaqueBorderPixels = 0;
  let configuredColorPixels = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3];
      if (alpha > 0 && (x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1)) opaqueBorderPixels += 1;
      if (alpha > 0 && color && sameRgbAt(image, offset, color, tolerance)) configuredColorPixels += 1;
    }
  }
  return { opaqueBorderPixels, configuredColorPixels };
}

function blockMatches(source, output, scale) {
  if (output.width !== source.width * scale || output.height !== source.height * scale) return false;
  for (let sy = 0; sy < source.height; sy += 1) {
    for (let sx = 0; sx < source.width; sx += 1) {
      const sourceOffset = (sy * source.width + sx) * 4;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const outputOffset = (((sy * scale + dy) * output.width) + sx * scale + dx) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            if (source.data[sourceOffset + channel] !== output.data[outputOffset + channel]) return false;
          }
        }
      }
    }
  }
  return true;
}

function normalizedMatchesApprovedSource(source, normalized, scale, left, top) {
  for (let y = 0; y < normalized.height; y += 1) {
    for (let x = 0; x < normalized.width; x += 1) {
      const outputOffset = (y * normalized.width + x) * 4;
      const inside = x >= left && y >= top && x < left + source.width * scale && y < top + source.height * scale;
      if (!inside) {
        if (normalized.data[outputOffset] !== 0 || normalized.data[outputOffset + 1] !== 0 || normalized.data[outputOffset + 2] !== 0 || normalized.data[outputOffset + 3] !== 0) return false;
        continue;
      }
      const sourceX = Math.floor((x - left) / scale);
      const sourceY = Math.floor((y - top) / scale);
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      for (let channel = 0; channel < 4; channel += 1) if (normalized.data[outputOffset + channel] !== source.data[sourceOffset + channel]) return false;
    }
  }
  return true;
}

function sheetMatches(sheet, runtimeImages, columns, rows, cell) {
  if (sheet.width !== columns * cell.width || sheet.height !== rows * cell.height) return false;
  for (let y = 0; y < sheet.height; y += 1) {
    for (let x = 0; x < sheet.width; x += 1) {
      const cellIndex = Math.floor(y / cell.height) * columns + Math.floor(x / cell.width);
      const sheetOffset = (y * sheet.width + x) * 4;
      if (cellIndex >= runtimeImages.length) {
        if (sheet.data[sheetOffset + 3] !== 0) return false;
        continue;
      }
      const frame = runtimeImages[cellIndex];
      const frameOffset = (((y % cell.height) * cell.width) + x % cell.width) * 4;
      for (let channel = 0; channel < 4; channel += 1) if (sheet.data[sheetOffset + channel] !== frame.data[frameOffset + channel]) return false;
    }
  }
  return true;
}

function addFailure(failures, code, details = {}) {
  failures.push({ code, ...details });
}

function validSemanticEvidence(item) {
  return item && SEMANTIC_CODES.has(item.code) && item.failed === true && item.evidence && typeof item.evidence === 'object';
}

function validCoordinate(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 && Object.hasOwn(value, 'x') && Object.hasOwn(value, 'y') && Number.isInteger(value.x) && Number.isInteger(value.y);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} schema is invalid`);
}

function snapshotAnimationContract(animationContract) {
  if (animationContract === undefined) return null;
  exactKeys(animationContract, ['document', 'sha256'], 'validation animation contract');
  const document = structuredClone(animationContract.document);
  validateAnimationContract(document);
  if (animationContract.sha256 !== stableHash(document)) throw new Error('validation animation contract hash is invalid');
  return { document, sha256: animationContract.sha256 };
}

function snapshotFrameApproval(frameApproval, animationContract) {
  if (frameApproval === undefined) return null;
  if (!animationContract) throw new Error('frame approval validation requires an animation contract');
  exactKeys(frameApproval, ['projectDir', 'file', 'snapReceipt', 'version'], 'frame approval selection');
  exactKeys(frameApproval.snapReceipt, ['path', 'sha256'], 'frame approval snap receipt selection');
  if ([frameApproval.projectDir, frameApproval.file, frameApproval.snapReceipt.path, frameApproval.snapReceipt.sha256].some((value) => typeof value !== 'string' || value === '') || !Number.isInteger(frameApproval.version) || frameApproval.version < 1) throw new Error('frame approval selection is invalid');
  return { projectDir: frameApproval.projectDir, file: frameApproval.file, snapReceipt: { path: frameApproval.snapReceipt.path, sha256: frameApproval.snapReceipt.sha256 }, version: frameApproval.version };
}

function flatContractFrames(contract) { return contract?.document.clips.flatMap((clip) => clip.frames) ?? null; }

function portableArtifactPath(value) {
  return typeof value === 'string' && value !== '' && !path.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.includes('\\') && value !== '.' && value !== '..' && !value.startsWith('../') && path.posix.normalize(value) === value;
}

async function containedArtifact(root, relative) {
  if (!portableArtifactPath(relative)) throw new Error('contract export artifact path is not portable and contained');
  const candidate = path.join(root, ...relative.split('/'));
  const containment = path.relative(root, candidate);
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error('contract export artifact escaped its root');
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('contract export artifact path must not contain a symlink');
  }
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('contract export artifact must be a regular single-link file');
  return candidate;
}

async function recursiveEntries(root, relative = '') {
  const current = relative ? path.join(root, relative) : root;
  const names = await fs.readdir(current, { withFileTypes: true });
  const entries = [];
  for (const entry of names) {
    const portable = relative ? path.posix.join(relative.replaceAll('\\', '/'), entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      entries.push(`!symlink:${portable}`);
    } else if (entry.isDirectory()) {
      entries.push(`dir:${portable}`);
      entries.push(...await recursiveEntries(root, portable));
    } else {
      entries.push(`file:${portable}`);
    }
  }
  return entries.sort();
}

function colorsOutsidePalette(image, allowed) {
  return paletteOf(image).map(({ rgba }) => rgbaKey(rgba)).filter((key) => !allowed.has(key));
}

function expectedMeasurementRecord(measurement, normalizedSha256) {
  const coordinate = (value) => validCoordinate(value) ? { x: value.x, y: value.y } : null;
  return {
    frameId: measurement?.frameId,
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

function canonicalClipArtifacts(clip) {
  const digits = Math.max(2, String(clip.frames.length - 1).length);
  const prefix = clip.id;
  const join = (name) => path.posix.join(prefix, name);
  const frames = clip.frames.map((_, index) => join(`${prefix}-${String(index).padStart(digits, '0')}.png`));
  return {
    frames,
    sheet: join(`${prefix}-sheet.png`),
    metadata: join(`${prefix}.json`),
    preview: join(`${prefix}.webp`)
  };
}

function contractExportFailure(failures, code, details = {}) {
  addFailure(failures, code, { stage: 'contract-export', ...details });
}

async function validateContractExportRun({ anchorReport, normalized, exported, config, semanticEvidence, animationContract, frameApproval }, { afterContractCapture } = {}) {
  anchorReport = structuredClone(anchorReport);
  normalized = structuredClone(normalized);
  exported = structuredClone(exported);
  config = structuredClone(config);
  semanticEvidence = structuredClone(semanticEvidence ?? []);
  animationContract = snapshotAnimationContract(animationContract);
  if (!animationContract) throw new Error('contract clip validation requires an animation contract');
  if (!jsonEqual(animationContract.document.sizes.canonical, [config.canonical.width, config.canonical.height]) || !jsonEqual(animationContract.document.pivot, config.pivot)) throw new Error('validation animation contract geometry does not match the selected config');
  if (frameApproval === undefined) throw new Error('a signed frame approval is required for animation contract validation');
  frameApproval = snapshotFrameApproval(frameApproval, animationContract);
  const verifiedApproval = await verifyFrameApproval({ projectDir: frameApproval.projectDir, file: frameApproval.file, contract: animationContract, snapReceipt: frameApproval.snapReceipt, version: frameApproval.version });
  const failures = [];
  const warnings = [];
  const measurements = {
    animationContractSha256: animationContract.sha256,
    frameApprovalSha256: verifiedApproval.sha256,
    contractClips: []
  };
  try { exactKeys(exported, ['clips', 'metadata'], 'contract export selection'); }
  catch (error) { contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'selectionSchema', reason: error.message }); }
  if (!Array.isArray(normalized.frames) || !Array.isArray(normalized.measurements)) throw new Error('contract clip validation requires normalized frames and measurements');
  if (!exported.clips || typeof exported.clips !== 'object' || Array.isArray(exported.clips) || typeof exported.metadata !== 'string') throw new Error('contract clip validation requires clips and a contract index');

  const allowedPalette = new Set(animationContract.document.palette.rgba.map(rgbaKey));
  let capturedAnchor = null;
  try {
    capturedAnchor = await captureImage(anchorReport.path);
    measurements.anchorHash = capturedAnchor.sha256;
    if (capturedAnchor.sha256 !== animationContract.document.anchor.sha256) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'contractAnchor', expected: animationContract.document.anchor.sha256, actual: capturedAnchor.sha256 });
    if (anchorReport.sha256 && anchorReport.sha256 !== capturedAnchor.sha256) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'anchorReport', expected: anchorReport.sha256, actual: capturedAnchor.sha256 });
    const drift = colorsOutsidePalette(capturedAnchor.image, allowedPalette);
    if (drift.length > 0) contractExportFailure(failures, 'PALETTE_DRIFT', { field: 'anchorPixels', colors: drift });
  } catch (error) {
    contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'contractAnchor', reason: error.message });
  }

  let index;
  let root;
  let capturedIndex;
  try {
    const indexStat = await fs.lstat(exported.metadata);
    if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.nlink > 1) throw new Error('contract index must be a regular single-link file');
    root = await fs.realpath(path.dirname(exported.metadata));
    if (path.dirname(await fs.realpath(exported.metadata)) !== root) throw new Error('contract index escaped its export root');
    capturedIndex = await captureJson(exported.metadata);
    index = capturedIndex.document;
    exactKeys(index, ['version', 'animationContractSha256', 'animationContract', 'frameApprovalSha256', 'palette', 'clips', 'measurements'], 'contract export index');
  } catch (error) {
    contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'index', reason: error.message });
    return { passed: false, failures: classifyFailures({ failures }), warnings, measurements };
  }
  if (index.version !== 1) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'version', expected: 1, actual: index.version });
  if (path.basename(exported.metadata) !== 'animation-contract-export.json') contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'indexName', expected: 'animation-contract-export.json', actual: path.basename(exported.metadata) });
  if (index.animationContractSha256 !== animationContract.sha256 || !jsonEqual(index.animationContract, animationContract.document) || stableHash(index.animationContract) !== index.animationContractSha256) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'animationContract' });
  if (index.frameApprovalSha256 !== verifiedApproval.sha256) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'frameApprovalSha256', expected: verifiedApproval.sha256, actual: index.frameApprovalSha256 });
  if (!jsonEqual(index.palette, animationContract.document.palette) || stableHash(index.palette?.rgba) !== animationContract.document.palette.sha256 || !jsonEqual(index.palette?.snapperPaletteHex, animationContract.document.palette.snapperPaletteHex)) contractExportFailure(failures, 'PALETTE_DRIFT', { field: 'frozenPalette' });

  const contractFrames = flatContractFrames(animationContract);
  const declaredClipIds = Object.keys(exported.clips);
  const expectedClipIds = animationContract.document.clips.map((clip) => clip.id);
  if (!jsonEqual(declaredClipIds, expectedClipIds)) contractExportFailure(failures, 'FRAME_COUNT', { field: 'callerClipSet', expected: expectedClipIds, actual: declaredClipIds });
  if (!Array.isArray(index.clips) || index.clips.length !== expectedClipIds.length || !jsonEqual(index.clips?.map((clip) => clip?.id), expectedClipIds)) contractExportFailure(failures, 'FRAME_COUNT', { field: 'indexClipSet', expected: expectedClipIds, actual: index.clips?.map((clip) => clip?.id) ?? null });
  if (normalized.frames.length !== contractFrames.length || normalized.measurements.length !== contractFrames.length || !Array.isArray(index.measurements) || index.measurements.length !== contractFrames.length) contractExportFailure(failures, 'FRAME_COUNT', { field: 'normalizedFrameSet', expected: contractFrames.length, actual: { frames: normalized.frames.length, measurements: normalized.measurements.length, indexMeasurements: index.measurements?.length ?? null } });

  const normalizedCaptures = [];
  const approvedSourceCaptures = [];
  const sourceCaptureByPath = new Map();
  if (capturedAnchor) sourceCaptureByPath.set(path.resolve(anchorReport.path), capturedAnchor);
  for (let frameIndex = 0; frameIndex < contractFrames.length; frameIndex += 1) {
    const definition = contractFrames[frameIndex];
    const recorded = normalized.measurements[frameIndex];
    const approved = verifiedApproval.document.payload.frames[frameIndex];
    let captured = null;
    try {
      captured = await captureImage(normalized.frames[frameIndex]);
      const drift = colorsOutsidePalette(captured.image, allowedPalette);
      if (drift.length > 0) contractExportFailure(failures, 'PALETTE_DRIFT', { field: 'normalizedPixels', frame: frameIndex, colors: drift });
    }
    catch (error) { contractExportFailure(failures, 'FRAME_COUNT', { field: 'normalizedArtifact', frame: frameIndex, reason: error.message }); }
    normalizedCaptures.push(captured);
    const approvedSource = approved ? path.resolve(path.dirname(frameApproval.snapReceipt.path), approved.path) : null;
    let capturedSource = null;
    if (!approvedSource || typeof recorded?.input !== 'string' || path.resolve(recorded.input) !== approvedSource) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'approvedSource', frame: frameIndex, expected: approvedSource, actual: recorded?.input ?? null });
    if (approvedSource) {
      try {
        capturedSource = sourceCaptureByPath.get(approvedSource) ?? await captureImage(approvedSource);
        sourceCaptureByPath.set(approvedSource, capturedSource);
        if (capturedSource.sha256 !== approved.sha256) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'approvedSource', frame: frameIndex, expected: approved.sha256, actual: capturedSource.sha256 });
      } catch (error) {
        contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'approvedSource', frame: frameIndex, reason: error.message });
      }
    }
    approvedSourceCaptures.push(capturedSource);
    if (recorded?.frameId !== definition.id || approved?.id !== definition.id) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'orderedFrame', frame: frameIndex, expected: definition.id, actual: recorded?.frameId ?? null });
    if (!sameCoordinate(recorded?.sourceLandmark, approved?.landmark)) contractExportFailure(failures, 'LANDMARK_DRIFT', { field: 'sourceLandmark', frame: frameIndex, expected: approved?.landmark ?? null, actual: recorded?.sourceLandmark ?? null });
    let derivedRoot = null;
    let derivedDrift = null;
    if (captured && capturedSource && approved) {
      const normalizedBounds = (await retainedForeground(normalized.frames[frameIndex], captured.image, config, { configuredBackground: false })).bounds;
      const recoveredSource = await retainedForeground(approvedSource, capturedSource.image, config);
      const sourceBounds = recoveredSource.bounds;
      const landmarkContained = approved.landmark.x < capturedSource.image.width && approved.landmark.y < capturedSource.image.height;
      const scaleX = sourceBounds && normalizedBounds ? normalizedBounds.width / sourceBounds.width : NaN;
      const scaleY = sourceBounds && normalizedBounds ? normalizedBounds.height / sourceBounds.height : NaN;
      if (!landmarkContained || !Number.isInteger(scaleX) || scaleX < 1 || scaleX !== scaleY) {
        contractExportFailure(failures, 'GLOBAL_SCALE_DRIFT', { field: 'approvedSourceGeometry', frame: frameIndex, sourceBounds, normalizedBounds, landmark: approved.landmark });
      } else {
        derivedRoot = {
          x: normalizedBounds.left + (approved.landmark.x - sourceBounds.left) * scaleX,
          y: normalizedBounds.top + (approved.landmark.y - sourceBounds.top) * scaleX
        };
        derivedDrift = { x: derivedRoot.x - definition.landmarkSemantic.target.x, y: derivedRoot.y - definition.landmarkSemantic.target.y };
        const placementLeft = definition.landmarkSemantic.target.x - (approved.landmark.x - sourceBounds.left) * scaleX;
        const placementTop = definition.landmarkSemantic.target.y - (approved.landmark.y - sourceBounds.top) * scaleX;
        if (!normalizedMatchesApprovedSource(recoveredSource.image, captured.image, scaleX, placementLeft, placementTop)) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'approvedSource', frame: frameIndex, reason: 'normalized pixels do not derive from the signed approved source' });
      }
    }
    if (!sameCoordinate(derivedRoot, definition.landmarkSemantic.target) || !sameCoordinate(derivedDrift, { x: 0, y: 0 }) || !sameCoordinate(recorded?.canonicalLandmark, derivedRoot) || !sameCoordinate(recorded?.landmarkDrift, derivedDrift)) contractExportFailure(failures, 'LANDMARK_DRIFT', { field: 'canonicalLandmark', frame: frameIndex, expected: definition.landmarkSemantic.target, actual: derivedRoot, recorded: recorded?.canonicalLandmark ?? null });
    const indexedMeasurement = index.measurements?.[frameIndex];
    if (!sameCoordinate(indexedMeasurement?.canonicalLandmark, definition.landmarkSemantic.target) || !sameCoordinate(indexedMeasurement?.sourceLandmark, approved?.landmark) || !sameCoordinate(indexedMeasurement?.landmarkDrift, { x: 0, y: 0 })) contractExportFailure(failures, 'LANDMARK_DRIFT', { field: 'indexedLandmark', frame: frameIndex });
    if (!jsonEqual(indexedMeasurement, expectedMeasurementRecord(recorded, captured?.sha256 ?? null))) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'landmarkMeasurements', frame: frameIndex });
  }

  const expectedEntries = new Set([`file:${path.basename(exported.metadata)}`]);
  const validationJobs = [];
  let definitionOffset = 0;
  for (let clipIndex = 0; clipIndex < animationContract.document.clips.length; clipIndex += 1) {
    const definition = animationContract.document.clips[clipIndex];
    const canonicalArtifacts = canonicalClipArtifacts(definition);
    expectedEntries.add(`dir:${definition.id}`);
    for (const relative of [...canonicalArtifacts.frames, canonicalArtifacts.sheet, canonicalArtifacts.metadata, canonicalArtifacts.preview]) expectedEntries.add(`file:${relative}`);
    const record = index.clips?.[clipIndex];
    const caller = exported.clips[definition.id];
    const expectedIds = definition.frames.map((frame) => frame.id);
    const expectedDurations = definition.frames.map((frame) => frame.duration);
    measurements.contractClips.push({ id: definition.id, frames: expectedIds, durations: expectedDurations, loopMode: definition.loopMode });
    let schemaValid = true;
    try {
      exactKeys(record, ['id', 'loopMode', 'frames', 'sheet', 'metadata', 'preview'], 'contract export clip');
      if (!Array.isArray(record.frames)) throw new Error('contract export clip frames must be an array');
      record.frames.forEach((item) => exactKeys(item, ['id', 'duration', 'file'], 'contract export frame'));
    } catch (error) {
      schemaValid = false;
      contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'clipSchema', clipId: definition.id, reason: error.message });
    }
    if (!schemaValid) { definitionOffset += definition.frames.length; continue; }
    const actualIds = record.frames.map((frame) => frame.id);
    const actualDurations = record.frames.map((frame) => frame.duration);
    if (!jsonEqual(actualIds, expectedIds)) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'frameOrder', clipId: definition.id, expected: expectedIds, actual: actualIds });
    if (!jsonEqual(actualDurations, expectedDurations)) contractExportFailure(failures, 'TIMING_MISMATCH', { field: 'durations', clipId: definition.id, expected: expectedDurations, actual: actualDurations });
    if (record.loopMode !== definition.loopMode) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'loopMode', clipId: definition.id, expected: definition.loopMode, actual: record.loopMode });
    const recordedArtifacts = { frames: record.frames.map((frame) => frame.file), sheet: record.sheet, metadata: record.metadata, preview: record.preview };
    if (!jsonEqual(recordedArtifacts, canonicalArtifacts)) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'canonicalArtifacts', clipId: definition.id, expected: canonicalArtifacts, actual: recordedArtifacts });
    const relativeArtifacts = [...canonicalArtifacts.frames, canonicalArtifacts.sheet, canonicalArtifacts.metadata, canonicalArtifacts.preview];
    const resolved = [];
    for (const relative of relativeArtifacts) {
      try { resolved.push(await containedArtifact(root, relative)); }
      catch (error) { contractExportFailure(failures, 'FRAME_COUNT', { field: 'artifactSet', clipId: definition.id, artifact: relative, reason: error.message }); }
    }
    if (resolved.length === relativeArtifacts.length) {
      const frameFiles = resolved.slice(0, definition.frames.length);
      const flat = { runtimeFrames: frameFiles, sheet: resolved.at(-3), metadata: resolved.at(-2), preview: resolved.at(-1) };
      let callerSchema = true;
      try {
        exactKeys(caller, ['runtimeFrames', 'sheet', 'metadata', 'preview', 'frames', 'durations', 'loopMode'], 'contract export selected clip');
        if (!Array.isArray(caller.frames) || !Array.isArray(caller.runtimeFrames) || !Array.isArray(caller.durations)) throw new Error('contract export selected clip arrays are invalid');
        caller.frames.forEach((frame) => exactKeys(frame, ['id', 'file'], 'contract export selected frame'));
        if ([caller.sheet, caller.metadata, caller.preview, ...caller.runtimeFrames, ...caller.frames.map((frame) => frame.file)].some((file) => typeof file !== 'string' || file === '')) throw new Error('contract export selected artifact paths are invalid');
      } catch (error) {
        callerSchema = false;
        contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'callerSchema', clipId: definition.id, reason: error.message });
      }
      if (callerSchema) {
        const callerIds = caller.frames.map((frame) => frame.id);
        const callerPaths = caller.runtimeFrames;
        try {
          const callerArtifacts = await Promise.all([...callerPaths, ...caller.frames.map((frame) => frame.file), caller.sheet, caller.metadata, caller.preview].map((file) => canonicalPath(file)));
          const expectedArtifacts = await Promise.all([...frameFiles, ...frameFiles, flat.sheet, flat.metadata, flat.preview].map((file) => canonicalPath(file)));
          if (!jsonEqual(callerIds, expectedIds) || !jsonEqual(caller.durations, expectedDurations) || caller.loopMode !== definition.loopMode || !jsonEqual(callerArtifacts, expectedArtifacts)) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'callerArtifacts', clipId: definition.id });
        } catch (error) {
          contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'callerArtifacts', clipId: definition.id, reason: error.message });
        }
      }
      const subset = {
        frames: normalized.frames.slice(definitionOffset, definitionOffset + definition.frames.length),
        measurements: normalized.measurements.slice(definitionOffset, definitionOffset + definition.frames.length),
        canonicalPivot: normalized.canonicalPivot,
        scaleFactor: normalized.scaleFactor
      };
      try {
        const runtimeCaptures = await Promise.all(frameFiles.map(captureImage));
        for (const [frameIndex, captured] of runtimeCaptures.entries()) {
          const drift = colorsOutsidePalette(captured.image, allowedPalette);
          if (drift.length > 0) contractExportFailure(failures, 'PALETTE_DRIFT', { field: 'runtimePixels', clipId: definition.id, frame: frameIndex, colors: drift });
        }
        const capturedMetadata = await captureJson(flat.metadata);
        const capturedSheet = await captureImage(flat.sheet);
        const capturedPreview = await capturePreview(flat.preview);
        const clipMetadata = capturedMetadata.document;
        const canonicalMetadataNames = {
          frames: canonicalArtifacts.frames.map((file) => path.posix.basename(file)),
          sheet: path.posix.basename(canonicalArtifacts.sheet),
          preview: path.posix.basename(canonicalArtifacts.preview)
        };
        const actualMetadataNames = { frames: clipMetadata.frames?.map((frame) => frame.file) ?? null, sheet: clipMetadata.sheet, preview: clipMetadata.preview };
        if (!jsonEqual(actualMetadataNames, canonicalMetadataNames)) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'canonicalMetadataArtifacts', clipId: definition.id, expected: canonicalMetadataNames, actual: actualMetadataNames });
        if (!jsonEqual(clipMetadata.durations, expectedDurations) || !jsonEqual(clipMetadata.frames?.map((frame) => frame.duration), expectedDurations)) contractExportFailure(failures, 'TIMING_MISMATCH', { field: 'clipMetadataDurations', clipId: definition.id, expected: expectedDurations, actual: { durations: clipMetadata.durations, frames: clipMetadata.frames?.map((frame) => frame.duration) ?? null } });
        const previewDelays = capturedPreview.decoded.metadata.delay ?? [];
        if (definition.frames.length > 1 && !jsonEqual(previewDelays, expectedDurations)) contractExportFailure(failures, 'TIMING_MISMATCH', { field: 'previewDelays', clipId: definition.id, expected: expectedDurations, actual: previewDelays });
        validationJobs.push({
          clipId: definition.id,
          request: { anchorReport, normalized: subset, exported: flat, config, semanticEvidence: [] },
          captures: {
            anchor: capturedAnchor,
            normalized: normalizedCaptures.slice(definitionOffset, definitionOffset + definition.frames.length),
            sources: approvedSourceCaptures.slice(definitionOffset, definitionOffset + definition.frames.length),
            runtime: runtimeCaptures,
            metadata: capturedMetadata,
            sheet: capturedSheet,
            preview: capturedPreview
          }
        });
      } catch (error) {
        contractExportFailure(failures, 'FRAME_COUNT', { field: 'artifactCapture', clipId: definition.id, reason: error.message });
      }
    }
    definitionOffset += definition.frames.length;
  }

  try {
    const actualEntries = await recursiveEntries(root);
    const expected = [...expectedEntries].sort();
    if (!jsonEqual(actualEntries, expected)) contractExportFailure(failures, 'FRAME_COUNT', { field: 'artifactSet', expected, actual: actualEntries });
  } catch (error) {
    contractExportFailure(failures, 'FRAME_COUNT', { field: 'artifactSet', reason: error.message });
  }
  if (typeof afterContractCapture === 'function') await afterContractCapture();
  for (const job of validationJobs) {
    try {
      const clipReport = await validateFlatRun(job.request, job.captures);
      failures.push(...clipReport.failures.map(({ correction: _correction, ...failure }) => ({ ...failure, clipId: job.clipId })));
    } catch (error) {
      contractExportFailure(failures, 'FRAME_COUNT', { field: 'artifactValidation', clipId: job.clipId, reason: error.message });
    }
  }
  for (const code of SEMANTIC_CODES) {
    const evidence = semanticEvidence.find((item) => item.code === code);
    if (validSemanticEvidence(evidence)) addFailure(failures, code, { frame: evidence.frame, evidence: evidence.evidence });
    else warnings.push({ code: 'HUMAN_REVIEW_REQUIRED', check: code, reason: 'artistic or semantic judgment requires explicit evidence' });
  }
  for (const clip of animationContract.document.clips) {
    if (clip.loopMode === 'loop' && !loopApprovedByFrameManifest(verifiedApproval, clip)) warnings.push({ code: 'HUMAN_REVIEW_REQUIRED', check: 'LOOP_ROOT_TRANSITION', clipId: clip.id, transition: clip.loopTransition, reason: 'the declared last-to-first root transition requires an authenticated frame approval at its review checkpoint' });
  }
  const classified = classifyFailures({ failures });
  return { passed: classified.length === 0, failures: classified, warnings, measurements };
}

function loopApprovedByFrameManifest(verifiedApproval, clip) {
  if (!verifiedApproval) return false;
  const frames = verifiedApproval.document.payload.frames;
  const from = frames.find((frame) => frame.id === clip.loopTransition.fromFrameId);
  const to = frames.find((frame) => frame.id === clip.loopTransition.toFrameId);
  return [from, to].every((frame) => frame?.approved === true && frame.approvedBy === verifiedApproval.document.payload.approvedBy && frame.checkpoints.includes(clip.loopTransition.reviewCheckpoint));
}

function sameCoordinate(left, right) { return validCoordinate(left) && validCoordinate(right) && left.x === right.x && left.y === right.y; }

function translatedImageMatches(source, output, delta) {
  if (source.width !== output.width || source.height !== output.height) return false;
  for (let y = 0; y < output.height; y += 1) {
    for (let x = 0; x < output.width; x += 1) {
      const outputOffset = (y * output.width + x) * 4;
      const sourceX = x - delta.x;
      const sourceY = y - delta.y;
      if (sourceX < 0 || sourceY < 0 || sourceX >= source.width || sourceY >= source.height) {
        if (output.data[outputOffset] !== 0 || output.data[outputOffset + 1] !== 0 || output.data[outputOffset + 2] !== 0 || output.data[outputOffset + 3] !== 0) return false;
        continue;
      }
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      for (let channel = 0; channel < 4; channel += 1) if (source.data[sourceOffset + channel] !== output.data[outputOffset + channel]) return false;
    }
  }
  return true;
}

function translatedNamedLandmarks(values, delta) {
  return Object.fromEntries((values ?? []).map((value) => [value.id, { x: value.x + delta.x, y: value.y + delta.y }]));
}

function nonzeroTravel(value) { return value?.x !== 0 || value?.y !== 0; }

async function compositedFilesMatch(files, expected, width, height) {
  if (!Array.isArray(files) || files.length === 0 || expected.width !== width || expected.height !== height) return false;
  const { data, info } = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(files.map((input) => ({ input })))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return info.width === expected.width && info.height === expected.height && data.equals(expected.data);
}

async function validateV2ArtifactRecord(root, record, label) {
  exactKeys(record, ['file', 'sha256'], label);
  const file = await containedArtifact(root, record.file);
  const actual = rawHash(await fs.readFile(file));
  return { file, actual, matches: actual === record.sha256 };
}

function expectV2Artifact(entries, relative) {
  const segments = relative.split('/');
  for (let index = 1; index < segments.length; index += 1) entries.add(`dir:${segments.slice(0, index).join('/')}`);
  entries.add(`file:${relative}`);
}

async function validateContractExportRunV2({ anchorReport, normalized, exported, config, animationContract, frameApproval }) {
  anchorReport = structuredClone(anchorReport);
  normalized = structuredClone(normalized);
  exported = structuredClone(exported);
  config = structuredClone(config);
  animationContract = snapshotAnimationContract(animationContract);
  if (!animationContract || animationContract.document.version !== 2) throw new Error('v2 contract validation requires an animation contract version 2');
  const contract = animationContract.document;
  const canonical = { width: contract.canvas.width, height: contract.canvas.height };
  if (!jsonEqual(config?.canonical, canonical) || !jsonEqual(config?.runtime, contract.scale.runtime) || !jsonEqual(config?.pivot, contract.canvas.pivot)) throw new Error('validation animation contract geometry does not match the selected config');
  if (frameApproval === undefined) throw new Error('a signed frame approval is required for animation contract validation');
  frameApproval = snapshotFrameApproval(frameApproval, animationContract);
  const verifiedApproval = await verifyFrameApproval({ projectDir: frameApproval.projectDir, file: frameApproval.file, contract: animationContract, snapReceipt: frameApproval.snapReceipt, version: frameApproval.version });
  const failures = [];
  const warnings = [];
  const measurements = { animationContractSha256: animationContract.sha256, frameApprovalSha256: verifiedApproval.sha256, frames: [] };
  const allowedPalette = new Set(contract.palette.rgba.map(rgbaKey));

  try {
    const capturedAnchor = await captureImage(anchorReport.path);
    measurements.anchorHash = capturedAnchor.sha256;
    if (capturedAnchor.sha256 !== contract.character.anchorSha256 || (anchorReport.sha256 && anchorReport.sha256 !== capturedAnchor.sha256)) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'characterAnchor', expected: contract.character.anchorSha256, actual: capturedAnchor.sha256 });
    const drift = colorsOutsidePalette(capturedAnchor.image, allowedPalette);
    if (drift.length > 0) contractExportFailure(failures, 'PALETTE_DRIFT', { field: 'anchorPixels', colors: drift });
  } catch (error) {
    contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'characterAnchor', reason: error.message });
  }

  if (normalized?.version !== 2 || normalized.animationContractSha256 !== animationContract.sha256 || normalized.selectionApprovalSha256 !== contract.selectionApprovalSha256 || normalized.frameApprovalSha256 !== verifiedApproval.sha256 || normalized.snapReceiptSha256 !== verifiedApproval.document.payload.snapReceiptSha256 || !Array.isArray(normalized.frames)) throw new Error('v2 validation normalized provenance binding is invalid');
  if (exported?.version !== 2 || !exported.clips || !exported.tracks || typeof exported.metadata !== 'string') throw new Error('v2 validation requires the complete contract export selection');
  const definitions = contract.clips.flatMap((clip) => clip.frames.map((frame) => ({ ...frame, loopMode: clip.loopMode, clipId: clip.id })));
  if (normalized.frames.length !== definitions.length || verifiedApproval.document.payload.frames.length !== definitions.length) throw new Error('v2 validation requires exact normalized and approved frame coverage');

  const normalizedCaptures = new Map();
  const trackById = new Map(contract.tracks.map((track) => [track.id, track]));
  for (const [frameIndex, definition] of definitions.entries()) {
    const frame = normalized.frames[frameIndex];
    const approved = verifiedApproval.document.payload.frames[frameIndex];
    const delta = { x: contract.canvas.pivot.x - approved.landmarks.root.x, y: contract.canvas.pivot.y - approved.landmarks.root.y };
    const expectedSockets = translatedNamedLandmarks(approved.landmarks.sockets, delta);
    const expectedContacts = translatedNamedLandmarks(approved.landmarks.contacts, delta);
    const frameMeasurement = { id: definition.id, tracks: [] };
    measurements.frames.push(frameMeasurement);
    if (frame?.id !== definition.id || frame?.semantic !== definition.semantic || frame?.duration !== definition.duration || frame?.loopMode !== definition.loopMode || frame?.scale !== contract.scale.integer) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'normalizedFrame', frame: frameIndex });
    if (!sameCoordinate(frame?.root, contract.canvas.pivot)) contractExportFailure(failures, 'LANDMARK_DRIFT', { field: 'root', frame: frameIndex, expected: contract.canvas.pivot, actual: frame?.root ?? null });
    if (frame?.baseline !== contract.canvas.baseline || approved.landmarks.baseline + delta.y !== contract.canvas.baseline) contractExportFailure(failures, 'BASELINE_DRIFT', { frame: frameIndex, expected: contract.canvas.baseline, actual: frame?.baseline ?? null });
    if (!jsonEqual(frame?.sockets, expectedSockets)) contractExportFailure(failures, 'LANDMARK_DRIFT', { field: 'sockets', frame: frameIndex, expected: expectedSockets, actual: frame?.sockets ?? null });
    if (!jsonEqual(frame?.contacts, expectedContacts)) contractExportFailure(failures, 'LANDMARK_DRIFT', { field: 'contacts', frame: frameIndex, expected: expectedContacts, actual: frame?.contacts ?? null });
    if (!jsonEqual(frame?.groundTravel, definition.groundTravel)) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'groundTravel', frame: frameIndex });
    if (nonzeroTravel(definition.groundTravel) && definition.contacts.length === 0) contractExportFailure(failures, 'GROUND_TRAVEL_CONTACT', { frame: frameIndex, frameId: definition.id, groundTravel: definition.groundTravel });
    if (!jsonEqual(Object.keys(frame?.tracks ?? {}), definition.tracks)) contractExportFailure(failures, 'FRAME_COUNT', { field: 'normalizedTracks', frame: frameIndex, expected: definition.tracks, actual: Object.keys(frame?.tracks ?? {}) });

    const normalizedTrackFiles = [];
    for (const [trackIndex, trackId] of definition.tracks.entries()) {
      const track = trackById.get(trackId);
      const record = frame?.tracks?.[trackId];
      const approvedOutput = approved.outputs[trackIndex];
      if (!record || !approvedOutput || approvedOutput.trackId !== trackId || record.sourceSha256 !== approvedOutput.sha256 || record.kind !== track.kind || record.attachTo !== track.attachTo) {
        contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'trackBinding', frame: frameIndex, trackId });
        continue;
      }
      if (track.attachTo !== null && !definition.sockets.includes(track.attachTo)) contractExportFailure(failures, 'SOCKET_ATTACHMENT', { frame: frameIndex, trackId, socket: track.attachTo });
      const expectedSource = path.resolve(path.dirname(frameApproval.snapReceipt.path), approvedOutput.path);
      if (!await sourcePathsMatch(record.sourcePath, expectedSource)) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'trackSourcePath', frame: frameIndex, trackId });
      try {
        const source = await captureImage(expectedSource);
        const output = await captureImage(record.path);
        normalizedTrackFiles.push(record.path);
        normalizedCaptures.set(`${definition.id}\0${trackId}`, output);
        frameMeasurement.tracks.push({ id: trackId, sourceSha256: source.sha256, normalizedSha256: output.sha256 });
        if (source.sha256 !== approvedOutput.sha256 || output.sha256 !== record.normalizedSha256) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'trackPixels', frame: frameIndex, trackId });
        if (output.image.width !== canonical.width || output.image.height !== canonical.height) contractExportFailure(failures, 'CANVAS_SIZE', { frame: frameIndex, trackId, expected: [canonical.width, canonical.height], actual: [output.image.width, output.image.height] });
        const drift = colorsOutsidePalette(output.image, allowedPalette);
        if (drift.length > 0) contractExportFailure(failures, 'PALETTE_DRIFT', { frame: frameIndex, trackId, colors: drift });
        if (!translatedImageMatches(source.image, output.image, delta)) contractExportFailure(failures, track.attachTo === null ? 'LANDMARK_DRIFT' : 'SOCKET_ATTACHMENT', { frame: frameIndex, trackId, delta });
        if (track.required && record.clippedPixelCount !== 0) contractExportFailure(failures, 'CLIPPED_FOREGROUND', { frame: frameIndex, trackId, clippedPixelCount: record.clippedPixelCount ?? null });
      } catch (error) {
        contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'trackArtifact', frame: frameIndex, trackId, reason: error.message });
      }
    }
    try {
      const combined = await captureImage(frame.combined.path);
      if (combined.sha256 !== frame.combined.sha256 || !await compositedFilesMatch(normalizedTrackFiles, combined.image, canonical.width, canonical.height)) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'normalizedCombined', frame: frameIndex });
    } catch (error) {
      contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'normalizedCombined', frame: frameIndex, reason: error.message });
    }
  }

  let index;
  let root;
  try {
    const captured = await captureJson(exported.metadata);
    index = captured.document;
    root = await fs.realpath(path.dirname(exported.metadata));
    exactKeys(index, ['version', 'animationContractSha256', 'animationContract', 'selectionApprovalSha256', 'frameApprovalSha256', 'snapReceiptSha256', 'character', 'canvas', 'scale', 'palette', 'tracks', 'sockets', 'contacts', 'clips'], 'v2 contract export index');
  } catch (error) {
    contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'index', reason: error.message });
    return { passed: false, failures: classifyFailures({ failures }), warnings, measurements };
  }
  if (index.version !== 2 || index.animationContractSha256 !== animationContract.sha256 || !jsonEqual(index.animationContract, contract) || index.selectionApprovalSha256 !== contract.selectionApprovalSha256 || index.frameApprovalSha256 !== verifiedApproval.sha256 || index.snapReceiptSha256 !== verifiedApproval.document.payload.snapReceiptSha256) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'provenanceBindings' });
  for (const field of ['character', 'canvas', 'scale', 'palette', 'tracks', 'sockets', 'contacts']) if (!jsonEqual(index[field], contract[field])) contractExportFailure(failures, field === 'palette' ? 'PALETTE_DRIFT' : 'METADATA_MISMATCH', { field });
  if (!Array.isArray(index.clips) || index.clips.length !== contract.clips.length) contractExportFailure(failures, 'FRAME_COUNT', { field: 'clips', expected: contract.clips.length, actual: index.clips?.length ?? null });

  const expectedEntries = new Set([`file:${path.basename(exported.metadata)}`]);
  let definitionOffset = 0;
  for (const [clipIndex, clip] of contract.clips.entries()) {
    const record = index.clips?.[clipIndex];
    if (!record) { definitionOffset += clip.frames.length; continue; }
    try { exactKeys(record, ['id', 'loopMode', 'restart', 'frames', 'sheet', 'contactSheet', 'metadata', 'preview'], 'v2 export clip'); }
    catch (error) { contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'clipSchema', clipId: clip.id, reason: error.message }); definitionOffset += clip.frames.length; continue; }
    if (record.id !== clip.id || record.loopMode !== clip.loopMode) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'loopMode', clipId: clip.id });
    const expectedRestart = clip.loopMode === 'loop' ? 'loop' : 'stop';
    if (record.restart !== expectedRestart) contractExportFailure(failures, clip.loopMode === 'loop' ? 'METADATA_MISMATCH' : 'NONCYCLIC_RESTART', { clipId: clip.id, expected: expectedRestart, actual: record.restart });
    if (!Array.isArray(record.frames) || record.frames.length !== clip.frames.length) contractExportFailure(failures, 'FRAME_COUNT', { field: 'clipFrames', clipId: clip.id });
    const runtimeCombinedImages = [];
    for (const [localIndex, definition] of clip.frames.entries()) {
      const frameRecord = record.frames?.[localIndex];
      const normalizedFrame = normalized.frames[definitionOffset + localIndex];
      if (!frameRecord) continue;
      try { exactKeys(frameRecord, ['id', 'semantic', 'duration', 'tracks', 'root', 'baseline', 'sockets', 'contacts', 'groundTravel', 'outputs', 'combined'], 'v2 export frame'); }
      catch (error) { contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'frameSchema', frameId: definition.id, reason: error.message }); continue; }
      if (frameRecord.id !== definition.id || frameRecord.semantic !== definition.semantic || frameRecord.duration !== definition.duration || !jsonEqual(frameRecord.tracks, definition.tracks) || !sameCoordinate(frameRecord.root, contract.canvas.pivot) || frameRecord.baseline !== contract.canvas.baseline || !jsonEqual(frameRecord.sockets, normalizedFrame.sockets) || !jsonEqual(frameRecord.contacts, normalizedFrame.contacts) || !jsonEqual(frameRecord.groundTravel, definition.groundTravel)) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'engineFrame', frameId: definition.id });
      if (nonzeroTravel(frameRecord.groundTravel) && Object.keys(frameRecord.contacts ?? {}).length === 0) contractExportFailure(failures, 'GROUND_TRAVEL_CONTACT', { frameId: definition.id, groundTravel: frameRecord.groundTravel });
      if (!Array.isArray(frameRecord.outputs) || frameRecord.outputs.length !== definition.tracks.length) contractExportFailure(failures, 'FRAME_COUNT', { field: 'trackOutputs', frameId: definition.id });
      const runtimeTrackFiles = [];
      for (const [trackIndex, outputRecord] of (frameRecord.outputs ?? []).entries()) {
        const trackId = definition.tracks[trackIndex];
        try {
          exactKeys(outputRecord, ['trackId', 'kind', 'attachTo', 'sourceSha256', 'normalizedSha256', 'file', 'sha256'], 'v2 track output');
          expectV2Artifact(expectedEntries, outputRecord.file);
          const artifact = await validateV2ArtifactRecord(root, { file: outputRecord.file, sha256: outputRecord.sha256 }, 'v2 runtime track artifact');
          runtimeTrackFiles.push(artifact.file);
          const image = await readRgba(artifact.file);
          const normalizedImage = normalizedCaptures.get(`${definition.id}\0${trackId}`)?.image;
          if (!artifact.matches || outputRecord.trackId !== trackId || outputRecord.sourceSha256 !== normalizedFrame.tracks[trackId].sourceSha256 || outputRecord.normalizedSha256 !== normalizedFrame.tracks[trackId].normalizedSha256) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'runtimeTrack', frameId: definition.id, trackId });
          if (!normalizedImage || !blockMatches(normalizedImage, image, contract.scale.integer)) contractExportFailure(failures, 'NON_INTEGER_SCALE', { frameId: definition.id, trackId });
        } catch (error) {
          contractExportFailure(failures, 'FRAME_COUNT', { field: 'runtimeTrack', frameId: definition.id, trackId, reason: error.message });
        }
      }
      try {
        expectV2Artifact(expectedEntries, frameRecord.combined.file);
        const combined = await validateV2ArtifactRecord(root, frameRecord.combined, 'v2 combined artifact');
        const image = await readRgba(combined.file);
        runtimeCombinedImages.push(image);
        if (!combined.matches || image.width !== contract.scale.runtime.width || image.height !== contract.scale.runtime.height || !await compositedFilesMatch(runtimeTrackFiles, image, contract.scale.runtime.width, contract.scale.runtime.height)) contractExportFailure(failures, 'SOURCE_HASH_MISMATCH', { field: 'combined', frameId: definition.id });
      } catch (error) {
        contractExportFailure(failures, 'FRAME_COUNT', { field: 'combined', frameId: definition.id, reason: error.message });
      }
    }
    definitionOffset += clip.frames.length;
    let clipMetadata = null;
    try {
      expectV2Artifact(expectedEntries, record.metadata.file);
      const artifact = await validateV2ArtifactRecord(root, record.metadata, 'v2 metadata artifact');
      clipMetadata = (await captureJson(artifact.file)).document;
      if (!artifact.matches || !jsonEqual(clipMetadata.durations, clip.frames.map((frame) => frame.duration)) || clipMetadata.frames?.length !== clip.frames.length || clipMetadata.frameSize?.width !== contract.scale.runtime.width || clipMetadata.frameSize?.height !== contract.scale.runtime.height) contractExportFailure(failures, 'METADATA_MISMATCH', { field: 'clipMetadata', clipId: clip.id });
    } catch (error) {
      contractExportFailure(failures, 'FRAME_COUNT', { field: 'metadata', clipId: clip.id, reason: error.message });
    }
    for (const field of ['sheet', 'contactSheet']) {
      try {
        expectV2Artifact(expectedEntries, record[field].file);
        const artifact = await validateV2ArtifactRecord(root, record[field], `v2 ${field} artifact`);
        const image = await readRgba(artifact.file);
        const matches = clipMetadata && sheetMatches(image, runtimeCombinedImages, clipMetadata.columns, clipMetadata.rows, contract.scale.runtime);
        if (!artifact.matches || !matches) contractExportFailure(failures, 'FRAME_BLEED', { field, clipId: clip.id });
      } catch (error) {
        contractExportFailure(failures, 'FRAME_COUNT', { field, clipId: clip.id, reason: error.message });
      }
    }
    try {
      expectV2Artifact(expectedEntries, record.preview.file);
      const artifact = await validateV2ArtifactRecord(root, record.preview, 'v2 preview artifact');
      const preview = await capturePreview(artifact.file);
      const metadata = preview.decoded.metadata;
      const pages = preview.decoded.info.pages ?? 1;
      const pageHeight = preview.decoded.info.pageHeight ?? preview.decoded.info.height / pages;
      let pixelsMatch = pages === runtimeCombinedImages.length;
      const pageBytes = preview.decoded.info.width * pageHeight * 4;
      for (let index = 0; pixelsMatch && index < pages; index += 1) pixelsMatch = preview.decoded.data.subarray(index * pageBytes, (index + 1) * pageBytes).equals(runtimeCombinedImages[index].data);
      if (!artifact.matches || (metadata.pages ?? 1) !== clip.frames.length || metadata.width !== contract.scale.runtime.width || (metadata.pageHeight ?? metadata.height) !== contract.scale.runtime.height || ((metadata.pages ?? 1) > 1 && !jsonEqual(metadata.delay, clip.frames.map((frame) => frame.duration))) || !pixelsMatch) contractExportFailure(failures, 'PREVIEW_MISMATCH', { field: 'timingGeometryOrPixels', clipId: clip.id });
    } catch (error) {
      contractExportFailure(failures, 'FRAME_COUNT', { field: 'preview', clipId: clip.id, reason: error.message });
    }
  }

  try {
    const actualEntries = await recursiveEntries(root);
    if (!jsonEqual(actualEntries, [...expectedEntries].sort())) contractExportFailure(failures, 'FRAME_COUNT', { field: 'artifactSet', expected: [...expectedEntries].sort(), actual: actualEntries });
  } catch (error) {
    contractExportFailure(failures, 'FRAME_COUNT', { field: 'artifactSet', reason: error.message });
  }

  const classified = classifyFailures({ failures });
  return { passed: classified.length === 0, failures: classified, warnings, measurements };
}

function validSourceLandmark(value) { return validCoordinate(value) && value.x >= 0 && value.y >= 0; }

function validCanonicalLandmark(value, canonical) { return validSourceLandmark(value) && value.x < canonical.width && value.y < canonical.height; }

async function validateFlatRun({ anchorReport, normalized, exported, config, semanticEvidence = [], animationContract, frameApproval }, capturedArtifacts = null) {
  if (!anchorReport || !normalized || !exported || !config) throw new Error('anchorReport, normalized, exported, and config are required');
  anchorReport = structuredClone(anchorReport);
  normalized = structuredClone(normalized);
  exported = structuredClone(exported);
  config = structuredClone(config);
  semanticEvidence = structuredClone(semanticEvidence);
  animationContract = snapshotAnimationContract(animationContract);
  if (animationContract && (!jsonEqual(animationContract.document.sizes.canonical, [config.canonical.width, config.canonical.height]) || !jsonEqual(animationContract.document.pivot, config.pivot))) throw new Error('validation animation contract geometry does not match the selected config');
  if (animationContract && frameApproval === undefined) throw new Error('a signed frame approval is required for animation contract validation');
  frameApproval = snapshotFrameApproval(frameApproval, animationContract);
  const verifiedFrameApproval = frameApproval ? await verifyFrameApproval({ projectDir: frameApproval.projectDir, file: frameApproval.file, contract: animationContract, snapReceipt: frameApproval.snapReceipt, version: frameApproval.version }) : null;
  const contractedFrames = flatContractFrames(animationContract);
  if (contractedFrames && (!Array.isArray(normalized.measurements) || normalized.measurements.length !== normalized.frames?.length)) throw new Error('animation contract validation requires an exact normalization measurements array for every frame');
  const failures = [];
  const warnings = [];
  const measurements = { runtimeFrames: exported.runtimeFrames?.length ?? 0, sourceHashes: [] };
  const canonical = config.canonical;
  const runtime = config.runtime;
  const scaleFailures = validateIntegerScale({ source: canonical, output: runtime });
  failures.push(...scaleFailures);
  const runtimeScale = scaleFailures.length === 0 ? runtime.width / canonical.width : null;
  const margin = config.validation?.marginPixels ?? 1;

  if (!Array.isArray(normalized.frames) || !Array.isArray(exported.runtimeFrames)) throw new Error('normalized and exported frame lists are required');
  if (normalized.frames.length !== exported.runtimeFrames.length) addFailure(failures, 'FRAME_COUNT', { stage: 'runtime', trustedArtifact: false, expected: normalized.frames.length, actual: exported.runtimeFrames.length });
  if (contractedFrames && normalized.frames.length !== contractedFrames.length) addFailure(failures, 'FRAME_COUNT', { stage: 'normalization-contract', trustedArtifact: false, expected: contractedFrames.length, actual: normalized.frames.length });
  if (normalized.canonicalPivot?.x !== config.pivot.x || normalized.canonicalPivot?.y !== config.pivot.y) addFailure(failures, 'PIVOT_DRIFT', { expected: config.pivot, actual: normalized.canonicalPivot });

  if (typeof anchorReport.path !== 'string' || anchorReport.path.trim() === '') throw new Error('anchorReport.path is required for artifact-backed validation');
  const capturedAnchor = capturedArtifacts?.anchor ?? await captureImage(anchorReport.path);
  const anchorImage = capturedAnchor.image;
  const actualAnchorHash = capturedAnchor.sha256;
  measurements.anchorHash = actualAnchorHash;
  measurements.anchorPalette = paletteOf(anchorImage);
  if (anchorReport.sha256 && anchorReport.sha256 !== actualAnchorHash) addFailure(failures, 'SOURCE_HASH_MISMATCH', { stage: 'anchor', trustedArtifact: false, artifact: 'anchor', expected: anchorReport.sha256, actual: actualAnchorHash });
  const anchorForeground = await retainedForeground(anchorReport.path, anchorImage, config);
  const anchorColors = paletteKeys(paletteOf(anchorForeground.image));
  anchorColors.add('0,0,0,0');
  const normalizedImages = [];
  const derivedScales = [];
  for (let index = 0; index < normalized.frames.length; index += 1) {
    const file = normalized.frames[index];
    const captured = capturedArtifacts?.normalized?.[index] ?? await captureImage(file);
    const image = captured.image;
    normalizedImages.push(image);
    if (image.width !== canonical.width || image.height !== canonical.height) addFailure(failures, 'CANVAS_SIZE', { stage: 'canonical', frame: index, expected: [canonical.width, canonical.height], actual: [image.width, image.height] });
    const bounds = (await retainedForeground(file, image, config, { configuredBackground: false })).bounds;
    const recorded = normalized.measurements?.[index];
    if (bounds && bounds.bottom !== config.pivot.y - 1) addFailure(failures, 'BASELINE_DRIFT', { frame: index, expected: config.pivot.y - 1, actual: bounds.bottom });
    if (bounds && (bounds.left < margin || bounds.top < margin || bounds.right >= image.width - margin || bounds.bottom >= image.height - margin)) addFailure(failures, 'CLIPPED_FOREGROUND', { stage: 'canonical', frame: index, margin, bounds });
    if (recorded && bounds && (recorded.left !== bounds.left || recorded.top !== bounds.top || recorded.width !== bounds.width || recorded.height !== bounds.height)) addFailure(failures, 'METADATA_MISMATCH', { stage: 'normalization', frame: index, recorded, actual: bounds });
    const drift = [...paletteKeys(paletteOf(image))].filter((key) => !anchorColors.has(key));
    if (drift.length > 0) addFailure(failures, 'PALETTE_DRIFT', { stage: 'canonical', frame: index, colors: drift });
    const sourceHash = captured.sha256;
    measurements.sourceHashes.push({ frame: index, sha256: sourceHash });
    const definition = contractedFrames?.[index];
    const approved = verifiedFrameApproval?.document.payload.frames[index];
    let sourceArtifact = typeof recorded?.input === 'string' ? recorded.input : null;
    if (approved) {
      const approvedSource = path.resolve(path.dirname(frameApproval.snapReceipt.path), approved.path);
      if (typeof recorded?.input !== 'string' || path.resolve(recorded.input) !== approvedSource) addFailure(failures, 'METADATA_MISMATCH', { stage: 'normalization-landmark', frame: index, field: 'approved-source' });
      sourceArtifact = approvedSource;
    }
    let sourceBounds = null;
    let sourceScale = null;
    let sourceDimensions = null;
    if (!sourceArtifact) {
      addFailure(failures, 'GLOBAL_SCALE_DRIFT', { stage: 'normalization-provenance', frame: index, reason: 'missing source artifact' });
    } else {
      let source = null;
      if (approved) {
        const captured = await captureRgba(sourceArtifact, { expectedSha256: approved.sha256 });
        if (captured.sha256 !== approved.sha256) {
          addFailure(failures, 'SOURCE_HASH_MISMATCH', { stage: 'normalization-landmark', trustedArtifact: false, frame: index, expected: approved.sha256, actual: captured.sha256 });
        } else {
          source = captured.image;
        }
      } else {
        source = Array.isArray(capturedArtifacts?.sources)
          ? capturedArtifacts.sources[index]?.image ?? null
          : await readRgba(sourceArtifact);
      }
      if (!source) {
        addFailure(failures, 'GLOBAL_SCALE_DRIFT', { stage: 'normalization-provenance', frame: index, reason: 'approved source byte capture did not match its signed hash' });
      } else {
        sourceDimensions = { width: source.width, height: source.height };
        sourceBounds = (await retainedForeground(sourceArtifact, source, config)).bounds;
        const sx = sourceBounds && bounds ? bounds.width / sourceBounds.width : NaN;
        const sy = sourceBounds && bounds ? bounds.height / sourceBounds.height : NaN;
        if (!Number.isInteger(sx) || sx < 1 || sx !== sy) addFailure(failures, 'GLOBAL_SCALE_DRIFT', { stage: 'normalization-artifacts', frame: index, source: sourceBounds, output: bounds });
        else {
          sourceScale = sx;
          derivedScales.push(sx);
        }
      }
    }
    if (definition) {
      const complete = recorded && typeof recorded.frameId === 'string' && validSourceLandmark(recorded.sourceLandmark) && validCanonicalLandmark(recorded.canonicalLandmark, canonical) && validCoordinate(recorded.landmarkDrift);
      if (!complete || recorded.frameId !== definition.id) addFailure(failures, 'METADATA_MISMATCH', { stage: 'normalization-landmark', frame: index, field: 'ordered-frame', expected: definition.id, actual: recorded?.frameId ?? null });
      if (approved) {
        if (!complete || approved.id !== definition.id || !sameCoordinate(recorded.sourceLandmark, approved.landmark)) addFailure(failures, 'METADATA_MISMATCH', { stage: 'normalization-landmark', frame: index, field: 'sourceLandmark', expected: approved.landmark, actual: recorded?.sourceLandmark ?? null });
        const sourceContained = sourceDimensions && approved.landmark.x < sourceDimensions.width && approved.landmark.y < sourceDimensions.height;
        if (!sourceContained) addFailure(failures, 'METADATA_MISMATCH', { stage: 'normalization-landmark', frame: index, field: 'sourceLandmarkContainment', landmark: approved.landmark, sourceDimensions });
        if (sourceScale && sourceContained) {
          const canonicalLandmark = { x: bounds.left + (approved.landmark.x - sourceBounds.left) * sourceScale, y: bounds.top + (approved.landmark.y - sourceBounds.top) * sourceScale };
          const target = definition.landmarkSemantic.target;
          const actual = { x: canonicalLandmark.x - target.x, y: canonicalLandmark.y - target.y };
          if (actual.x !== 0 || actual.y !== 0) addFailure(failures, 'LANDMARK_DRIFT', { stage: 'canonical', frame: index, frameId: definition.id, expected: { x: 0, y: 0 }, actual });
          if (!complete || !sameCoordinate(recorded.canonicalLandmark, canonicalLandmark) || !sameCoordinate(recorded.landmarkDrift, actual)) addFailure(failures, 'METADATA_MISMATCH', { stage: 'normalization-landmark', frame: index, field: 'derived-landmark', canonicalLandmark, landmarkDrift: actual });
        }
      }
    }
  }
  measurements.normalizedScales = [...derivedScales];
  const scales = new Set(derivedScales);
  if (scales.size > 1) addFailure(failures, 'GLOBAL_SCALE_DRIFT', { stage: 'normalization-artifacts', scales: [...scales] });

  const runtimeImages = [];
  for (let index = 0; index < exported.runtimeFrames.length; index += 1) {
    const file = exported.runtimeFrames[index];
    const captured = capturedArtifacts?.runtime?.[index] ?? await captureImage(file);
    const image = captured.image;
    runtimeImages.push(image);
    if (image.width !== runtime.width || image.height !== runtime.height) addFailure(failures, 'CANVAS_SIZE', { stage: 'runtime', frame: index, expected: [runtime.width, runtime.height], actual: [image.width, image.height] });
    failures.push(...validateIntegerScale({ source: canonical, output: { width: image.width, height: image.height } }).map((failure) => ({ ...failure, frame: index })));
    const bounds = alphaBounds(image);
    if (runtimeScale && bounds && bounds.bottom !== config.pivot.y * runtimeScale - 1) addFailure(failures, 'BASELINE_DRIFT', { stage: 'runtime', frame: index, expected: config.pivot.y * runtimeScale - 1, actual: bounds.bottom });
    if (bounds && (bounds.left < margin * (runtimeScale ?? 1) || bounds.top < margin * (runtimeScale ?? 1) || bounds.right >= image.width - margin * (runtimeScale ?? 1) || bounds.bottom >= image.height - margin * (runtimeScale ?? 1))) addFailure(failures, 'CLIPPED_FOREGROUND', { stage: 'runtime', frame: index, margin: margin * (runtimeScale ?? 1), bounds });
    const background = backgroundEvidence(image, config);
    if (background.opaqueBorderPixels > 0 || background.configuredColorPixels > 0) addFailure(failures, 'BACKGROUND_REMAINS', { frame: index, ...background });
    const runtimeColors = paletteKeys(paletteOf(image));
    const sourceColors = paletteKeys(paletteOf(normalizedImages[index] ?? { data: Buffer.alloc(0) }));
    const intermediate = [...runtimeColors].filter((key) => !sourceColors.has(key));
    if (intermediate.length > 0 || (runtimeScale && normalizedImages[index] && !blockMatches(normalizedImages[index], image, runtimeScale))) addFailure(failures, 'INTERMEDIATE_COLORS', { frame: index, colors: intermediate, nearestNeighborBlocks: false });
    const paletteDrift = [...runtimeColors].filter((key) => !anchorColors.has(key));
    if (paletteDrift.length > 0) addFailure(failures, 'PALETTE_DRIFT', { stage: 'runtime', frame: index, colors: paletteDrift });
  }

  const metadata = capturedArtifacts?.metadata?.document ?? JSON.parse(await fs.readFile(exported.metadata, 'utf8'));
  measurements.metadataFrames = Array.isArray(metadata.frames) ? metadata.frames.length : null;
  if (!Array.isArray(metadata.frames) || metadata.frames.length !== exported.runtimeFrames.length || !Array.isArray(metadata.sources) || metadata.sources.length !== normalized.frames.length) addFailure(failures, 'FRAME_COUNT', { stage: 'metadata', trustedArtifact: normalized.frames.length === exported.runtimeFrames.length, expected: normalized.frames.length, actual: metadata.frames?.length ?? null });
  if (metadata.canonicalPivot?.x !== config.pivot.x || metadata.canonicalPivot?.y !== config.pivot.y) addFailure(failures, 'PIVOT_DRIFT', { stage: 'metadata-canonical', expected: config.pivot, actual: metadata.canonicalPivot });
  if (runtimeScale && (metadata.pivot?.x !== config.pivot.x * runtimeScale || metadata.pivot?.y !== config.pivot.y * runtimeScale)) addFailure(failures, 'PIVOT_DRIFT', { stage: 'metadata', expected: { x: config.pivot.x * runtimeScale, y: config.pivot.y * runtimeScale }, actual: metadata.pivot });
  if (metadata.frameSize?.width !== runtime.width || metadata.frameSize?.height !== runtime.height) addFailure(failures, 'METADATA_MISMATCH', { field: 'frameSize', expected: runtime, actual: metadata.frameSize });
  if (metadata.sheet !== path.basename(exported.sheet) || metadata.preview !== path.basename(exported.preview)) addFailure(failures, 'METADATA_MISMATCH', { field: 'artifactNames', expected: { sheet: path.basename(exported.sheet), preview: path.basename(exported.preview) }, actual: { sheet: metadata.sheet, preview: metadata.preview } });
  if (!Array.isArray(metadata.durations) || metadata.durations.length !== normalized.frames.length || metadata.durations.some((duration) => !Number.isInteger(duration) || duration < 11 || duration > 65535)) addFailure(failures, 'TIMING_MISMATCH', { field: 'durations', actual: metadata.durations });
  if (!samePaletteCounts(metadata.palette?.colors, paletteCounts(normalizedImages))) addFailure(failures, 'METADATA_MISMATCH', { field: 'palette' });
  if (!jsonEqual(relevantConfig(metadata.config ?? {}), relevantConfig(config))) addFailure(failures, 'METADATA_MISMATCH', { field: 'config', expected: relevantConfig(config), actual: relevantConfig(metadata.config ?? {}) });
  for (let index = 0; index < normalized.frames.length; index += 1) {
    if (metadata.sources?.[index]?.sha256 !== measurements.sourceHashes[index].sha256) addFailure(failures, 'SOURCE_HASH_MISMATCH', { stage: 'metadata', trustedArtifact: false, frame: index, expected: metadata.sources?.[index]?.sha256, actual: measurements.sourceHashes[index].sha256 });
    if (metadata.frames?.[index]?.duration !== metadata.durations?.[index]) addFailure(failures, 'TIMING_MISMATCH', { frame: index, frameDuration: metadata.frames?.[index]?.duration, duration: metadata.durations?.[index] });
    const frame = metadata.frames?.[index];
    const expectedX = Number.isInteger(metadata.columns) ? (index % metadata.columns) * runtime.width : null;
    const expectedY = Number.isInteger(metadata.columns) ? Math.floor(index / metadata.columns) * runtime.height : null;
    if (frame && (frame.width !== runtime.width || frame.height !== runtime.height || frame.index !== index || frame.x !== expectedX || frame.y !== expectedY || frame.file !== path.basename(exported.runtimeFrames[index]))) addFailure(failures, 'METADATA_MISMATCH', { field: 'frames', frame: index });
  }

  const expectedRows = Number.isInteger(metadata.columns) && metadata.columns > 0 ? Math.ceil(exported.runtimeFrames.length / metadata.columns) : null;
  if (!Number.isInteger(metadata.columns) || metadata.columns < 1 || metadata.rows !== expectedRows) addFailure(failures, 'METADATA_MISMATCH', { field: 'sheetGeometry', columns: metadata.columns, rows: metadata.rows, expectedRows });
  const sheet = (capturedArtifacts?.sheet ?? await captureImage(exported.sheet)).image;
  if (!expectedRows || !sheetMatches(sheet, runtimeImages, metadata.columns, expectedRows, runtime)) addFailure(failures, 'FRAME_BLEED', { expected: expectedRows ? [metadata.columns * runtime.width, expectedRows * runtime.height] : null, actual: [sheet.width, sheet.height] });

  const { data: previewData, info: previewInfo, metadata: preview } = (capturedArtifacts?.preview ?? await capturePreview(exported.preview)).decoded;
  measurements.previewPages = preview.pages ?? 1;
  measurements.previewDelays = preview.delay ?? [];
  if ((preview.pages ?? 1) !== exported.runtimeFrames.length) addFailure(failures, 'PREVIEW_MISMATCH', { field: 'pages', expected: exported.runtimeFrames.length, actual: preview.pages ?? 1 });
  const previewPageHeight = preview.pageHeight ?? preview.height;
  if (preview.width !== runtime.width || previewPageHeight !== runtime.height) addFailure(failures, 'PREVIEW_MISMATCH', { field: 'dimensions', expected: runtime, actual: { width: preview.width, height: previewPageHeight } });
  if ((preview.pages ?? 1) > 1 && JSON.stringify(preview.delay ?? []) !== JSON.stringify(metadata.durations ?? [])) addFailure(failures, 'PREVIEW_MISMATCH', { field: 'delays', expected: metadata.durations, actual: preview.delay });
  const previewPages = previewInfo.pages ?? 1;
  const decodedPageHeight = previewInfo.pageHeight ?? previewInfo.height / previewPages;
  measurements.previewHashes = [];
  for (let index = 0; index < Math.min(previewPages, runtimeImages.length); index += 1) {
    const bytes = previewInfo.width * decodedPageHeight * 4;
    const page = previewData.subarray(index * bytes, (index + 1) * bytes);
    const expected = runtimeImages[index].data;
    const actualHash = rawHash(page);
    const expectedHash = rawHash(expected);
    measurements.previewHashes.push({ frame: index, actual: actualHash, expected: expectedHash });
    if (!page.equals(expected)) addFailure(failures, 'PREVIEW_MISMATCH', { field: 'pixels', frame: index, expectedHash, actualHash });
  }

  for (const code of SEMANTIC_CODES) {
    const evidence = semanticEvidence.find((item) => item.code === code);
    if (validSemanticEvidence(evidence)) addFailure(failures, code, { frame: evidence.frame, evidence: evidence.evidence });
    else warnings.push({ code: 'HUMAN_REVIEW_REQUIRED', check: code, reason: 'artistic or semantic judgment requires explicit evidence' });
  }
  if (animationContract) {
    for (const clip of animationContract.document.clips) {
      if (clip?.loopMode !== 'loop') continue;
      if (!loopApprovedByFrameManifest(verifiedFrameApproval, clip)) warnings.push({ code: 'HUMAN_REVIEW_REQUIRED', check: 'LOOP_ROOT_TRANSITION', clipId: clip.id, transition: clip.loopTransition, reason: 'the declared last-to-first root transition requires an authenticated frame approval at its review checkpoint' });
    }
  }
  const classified = classifyFailures({ failures });
  return { passed: classified.length === 0, failures: classified, warnings, measurements };
}

export async function validateRun(request, options = {}) {
  if (!request || typeof request !== 'object') throw new Error('validation request is required');
  if (request.animationContract?.document?.version === 2) return validateContractExportRunV2(request, options);
  return request.exported?.clips !== undefined
    ? validateContractExportRun(request, options)
    : validateFlatRun(request);
}
