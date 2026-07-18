import { connectedComponents, dominantBorderColor, foregroundPredicate } from './components.mjs';
import { colorAt, foregroundBounds, paletteOf, readRgba, sameColor, sha256 } from './image.mjs';

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

function inferGrid(image, background, tolerance) {
  const runs = [];
  const byAxis = { horizontal: [], vertical: [] };
  const visit = (horizontal) => {
    const outer = horizontal ? image.height : image.width;
    const inner = horizontal ? image.width : image.height;
    for (let a = 0; a < outer; a += 1) {
      let start = 0;
      while (start < inner) {
        const point = (n) => horizontal ? colorAt(image, n, a) : colorAt(image, a, n);
        const color = point(start);
        let end = start + 1;
        while (end < inner && sameColor(point(end), color, 0)) end += 1;
        if (!sameColor(color, background, tolerance)) {
          runs.push(end - start);
          byAxis[horizontal ? 'horizontal' : 'vertical'].push(end - start);
        }
        start = end;
      }
    }
  };
  visit(true); visit(false);
  const useful = runs.filter((length) => length > 1);
  const blockSize = useful.length ? useful.reduce(gcd) : null;
  const repeatedModes = [];
  for (const [axis, values] of Object.entries(byAxis)) {
    const counts = new Map();
    for (const value of values.filter((length) => length > 1)) counts.set(value, (counts.get(value) ?? 0) + 1);
    const significant = [...counts].filter(([, count]) => count >= 4 && count / Math.max(1, values.length) >= 0.15).sort((a, b) => b[1] - a[1]);
    if (significant.length >= 2) repeatedModes.push({ axis, modes: significant.slice(0, 3).map(([length, count]) => ({ length, count })) });
  }
  const evidence = { runLengths: [...new Set(useful)].sort((a, b) => a - b).slice(0, 32), sampleCount: useful.length, repeatedIncompatibleModes: repeatedModes };
  const confidence = blockSize === 1 ? 0.55 : blockSize && useful.length >= 4 ? Math.min(0.75, 0.35 + useful.length / 100) : blockSize ? 0.25 : 0;
  const mixedBlockSizes = repeatedModes.length > 0;
  return { blockSize, confidence: mixedBlockSizes ? Math.min(0.8, 0.55 + repeatedModes.length * 0.1) : confidence, evidence, mixedBlockSizes, method: 'foreground run GCD with conservative same-axis repeated-mode check', limitation: 'Repeated run lengths can reflect intentional geometry; mixed-block diagnostics require two statistically repeated modes on one axis.' };
}

export async function inspectImage(file, { tolerance = 0, backgroundColor } = {}) {
  const image = await readRgba(file);
  const background = backgroundColor ?? dominantBorderColor(image) ?? colorAt(image, 0, 0);
  const bounds = foregroundBounds(image, background, tolerance);
  const palette = paletteOf(image);
  const alpha = { opaque: 0, transparent: 0, partial: 0 };
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] === 255) alpha.opaque += 1;
    else if (image.data[i] === 0) alpha.transparent += 1;
    else alpha.partial += 1;
  }
  const predicate = foregroundPredicate(image, { color: background, tolerance });
  const found = connectedComponents(image, predicate);
  const componentSizes = found.map((component) => component.length);
  const margins = bounds ? { left: bounds.left, top: bounds.top, right: image.width - bounds.right - 1, bottom: image.height - bounds.bottom - 1 } : null;
  const clipping = margins ? { left: margins.left === 0, top: margins.top === 0, right: margins.right === 0, bottom: margins.bottom === 0 } : { left: false, top: false, right: false, bottom: false };
  clipping.any = clipping.left || clipping.top || clipping.right || clipping.bottom;
  const pixelGrid = inferGrid(image, background, tolerance);
  const smoothingEvidence = { partialAlphaPixels: alpha.partial, paletteSize: palette.length, repeatedMixedGridModes: pixelGrid.evidence.repeatedIncompatibleModes.length };
  const smoothing = {
    suspected: alpha.partial > 0,
    confidence: alpha.partial > 0 ? 0.65 : 0.15,
    evidence: smoothingEvidence,
    limitation: 'Heuristic only; partial alpha and irregular runs can be intentional art.'
  };
  const diagnostics = [];
  if (!bounds) diagnostics.push({ code: 'NO_FOREGROUND', severity: 'error' });
  if (palette.length > 256) diagnostics.push({ code: 'LARGE_PALETTE', severity: 'warning', value: palette.length });
  if (clipping.any) diagnostics.push({ code: 'EDGE_CLIPPING', severity: 'warning', edges: Object.keys(clipping).filter((key) => key !== 'any' && clipping[key]) });
  if (smoothing.suspected) diagnostics.push({ code: 'SMOOTHING_SUSPECTED', severity: 'warning', confidence: smoothing.confidence, evidence: smoothingEvidence });
  if (pixelGrid.mixedBlockSizes) diagnostics.push({ code: 'MIXED_PIXEL_BLOCKS', severity: 'warning', confidence: pixelGrid.confidence, evidence: pixelGrid.evidence });
  return {
    path: file, width: image.width, height: image.height, channels: 4, palette, background, bounds,
    margins, clipping, alpha,
    components: { count: found.length, sizes: componentSizes, union: bounds },
    pixelGrid, smoothing, diagnostics,
    limitations: ['Pixel-grid and smoothing results are heuristic estimates, not proof.'],
    sha256: await sha256(file)
  };
}
