import crypto from 'node:crypto';
import sharp from 'sharp';

import { canonicalJson } from './schema.mjs';
import { validatePoseBoardContract } from './pose-board-contract.mjs';

const NEIGHBORS_4 = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1]
];

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function byteTuple(data, offset) {
  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
}

function sameWithinTolerance(left, right, tolerance) {
  return left.every((channel, index) => Math.abs(channel - right[index]) <= tolerance);
}

function chromaSpillChannel(backgroundRgba, spill) {
  if (!spill) return null;
  const rgb = backgroundRgba.slice(0, 3);
  const maximum = Math.max(...rgb);
  const channels = rgb.flatMap((value, index) => value === maximum ? [index] : []);
  if (channels.length !== 1) {
    throw new Error('pose-board chroma spill requires one uniquely dominant background channel');
  }
  return channels[0];
}

function isBackgroundPixel(pixel, backgroundRgba, selected, spillChannel) {
  if (sameWithinTolerance(pixel, backgroundRgba, selected.background.tolerance)) {
    return true;
  }
  if (spillChannel === null) return false;
  if (Math.abs(pixel[3] - backgroundRgba[3]) > selected.background.tolerance) {
    return false;
  }
  const competing = pixel
    .slice(0, 3)
    .filter((_, index) => index !== spillChannel);
  return pixel[spillChannel] - Math.max(...competing) >=
    selected.background.spill.minimumDominance;
}

function dominantBorder(data, width, height) {
  const counts = new Map();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x !== 0 && x !== width - 1 && y !== 0 && y !== height - 1) continue;
      const offset = ((y * width) + x) * 4;
      const rgba = byteTuple(data, offset);
      const key = rgba.join(',');
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { count: 1, rgba });
    }
  }
  return [...counts.values()].reduce((best, item) => (
    !best || item.count > best.count ? item : best
  )).rgba;
}

function boundsForPixels(pixels) {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const { x, y } of pixels) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return {
    left,
    top,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1
  };
}

function componentDocument(id, pixels) {
  const ordered = pixels.sort((left, right) => (left.y - right.y) || (left.x - right.x));
  const bounds = boundsForPixels(ordered);
  const sum = ordered.reduce(
    (result, pixel) => ({ x: result.x + pixel.x, y: result.y + pixel.y }),
    { x: 0, y: 0 }
  );
  const document = {
    id,
    pixelCount: ordered.length,
    bounds,
    centroid: {
      x: sum.x / ordered.length,
      y: sum.y / ordered.length
    },
    pixelSha256: sha256Bytes(Buffer.from(canonicalJson(ordered)))
  };
  Object.defineProperty(document, 'pixels', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: ordered
  });
  return document;
}

function connectedComponents(mask, data, width, height) {
  const visited = Buffer.alloc(mask.length);
  const found = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] === 1) continue;
    visited[start] = 1;
    const queue = [start];
    const pixels = [];

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor];
      const x = index % width;
      const y = Math.floor(index / width);
      pixels.push({ x, y, rgba: byteTuple(data, index * 4) });

      for (const [dx, dy] of NEIGHBORS_4) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
        const next = (nextY * width) + nextX;
        if (mask[next] === 0 || visited[next] === 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    found.push(pixels);
  }
  return found;
}

function combinedCandidate(id, components) {
  const pixels = components.flatMap((component) => component.pixels);
  const bounds = boundsForPixels(pixels);
  const pixelCount = components.reduce((sum, component) => sum + component.pixelCount, 0);
  const centroid = components.reduce(
    (sum, component) => ({
      x: sum.x + (component.centroid.x * component.pixelCount),
      y: sum.y + (component.centroid.y * component.pixelCount)
    }),
    { x: 0, y: 0 }
  );
  return {
    id,
    componentIds: components.map(({ id: componentId }) => componentId),
    pixelCount,
    bounds,
    centroid: {
      x: centroid.x / pixelCount,
      y: centroid.y / pixelCount
    }
  };
}

function rowMajorCandidates(candidates) {
  const pending = [...candidates].sort((left, right) => (
    (left.bounds.top - right.bounds.top) ||
    (left.centroid.y - right.centroid.y) ||
    left.id.localeCompare(right.id)
  ));
  const rows = [];

  for (const candidate of pending) {
    const row = rows.find((item) => (
      candidate.bounds.top <= item.bottom && candidate.bounds.bottom >= item.top
    ));
    if (row) {
      row.candidates.push(candidate);
      row.top = Math.min(row.top, candidate.bounds.top);
      row.bottom = Math.max(row.bottom, candidate.bounds.bottom);
    } else {
      rows.push({
        top: candidate.bounds.top,
        bottom: candidate.bounds.bottom,
        candidates: [candidate]
      });
    }
  }

  return rows.flatMap((row) => row.candidates.sort((left, right) => (
    (left.centroid.x - right.centroid.x) ||
    (left.centroid.y - right.centroid.y) ||
    left.id.localeCompare(right.id)
  )));
}

