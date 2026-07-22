#!/usr/bin/env node
import fs from 'node:fs';
import sharp from 'sharp';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '-version') {
  process.stdout.write('ffmpeg version game-character-fixture-1.0\n');
  process.exit(0);
}

const inputIndex = args.indexOf('-i');
const input = inputIndex === -1 ? '' : args[inputIndex + 1];
const sourceMarker = input ? fs.readFileSync(input, 'utf8') : '';
if (args.includes('framehash')) {
  const missing = sourceMarker.includes('missing-timestamps');
  process.stdout.write([
    '#format: frame checksums',
    '#version: 2',
    '#hash: SHA256',
    '#tb 0: 1/1000',
    `0, 0, ${missing ? 'N/A' : '0'}, 40, 24, ${'1'.repeat(64)}`,
    `0, 40, ${missing ? 'N/A' : '40'}, 100, 24, ${'2'.repeat(64)}`,
    `0, 140, ${missing ? 'N/A' : '140'}, 40, 24, ${'3'.repeat(64)}`,
    `0, 180, ${missing ? 'N/A' : '180'}, 80, 24, ${'4'.repeat(64)}`,
    ''
  ].join('\n'));
  process.exit(0);
}

if (sourceMarker.includes('corrupt')) {
  process.stderr.write('decode corruption detected\n');
  process.exit(1);
}

const pattern = args.at(-1);
const colors = [
  { r: 255, g: 0, b: 0, alpha: 0.5 },
  { r: 0, g: 255, b: 0, alpha: 1 },
  { r: 0, g: 255, b: 0, alpha: 1 },
  { r: 0, g: 0, b: 0, alpha: 0 }
];
for (const [index, background] of colors.entries()) {
  const selected = pattern.replace('%06d', String(index + 1).padStart(6, '0'));
  await sharp({ create: { width: 3, height: 2, channels: 4, background } }).png().toFile(selected);
}
