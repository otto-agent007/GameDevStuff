import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { extractApngSubframes, inspectApng } from './apng-container.mjs';
import { copyImmutable, writeImmutableBytes } from './artifacts.mjs';
import { inspectGif } from './gif-container.mjs';
import { inspectAnimatedWebp } from './webp-container.mjs';

const MAX_DECODED_RGBA = 512 * 1024 * 1024;

function identify(bytes) {
  if (bytes.subarray(0, 6).toString('ascii').startsWith('GIF8')) return { kind: 'gif', extension: 'gif', inspect: inspectGif };
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { kind: 'apng', extension: 'png', inspect: inspectApng };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { kind: 'webp', extension: 'webp', inspect: inspectAnimatedWebp };
  }
  throw new Error('animated image source format is unsupported');
}

function rgbaHash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertDecodeBound(inspection) {
  const decodedBytes = inspection.canvas.width * inspection.canvas.height * 4 * inspection.frames.length;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_DECODED_RGBA) {
    throw new Error('animated image exceeds the 512 MiB decoded RGBA limit');
  }
}

async function decodeSharpPages(bytes, inspection) {
  const { data, info } = await sharp(bytes, { animated: true, pages: -1, limitInputPixels: 268435456 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pageHeight = info.pageHeight ?? (info.pages === 1 ? info.height : null);
  if (
    info.pages !== inspection.frames.length ||
    info.width !== inspection.canvas.width ||
    pageHeight !== inspection.canvas.height ||
    info.height !== inspection.canvas.height * inspection.frames.length ||
    info.channels !== 4 ||
    data.length !== inspection.canvas.width * inspection.canvas.height * 4 * inspection.frames.length
  ) throw new Error('animated image decoder page-count or canvas mismatch');
  const pageBytes = inspection.canvas.width * inspection.canvas.height * 4;
  return Array.from({ length: inspection.frames.length }, (_, index) => Buffer.from(data.subarray(index * pageBytes, (index + 1) * pageBytes)));
}

function alphaOver(destination, destinationOffset, source, sourceOffset) {
  const sourceAlpha = source[sourceOffset + 3];
  if (sourceAlpha === 255) {
    source.copy(destination, destinationOffset, sourceOffset, sourceOffset + 4);
    return;
  }
  if (sourceAlpha === 0) return;
  const destinationAlpha = destination[destinationOffset + 3];
  const inverseSource = 255 - sourceAlpha;
  const outputAlphaNumerator = sourceAlpha * 255 + destinationAlpha * inverseSource;
  const outputAlpha = Math.round(outputAlphaNumerator / 255);
  for (let channel = 0; channel < 3; channel += 1) {
    const premultiplied = source[sourceOffset + channel] * sourceAlpha * 255 +
      destination[destinationOffset + channel] * destinationAlpha * inverseSource;
    destination[destinationOffset + channel] = Math.round(premultiplied / outputAlphaNumerator);
  }
  destination[destinationOffset + 3] = outputAlpha;
}

async function decodeApngPages(bytes, inspection) {
  const extracted = extractApngSubframes(bytes);
  if (JSON.stringify(extracted.inspection) !== JSON.stringify(inspection)) throw new Error('APNG parser result changed during decode');
  const { width, height } = inspection.canvas;
  let canvas = Buffer.alloc(width * height * 4);
  const pages = [];
  for (const [index, frame] of inspection.frames.entries()) {
    const before = frame.dispose === 'previous' ? Buffer.from(canvas) : null;
    const { data, info } = await sharp(extracted.pages[index], { limitInputPixels: 268435456 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== frame.rect.width || info.height !== frame.rect.height || info.channels !== 4) {
      throw new Error('APNG decoded subframe dimensions do not match fcTL');
    }
    for (let y = 0; y < frame.rect.height; y += 1) {
      for (let x = 0; x < frame.rect.width; x += 1) {
        const sourceOffset = (y * frame.rect.width + x) * 4;
        const destinationOffset = ((frame.rect.y + y) * width + frame.rect.x + x) * 4;
        if (frame.blend === 'source') data.copy(canvas, destinationOffset, sourceOffset, sourceOffset + 4);
        else alphaOver(canvas, destinationOffset, data, sourceOffset);
      }
    }
    pages.push(Buffer.from(canvas));
    if (frame.dispose === 'background') {
      for (let y = 0; y < frame.rect.height; y += 1) {
        const start = ((frame.rect.y + y) * width + frame.rect.x) * 4;
        canvas.fill(0, start, start + frame.rect.width * 4);
      }
    } else if (frame.dispose === 'previous') {
      canvas = before;
    }
  }
  return pages;
}

function pageState(page) {
  let alpha = false;
  let empty = true;
  for (let offset = 3; offset < page.length; offset += 4) {
    if (page[offset] < 255) alpha = true;
    if (page[offset] !== 0) empty = false;
  }
  return { alpha, empty };
}

export async function decodeAnimatedImage({ source, run }) {
  if (!source) throw new Error('animated image intake requires a source file');
  const copied = await copyImmutable({
    source: path.resolve(source),
    root: run.root,
    relative: 'source/animated/original.bin'
  });
  const bytes = await fs.readFile(copied.path);
  const selected = identify(bytes);
  if (run?.document?.sourceRequest?.kind !== selected.kind) throw new Error('animated image format does not match the immutable run request');
  const inspection = selected.inspect(bytes);
  assertDecodeBound(inspection);
  const pages = selected.kind === 'apng'
    ? await decodeApngPages(bytes, inspection)
    : await decodeSharpPages(bytes, inspection);

  const diagnostics = [];
  const firstByHash = new Map();
  let timestampMs = 0;
  let alpha = false;
  const frames = [];
  for (const [index, page] of pages.entries()) {
    const metadata = inspection.frames[index];
    const id = `frame-${String(index + 1).padStart(4, '0')}`;
    const state = pageState(page);
    alpha ||= state.alpha;
    const hash = rgbaHash(page);
    const duplicateOf = firstByHash.get(hash) ?? null;
    if (duplicateOf === null) firstByHash.set(hash, id);
    else diagnostics.push({ code: 'DUPLICATE_FRAME', frameId: id });
    if (state.empty) diagnostics.push({ code: 'EMPTY_FRAME', frameId: id });
    if (metadata.rect.x !== 0 || metadata.rect.y !== 0 || metadata.rect.width !== inspection.canvas.width || metadata.rect.height !== inspection.canvas.height) {
      diagnostics.push({ code: 'PARTIAL_SOURCE_RECT', frameId: id });
    }
    if (metadata.dispose === 'background') diagnostics.push({ code: 'DISPOSAL_RESTORE_BACKGROUND', frameId: id });
    if (metadata.dispose === 'previous') diagnostics.push({ code: 'DISPOSAL_RESTORE_PREVIOUS', frameId: id });
    const encoded = await sharp(page, { raw: { ...inspection.canvas, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    const output = await writeImmutableBytes({
      root: run.root,
      relative: `work/decoded/${id}.png`,
      bytes: encoded,
      reuse: true
    });
    frames.push({
      index,
      id,
      path: output.relative,
      sha256: output.sha256,
      width: inspection.canvas.width,
      height: inspection.canvas.height,
      timestampMs,
      durationMs: metadata.durationMs,
      sourceRect: metadata.rect,
      duplicateOf
    });
    timestampMs += metadata.durationMs;
  }
  if (alpha) diagnostics.push({ code: 'ALPHA_PRESENT', frameId: null });
  return {
    kind: selected.kind,
    sourceSha256: copied.sha256,
    decoder: {
      name: `${selected.kind}-container-v${inspection.parserVersion}+sharp-rgba`,
      version: `sharp=${sharp.versions.sharp};vips=${sharp.versions.vips}`,
      arguments: selected.kind === 'apng'
        ? ['crc-and-sequence-validated-subframes', 'rgba-source-over-composite']
        : ['animated=true', 'pages=-1', 'ensureAlpha', 'raw']
    },
    canvas: inspection.canvas,
    alpha,
    timeBase: { numerator: 1, denominator: 1000 },
    frames,
    diagnostics,
    approval: null
  };
}
