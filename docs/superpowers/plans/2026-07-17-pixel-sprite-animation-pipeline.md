# Pixel Sprite Animation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and install a reusable ChatGPT/Codex skill that prepares, pixel-snaps, normalizes, validates, self-corrects, and exports animated pixel-art characters.

**Architecture:** The repository contains a self-contained ESM Node.js package under `skills/pixel-sprite-animation-pipeline/`. Small library modules own configuration, image inspection, anchor preparation, Pixel Snapper integration, normalization, export, validation, and learning; a thin CLI composes them. The skill instructions call the CLI when deterministic processing is possible and use explicit manual handoffs for image generation or an unavailable Pixel Snapper binary.

**Tech Stack:** Node.js 20.9.0 or newer, ESM JavaScript, `sharp` 0.35.3, `commander` 15.0.0, `yaml` 2.9.0, Node's built-in `node:test`, GitHub Actions, Codex personal skills.

## Global Constraints

- Canonical, generation, and runtime sizes are configurable; defaults are 128 x 128, 1024 x 1024, and 256 x 256.
- Default canonical pivot is `(64, 112)` and default runtime pivot is `(128, 224)`.
- Padding and artwork scaling are separate operations; never stretch a non-square source to make it square.
- Every resize uses an integer factor and nearest-neighbor interpolation.
- A pose board is reference material only; articulated production frames are generated individually from one locked anchor.
- Pixel Snapper is detected and invoked when available; otherwise emit a resumable manual handoff.
- Normalize all frames with one global integer scale and one shared pivot; never scale frames independently.
- Preserve original files and use versioned run directories.
- Automatic generative correction is limited to two attempts per failed frame.
- Skill-level rule changes require explicit approval and three independent successful runs unless the reduced evidence is disclosed.
- The public repository must not commit private Pop T fixture images; use the supplied image from a gitignored local fixture directory for acceptance testing.

---

## File Map

Create these focused units:

