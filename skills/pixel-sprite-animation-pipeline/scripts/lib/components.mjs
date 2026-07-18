import { readRgba } from './image.mjs';

function componentBounds(component) {
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  for (const [x, y] of component) {
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

const RETENTION_POLICIES = new Set(['all', 'largest', 'reject-multiple']);

function rgbaAt(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return {
    r: image.data[offset],
    g: image.data[offset + 1],
    b: image.data[offset + 2],
    a: image.data[offset + 3]
  };
}

function normalizedColor(color) {
  if (!color) return null;
  const result = { r: color.r, g: color.g, b: color.b };
  if (color.a !== undefined || color.alpha !== undefined) result.a = color.a ?? color.alpha;
  return result;
}

function matchesBackground(pixel, background, tolerance) {
  if (background.a === 0 && pixel.a === 0) return true;
  const channels = background.a === undefined ? ['r', 'g', 'b'] : ['r', 'g', 'b', 'a'];
  return channels.every((channel) => Math.abs(pixel[channel] - background[channel]) <= tolerance);
}

export function dominantBorderColor(image) {
  const counts = new Map();
  const visit = (x, y) => {
    const color = rgbaAt(image, x, y);
    const key = `${color.r},${color.g},${color.b},${color.a}`;
    const entry = counts.get(key) ?? { color, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  };
  for (let x = 0; x < image.width; x += 1) {
    visit(x, 0);
    if (image.height > 1) visit(x, image.height - 1);
  }
  for (let y = 1; y < image.height - 1; y += 1) {
    visit(0, y);
    if (image.width > 1) visit(image.width - 1, y);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.color ?? null;
}

export function foregroundPredicate(image, { color, tolerance = 0 } = {}) {
  const background = normalizedColor(color) ?? dominantBorderColor(image);
  if (!background) return () => false;
  return (x, y) => !matchesBackground(rgbaAt(image, x, y), background, tolerance);
}

export function connectedComponents(image, isForeground) {
  const seen = new Uint8Array(image.width * image.height);
  const components = [];

  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    const start = y * image.width + x;
    if (seen[start] || !isForeground(x, y)) continue;

    const pending = [[x, y]];
    const pixels = [];
    seen[start] = 1;
    while (pending.length > 0) {
      const [currentX, currentY] = pending.pop();
      pixels.push([currentX, currentY]);
      for (const [nextX, nextY] of [
        [currentX - 1, currentY],
        [currentX + 1, currentY],
        [currentX, currentY - 1],
        [currentX, currentY + 1]
      ]) {
        if (nextX < 0 || nextY < 0 || nextX >= image.width || nextY >= image.height) continue;
        const next = nextY * image.width + nextX;
        if (!seen[next] && isForeground(nextX, nextY)) {
          seen[next] = 1;
          pending.push([nextX, nextY]);
        }
      }
    }
    components.push(pixels);
  }

  return components.sort((a, b) => b.length - a.length);
}

export async function extractPrimaryComponent(file, options = {}) {
  const image = options.image ?? await readRgba(file);
  const alphaThreshold = options.alphaThreshold ?? 0;
  const isForeground = options.isForeground ?? ((x, y) => (
    image.data[(y * image.width + x) * 4 + 3] > alphaThreshold
  ));
  const components = connectedComponents(image, isForeground);
  if (components.length === 0) throw new Error(`frame ${file} contains no foreground`);

  const minimumComponentPixels = options.minimumComponentPixels ?? 1;
  if (!Number.isInteger(minimumComponentPixels) || minimumComponentPixels < 1) {
    throw new Error('minimumComponentPixels must be a positive integer');
  }
  const retentionPolicy = options.retentionPolicy ?? 'all';
  if (!RETENTION_POLICIES.has(retentionPolicy)) {
    throw new Error(`retentionPolicy must be one of: ${[...RETENTION_POLICIES].join(', ')}`);
  }
  const eligible = components.filter((component) => component.length >= minimumComponentPixels);
  if (eligible.length === 0) {
    throw new Error(`frame ${file} contains no foreground component of at least ${minimumComponentPixels} pixels`);
  }
  if (retentionPolicy === 'reject-multiple' && eligible.length > 1) {
    throw new Error(`frame ${file} contains ${eligible.length} foreground components`);
  }
  const retainedComponents = retentionPolicy === 'largest' ? eligible.slice(0, 1) : eligible;
  const retainedPixels = retainedComponents.flat();
  const bounds = componentBounds(retainedPixels);
  const extracted = {
    data: Buffer.alloc(bounds.width * bounds.height * 4),
    width: bounds.width,
    height: bounds.height,
    channels: 4
  };
  for (const [x, y] of retainedPixels) {
    const sourceOffset = (y * image.width + x) * 4;
    const targetOffset = ((y - bounds.top) * bounds.width + x - bounds.left) * 4;
    image.data.copy(extracted.data, targetOffset, sourceOffset, sourceOffset + 4);
  }

  return {
    image: extracted,
    bounds,
    components,
    primary: retainedComponents[0],
    retainedComponents,
    componentCount: components.length,
    retainedComponentCount: retainedComponents.length,
    retainedPixelCount: retainedPixels.length,
    pixelCount: retainedPixels.length,
    retentionPolicy,
    minimumComponentPixels
  };
}
