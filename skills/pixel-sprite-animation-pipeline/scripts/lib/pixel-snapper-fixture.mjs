import crypto from 'node:crypto';

const PIXEL = Buffer.from([16, 32, 48, 255]);
const RAW = Buffer.concat(Array.from({ length: 9 }, () => PIXEL));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

export const PIXEL_SNAPPER_FIXTURE_WIDTH = 3;
export const PIXEL_SNAPPER_FIXTURE_HEIGHT = 3;
export const PIXEL_SNAPPER_FIXTURE_INPUT_RGBA_SHA256 = 'bb9b87994cf22366cad9d0bbaca0a4663921cda521c5c7f1d44de921d8d8c84f';
export const PIXEL_SNAPPER_FIXTURE_OUTPUT_RGBA_SHA256 = 'bb9b87994cf22366cad9d0bbaca0a4663921cda521c5c7f1d44de921d8d8c84f';
export const PIXEL_SNAPPER_FIXTURE_PALETTE_SHA256 = '09349ae9fcc935c5d4a7dd1bebced6bef54f32ae3bf48ff1d92cc61b220859b2';

if (
  hash(RAW) !== PIXEL_SNAPPER_FIXTURE_INPUT_RGBA_SHA256
  || hash(PIXEL) !== PIXEL_SNAPPER_FIXTURE_PALETTE_SHA256
  || PIXEL_SNAPPER_FIXTURE_INPUT_RGBA_SHA256 !== PIXEL_SNAPPER_FIXTURE_OUTPUT_RGBA_SHA256
) throw new Error('invalid approved Pixel Snapper fixture constants');

export function pixelSnapperFixtureRgba() {
  return Buffer.from(RAW);
}
