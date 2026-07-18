import sharp from 'sharp';

export async function makeAnchor(file) {
  const width = 13, height = 14;
  const data = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < width * height; i += 1) data.set([0, 255, 0, 255], i * 4);
  for (let y = 3; y <= 11; y += 1) {
    for (let x = 5; x <= 7; x += 1) data.set([20, 30, 60, 255], (y * width + x) * 4);
  }
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
}