function buildCandidates(components, groups) {
  const byId = new Map(components.map((component) => [component.id, component]));
  const grouped = new Set();
  const candidates = [];
  const usedCandidateIds = new Set(groups.map(({ id }) => id));

  for (const group of groups) {
    const selected = group.componentIds.map((componentId) => {
      const component = byId.get(componentId);
      if (!component) throw new Error(`pose-board group references unknown component ID: ${componentId}`);
      grouped.add(componentId);
      return component;
    });
    candidates.push(combinedCandidate(group.id, selected));
  }

  let sequence = 1;
  for (const component of components) {
    if (grouped.has(component.id)) continue;
    let candidateId;
    do {
      candidateId = `candidate-${String(sequence).padStart(4, '0')}`;
      sequence += 1;
    } while (usedCandidateIds.has(candidateId));
    usedCandidateIds.add(candidateId);
    candidates.push(combinedCandidate(candidateId, [component]));
  }
  return rowMajorCandidates(candidates);
}

export async function analyzePoseBoard({ bytes, contract }) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error('pose-board source bytes must be a byte buffer');
  }
  const selected = validatePoseBoardContract(contract);
  const snapshot = Buffer.from(bytes);
  const { data, info } = await sharp(snapshot, { limitInputPixels: 268435456 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (data.length > selected.maxDecodedRgbaBytes) {
    throw new Error('pose-board decoded RGBA exceeds the configured byte limit');
  }

  const backgroundRgba = selected.background.mode === 'color'
    ? [...selected.background.rgba]
    : dominantBorder(data, info.width, info.height);
  const spillChannel = chromaSpillChannel(
    backgroundRgba,
    selected.background.spill
  );
  const mask = Buffer.alloc(info.width * info.height);
  for (let index = 0; index < mask.length; index += 1) {
    const pixel = byteTuple(data, index * 4);
    mask[index] = isBackgroundPixel(
      pixel,
      backgroundRgba,
      selected,
      spillChannel
    ) ? 0 : 1;
  }

  const found = connectedComponents(mask, data, info.width, info.height);
  const eligiblePixels = found.filter((pixels) => pixels.length >= selected.minimumComponentPixels);
  const noisePixels = found.filter((pixels) => pixels.length < selected.minimumComponentPixels);
  const components = eligiblePixels.map((pixels, index) => (
    componentDocument(`component-${String(index + 1).padStart(4, '0')}`, pixels)
  ));
  const ignoredNoise = noisePixels.map((pixels, index) => (
    componentDocument(`noise-${String(index + 1).padStart(4, '0')}`, pixels)
  ));
  const candidates = buildCandidates(components, selected.groups);
  if (
    candidates.length < selected.expectedCandidates.min ||
    candidates.length > selected.expectedCandidates.max
  ) {
    throw new Error(
      `pose-board candidate count ${candidates.length} is outside configured range ` +
      `${selected.expectedCandidates.min}-${selected.expectedCandidates.max}`
    );
  }

  const analysis = {
    schemaVersion: 1,
    width: info.width,
    height: info.height,
    sourceSha256: sha256Bytes(snapshot),
    contractSha256: sha256Bytes(Buffer.from(canonicalJson(selected))),
    background: {
      mode: selected.background.mode,
      rgba: backgroundRgba,
      tolerance: selected.background.tolerance,
      spill: spillChannel === null
        ? null
        : {
          channel: ['red', 'green', 'blue'][spillChannel],
          minimumDominance: selected.background.spill.minimumDominance
        }
    },
    connectivity: selected.connectivity,
    minimumComponentPixels: selected.minimumComponentPixels,
    maskSha256: sha256Bytes(mask),
    components,
    ignoredNoise,
    candidates,
    proposedOrder: candidates.map(({ id }) => id)
  };
  Object.defineProperties(analysis, {
    sourceRgba: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Buffer.from(data)
    },
    foregroundMask: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Buffer.from(mask)
    },
    contract: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: selected
    }
  });
  return analysis;
}

export async function renderRecoveredCandidate({ analysis, componentIds }) {
  if (!analysis?.sourceRgba || !analysis?.contract || !Array.isArray(analysis.components)) {
    throw new Error('pose-board analysis is invalid or missing captured source pixels');
  }
  if (!Array.isArray(componentIds) || componentIds.length === 0) {
    throw new Error('pose-board candidate component IDs must be a non-empty list');
  }
  if (new Set(componentIds).size !== componentIds.length) {
    throw new Error('pose-board candidate component IDs must be unique');
  }
  const byId = new Map(analysis.components.map((component) => [component.id, component]));
  const selected = componentIds.map((componentId) => {
    const component = byId.get(componentId);
    if (!component) throw new Error(`pose-board candidate references unknown component ID: ${componentId}`);
    return component;
  });
  const pixels = selected.flatMap((component) => component.pixels);
  const sourceBounds = boundsForPixels(pixels);
  const padding = analysis.contract.padding;
  const width = sourceBounds.width + (padding * 2);
  const height = sourceBounds.height + (padding * 2);
  const output = Buffer.alloc(width * height * 4);

  for (const { x, y } of pixels) {
    const sourceOffset = ((y * analysis.width) + x) * 4;
    const outputX = x - sourceBounds.left + padding;
    const outputY = y - sourceBounds.top + padding;
    const outputOffset = ((outputY * width) + outputX) * 4;
    analysis.sourceRgba.copy(output, outputOffset, sourceOffset, sourceOffset + 4);
  }

  const bytes = await sharp(output, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  return {
    bytes,
    width,
    height,
    placement: {
      sourceBounds,
      outputOffset: { x: padding, y: padding }
    },
    componentIds: [...componentIds],
    sha256: sha256Bytes(bytes)
  };
}
