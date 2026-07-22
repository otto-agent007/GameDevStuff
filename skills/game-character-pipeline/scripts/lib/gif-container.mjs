const MAX_FRAMES = 10000;

function truncated(label) {
  throw new Error(`truncated GIF ${label}`);
}

function skipSubBlocks(bytes, start, label) {
  let offset = start;
  let payloadBytes = 0;
  while (true) {
    if (offset >= bytes.length) truncated(label);
    const length = bytes[offset];
    offset += 1;
    if (length === 0) return { offset, payloadBytes };
    if (offset + length > bytes.length) truncated(label);
    offset += length;
    payloadBytes += length;
  }
}

function tableBytes(packed) {
  return (packed & 0x80) === 0 ? 0 : 3 * (2 ** ((packed & 0x07) + 1));
}

function disposal(value) {
  if (value === 0 || value === 1) return 'none';
  if (value === 2) return 'background';
  if (value === 3) return 'previous';
  throw new Error(`GIF disposal method is unsupported: ${value}`);
}

export function inspectGif(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 13) truncated('header');
  const signature = bytes.subarray(0, 6).toString('ascii');
  if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('GIF signature is invalid');
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (width === 0 || height === 0) throw new Error('GIF canvas dimensions must be positive');
  let offset = 13 + tableBytes(bytes[10]);
  if (offset > bytes.length) truncated('global color table');
  let pending = null;
  const frames = [];
  let trailer = false;

  while (offset < bytes.length) {
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x3b) {
      trailer = true;
      break;
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) truncated('extension label');
      const label = bytes[offset];
      offset += 1;
      if (label === 0xf9) {
        if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0) truncated('graphic control extension');
        const packed = bytes[offset + 1];
        pending = {
          durationMs: bytes.readUInt16LE(offset + 2) * 10,
          dispose: disposal((packed >> 2) & 0x07),
          hasAlpha: (packed & 0x01) !== 0
        };
        offset += 6;
      } else {
        offset = skipSubBlocks(bytes, offset, 'extension').offset;
      }
      continue;
    }
    if (marker !== 0x2c) throw new Error(`GIF block marker is invalid: 0x${marker.toString(16)}`);
    if (offset + 9 > bytes.length) truncated('image descriptor');
    const x = bytes.readUInt16LE(offset);
    const y = bytes.readUInt16LE(offset + 2);
    const frameWidth = bytes.readUInt16LE(offset + 4);
    const frameHeight = bytes.readUInt16LE(offset + 6);
    const packed = bytes[offset + 8];
    offset += 9;
    if (frameWidth === 0 || frameHeight === 0 || x + frameWidth > width || y + frameHeight > height) {
      throw new Error('GIF frame rectangle exceeds the canvas');
    }
    offset += tableBytes(packed);
    if (offset >= bytes.length) truncated('image data');
    const minimumCodeSize = bytes[offset];
    offset += 1;
    if (minimumCodeSize < 2 || minimumCodeSize > 8) throw new Error('GIF LZW minimum code size is invalid');
    const imageData = skipSubBlocks(bytes, offset, 'image data');
    if (imageData.payloadBytes === 0) throw new Error('GIF image data is empty');
    offset = imageData.offset;
    const control = pending ?? { durationMs: 0, dispose: 'none', hasAlpha: false };
    if (control.durationMs === 0) throw new Error('GIF contains a zero frame delay');
    frames.push({
      rect: { x, y, width: frameWidth, height: frameHeight },
      durationMs: control.durationMs,
      dispose: control.dispose,
      blend: 'over',
      hasAlpha: control.hasAlpha
    });
    if (frames.length > MAX_FRAMES) throw new Error(`GIF exceeds ${MAX_FRAMES} frames`);
    pending = null;
  }

  if (!trailer) throw new Error('GIF trailer is missing');
  if (offset !== bytes.length) throw new Error('GIF contains data after the trailer');
  if (frames.length === 0) throw new Error('GIF contains no frames');
  return { format: 'gif', parserVersion: 1, canvas: { width, height }, frames };
}
