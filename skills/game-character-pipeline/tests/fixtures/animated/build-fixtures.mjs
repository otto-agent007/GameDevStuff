import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';

const execFile = promisify(execFileCallback);
const outputRoot = path.dirname(fileURLToPath(import.meta.url));

function frame({ color = 'none', point, delay, dispose = 'none' }) {
  const args = ['(', '-size', '4x4', `xc:${color}`, '-page', '+0+0'];
  if (point) args.push('-fill', point.color, '-draw', `point ${point.x},${point.y}`);
  args.push('-set', 'delay', String(delay), '-dispose', dispose, ')');
  return args;
}

async function convert(name, args, prefix = '') {
  await execFile('convert', [...args, `${prefix}${path.join(outputRoot, name)}`]);
}

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

function rgbaFrame(x, y, rgba) {
  const rows = [];
  for (let row = 0; row < 4; row += 1) {
    const pixels = Buffer.alloc(16);
    if (row === y) Buffer.from(rgba).copy(pixels, x * 4);
    rows.push(Buffer.from([0]), pixels);
  }
  return Buffer.concat(rows);
}

function frameControl(sequence, delayNumerator, blend) {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequence, 0);
  data.writeUInt32BE(4, 4);
  data.writeUInt32BE(4, 8);
  data.writeUInt16BE(delayNumerator, 20);
  data.writeUInt16BE(100, 22);
  data[24] = 0;
  data[25] = blend;
  return data;
}

async function writeApng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2, 0);
  const secondData = Buffer.concat([
    Buffer.from([0, 0, 0, 2]),
    deflateSync(rgbaFrame(1, 1, [0, 255, 0, 128]))
  ]);
  const bytes = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('acTL', animation),
    pngChunk('fcTL', frameControl(0, 8, 0)),
    pngChunk('IDAT', deflateSync(rgbaFrame(0, 0, [255, 0, 0, 128]))),
    pngChunk('fcTL', frameControl(1, 12, 1)),
    pngChunk('fdAT', secondData),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  await fs.writeFile(path.join(outputRoot, 'alpha.apng.png'), bytes);
}

async function makeSecondWebpFrameBlend() {
  const file = path.join(outputRoot, 'alpha.webp');
  const bytes = await fs.readFile(file);
  let offset = 12;
  let frameIndex = 0;
  while (offset < bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = bytes.readUInt32LE(offset + 4);
    if (type === 'ANMF') {
      if (frameIndex === 1) bytes[offset + 8 + 15] &= 0xfd;
      frameIndex += 1;
    }
    offset += 8 + length + (length & 1);
  }
  if (frameIndex !== 2) throw new Error('expected exactly two generated WebP frames');
  await fs.writeFile(file, bytes);
}

function skipGifSubBlocks(bytes, start) {
  let offset = start;
  while (true) {
    const length = bytes[offset];
    offset += 1;
    if (length === 0) return offset;
    offset += length;
  }
}

async function patchGifLayout(name) {
  const file = path.join(outputRoot, name);
  const bytes = await fs.readFile(file);
  bytes.writeUInt16LE(4, 6);
  bytes.writeUInt16LE(4, 8);
  const positions = [[0, 0], [3, 3], [1, 1]];
  const disposals = [0, 3, 0];
  let frameIndex = 0;
  let controlIndex = 0;
  let offset = 13 + ((bytes[10] & 0x80) === 0 ? 0 : 3 * (2 ** ((bytes[10] & 7) + 1)));
  while (bytes[offset] !== 0x3b) {
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x21) {
      const label = bytes[offset];
      offset += 1;
      if (label === 0xf9) {
        bytes[offset + 1] = (bytes[offset + 1] & 0xe3) | (disposals[controlIndex] << 2);
        controlIndex += 1;
        offset += 6;
      } else {
        offset = skipGifSubBlocks(bytes, offset);
      }
    } else if (marker === 0x2c) {
      bytes.writeUInt16LE(positions[frameIndex][0], offset);
      bytes.writeUInt16LE(positions[frameIndex][1], offset + 2);
      const packed = bytes[offset + 8];
      offset += 9 + ((packed & 0x80) === 0 ? 0 : 3 * (2 ** ((packed & 7) + 1)));
      offset += 1;
      offset = skipGifSubBlocks(bytes, offset);
      frameIndex += 1;
    } else {
      throw new Error('unexpected generated GIF block');
    }
  }
  if (frameIndex !== 3 || controlIndex !== 3) throw new Error('expected three generated GIF frames and controls');
  await fs.writeFile(file, bytes);
}

await fs.mkdir(outputRoot, { recursive: true });

await convert('disposal-previous.gif', [
  ...frame({ point: { x: 0, y: 0, color: '#ff0000ff' }, delay: 7 }),
  '(', '-size', '1x1', 'xc:#0000ffff', '-page', '+3+3', '-set', 'delay', '13', '-dispose', 'previous', ')',
  '(', '-size', '1x1', 'xc:#00ff00ff', '-page', '+1+1', '-set', 'delay', '9', '-dispose', 'none', ')',
  '-background', 'none', '-loop', '0'
]);
await patchGifLayout('disposal-previous.gif');

await convert('duplicates-empty.gif', [
  ...frame({ delay: 5 }),
  ...frame({ delay: 7 }),
  ...frame({ delay: 11 }),
  '-loop', '0'
]);

await convert('zero-delay.gif', [
  ...frame({ point: { x: 0, y: 0, color: '#ff0000ff' }, delay: 0 }),
  ...frame({ point: { x: 1, y: 1, color: '#00ff00ff' }, delay: 5 }),
  '-loop', '0'
]);

await writeApng();

await convert('alpha.webp', [
  ...frame({ point: { x: 0, y: 0, color: '#ff000080' }, delay: 6 }),
  ...frame({ point: { x: 1, y: 1, color: '#00ff0080' }, delay: 14 }),
  '-loop', '0', '-define', 'webp:lossless=true'
]);
await makeSecondWebpFrameBlend();
