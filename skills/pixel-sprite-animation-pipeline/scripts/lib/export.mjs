import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { paletteOf, readRgba, sha256 } from './image.mjs';

const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

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

async function validateExport({ frames, outputDir, config, columns, durations, name }) {
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
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ||
    name === '.' || name === '..' ||
    WINDOWS_RESERVED_STEM.test(name)
  ) {
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

  for (const frame of frames) {
    if (typeof frame !== 'string' || frame.trim() === '') {
      throw new Error('each frame must be a nonempty path');
    }
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

  const sources = [];
  const framePalettes = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const image = await readRgba(frame);
    if (image.width !== config.canonical.width || image.height !== config.canonical.height) {
      throw new Error(`frame ${frame} must be ${config.canonical.width}x${config.canonical.height}`);
    }
    sources.push({
      index,
      id: `source-${String(index).padStart(digits, '0')}`,
      sha256: await sha256(frame)
    });
    framePalettes.push(paletteOf(image));
  }

  return {
    resolvedOutput,
    digits,
    runtimeScale: scaleX,
    sources,
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

export async function exportAnimation({ frames, outputDir, config, columns, durations, name }) {
  const {
    resolvedOutput,
    digits,
    runtimeScale,
    sources,
    palette,
    configSnapshot
  } = await validateExport({
    frames, outputDir, config, columns, durations, name
  });
  const parent = path.dirname(resolvedOutput);
  await fs.mkdir(parent, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(parent, '.sprite-export-stage-'));

  try {
    const runtimeFrames = [];
    for (let index = 0; index < frames.length; index += 1) {
      const output = path.join(stagingDir, `${name}-${String(index).padStart(digits, '0')}.png`);
      await sharp(frames[index])
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
