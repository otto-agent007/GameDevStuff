const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_FRAMES = 10000;

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function parseApng(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('APNG signature is invalid');
  let offset = 8;
  let ihdr = null;
  let animation = null;
  let expectedSequence = 0;
  let current = null;
  let sawIdat = false;
  let ended = false;
  let hasTransparency = false;
  const sharedChunks = [];
  const frames = [];

  function finishFrame() {
    if (!current) return;
    if (current.data.length === 0) throw new Error('APNG frame is missing image data');
    frames.push(current);
    if (frames.length > MAX_FRAMES) throw new Error(`APNG exceeds ${MAX_FRAMES} frames`);
    current = null;
  }

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('truncated APNG chunk');
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('truncated APNG chunk payload');
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([typeBytes, data])) !== expectedCrc) throw new Error(`APNG CRC mismatch for ${type}`);
    offset = end;

    if (type === 'IHDR') {
      if (ihdr || length !== 13 || frames.length > 0) throw new Error('APNG IHDR is invalid');
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      if (width === 0 || height === 0) throw new Error('APNG canvas dimensions must be positive');
      ihdr = Buffer.from(data);
      hasTransparency = data[9] === 4 || data[9] === 6;
    } else if (type === 'acTL') {
      if (!ihdr || animation || sawIdat || length !== 8) throw new Error('APNG acTL is invalid or out of order');
      animation = { frameCount: data.readUInt32BE(0), plays: data.readUInt32BE(4) };
      if (animation.frameCount === 0 || animation.frameCount > MAX_FRAMES) throw new Error('APNG declared frame count is invalid');
    } else if (type === 'fcTL') {
      if (!animation || length !== 26) throw new Error('APNG fcTL is invalid or out of order');
      finishFrame();
      const sequence = data.readUInt32BE(0);
      if (sequence !== expectedSequence) throw new Error('APNG sequence numbers are not contiguous');
      expectedSequence += 1;
      const rect = {
        width: data.readUInt32BE(4),
        height: data.readUInt32BE(8),
        x: data.readUInt32BE(12),
        y: data.readUInt32BE(16)
      };
      const canvas = { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4) };
      if (rect.width === 0 || rect.height === 0 || rect.x + rect.width > canvas.width || rect.y + rect.height > canvas.height) {
        throw new Error('APNG frame rectangle exceeds the canvas');
      }
      const numerator = data.readUInt16BE(20);
      const denominator = data.readUInt16BE(22) || 100;
      const exactDuration = (numerator * 1000) / denominator;
      if (numerator === 0) throw new Error('APNG contains a zero frame delay');
      if (!Number.isInteger(exactDuration) || exactDuration > 65535) throw new Error('APNG frame delay cannot be represented in integer milliseconds');
      const dispose = ['none', 'background', 'previous'][data[24]];
      const blend = ['source', 'over'][data[25]];
      if (!dispose || !blend) throw new Error('APNG frame disposal or blend operation is invalid');
      current = { rect, durationMs: exactDuration, dispose, blend, hasAlpha: hasTransparency, data: [] };
    } else if (type === 'IDAT') {
      if (!current || frames.length > 0) throw new Error('APNG default images outside the animation are unsupported');
      current.data.push(Buffer.from(data));
      sawIdat = true;
    } else if (type === 'fdAT') {
      if (!current || !sawIdat || length < 5) throw new Error('APNG fdAT is invalid or out of order');
      const sequence = data.readUInt32BE(0);
      if (sequence !== expectedSequence) throw new Error('APNG sequence numbers are not contiguous');
      expectedSequence += 1;
      current.data.push(Buffer.from(data.subarray(4)));
    } else if (type === 'tRNS') {
      if (sawIdat) throw new Error('APNG tRNS is out of order');
      hasTransparency = true;
      sharedChunks.push({ type, data: Buffer.from(data) });
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('APNG IEND is invalid');
      finishFrame();
      ended = true;
      break;
    } else if (!sawIdat && type !== 'acTL') {
      sharedChunks.push({ type, data: Buffer.from(data) });
    }
  }

  if (!ended || offset !== bytes.length) throw new Error('APNG IEND is missing or nonterminal');
  if (!ihdr || !animation) throw new Error('PNG is not an animated PNG');
  if (frames.length !== animation.frameCount) throw new Error('APNG frame-count disagreement');
  for (const frame of frames) frame.hasAlpha = hasTransparency;
  return {
    inspection: {
      format: 'apng',
      parserVersion: 1,
      canvas: { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4) },
      frames: frames.map(({ data, ...frame }) => frame)
    },
    ihdr,
    sharedChunks,
    frames
  };
}

export function inspectApng(bytes) {
  return parseApng(bytes).inspection;
}

export function extractApngSubframes(bytes) {
  const parsed = parseApng(bytes);
  const pages = parsed.frames.map((frame) => {
    const ihdr = Buffer.from(parsed.ihdr);
    ihdr.writeUInt32BE(frame.rect.width, 0);
    ihdr.writeUInt32BE(frame.rect.height, 4);
    return Buffer.concat([
      SIGNATURE,
      pngChunk('IHDR', ihdr),
      ...parsed.sharedChunks.map(({ type, data }) => pngChunk(type, data)),
      ...frame.data.map((data) => pngChunk('IDAT', data)),
      pngChunk('IEND', Buffer.alloc(0))
    ]);
  });
  return { inspection: parsed.inspection, pages };
}