- `skills/pixel-sprite-animation-pipeline/package.json` — package metadata, dependency pins, CLI and test scripts.
- `skills/pixel-sprite-animation-pipeline/SKILL.md` — concise skill trigger and orchestration rules.
- `skills/pixel-sprite-animation-pipeline/agents/openai.yaml` — ChatGPT/Codex UI metadata.
- `skills/pixel-sprite-animation-pipeline/scripts/cli.mjs` — command routing only.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/config.mjs` — defaults, YAML profile loading, and validation.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/image.mjs` — raw RGBA loading, palette, bounds, hashes, and PNG writing.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/inspect.mjs` — input measurements and diagnostics.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/prepare.mjs` — canonical anchor, chroma, runtime, generation plate, and pixel matrix.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/snapper.mjs` — Pixel Snapper detection, invocation, and handoff manifest.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/components.mjs` — foreground connected-component recovery.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/normalize.mjs` — shared-scale and shared-pivot frame placement.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/export.mjs` — individual frames, sheet, JSON, and animated WebP.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/validate.mjs` — objective validation and correction classification.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/correct.mjs` — reversible deterministic corrections and retry accounting.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/learning.mjs` — project profiles, run records, lessons, and proposals.
- `skills/pixel-sprite-animation-pipeline/references/configuration.md` — configuration schema and defaults.
- `skills/pixel-sprite-animation-pipeline/references/generation-prompts.md` — per-frame generation method and prompt template.
- `skills/pixel-sprite-animation-pipeline/references/pixel-snapper.md` — supported executable discovery and manual handoff.
- `skills/pixel-sprite-animation-pipeline/references/corrections.md` — failure taxonomy and stop rules.
- `skills/pixel-sprite-animation-pipeline/tests/*.test.mjs` — module-level and end-to-end tests.
- `skills/pixel-sprite-animation-pipeline/tests/helpers/fixtures.mjs` — deterministic synthetic PNG fixtures.
- `.github/workflows/pixel-sprite-skill.yml` — Linux and Windows test matrix.
- `.gitignore` — private fixture, run-state, dependency, and generated-output exclusions.

---

### Task 1: Package Scaffold and Configuration Contract

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/package.json`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/config.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/config.test.mjs`
- Create: `.gitignore`

**Interfaces:**
- Produces: `DEFAULT_CONFIG`, `loadConfig({ cwd, profilePath, overrides })`, and `validateConfig(config)`.
- `loadConfig` returns a frozen configuration with `{ canonical, generation, runtime, pivot, palette, background, snapper, correction }`.

- [ ] **Step 1: Write the failing configuration tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, loadConfig } from '../scripts/lib/config.mjs';

test('defaults preserve the approved 128 to 1024 to 256 workflow', async () => {
  assert.deepEqual(DEFAULT_CONFIG.canonical, { width: 128, height: 128 });
  assert.deepEqual(DEFAULT_CONFIG.generation, { width: 1024, height: 1024 });
  assert.deepEqual(DEFAULT_CONFIG.runtime, { width: 256, height: 256 });
  assert.deepEqual(DEFAULT_CONFIG.pivot, { x: 64, y: 112 });
});

test('derived scale factors must be positive integers', async () => {
  await assert.rejects(
    loadConfig({ cwd: process.cwd(), overrides: { generation: { width: 1000, height: 1024 } } }),
    /generation width must be an integer multiple of canonical width/
  );
});
```

- [ ] **Step 2: Run the tests and confirm the missing-module failure**

Run: `cd skills/pixel-sprite-animation-pipeline && node --test tests/config.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/lib/config.mjs`.

- [ ] **Step 3: Add the package manifest and minimal configuration implementation**

```json
{
  "name": "pixel-sprite-animation-pipeline",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.9.0" },
  "bin": { "pixel-sprite-pipeline": "scripts/cli.mjs" },
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "validate-skill": "python /root/.codex/skills/oai/skill-creator/scripts/quick_validate.py ."
  },
  "dependencies": {
    "commander": "15.0.0",
    "sharp": "0.35.3",
    "yaml": "2.9.0"
  }
}
```

```js
// scripts/lib/config.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export const DEFAULT_CONFIG = Object.freeze({
  canonical: { width: 128, height: 128 },
  generation: { width: 1024, height: 1024 },
  runtime: { width: 256, height: 256 },
  pivot: { x: 64, y: 112 },
  palette: { mode: 'preserve-anchor' },
  background: { mode: 'border', color: null, tolerance: 0 },
  snapper: { executable: 'spritefusion-pixel-snapper', args: ['16'] },
  correction: { generativeAttempts: 2, skillProposalEvidence: 3 }
});

function merge(base, extra = {}) {
  return Object.fromEntries(Object.keys(base).map((key) => [
    key,
    typeof base[key] === 'object' && !Array.isArray(base[key])
      ? { ...base[key], ...(extra[key] ?? {}) }
      : (extra[key] ?? base[key])
  ]));
}

export function validateConfig(config) {
  const pairs = [['generation', config.generation], ['runtime', config.runtime]];
  for (const [name, size] of pairs) {
    if (size.width % config.canonical.width !== 0) {
      throw new Error(`${name} width must be an integer multiple of canonical width`);
    }
    if (size.height % config.canonical.height !== 0) {
      throw new Error(`${name} height must be an integer multiple of canonical height`);
    }
  }
  if (config.pivot.x < 0 || config.pivot.x >= config.canonical.width || config.pivot.y < 0 || config.pivot.y >= config.canonical.height) {
    throw new Error('pivot must be inside the canonical cell');
  }
  return Object.freeze(config);
}

export async function loadConfig({ cwd, profilePath, overrides = {} }) {
  const selected = profilePath ?? path.join(cwd, '.pixel-sprite-pipeline', 'profile.yaml');
  let profile = {};
  try { profile = YAML.parse(await fs.readFile(selected, 'utf8')) ?? {}; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return validateConfig(merge(merge(DEFAULT_CONFIG, profile), overrides));
}
```

- [ ] **Step 4: Install dependencies and run the tests**

Run: `cd skills/pixel-sprite-animation-pipeline && npm install && npm test`

Expected: two passing tests and a generated `package-lock.json`.

- [ ] **Step 5: Add repository exclusions**

```gitignore
node_modules/
.pixel-sprite-pipeline/
examples/private/
generated/
*.log
```

- [ ] **Step 6: Commit the configuration contract**

```bash
git add .gitignore skills/pixel-sprite-animation-pipeline/package.json skills/pixel-sprite-animation-pipeline/package-lock.json skills/pixel-sprite-animation-pipeline/scripts/lib/config.mjs skills/pixel-sprite-animation-pipeline/tests/config.test.mjs
git commit -m "feat: define pixel sprite pipeline configuration"
```

---

### Task 2: Image Inspection and Synthetic Fixtures

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/image.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/inspect.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/helpers/fixtures.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/inspect.test.mjs`

**Interfaces:**
- Produces: `readRgba(path)`, `writeRgba(path, image)`, `sha256(path)`, `paletteOf(image)`, `foregroundBounds(image, background)`, and `inspectImage(path, options)`.
- `inspectImage` returns JSON-safe `{ path, width, height, channels, palette, background, bounds, diagnostics, sha256 }`.

- [ ] **Step 1: Write a deterministic fixture and failing inspection test**

```js
// tests/helpers/fixtures.mjs
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
```

```js
// tests/inspect.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { makeAnchor } from './helpers/fixtures.mjs';
import { inspectImage } from '../scripts/lib/inspect.mjs';

test('inspection finds exact border background and foreground bounds', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-inspect-'));
  const file = path.join(dir, 'anchor.png');
  await makeAnchor(file);
  const report = await inspectImage(file, { tolerance: 0 });
  assert.deepEqual(report.background, { r: 0, g: 255, b: 0, a: 255 });
  assert.deepEqual(report.bounds, { left: 5, top: 3, width: 3, height: 9, right: 7, bottom: 11 });
  assert.equal(report.palette.length, 2);
});
```

- [ ] **Step 2: Run the failing test**

Run: `node --test tests/inspect.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `inspect.mjs`.

- [ ] **Step 3: Implement raw image primitives and inspection**

```js
// scripts/lib/image.mjs
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
```

```js
// scripts/lib/inspect.mjs
import { colorAt, foregroundBounds, paletteOf, readRgba, sha256 } from './image.mjs';

export async function inspectImage(file, { tolerance = 0 } = {}) {
  const image = await readRgba(file);
  const background = colorAt(image, 0, 0);
  const bounds = foregroundBounds(image, background, tolerance);
  const palette = paletteOf(image);
  const diagnostics = [];
  if (!bounds) diagnostics.push({ code: 'NO_FOREGROUND', severity: 'error' });
  if (palette.length > 256) diagnostics.push({ code: 'LARGE_PALETTE', severity: 'warning', value: palette.length });
  return { path: file, width: image.width, height: image.height, channels: 4, palette, background, bounds, diagnostics, sha256: await sha256(file) };
}
```

- [ ] **Step 4: Run inspection tests**

Run: `node --test tests/inspect.test.mjs`

Expected: one passing test.

- [ ] **Step 5: Commit inspection support**

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/image.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/inspect.mjs skills/pixel-sprite-animation-pipeline/tests/helpers/fixtures.mjs skills/pixel-sprite-animation-pipeline/tests/inspect.test.mjs
git commit -m "feat: inspect pixel sprite anchors"
```

---

### Task 3: Canonical Anchor and Generation References

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/prepare.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/prepare.test.mjs`

**Interfaces:**
- Consumes: `readRgba`, `writeRgba`, `foregroundBounds`, and validated configuration.
- Produces: `prepareAnchor({ input, outputDir, config })` and `createPixelMatrix({ output, width, height, blockSize })`.
- `prepareAnchor` returns paths for `canonicalChroma`, `canonicalTransparent`, `generationPlate`, `runtimeAnchor`, and `pixelMatrix` plus measured pivots and hashes.

- [ ] **Step 1: Write failing tests for padding and integer scaling**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { makeAnchor } from './helpers/fixtures.mjs';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { prepareAnchor } from '../scripts/lib/prepare.mjs';

test('prepare pads without changing foreground pixels and exports exact sizes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-prepare-'));
  const input = path.join(dir, 'input.png');
  await makeAnchor(input);
  const result = await prepareAnchor({ input, outputDir: path.join(dir, 'out'), config: DEFAULT_CONFIG });
  assert.deepEqual(await sharp(result.canonicalChroma).metadata().then(({ width, height }) => ({ width, height })), { width: 128, height: 128 });
  assert.deepEqual(await sharp(result.generationPlate).metadata().then(({ width, height }) => ({ width, height })), { width: 1024, height: 1024 });
  assert.deepEqual(await sharp(result.runtimeAnchor).metadata().then(({ width, height }) => ({ width, height })), { width: 256, height: 256 });
  assert.deepEqual(result.runtimePivot, { x: 128, y: 224 });
});
```

- [ ] **Step 2: Confirm the missing implementation failure**

Run: `node --test tests/prepare.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `prepare.mjs`.

- [ ] **Step 3: Implement exact anchor placement and matrix generation**

```js
// scripts/lib/prepare.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { colorAt, foregroundBounds, readRgba } from './image.mjs';

function rgba(color) { return { r: color.r, g: color.g, b: color.b, alpha: color.a / 255 }; }

export async function createPixelMatrix({ output, width, height, blockSize }) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const white = (Math.floor(x / blockSize) + Math.floor(y / blockSize)) % 2 === 0;
    const value = white ? 255 : 0;
    data.set([value, value, value, 255], (y * width + x) * 4);
  }
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(output);
}

export async function prepareAnchor({ input, outputDir, config }) {
  await fs.mkdir(outputDir, { recursive: true });
  const image = await readRgba(input);
  const background = colorAt(image, 0, 0);
  const bounds = foregroundBounds(image, background, config.background.tolerance);
  if (!bounds) throw new Error('anchor contains no foreground');
  const left = config.pivot.x - Math.floor(bounds.width / 2);
  const top = config.pivot.y - bounds.height;
  if (left < 0 || top < 0 || left + bounds.width > config.canonical.width || top + bounds.height > config.canonical.height) throw new Error('foreground does not fit canonical cell');
  const { data: extractedData } = await sharp(input).extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < extractedData.length; i += 4) {
    const matches = Math.max(Math.abs(extractedData[i] - background.r), Math.abs(extractedData[i + 1] - background.g), Math.abs(extractedData[i + 2] - background.b), Math.abs(extractedData[i + 3] - background.a)) <= config.background.tolerance;
    if (matches) extractedData[i + 3] = 0;
  }
  const extracted = await sharp(extractedData, { raw: { width: bounds.width, height: bounds.height, channels: 4 } }).png().toBuffer();
  const canonicalChroma = path.join(outputDir, 'anchor-canonical-chroma.png');
  const canonicalTransparent = path.join(outputDir, 'anchor-canonical-transparent.png');
  const generationPlate = path.join(outputDir, 'anchor-generation.png');
  const runtimeAnchor = path.join(outputDir, 'anchor-runtime.png');
  const pixelMatrix = path.join(outputDir, 'pixel-matrix.png');
  await sharp({ create: { width: config.canonical.width, height: config.canonical.height, channels: 4, background: rgba(background) } }).composite([{ input: extracted, left, top }]).png().toFile(canonicalChroma);
  await sharp({ create: { width: config.canonical.width, height: config.canonical.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: extracted, left, top }]).png().toFile(canonicalTransparent);
  await sharp(canonicalChroma).resize(config.generation.width, config.generation.height, { kernel: 'nearest' }).png().toFile(generationPlate);
  await sharp(canonicalTransparent).resize(config.runtime.width, config.runtime.height, { kernel: 'nearest' }).png().toFile(runtimeAnchor);
  const generationScale = config.generation.width / config.canonical.width;
  await createPixelMatrix({ output: pixelMatrix, width: config.generation.width, height: config.generation.height, blockSize: generationScale });
  return { canonicalChroma, canonicalTransparent, generationPlate, runtimeAnchor, pixelMatrix, canonicalPivot: config.pivot, runtimePivot: { x: config.pivot.x * (config.runtime.width / config.canonical.width), y: config.pivot.y * (config.runtime.height / config.canonical.height) } };
}
```

- [ ] **Step 4: Run the preparation tests and inspect all outputs**

Run: `node --test tests/prepare.test.mjs`

Expected: one passing test with exact 128, 1024, and 256 dimensions.

- [ ] **Step 5: Commit anchor preparation**

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/prepare.mjs skills/pixel-sprite-animation-pipeline/tests/prepare.test.mjs
git commit -m "feat: prepare canonical and generation sprite assets"
```

---

### Task 4: Pixel Snapper Adapter and Resumable Handoff

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/snapper.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/snapper.test.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/references/pixel-snapper.md`

**Interfaces:**
- Produces: `detectPixelSnapper(config)`, `runPixelSnapper({ inputs, outputDir, config })`, and `writeSnapperHandoff({ inputs, outputDir, config })`.
- Returns `{ status: 'complete' | 'manual-handoff', executable, outputs, handoffPath }`.

- [ ] **Step 1: Write failing detection and handoff tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { detectPixelSnapper, writeSnapperHandoff } from '../scripts/lib/snapper.mjs';

test('missing Pixel Snapper produces a resumable manifest', async () => {
  const config = { snapper: { executable: 'definitely-not-installed-pixel-snapper', args: ['16'] } };
  assert.equal(detectPixelSnapper(config).available, false);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapper-handoff-'));
  const result = await writeSnapperHandoff({ inputs: ['frame-00.png'], outputDir, config });
  assert.equal(result.status, 'manual-handoff');
  const handoff = JSON.parse(await fs.readFile(result.handoffPath, 'utf8'));
  assert.deepEqual(handoff.expectedOutputs, ['frame-00-snapped.png']);
});
```

- [ ] **Step 2: Confirm the test fails for the missing module**

Run: `node --test tests/snapper.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `snapper.mjs`.

- [ ] **Step 3: Implement executable detection, safe argument passing, and handoff output**

```js
// scripts/lib/snapper.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export function detectPixelSnapper(config) {
  const executable = process.env.PIXEL_SNAPPER_BIN || config.snapper.executable;
  const probe = spawnSync(executable, ['--help'], { encoding: 'utf8', shell: false });
  return { available: !probe.error && probe.status === 0, executable, probeStatus: probe.status, error: probe.error?.message ?? null };
}

export async function writeSnapperHandoff({ inputs, outputDir, config }) {
  await fs.mkdir(outputDir, { recursive: true });
  const expectedOutputs = inputs.map((input) => `${path.basename(input, path.extname(input))}-snapped.png`);
  const handoffPath = path.join(outputDir, 'pixel-snapper-handoff.json');
  await fs.writeFile(handoffPath, JSON.stringify({ version: 1, executable: config.snapper.executable, inputs, expectedOutputs, resumeCommand: `pixel-sprite-pipeline normalize --frames ${outputDir}` }, null, 2));
  return { status: 'manual-handoff', executable: config.snapper.executable, outputs: [], handoffPath };
}

export async function runPixelSnapper({ inputs, outputDir, config }) {
  const detection = detectPixelSnapper(config);
  if (!detection.available) return writeSnapperHandoff({ inputs, outputDir, config });
  await fs.mkdir(outputDir, { recursive: true });
  const outputs = [];
  for (const input of inputs) {
    const output = path.join(outputDir, `${path.basename(input, path.extname(input))}-snapped.png`);
    const result = spawnSync(detection.executable, [input, output, ...config.snapper.args], { encoding: 'utf8', shell: false });
    if (result.status !== 0) throw new Error(`Pixel Snapper failed for ${input}: ${result.stderr || result.error?.message}`);
    outputs.push(output);
  }
  return { status: 'complete', executable: detection.executable, outputs, handoffPath: null };
}
```

- [ ] **Step 4: Document detection and manual continuation**

```markdown
# Pixel Snapper Integration

The pipeline first checks `PIXEL_SNAPPER_BIN`, then `snapper.executable` from the project profile. The default is `spritefusion-pixel-snapper`, installed by `cargo install spritefusion-pixel-snapper` or Homebrew. It invokes `spritefusion-pixel-snapper <INPUT> <OUTPUT> 16` without a shell and records every argument in the run manifest.

When unavailable, the pipeline writes `pixel-snapper-handoff.json`. Run Pixel Snapper on each listed input, save each file under its exact `expectedOutputs` name, then run the recorded `resumeCommand`. Do not rename or crop frames between snapping and normalization.
```

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/snapper.test.mjs`

Expected: one passing test.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/snapper.mjs skills/pixel-sprite-animation-pipeline/tests/snapper.test.mjs skills/pixel-sprite-animation-pipeline/references/pixel-snapper.md
git commit -m "feat: add resumable Pixel Snapper integration"
```

---

### Task 5: Foreground Recovery and Frame Normalization

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/components.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/normalize.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/normalize.test.mjs`

**Interfaces:**
- Produces: `connectedComponents(image, isForeground)`, `extractPrimaryComponent(file, options)`, and `normalizeFrames({ inputs, outputDir, config, scaleFactor })`.
- `normalizeFrames` returns `{ frames, canonicalPivot, scaleFactor, measurements }` and writes same-sized transparent PNGs.

- [ ] **Step 1: Write a failing baseline-alignment test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { normalizeFrames } from '../scripts/lib/normalize.mjs';

async function frame(file, left, top, width, height) {
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width, height, channels: 4, background: '#1a203fff' } }, left, top }]).png().toFile(file);
}

test('normalization preserves one scale and plants every frame on y=112', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-'));
  const a = path.join(dir, 'a.png'), b = path.join(dir, 'b.png');
  await frame(a, 5, 8, 15, 30); await frame(b, 20, 20, 28, 18);
  const result = await normalizeFrames({ inputs: [a, b], outputDir: path.join(dir, 'out'), config: DEFAULT_CONFIG, scaleFactor: 1 });
  assert.equal(result.frames.length, 2);
  assert.ok(result.measurements.every((item) => item.bottom === 111));
  assert.ok(result.measurements.every((item) => item.scaleFactor === 1));
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/normalize.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `normalize.mjs`.

- [ ] **Step 3: Implement four-neighbor connected components**

```js
// scripts/lib/components.mjs
export function connectedComponents(image, isForeground) {
  const seen = new Uint8Array(image.width * image.height);
  const components = [];
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    const start = y * image.width + x;
    if (seen[start] || !isForeground(x, y)) continue;
    const queue = [[x, y]]; seen[start] = 1; const pixels = [];
    while (queue.length) {
      const [cx, cy] = queue.pop(); pixels.push([cx, cy]);
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
        if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) continue;
        const index = ny * image.width + nx;
        if (!seen[index] && isForeground(nx, ny)) { seen[index] = 1; queue.push([nx, ny]); }
      }
    }
    components.push(pixels);
  }
  return components.sort((a, b) => b.length - a.length);
}
```

- [ ] **Step 4: Implement shared-scale normalization**

```js
// scripts/lib/normalize.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { readRgba } from './image.mjs';
import { connectedComponents } from './components.mjs';

export async function normalizeFrames({ inputs, outputDir, config, scaleFactor = 1 }) {
  if (!Number.isInteger(scaleFactor) || scaleFactor < 1) throw new Error('scaleFactor must be a positive integer');
  await fs.mkdir(outputDir, { recursive: true });
  const frames = []; const measurements = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const image = await readRgba(inputs[index]);
    const components = connectedComponents(image, (x, y) => image.data[(y * image.width + x) * 4 + 3] > 0);
    if (!components.length) throw new Error(`frame ${inputs[index]} contains no foreground`);
    const primary = components[0];
    const xs = primary.map(([x]) => x), ys = primary.map(([, y]) => y);
    const bounds = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
    bounds.width = bounds.right - bounds.left + 1; bounds.height = bounds.bottom - bounds.top + 1;
    const width = bounds.width * scaleFactor, height = bounds.height * scaleFactor;
    const left = config.pivot.x - Math.floor(width / 2), top = config.pivot.y - height;
    if (left < 0 || top < 0 || left + width > config.canonical.width || top + height > config.canonical.height) throw new Error(`frame ${inputs[index]} exceeds canonical cell at global scale ${scaleFactor}`);
    const crop = await sharp(inputs[index]).extract(bounds).resize(width, height, { kernel: 'nearest' }).png().toBuffer();
    const output = path.join(outputDir, `frame-${String(index).padStart(2, '0')}.png`);
    await sharp({ create: { width: config.canonical.width, height: config.canonical.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: crop, left, top }]).png().toFile(output);
    frames.push(output); measurements.push({ input: inputs[index], output, left, top, width, height, bottom: top + height - 1, scaleFactor, componentCount: components.length });
  }
  return { frames, canonicalPivot: config.pivot, scaleFactor, measurements };
}
```

- [ ] **Step 5: Run tests and commit normalization**

Run: `node --test tests/normalize.test.mjs`

Expected: one passing test with both frame bottoms at 111.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/components.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/normalize.mjs skills/pixel-sprite-animation-pipeline/tests/normalize.test.mjs
git commit -m "feat: normalize sprite frames around a shared pivot"
```

---

### Task 6: Runtime Export, Metadata, and Animated Preview

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/export.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/export.test.mjs`

**Interfaces:**
- Consumes: canonical transparent normalized frames and validated configuration.
- Produces: `exportAnimation({ frames, outputDir, config, columns, durations, name })` returning `{ runtimeFrames, sheet, metadata, preview }`.

- [ ] **Step 1: Write failing export assertions**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { exportAnimation } from '../scripts/lib/export.mjs';

test('export writes 256 cells, sheet, metadata, and animated WebP', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'export-'));
  const frame = path.join(dir, 'frame.png');
  await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(frame);
  const result = await exportAnimation({ frames: [frame, frame], outputDir: path.join(dir, 'out'), config: DEFAULT_CONFIG, columns: 2, durations: [80, 120], name: 'test-run' });
  assert.equal((await sharp(result.runtimeFrames[0]).metadata()).width, 256);
  assert.equal((await sharp(result.sheet).metadata()).width, 512);
  const metadata = JSON.parse(await fs.readFile(result.metadata, 'utf8'));
  assert.deepEqual(metadata.pivot, { x: 128, y: 224 });
  assert.deepEqual(metadata.durations, [80, 120]);
  assert.equal((await sharp(result.preview, { animated: true }).metadata()).pages, 2);
});
```

- [ ] **Step 2: Run and observe the missing-module failure**

Run: `node --test tests/export.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `export.mjs`.

- [ ] **Step 3: Implement runtime frames, sheet, JSON, and WebP**

Create `scripts/lib/export.mjs` with this complete implementation:

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export async function exportAnimation({ frames, outputDir, config, columns, durations, name }) {
await fs.mkdir(outputDir, { recursive: true });
if (frames.length === 0) throw new Error('at least one frame is required');
if (durations.length !== frames.length) throw new Error('durations must contain one value per frame');
const runtimeScale = config.runtime.width / config.canonical.width;
if (!Number.isInteger(runtimeScale)) throw new Error('runtime scale must be an integer');
const runtimeFrames = [];
for (let index = 0; index < frames.length; index += 1) {
  const output = path.join(outputDir, `${name}-${String(index).padStart(2, '0')}.png`);
  await sharp(frames[index]).resize(config.runtime.width, config.runtime.height, { kernel: 'nearest' }).png().toFile(output);
  runtimeFrames.push(output);
}
const rows = Math.ceil(runtimeFrames.length / columns);
const sheet = path.join(outputDir, `${name}-sheet.png`);
await sharp({ create: { width: columns * config.runtime.width, height: rows * config.runtime.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(runtimeFrames.map((input, index) => ({ input, left: (index % columns) * config.runtime.width, top: Math.floor(index / columns) * config.runtime.height })))
  .png().toFile(sheet);
const metadata = path.join(outputDir, `${name}.json`);
await fs.writeFile(metadata, JSON.stringify({
  name,
  frameSize: config.runtime,
  pivot: { x: config.pivot.x * runtimeScale, y: config.pivot.y * runtimeScale },
  columns,
  rows,
  durations,
  frames: runtimeFrames.map((file, index) => ({ index, file: path.basename(file), x: (index % columns) * config.runtime.width, y: Math.floor(index / columns) * config.runtime.height, width: config.runtime.width, height: config.runtime.height }))
}, null, 2));
const preview = path.join(outputDir, `${name}.webp`);
const pageBytes = config.runtime.width * config.runtime.height * 4;
const stackedRaw = Buffer.alloc(pageBytes * runtimeFrames.length);
for (let index = 0; index < runtimeFrames.length; index += 1) {
  const frameRaw = await sharp(runtimeFrames[index]).ensureAlpha().raw().toBuffer();
  frameRaw.copy(stackedRaw, index * pageBytes);
}
await sharp(stackedRaw, { raw: { width: config.runtime.width, height: config.runtime.height * runtimeFrames.length, channels: 4, pageHeight: config.runtime.height } })
  .webp({ loop: 0, delay: durations, lossless: true }).toFile(preview);
return { runtimeFrames, sheet, metadata, preview };
}
```

- [ ] **Step 4: Run export tests and commit**

Run: `node --test tests/export.test.mjs`

Expected: one passing test and a two-page WebP.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/export.mjs skills/pixel-sprite-animation-pipeline/tests/export.test.mjs
git commit -m "feat: export runtime sprite animations"
```

---

### Task 7: Validation and Bounded Deterministic Correction

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/validate.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/correct.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/validate.test.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/references/corrections.md`

**Interfaces:**
- Produces: `validateRun({ anchorReport, normalized, exported, config })`, `classifyFailures(report)`, and `applyDeterministicCorrections({ failures, run, config, operations })`.
- Validation returns `{ passed, failures, warnings, measurements }`; corrections return versioned outputs and never overwrite inputs.

- [ ] **Step 1: Write failing validation tests for wrong dimensions and interpolation colors**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailures } from '../scripts/lib/validate.mjs';
import { applyDeterministicCorrections } from '../scripts/lib/correct.mjs';

test('classifies canvas, scaling, pivot, palette, and clipping failures', () => {
  const failures = classifyFailures({
    passed: false,
    failures: [
      { code: 'CANVAS_SIZE', expected: [128, 128], actual: [128, 131] },
      { code: 'INTERMEDIATE_COLORS', count: 17 },
      { code: 'PIVOT_DRIFT', frame: 3, pixels: 4 },
      { code: 'CLIPPED_FOREGROUND', frame: 5 }
    ]
  });
  assert.deepEqual(failures.map((item) => item.correction), ['repad', 'nearest-rescale', 'realign', 'stop-for-regeneration']);
});

test('automatic corrections execute a supplied deterministic operation and retain the version directory', async () => {
  const run = { runDir: '/tmp/pixel-sprite-correction-test', corrections: [], generativeAttempts: 0 };
  const result = await applyDeterministicCorrections({
    failures: [{ code: 'CANVAS_SIZE', correction: 'repad' }],
    run,
    config: { correction: { generativeAttempts: 2 } },
    operations: { repad: async ({ outputDir }) => ({ output: `${outputDir}/anchor-corrected.png`, validationPassed: true }) }
  });
  assert.equal(result.actions[0].status, 'applied');
  assert.equal(result.actions[0].result.validationPassed, true);
});
```

- [ ] **Step 2: Run and confirm the missing-module failure**

Run: `node --test tests/validate.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `validate.mjs`.

- [ ] **Step 3: Implement the failure taxonomy and correction limits**

```js
// scripts/lib/validate.mjs
import fs from 'node:fs/promises';
import sharp from 'sharp';

const CORRECTIONS = {
  CANVAS_SIZE: 'repad',
  NON_INTEGER_SCALE: 'nearest-rescale',
  INTERMEDIATE_COLORS: 'nearest-rescale',
  BACKGROUND_REMAINS: 'rekey',
  PIVOT_DRIFT: 'realign',
  PALETTE_DRIFT: 'palette-remap-review',
  CLIPPED_FOREGROUND: 'stop-for-regeneration',
  IDENTITY_DRIFT: 'stop-for-regeneration',
  DUPLICATE_POSE: 'stop-for-regeneration',
  LOOP_SEAM: 'timing-or-transition-review'
};

export function classifyFailures(report) {
  return report.failures.map((failure) => ({ ...failure, correction: CORRECTIONS[failure.code] ?? 'stop-for-review' }));
}

export function validateIntegerScale({ source, output }) {
  const sx = output.width / source.width, sy = output.height / source.height;
  return Number.isInteger(sx) && Number.isInteger(sy) && sx === sy
    ? []
    : [{ code: 'NON_INTEGER_SCALE', source, output }];
}

export async function validateRun({ normalized, exported, config }) {
  const failures = [];
  for (const item of normalized.measurements) {
    if (item.bottom !== config.pivot.y - 1) failures.push({ code: 'PIVOT_DRIFT', frame: item.output, pixels: item.bottom - (config.pivot.y - 1) });
    if (item.left <= 0 || item.top <= 0 || item.left + item.width >= config.canonical.width || item.top + item.height >= config.canonical.height) failures.push({ code: 'CLIPPED_FOREGROUND', frame: item.output });
  }
  for (const frame of exported.runtimeFrames) {
    const metadata = await sharp(frame).metadata();
    if (metadata.width !== config.runtime.width || metadata.height !== config.runtime.height) failures.push({ code: 'CANVAS_SIZE', frame, expected: [config.runtime.width, config.runtime.height], actual: [metadata.width, metadata.height] });
  }
  const animation = JSON.parse(await fs.readFile(exported.metadata, 'utf8'));
  const runtimeScale = config.runtime.width / config.canonical.width;
  const expectedPivot = { x: config.pivot.x * runtimeScale, y: config.pivot.y * runtimeScale };
  if (animation.pivot.x !== expectedPivot.x || animation.pivot.y !== expectedPivot.y) failures.push({ code: 'PIVOT_DRIFT', expected: expectedPivot, actual: animation.pivot });
  const preview = await sharp(exported.preview, { animated: true }).metadata();
  if (preview.pages !== exported.runtimeFrames.length) failures.push({ code: 'FRAME_COUNT', expected: exported.runtimeFrames.length, actual: preview.pages });
  const classified = classifyFailures({ failures });
  return { passed: classified.length === 0, failures: classified, warnings: [], measurements: { runtimeFrames: exported.runtimeFrames.length, previewPages: preview.pages } };
}
```

```js
// scripts/lib/correct.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

export async function applyDeterministicCorrections({ failures, run, config, operations }) {
  const correctionDir = path.join(run.runDir, `correction-${String(run.corrections.length + 1).padStart(2, '0')}`);
  await fs.mkdir(correctionDir, { recursive: true });
  const actions = [];
  for (const failure of failures) {
    if (failure.correction === 'stop-for-regeneration') actions.push({ ...failure, status: 'blocked', requires: 'generative-retry' });
    else if (failure.correction.endsWith('-review')) actions.push({ ...failure, status: 'blocked', requires: 'user-review' });
    else {
      const operation = operations[failure.correction];
      if (!operation) throw new Error(`missing deterministic correction operation: ${failure.correction}`);
      const result = await operation({ failure, outputDir: correctionDir });
      actions.push({ ...failure, status: 'applied', outputDir: correctionDir, result });
    }
  }
  return { correctionDir, actions, generativeAttemptsRemaining: Math.max(0, config.correction.generativeAttempts - run.generativeAttempts) };
}
```

- [ ] **Step 4: Document automatic and blocking corrections**

Create `references/corrections.md` with this content:

```markdown
# Correction Policy

| Failure | Action | Automatic |
|---|---|---|
| `CANVAS_SIZE` | Re-pad the unchanged native foreground | Yes |
| `NON_INTEGER_SCALE` | Re-export from the nearest canonical ancestor | Yes |
| `INTERMEDIATE_COLORS` | Re-export with nearest-neighbor | Yes |
| `BACKGROUND_REMAINS` | Re-key using the recorded border color and tolerance | Yes |
| `PIVOT_DRIFT` | Re-align to the shared configured pivot | Yes |
| `PALETTE_DRIFT` | Preview nearest-palette remap | User review |
| `CLIPPED_FOREGROUND` | Regenerate the affected frame with more padding | Generative retry |
| `IDENTITY_DRIFT` | Regenerate only the affected frame from the locked anchor | Generative retry |
| `DUPLICATE_POSE` | Regenerate only the duplicate pose | Generative retry |
| `LOOP_SEAM` | Review timing or add a transition frame | User review |

Never overwrite an input or approved artifact. Store corrections in a numbered run subdirectory and compare the new validation report with the failed report. Allow no more than two generative attempts per frame. Stop when a correction changes approved character design, removes meaningful palette detail, presents multiple artistic choices, fails to improve after two generative attempts, or conflicts with an installed rule.
```

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/validate.test.mjs`

Expected: one passing classification test.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/validate.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/correct.mjs skills/pixel-sprite-animation-pipeline/tests/validate.test.mjs skills/pixel-sprite-animation-pipeline/references/corrections.md
git commit -m "feat: validate and self-correct sprite pipeline runs"
```

---

### Task 8: Project Learning and Skill-Change Proposals

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/learning.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/learning.test.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/references/configuration.md`

**Interfaces:**
- Produces: `createRun({ cwd, config, inputs })`, `recordRunResult(run, result)`, `promoteVerifiedProfile({ cwd, config, report })`, and `proposeSkillRule({ cwd, failureCode, correction })`.
- Uses `.pixel-sprite-pipeline/profile.yaml`, `runs/<run-id>/manifest.json`, `report.json`, and `lessons.jsonl`.

- [ ] **Step 1: Write failing evidence-threshold tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { proposeSkillRule } from '../scripts/lib/learning.mjs';

test('skill rule proposal requires three independently successful lessons', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'learning-'));
  const state = path.join(cwd, '.pixel-sprite-pipeline');
  await fs.mkdir(state, { recursive: true });
  const lessons = [1, 2].map((run) => JSON.stringify({ run: `run-${run}`, failureCode: 'CANVAS_SIZE', correction: 'repad', validationPassed: true }));
  await fs.writeFile(path.join(state, 'lessons.jsonl'), `${lessons.join('\n')}\n`);
  const blocked = await proposeSkillRule({ cwd, failureCode: 'CANVAS_SIZE', correction: 'repad' });
  assert.equal(blocked.ready, false);
  await fs.appendFile(path.join(state, 'lessons.jsonl'), `${JSON.stringify({ run: 'run-3', failureCode: 'CANVAS_SIZE', correction: 'repad', validationPassed: true })}\n`);
  const ready = await proposeSkillRule({ cwd, failureCode: 'CANVAS_SIZE', correction: 'repad' });
  assert.equal(ready.ready, true);
  assert.equal(ready.requiresUserApproval, true);
});
```

- [ ] **Step 2: Run and confirm the missing implementation failure**

Run: `node --test tests/learning.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `learning.mjs`.

- [ ] **Step 3: Implement versioned run records and proposal gating**

```js
// scripts/lib/learning.mjs
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export async function createRun({ cwd, config, inputs }) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const runDir = path.join(cwd, '.pixel-sprite-pipeline', 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });
  const manifest = { version: 1, runId, createdAt: new Date().toISOString(), inputs, config, status: 'started' };
  await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { runId, runDir, manifest, corrections: [], generativeAttempts: 0 };
}

export async function recordRunResult(run, result) {
  await fs.writeFile(path.join(run.runDir, 'report.json'), JSON.stringify(result, null, 2));
  return result;
}

export async function promoteVerifiedProfile({ cwd, config, report }) {
  if (!report.passed) throw new Error('only a passing run can update the project profile');
  const state = path.join(cwd, '.pixel-sprite-pipeline');
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, 'profile.yaml'), YAML.stringify(config));
}

export async function proposeSkillRule({ cwd, failureCode, correction }) {
  const file = path.join(cwd, '.pixel-sprite-pipeline', 'lessons.jsonl');
  let rows = [];
  try { rows = (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const runs = new Set(rows.filter((row) => row.validationPassed && row.failureCode === failureCode && row.correction === correction).map((row) => row.run));
  return { ready: runs.size >= 3, evidenceCount: runs.size, requiresUserApproval: true, proposedRule: { failureCode, correction } };
}
```

- [ ] **Step 4: Document the project profile schema**

Create `references/configuration.md` with this content:

````markdown
# Configuration

Configuration precedence is: CLI overrides, `.pixel-sprite-pipeline/profile.yaml`, built-in defaults.

```yaml
canonical: { width: 128, height: 128 }
generation: { width: 1024, height: 1024 }
runtime: { width: 256, height: 256 }
pivot: { x: 64, y: 112 }
palette: { mode: preserve-anchor }
background: { mode: border, color: null, tolerance: 0 }
snapper: { executable: spritefusion-pixel-snapper, args: ["16"] }
correction: { generativeAttempts: 2, skillProposalEvidence: 3 }
```

Generation and runtime width and height must be integer multiples of canonical width and height. The pivot must be inside the canonical cell. Project state is stored in `.pixel-sprite-pipeline/`: `profile.yaml` holds verified settings, `runs/<run-id>/manifest.json` records immutable inputs/configuration, `runs/<run-id>/report.json` records results, and `lessons.jsonl` records verified correction evidence.
````

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/learning.test.mjs`

Expected: one passing threshold test.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/learning.mjs skills/pixel-sprite-animation-pipeline/tests/learning.test.mjs skills/pixel-sprite-animation-pipeline/references/configuration.md
git commit -m "feat: record verified sprite pipeline lessons"
```

---

### Task 9: CLI Orchestration and Skill Instructions

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/cli.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/SKILL.md`
- Create: `skills/pixel-sprite-animation-pipeline/agents/openai.yaml`
- Create: `skills/pixel-sprite-animation-pipeline/references/generation-prompts.md`
- Create: `skills/pixel-sprite-animation-pipeline/tests/cli.test.mjs`

**Interfaces:**
- Produces CLI commands `inspect`, `prepare`, `snap`, `normalize`, `export`, `validate`, and `run`.
- Exit codes: `0` pass, `2` manual handoff, `3` objective validation failure, `4` user review required, `1` unexpected error.

- [ ] **Step 1: Write a failing CLI smoke test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('CLI exposes every independently callable pipeline stage', () => {
  const result = spawnSync(process.execPath, ['scripts/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  for (const command of ['inspect', 'prepare', 'snap', 'normalize', 'export', 'validate', 'run']) assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
});
```

- [ ] **Step 2: Run and confirm the missing CLI failure**

Run: `node --test tests/cli.test.mjs`

Expected: FAIL because `scripts/cli.mjs` does not exist.

- [ ] **Step 3: Implement command routing**

Create `scripts/cli.mjs` with this implementation:

```js
#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig } from './lib/config.mjs';
import { inspectImage } from './lib/inspect.mjs';
import { prepareAnchor } from './lib/prepare.mjs';
import { runPixelSnapper } from './lib/snapper.mjs';
import { normalizeFrames } from './lib/normalize.mjs';
import { exportAnimation } from './lib/export.mjs';
import { validateRun } from './lib/validate.mjs';
import { createRun, recordRunResult, promoteVerifiedProfile } from './lib/learning.mjs';

const program = new Command().name('pixel-sprite-pipeline').description('Prepare and normalize animated pixel-art sprites').version('0.1.0');
const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const csv = (value) => value.split(',').filter(Boolean);

program.command('inspect').requiredOption('-i, --input <file>').option('--tolerance <n>', 'background tolerance', Number, 0).action(async ({ input, tolerance }) => print(await inspectImage(input, { tolerance })));

program.command('prepare').requiredOption('-i, --input <file>').requiredOption('-o, --output <dir>').option('--profile <file>').action(async ({ input, output, profile }) => {
  const config = await loadConfig({ cwd: process.cwd(), profilePath: profile });
  print(await prepareAnchor({ input, outputDir: output, config }));
});

program.command('snap').requiredOption('-f, --frames <files>', 'comma-separated frame paths').requiredOption('-o, --output <dir>').option('--profile <file>').action(async ({ frames, output, profile }) => {
  const config = await loadConfig({ cwd: process.cwd(), profilePath: profile });
  const result = await runPixelSnapper({ inputs: csv(frames), outputDir: output, config });
  print(result);
  if (result.status === 'manual-handoff') process.exitCode = 2;
});

program.command('normalize').requiredOption('-f, --frames <files>', 'comma-separated snapped frame paths').requiredOption('-o, --output <dir>').option('--scale <n>', 'shared integer scale', Number, 1).option('--profile <file>').action(async ({ frames, output, scale, profile }) => {
  const config = await loadConfig({ cwd: process.cwd(), profilePath: profile });
  print(await normalizeFrames({ inputs: csv(frames), outputDir: output, config, scaleFactor: scale }));
});

program.command('export').requiredOption('-f, --frames <files>', 'comma-separated normalized frame paths').requiredOption('-o, --output <dir>').requiredOption('-n, --name <name>').option('--columns <n>', 'sheet columns', Number, 4).option('--durations <ms>', 'comma-separated frame durations', csv, []).option('--profile <file>').action(async ({ frames, output, name, columns, durations, profile }) => {
  const inputs = csv(frames);
  const config = await loadConfig({ cwd: process.cwd(), profilePath: profile });
  const parsedDurations = durations.length ? durations.map(Number) : inputs.map(() => 100);
  print(await exportAnimation({ frames: inputs, outputDir: output, config, columns, durations: parsedDurations, name }));
});

program.command('validate').requiredOption('--report <file>').action(async ({ report }) => {
  const result = await validateRun(JSON.parse(await (await import('node:fs/promises')).readFile(report, 'utf8')));
  print(result);
  if (!result.passed) process.exitCode = result.failures.some((item) => item.requiresUserReview) ? 4 : 3;
});

program.command('run').requiredOption('-i, --input <anchor>').requiredOption('-o, --output <dir>').option('-f, --frames <files>', 'comma-separated generated frame paths').option('--profile <file>').action(async ({ input, output, frames, profile }) => {
  const cwd = process.cwd();
  const config = await loadConfig({ cwd, profilePath: profile });
  const run = await createRun({ cwd, config, inputs: { anchor: input, frames: frames ? csv(frames) : [] } });
  const anchorReport = await inspectImage(input);
  const prepared = await prepareAnchor({ input, outputDir: path.join(output, 'prepared'), config });
  if (!frames) {
    const result = { status: 'generation-handoff', runId: run.runId, anchorReport, prepared, next: 'Generate one pose per frame, then rerun with --frames.' };
    await recordRunResult(run, result); print(result); process.exitCode = 2; return;
  }
  const snapped = await runPixelSnapper({ inputs: csv(frames), outputDir: path.join(output, 'snapped'), config });
  if (snapped.status === 'manual-handoff') { await recordRunResult(run, snapped); print(snapped); process.exitCode = 2; return; }
  const normalized = await normalizeFrames({ inputs: snapped.outputs, outputDir: path.join(output, 'normalized'), config, scaleFactor: 1 });
  const exported = await exportAnimation({ frames: normalized.frames, outputDir: path.join(output, 'runtime'), config, columns: 4, durations: normalized.frames.map(() => 100), name: 'animation' });
  const validation = await validateRun({ anchorReport, normalized, exported, config });
  await recordRunResult(run, validation);
  if (validation.passed) await promoteVerifiedProfile({ cwd, config, report: validation });
  print({ runId: run.runId, prepared, snapped, normalized, exported, validation });
  if (!validation.passed) process.exitCode = validation.failures.some((item) => item.requiresUserReview) ? 4 : 3;
});

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message, stack: process.env.DEBUG ? error.stack : undefined })}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Write concise skill instructions**

Create `SKILL.md` with this complete content:

```markdown
---
name: pixel-sprite-animation-pipeline
description: Prepare, generate, pixel-snap, normalize, validate, self-correct, and export consistent animated pixel-art character spritesheets. Use for pixel-art anchors, animation frames, run/walk/idle cycles, Pixel Snapper workflows, shared pivots, nearest-neighbor runtime exports, or repairing blurry and drifting sprites.
---

# Pixel Sprite Animation Pipeline

Preserve every input and write versioned outputs. Inspect an anchor or frame set before changing it.

## Select a mode

- Use guided mode when the user supplies an anchor and a motion.
- Use an individual CLI stage when the user asks to inspect, prepare, snap, normalize, export, validate, or repair existing assets.

Load only the reference needed for the active stage: `references/configuration.md`, `references/generation-prompts.md`, `references/pixel-snapper.md`, or `references/corrections.md`.

## Deterministic stages

Run `npm ci --omit=dev` in this skill directory when `node_modules/` is absent. Then call `node scripts/cli.mjs <command>`. Exit code 2 is a resumable image-generation or Pixel Snapper handoff. Exit code 3 is an objective validation failure. Exit code 4 requires user judgment. Do not claim completion for any nonzero pipeline exit.

## Generation stage

Use the installed image-generation skill. Provide the prepared 1024 anchor as the identity reference and the 1024 matrix as the pixel constraint. Generate articulated characters one frame at a time from the same locked anchor. Describe only the pose delta. A pose board may guide motion but is never a production sheet.

## Correction and learning

Apply reversible deterministic corrections automatically and revalidate them. Preserve failed and corrected versions. Permit at most two targeted generative retries per frame. Store verified project settings and run evidence under `.pixel-sprite-pipeline/`. Never change this installed skill or its defaults without explicit user approval, even when three successful runs support a proposal.
```

- [ ] **Step 5: Add the per-frame prompt contract**

Create `references/generation-prompts.md` with this content:

````markdown
# Generation Prompts

Generate one image per articulated frame. Reuse both locked references in every request.

```text
Reference 1: locked 1024 x 1024 nearest-neighbor character anchor; preserve identity, costume, proportions, direction, palette, and outline.
Reference 2: 1024 x 1024 black-and-white pixel matrix; use only as a square-pixel cluster constraint.
Change only: <pose delta for this frame>.
Keep: full body, same scale, same camera, generous padding, flat chroma background, no text, no props unless requested.
```

For a correction, replace `<pose delta for this frame>` with the original pose plus exactly one measured repair such as “add more padding above the cap” or “restore the two gold epaulet stripes.” Keep approved features unchanged. Stop after two unsuccessful corrections and ask the user.
````

- [ ] **Step 6: Generate and validate `agents/openai.yaml`**

Run:

```bash
python /root/.codex/skills/oai/skill-creator/scripts/generate_openai_yaml.py . \
  --interface display_name="Pixel Sprite Animation Pipeline" \
  --interface short_description="Build consistent, normalized pixel-art animations" \
  --interface default_prompt="Use @pixel-sprite-animation-pipeline to prepare and validate this character animation."
python /root/.codex/skills/oai/skill-creator/scripts/quick_validate.py .
```

Expected: validation succeeds with no frontmatter or interface errors.

- [ ] **Step 7: Run CLI and full unit tests**

Run: `npm test && node scripts/cli.mjs --help`

Expected: all tests pass and all seven commands appear.

- [ ] **Step 8: Commit the usable skill package**

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/cli.mjs skills/pixel-sprite-animation-pipeline/SKILL.md skills/pixel-sprite-animation-pipeline/agents/openai.yaml skills/pixel-sprite-animation-pipeline/references/generation-prompts.md skills/pixel-sprite-animation-pipeline/tests/cli.test.mjs
git commit -m "feat: package reusable pixel sprite animation skill"
```

---

### Task 10: Cross-Platform CI, Pop T Acceptance, and Personal Installation

**Files:**
- Create: `.github/workflows/pixel-sprite-skill.yml`
- Create: `skills/pixel-sprite-animation-pipeline/tests/e2e.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/package.json`
- Install copy: `/root/.codex/skills/remote-skills/skill-pixel-sprite-animation-pipeline/`

**Interfaces:**
- Consumes every prior module and the supplied private Pop T anchor.
- Produces a passing CI workflow, acceptance artifacts under a gitignored directory, and an installed personal skill.

- [ ] **Step 1: Add a synthetic end-to-end test**

Create `tests/e2e.test.mjs` with this complete test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { makeAnchor } from './helpers/fixtures.mjs';
import { DEFAULT_CONFIG } from '../scripts/lib/config.mjs';
import { sha256 } from '../scripts/lib/image.mjs';
import { inspectImage } from '../scripts/lib/inspect.mjs';
import { prepareAnchor } from '../scripts/lib/prepare.mjs';
import { normalizeFrames } from '../scripts/lib/normalize.mjs';
import { exportAnimation } from '../scripts/lib/export.mjs';
import { validateRun } from '../scripts/lib/validate.mjs';
import { createRun, recordRunResult, promoteVerifiedProfile } from '../scripts/lib/learning.mjs';

test('complete deterministic workflow preserves input and promotes only a passing profile', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-e2e-'));
  const input = path.join(cwd, 'anchor.png');
  await makeAnchor(input);
  const before = await sha256(input);
  const run = await createRun({ cwd, config: DEFAULT_CONFIG, inputs: { anchor: input } });
  const anchorReport = await inspectImage(input);
  const prepared = await prepareAnchor({ input, outputDir: path.join(cwd, 'prepared'), config: DEFAULT_CONFIG });
  const normalized = await normalizeFrames({ inputs: [prepared.canonicalTransparent, prepared.canonicalTransparent], outputDir: path.join(cwd, 'normalized'), config: DEFAULT_CONFIG, scaleFactor: 1 });
  const exported = await exportAnimation({ frames: normalized.frames, outputDir: path.join(cwd, 'runtime'), config: DEFAULT_CONFIG, columns: 2, durations: [80, 120], name: 'synthetic-run' });
  const report = await validateRun({ anchorReport, normalized, exported, config: DEFAULT_CONFIG });
  await recordRunResult(run, report);
  assert.equal(report.passed, true);
  assert.equal(await sha256(input), before);
  await promoteVerifiedProfile({ cwd, config: DEFAULT_CONFIG, report });
  assert.ok((await fs.stat(path.join(cwd, '.pixel-sprite-pipeline', 'profile.yaml'))).isFile());
  for (const file of [prepared.generationPlate, prepared.pixelMatrix, exported.sheet, exported.metadata, exported.preview]) assert.ok((await fs.stat(file)).isFile());
});

test('a failed report cannot replace the verified profile', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-e2e-fail-'));
  await assert.rejects(promoteVerifiedProfile({ cwd, config: DEFAULT_CONFIG, report: { passed: false } }), /only a passing run/);
});
```

- [ ] **Step 2: Add Linux and Windows CI**

```yaml
name: Pixel Sprite Skill
on:
  push:
    paths:
      - "skills/pixel-sprite-animation-pipeline/**"
      - ".github/workflows/pixel-sprite-skill.yml"
  pull_request:
    paths:
      - "skills/pixel-sprite-animation-pipeline/**"
      - ".github/workflows/pixel-sprite-skill.yml"
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [20, 24]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        working-directory: skills/pixel-sprite-animation-pipeline
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
          cache-dependency-path: skills/pixel-sprite-animation-pipeline/package-lock.json
      - run: npm ci
      - run: npm test
```

- [ ] **Step 3: Run the full deterministic suite locally**

Run: `cd skills/pixel-sprite-animation-pipeline && npm ci && npm test`

Expected: every configuration, inspection, preparation, snapper, normalization, export, validation, learning, CLI, and end-to-end test passes.

- [ ] **Step 4: Run the private Pop T acceptance fixture**

Copy the supplied `PopTidle-pixel-snapper.png` into `examples/private/` without staging it. Run:

```bash
node skills/pixel-sprite-animation-pipeline/scripts/cli.mjs prepare \
  --input examples/private/PopTidle-pixel-snapper.png \
  --output generated/pop-t-anchor
```

Expected measurements:

- Source remains 123 x 126 with 15 colors.
- Canonical output is 128 x 128.
- Generation plate is 1024 x 1024.
- Pixel matrix is 1024 x 1024 with 8 x 8 blocks.
- Runtime anchor is 256 x 256.
- Canonical last shoe pixel is y=111 and pivot baseline is y=112.
- Runtime last shoe block ends at y=223 and pivot baseline is y=224.

- [ ] **Step 5: Install the personal skill using the skill-creator workflow**

Set `SKILLS_ROOT=/root/.codex/skills/remote-skills`. Create `skill-pixel-sprite-animation-pipeline/` there and copy only `SKILL.md`, `agents/`, `scripts/`, `references/`, `package.json`, and `package-lock.json` from the reviewed repository version. Do not copy tests, private fixtures, generated outputs, or repository documentation.

Run `npm ci --omit=dev` inside the installed skill directory before its local acceptance test. Do not stage or commit `node_modules/`; each execution environment restores dependencies from the lockfile when needed.

Run:

```bash
python /root/.codex/skills/oai/skill-creator/scripts/quick_validate.py \
  /root/.codex/skills/remote-skills/skill-pixel-sprite-animation-pipeline
```

Expected: `Skill is valid!`

- [ ] **Step 6: Commit and push the personal skill as one operation**

```bash
git -C /root/.codex/skills/remote-skills add skill-pixel-sprite-animation-pipeline
git -C /root/.codex/skills/remote-skills commit -m "feat: install pixel sprite animation pipeline skill"
git -C /root/.codex/skills/remote-skills push origin "$(git -C /root/.codex/skills/remote-skills branch --show-current)"
```

If push is rejected as non-fast-forward, fetch and rebase the same branch, then retry at most three times. Never force-push.

- [ ] **Step 7: Verify the remote installed paths**

Wait for reconciliation, fetch the personal-skills branch, then run:

```bash
git -C /root/.codex/skills/remote-skills ls-tree -r --name-only \
  "origin/$(git -C /root/.codex/skills/remote-skills branch --show-current)" |
  rg '^skill-pixel-sprite-animation-pipeline/'
```

Expected: the installed skill files appear and no `tests/`, `examples/private/`, or `generated/` paths are present.

- [ ] **Step 8: Commit repository CI and acceptance test**

```bash
git add .github/workflows/pixel-sprite-skill.yml skills/pixel-sprite-animation-pipeline/tests/e2e.test.mjs skills/pixel-sprite-animation-pipeline/package.json skills/pixel-sprite-animation-pipeline/package-lock.json
git commit -m "test: verify pixel sprite skill across platforms"
```

- [ ] **Step 9: Final repository verification**

Run:

```bash
git status --short
cd skills/pixel-sprite-animation-pipeline && npm test
python /root/.codex/skills/oai/skill-creator/scripts/quick_validate.py .
```

Expected: clean Git status, all tests passing, and valid skill metadata.
