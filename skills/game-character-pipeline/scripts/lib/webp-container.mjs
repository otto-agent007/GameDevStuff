const MAX_FRAMES = 10000;

function uint24(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function chunks(bytes, start, end, label) {
  const records = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw new Error(`truncated ${label} chunk header`);
    const type = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length & 1);
    if (paddedEnd > end) throw new Error(`truncated ${label} chunk payload`);
    records.push({ type, data: bytes.subarray(dataStart, dataEnd) });
    offset = paddedEnd;
  }
  if (offset !== end) throw new Error(`${label} chunk bounds are invalid`);
  return records;
}

export function inspectAnimatedWebp(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') {
    throw new Error('animated WebP RIFF header is invalid');
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('animated WebP RIFF size is invalid or truncated');
  let canvas = null;
  let animated = false;
  let globalAlpha = false;
  let sawAnimationHeader = false;
  const frames = [];
  for (const chunk of chunks(bytes, 12, bytes.length, 'WebP')) {
    if (chunk.type === 'VP8X') {
      if (canvas || chunk.data.length !== 10) throw new Error('animated WebP VP8X chunk is invalid');
      const flags = chunk.data[0];
      if ((flags & 0xc1) !== 0) throw new Error('animated WebP VP8X reserved bits are set');
      animated = (flags & 0x02) !== 0;
      globalAlpha = (flags & 0x10) !== 0;
      canvas = { width: uint24(chunk.data, 4) + 1, height: uint24(chunk.data, 7) + 1 };
    } else if (chunk.type === 'ANIM') {
      if (!canvas || sawAnimationHeader || chunk.data.length !== 6) throw new Error('animated WebP ANIM chunk is invalid or out of order');
      sawAnimationHeader = true;
    } else if (chunk.type === 'ANMF') {
      if (!canvas || !sawAnimationHeader || chunk.data.length < 24) throw new Error('animated WebP ANMF chunk is invalid or out of order');
      const rect = {
        x: uint24(chunk.data, 0) * 2,
        y: uint24(chunk.data, 3) * 2,
        width: uint24(chunk.data, 6) + 1,
        height: uint24(chunk.data, 9) + 1
      };
      const durationMs = uint24(chunk.data, 12);
      const flags = chunk.data[15];
      if ((flags & 0xfc) !== 0) throw new Error('animated WebP ANMF reserved bits are set');
      if (durationMs === 0) throw new Error('animated WebP contains a zero frame delay');
      if (rect.x + rect.width > canvas.width || rect.y + rect.height > canvas.height) {
        throw new Error('animated WebP frame rectangle exceeds the canvas');
      }
      const payload = chunks(chunk.data, 16, chunk.data.length, 'WebP frame');
      if (!payload.some(({ type }) => type === 'VP8 ' || type === 'VP8L')) throw new Error('animated WebP frame has no image payload');
      const hasAlpha = globalAlpha || payload.some(({ type }) => type === 'ALPH');
      frames.push({
        rect,
        durationMs,
        dispose: (flags & 0x01) === 0 ? 'none' : 'background',
        blend: (flags & 0x02) === 0 ? 'over' : 'source',
        hasAlpha
      });
      if (frames.length > MAX_FRAMES) throw new Error(`animated WebP exceeds ${MAX_FRAMES} frames`);
    }
  }
  if (!canvas || !animated || !sawAnimationHeader || frames.length === 0) throw new Error('WebP is not a complete animation');
  return { format: 'webp', parserVersion: 1, canvas, frames };
}
