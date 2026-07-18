import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import sharp from 'sharp';

export async function readRgba(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

export async function writeRgba(file, image) {
  await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }).png().toFile(file);
}

export async function sha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

export function colorAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return { r: image.data[i], g: image.data[i + 1], b: image.data[i + 2], a: image.data[i + 3] };
}

export function sameColor(a, b, tolerance = 0) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b), Math.abs(a.a - b.a)) <= tolerance;
}

export function paletteOf(image) {
  const values = new Map();
  for (let i = 0; i < image.data.length; i += 4) {
    const key = `${image.data[i]},${image.data[i + 1]},${image.data[i + 2]},${image.data[i + 3]}`;
    values.set(key, (values.get(key) ?? 0) + 1);
  }
  return [...values].map(([rgba, count]) => ({ rgba: rgba.split(',').map(Number), count })).sort((a, b) => b.count - a.count);
}

export function foregroundBounds(image, background, tolerance = 0) {
  let left = image.width, top = image.height, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    if (!sameColor(colorAt(image, x, y), background, tolerance)) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1, right, bottom };
}
