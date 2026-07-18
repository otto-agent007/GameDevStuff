import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { extractPrimaryComponent, foregroundPredicate } from './components.mjs';
import { paletteOf, readRgba, sha256 } from './image.mjs';

const CORRECTIONS = Object.freeze({
  CANVAS_SIZE: 'repad',
  NON_INTEGER_SCALE: 'nearest-rescale',
  INTERMEDIATE_COLORS: 'nearest-rescale',
  BACKGROUND_REMAINS: 'rekey',
  PIVOT_DRIFT: 'realign',
  BASELINE_DRIFT: 'realign',
  GLOBAL_SCALE_DRIFT: 'nearest-rescale',
  PALETTE_DRIFT: 'palette-remap-review',
  CLIPPED_FOREGROUND: 'stop-for-regeneration',
  FRAME_BLEED: 'repad',
  TIMING_MISMATCH: 'reexport-metadata',
  METADATA_MISMATCH: 'reexport-metadata',
  PREVIEW_MISMATCH: 'reexport-preview',
  IDENTITY_DRIFT: 'stop-for-regeneration',
  DUPLICATE_POSE: 'stop-for-regeneration',
  LOOP_SEAM: 'timing-or-transition-review'
});

const SEMANTIC_CODES = new Set(['IDENTITY_DRIFT', 'DUPLICATE_POSE', 'LOOP_SEAM']);

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

export async function validateRun({ anchorReport, normalized, exported, config, semanticEvidence = [] }) {
  if (!anchorReport || !normalized || !exported || !config) throw new Error('anchorReport, normalized, exported, and config are required');
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
  if (normalized.canonicalPivot?.x !== config.pivot.x || normalized.canonicalPivot?.y !== config.pivot.y) addFailure(failures, 'PIVOT_DRIFT', { expected: config.pivot, actual: normalized.canonicalPivot });

  if (typeof anchorReport.path !== 'string' || anchorReport.path.trim() === '') throw new Error('anchorReport.path is required for artifact-backed validation');
  const anchorImage = await readRgba(anchorReport.path);
  const actualAnchorHash = await sha256(anchorReport.path);
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
    const image = await readRgba(file);
    normalizedImages.push(image);
    if (image.width !== canonical.width || image.height !== canonical.height) addFailure(failures, 'CANVAS_SIZE', { stage: 'canonical', frame: index, expected: [canonical.width, canonical.height], actual: [image.width, image.height] });
    const bounds = (await retainedForeground(file, image, config, { configuredBackground: false })).bounds;
    const recorded = normalized.measurements?.[index];
    if (bounds && bounds.bottom !== config.pivot.y - 1) addFailure(failures, 'BASELINE_DRIFT', { frame: index, expected: config.pivot.y - 1, actual: bounds.bottom });
    if (bounds && (bounds.left < margin || bounds.top < margin || bounds.right >= image.width - margin || bounds.bottom >= image.height - margin)) addFailure(failures, 'CLIPPED_FOREGROUND', { stage: 'canonical', frame: index, margin, bounds });
    if (recorded && bounds && (recorded.left !== bounds.left || recorded.top !== bounds.top || recorded.width !== bounds.width || recorded.height !== bounds.height)) addFailure(failures, 'METADATA_MISMATCH', { stage: 'normalization', frame: index, recorded, actual: bounds });
    const drift = [...paletteKeys(paletteOf(image))].filter((key) => !anchorColors.has(key));
    if (drift.length > 0) addFailure(failures, 'PALETTE_DRIFT', { stage: 'canonical', frame: index, colors: drift });
    const sourceHash = await sha256(file);
    measurements.sourceHashes.push({ frame: index, sha256: sourceHash });
    if (!recorded || typeof recorded.input !== 'string') {
      addFailure(failures, 'GLOBAL_SCALE_DRIFT', { stage: 'normalization-provenance', frame: index, reason: 'missing source artifact' });
    } else {
      const source = await readRgba(recorded.input);
      const sourceBounds = (await retainedForeground(recorded.input, source, config)).bounds;
      const sx = sourceBounds && bounds ? bounds.width / sourceBounds.width : NaN;
      const sy = sourceBounds && bounds ? bounds.height / sourceBounds.height : NaN;
      if (!Number.isInteger(sx) || sx < 1 || sx !== sy) addFailure(failures, 'GLOBAL_SCALE_DRIFT', { stage: 'normalization-artifacts', frame: index, source: sourceBounds, output: bounds });
      else derivedScales.push(sx);
    }
  }
  measurements.normalizedScales = [...derivedScales];
  const scales = new Set(derivedScales);
  if (scales.size > 1) addFailure(failures, 'GLOBAL_SCALE_DRIFT', { stage: 'normalization-artifacts', scales: [...scales] });

  const runtimeImages = [];
  for (let index = 0; index < exported.runtimeFrames.length; index += 1) {
    const file = exported.runtimeFrames[index];
    const image = await readRgba(file);
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

  const metadata = JSON.parse(await fs.readFile(exported.metadata, 'utf8'));
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
  const sheet = await readRgba(exported.sheet);
  if (!expectedRows || !sheetMatches(sheet, runtimeImages, metadata.columns, expectedRows, runtime)) addFailure(failures, 'FRAME_BLEED', { expected: expectedRows ? [metadata.columns * runtime.width, expectedRows * runtime.height] : null, actual: [sheet.width, sheet.height] });

  const { data: previewData, info: previewInfo } = await sharp(exported.preview, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const preview = await sharp(exported.preview, { animated: true }).metadata();
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
  const classified = classifyFailures({ failures });
  return { passed: classified.length === 0, failures: classified, warnings, measurements };
}
