# Game Character Animation Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an auditable `game-character-pipeline` skill that imports timing-aware motion media, supports non-destructive frame authoring and approval, delegates authenticated pixel finishing to `pixel-sprite-animation-pipeline`, and exports reproducible engine-neutral animation packages.

**Architecture:** A new sibling Node.js skill owns immutable source intake, versioned run state, Frame Studio, approvals, and orchestration. Format-specific adapters converge on composited RGBA frames plus exact durations; Frame Studio writes edit metadata rather than mutating sources; the existing pixel pipeline gains a generic version-2 animation contract and remains the only snap/normalize/export validation boundary. ComfyUI is excluded from this initial plan and may later implement the same motion-source interface.

**Tech Stack:** Node.js 20.9+ ESM, `commander` 15.0.0, `sharp` 0.35.3/libvips, `ffmpeg-static` 5.2.0, `ffprobe-static` 3.1.0, browser-native ES modules and Web Components, Node `node:test`, Playwright 1.54.1, Python 3 skill validation, GitHub Actions on Ubuntu and Windows.

**Scope and sequencing:** The approved design spans contracts, media decoding, an authoring UI, deterministic production, and acceptance audits. They remain in one ordered plan because each stage produces the authenticated contract consumed by the next, but Tasks 1-3, 4-6, 7-10, 11-13, and 14-16 are deliberate review checkpoints and may ship as separate PRs. Do not start a later checkpoint until the prior checkpoint is green and reviewed.

## Global Constraints

- All implementation and public fixtures stay in `/mnt/2TBHDD/GameDevStuff`; do not modify `CockpitEscapeRoom`.
- Keep private Pop T media, manifests, reports, previews, and exports outside Git and outside npm package contents.
- Preserve immutable source bytes, source hashes, original timing, decoder identity, and every approved revision.
- Animated GIF, APNG, and WebP frames must be fully composited using their disposal and blend rules before they become working RGBA frames.
- PNG sequences require explicit order and one duration per frame; video uses decoded presentation timestamps and never assumes constant frame rate.
- Pixel stages use nearest-neighbor resampling and one project-wide integer scale; never fit, crop, rotate, or scale each frame independently.
- Frame Studio edits are metadata; rendered revisions are new hash-bound derivatives.
- Pivots and sockets are authored against visible pixels; props and effects stay on separate named tracks.
- Ground travel is permitted only inside authored travel intervals and must agree with planted-foot contact windows.
- Clips declare `loop`, `once`, or `hold-last`; noncyclic clips never silently restart.
- Source, approval, clip-membership, edit, snap-receipt, and export hash mismatches fail closed.
- Unknown schema fields fail validation; all portable paths are relative, forward-slash separated, symlink-free, and Windows-safe.
- New subprocesses use explicit argv arrays with `shell: false`, bounded output, and recorded executable identity.
- The default creative path is the environment's built-in image generation, but generated stills must be copied into `source/` and approved before use.
- ComfyUI, Wan models, model downloads, and GPU capability claims are excluded from initial acceptance.
- Implementation follows red-green-refactor TDD; every task ends with focused tests, the affected package suite, and an intentional commit.

---

## File Map

### New skill package

- `skills/game-character-pipeline/package.json` and `npm-shrinkwrap.json` — locked runtime, CLI, browser-test, and package boundaries.
- `skills/game-character-pipeline/SKILL.md` and `agents/openai.yaml` — end-to-end agent workflow and UI metadata.
- `skills/game-character-pipeline/scripts/cli.mjs` — `init`, `intake`, `studio`, `render`, `approve`, `produce`, `validate`, and `audit` commands.
- `skills/game-character-pipeline/scripts/validate-skill.mjs` — portable discovery and invocation of the official Python 3 skill validator.
- `skills/game-character-pipeline/scripts/lib/schema.mjs` — closed-object, scalar, path, date, and hash validators.
- `skills/game-character-pipeline/scripts/lib/artifacts.mjs` — immutable copy/write, canonical hashing, revision allocation, and containment checks.
- `skills/game-character-pipeline/scripts/lib/project-contract.mjs` — project brief and global scale profile contract.
- `skills/game-character-pipeline/scripts/lib/run-contract.mjs` — run state, source, edit, approval, clip, export, and provenance contracts.
- `skills/game-character-pipeline/scripts/lib/source-adapter.mjs` — common motion-source result and adapter registry.
- `skills/game-character-pipeline/scripts/lib/generated-still.mjs` — built-in image-generation handoff and immutable candidate intake.
- `skills/game-character-pipeline/scripts/lib/png-sequence.mjs` — ordered lossless sequence intake.
- `skills/game-character-pipeline/scripts/lib/animated-image.mjs` — GIF/APNG/WebP metadata inspection and composited RGBA extraction.
- `skills/game-character-pipeline/scripts/lib/gif-container.mjs`, `apng-container.mjs`, and `webp-container.mjs` — disposal, blend, rectangle, alpha, duration, and corruption diagnostics.
- `skills/game-character-pipeline/scripts/lib/video.mjs` — pinned ffprobe/ffmpeg timestamp extraction and dense PNG decode.
- `skills/game-character-pipeline/scripts/lib/edits.mjs` — non-destructive edit validation and deterministic replay.
- `skills/game-character-pipeline/scripts/lib/approval.mjs` — authenticated approval records and selected-frame binding.
- `skills/game-character-pipeline/scripts/lib/pixel-pipeline.mjs` — structured delegation to the existing sibling package.
- `skills/game-character-pipeline/scripts/lib/export-contract.mjs` — engine-neutral clip package and validation report.
- `skills/game-character-pipeline/scripts/lib/audit.mjs` — repeat-run hash comparison and audit report generation.

### Frame Studio

- `skills/game-character-pipeline/scripts/studio/server.mjs` — loopback-only static/API server with optimistic revision checks.
- `skills/game-character-pipeline/studio/index.html` — accessible application shell.
- `skills/game-character-pipeline/studio/app.mjs` — project loading, selection, playback, save, approval, and error state.
- `skills/game-character-pipeline/studio/frame-canvas.mjs` — integer zoom, nearest-neighbor rendering, onion skin, seam, and overlays.
- `skills/game-character-pipeline/studio/timeline.mjs` — ordered frames, real-duration playback, labels, inclusion, duplication, and replacement.
- `skills/game-character-pipeline/studio/markers.mjs` — pivot, baseline, feet, sockets, contacts, tracks, and ground-travel editing.
- `skills/game-character-pipeline/studio/styles.css` — desktop and narrow-browser presentation, focus, contrast, and reduced motion.

### Public fixtures and tests

- `skills/game-character-pipeline/tests/fixtures/` — purpose-built PNG, GIF disposal, APNG alpha, WebP timing, and timestamped video fixtures plus expected manifests.
- `skills/game-character-pipeline/tests/*.test.mjs` — unit and integration coverage mirroring each runtime unit.
- `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs` — Playwright interaction and visual behavior.
- `skills/game-character-pipeline/examples/clockwork-courier/` — original public project, approved anchor, source media, edit metadata, and expected audit hashes.

### Existing deterministic package changes

- `skills/pixel-sprite-animation-pipeline/scripts/lib/animation-contract.mjs` — preserve Pop T v1 and add generic v2 parsing.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/frame-approval.mjs` — accept v2 named landmarks and sockets while preserving signed v1 behavior.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/normalize.mjs` — apply one scale plus authored translations to actor/prop/effect tracks.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/export.mjs` — emit stable semantic IDs, nonuniform timing, tracks, pivots, sockets, contacts, and loop mode.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/validate.mjs` — enforce v2 scale, drift, attachment, contact, clipping, timing, and approval bindings.
- `skills/pixel-sprite-animation-pipeline/scripts/cli.mjs` — expose a machine-readable `produce-contract` command.

### Repository integration

- `references/donors/game-character-animation.json` — exact donor pins, licenses, adopted ideas, rejected behavior, and per-file provenance.
- `LICENSES/THIRD_PARTY.md` — dependency and adapted-code notices.
- `.github/workflows/game-character-pipeline.yml` — locked install, unit/integration/browser tests, skill validation, package audit, and fixture reproducibility.
- `.gitignore` — local run state, private audit output, browser artifacts, and downloaded caches.

---

### Task 1: Package Boundary and Donor Ledger

**Files:**
- Create: `skills/game-character-pipeline/package.json`
- Create: `skills/game-character-pipeline/scripts/cli.mjs`
- Create: `skills/game-character-pipeline/scripts/validate-skill.mjs`
- Create: `skills/game-character-pipeline/tests/cli.test.mjs`
- Create: `references/donors/game-character-animation.json`
- Create: `LICENSES/THIRD_PARTY.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces CLI process contract: JSON on stdout, actionable errors on stderr, exit `0` success, `1` usage/runtime error, `2` resumable external handoff, `3` objective validation failure, `4` owner review required.
- Produces donor record fields `{ repository, commit, license, contribution, rejected, mode, files }`.

- [ ] **Step 1: Write the failing package and CLI tests**

```js
test('CLI advertises the complete initial command surface', async () => {
  const result = await execFile(process.execPath, ['scripts/cli.mjs', '--help'], { cwd: packageDir });
  for (const command of ['init', 'intake', 'studio', 'render', 'approve', 'produce', 'validate', 'audit']) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});
```

- [ ] **Step 2: Run the test and verify the package is absent**

Run: `cd skills/game-character-pipeline && node --test tests/cli.test.mjs`

Expected: FAIL because `package.json` and `scripts/cli.mjs` do not exist.

- [ ] **Step 3: Create the package and closed CLI skeleton**

```json
{
  "name": "game-character-pipeline",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.9.0" },
  "bin": { "game-character-pipeline": "scripts/cli.mjs" },
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "test:browser": "playwright test tests/browser",
    "validate-skill": "node scripts/validate-skill.mjs"
  },
  "dependencies": {
    "commander": "15.0.0",
    "ffmpeg-static": "5.2.0",
    "ffprobe-static": "3.1.0",
    "sharp": "0.35.3"
  },
  "devDependencies": { "@playwright/test": "1.54.1" },
  "files": ["SKILL.md", "agents/", "scripts/", "studio/"]
}
```

Use `Command` from Commander, set `.showHelpAfterError()`, register every command, and make each not-yet-available action throw `command is not available in this package revision`; each later task replaces the corresponding action and its test, so an incomplete command can never report success.

- [ ] **Step 4: Add the exact donor and dependency review records**

Record the four repositories and commits from the design, their Apache-2.0/MIT licenses, `mode: "concept-only"`, empty `files`, the adopted concepts, and every explicitly rejected behavior. Record `sharp`, `ffmpeg-static`, `ffprobe-static`, `commander`, and Playwright in `LICENSES/THIRD_PARTY.md`; block package installation if any license or binary redistribution entry lacks a reviewed disposition.

- [ ] **Step 5: Add portable validator discovery and lock dependencies**

```js
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const validator = path.join(codexRoot, 'skills', '.system', 'skill-creator', 'scripts', 'quick_validate.py');
const python = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(python, [validator, '.'], { cwd: packageRoot, stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
```

Run: `cd skills/game-character-pipeline && npm install && npm shrinkwrap`

Expected: `npm-shrinkwrap.json` is created and every direct dependency exactly matches `package.json`.

- [ ] **Step 6: Run tests and commit**

Run: `cd skills/game-character-pipeline && npm test && npm pack --dry-run`

Expected: CLI test PASS; package output excludes tests, fixtures, examples, private data, and local run state.

```bash
git add .gitignore LICENSES/THIRD_PARTY.md references/donors/game-character-animation.json skills/game-character-pipeline
git commit -m "chore: scaffold game character pipeline"
```

---

### Task 2: Closed Project and Animation Contracts

**Files:**
- Create: `skills/game-character-pipeline/scripts/lib/schema.mjs`
- Create: `skills/game-character-pipeline/scripts/lib/project-contract.mjs`
- Create: `skills/game-character-pipeline/tests/project-contract.test.mjs`
- Create: `skills/game-character-pipeline/tests/fixtures/project.valid.json`

**Interfaces:**
- Produces `validateProjectContract(document) -> Readonly<ProjectContract>`.
- Produces `loadProjectContract(file) -> Promise<{ document, sha256 }>`.
- `ProjectContract` fixes `schemaVersion: 1`, character anchors, canvas, global integer scale, palette, actions, tracks, sockets, contacts, engine targets, sources, and approval identities.

- [ ] **Step 1: Write failing closed-schema and invariant tests**

```js
test('project contract binds one global scale and explicit action behavior', () => {
  const project = validateProjectContract(validProject());
  assert.equal(project.scale.integer, 2);
  assert.deepEqual(project.actions.map(({ id, loopMode }) => [id, loopMode]), [['idle', 'loop'], ['unlock', 'hold-last']]);
});

test('project contract rejects unknown fields and per-action scale', () => {
  assert.throws(() => validateProjectContract({ ...validProject(), surprise: true }), /unknown project field: surprise/);
  const changed = validProject();
  changed.actions[0].scale = 3;
  assert.throws(() => validateProjectContract(changed), /unknown action field: scale/);
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test tests/project-contract.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `project-contract.mjs`.

- [ ] **Step 3: Implement reusable strict validators**

```js
export function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`${label} ${key} is required`);
  return value;
}

export function portableId(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new Error(`${label} must be a portable ID`);
  return value;
}
```

Also implement `sha256Value`, `sha256File`, `hashString`, `integer`, `finiteNumber`, `isoDate`, `uniqueList`, `portableRelativePath`, and recursive `deepFreeze` with unit coverage through the project-contract tests.

- [ ] **Step 4: Implement and freeze the project contract**

Validate exact keys for every nested record. Require a leading transparent palette entry, at most 16 opaque colors for Pixel Snapper, one actor track, unique prop/effect tracks, unique named sockets, contact names that reference known tracks, `loop|once|hold-last`, and one preferred plus ordered fallback source kind per action. Hash the stable JSON value after validation.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/project-contract.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add skills/game-character-pipeline/scripts/lib/schema.mjs skills/game-character-pipeline/scripts/lib/project-contract.mjs skills/game-character-pipeline/tests/project-contract.test.mjs skills/game-character-pipeline/tests/fixtures/project.valid.json
git commit -m "feat: define character project contracts"
```

---

### Task 3: Immutable Run and Artifact Store

**Files:**
- Create: `skills/game-character-pipeline/scripts/lib/artifacts.mjs`
- Create: `skills/game-character-pipeline/scripts/lib/run-contract.mjs`
- Create: `skills/game-character-pipeline/tests/artifacts.test.mjs`
- Create: `skills/game-character-pipeline/tests/run-contract.test.mjs`
- Modify: `skills/game-character-pipeline/scripts/cli.mjs`

**Interfaces:**
- Produces `createProject({ root, contractFile })`, `createRun({ projectRoot, project, sourceRequest })`, `copyImmutable({ source, root, relative })`, and `writeRevision({ root, area, stem, value })`.
- Run layout is exactly `source/`, `work/`, `edits/`, `approved/`, `exports/`, `reports/`, and `run.json`.
- Produces append-only `run.json` with `{ schemaVersion, id, projectSha256, createdAt, sourceRequest, state, artifacts, decoder }`.

- [ ] **Step 1: Write failing immutability, traversal, collision, and resume tests**

```js
test('createRun allocates a complete append-only run', async () => {
  const created = await createRun({ projectRoot, project, sourceRequest: request });
  assert.deepEqual((await fs.readdir(created.root)).sort(), ['approved', 'edits', 'exports', 'reports', 'run.json', 'source', 'work']);
  await assert.rejects(createRun({ projectRoot, project, sourceRequest: request, id: created.id }), /already exists/);
});

test('immutable copy rejects symlinks, links, traversal, and changed retry bytes', async () => {
  await assert.rejects(copyImmutable({ source: symlink, root, relative: 'source/a.png' }), /regular single-link file/);
  await assert.rejects(copyImmutable({ source: png, root, relative: '../escape.png' }), /contained portable path/);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/artifacts.test.mjs tests/run-contract.test.mjs`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement secure append-only writes**

Use `lstat`, `realpath`, link-count checks, `COPYFILE_EXCL`, temporary files opened with `wx`, `fsync`, and same-directory hard-link publication. A retry may return the existing artifact only when both its content hash and canonical JSON bytes match exactly.

- [ ] **Step 4: Implement `init` and run allocation**

`init --contract <file> --project-dir <dir>` copies the validated contract to `project.json` and prints `{ status: "created", projectDir, projectSha256 }`. `intake` allocates a Windows-safe run ID and never accepts a caller-selected path outside `<project>/.game-character-pipeline/runs/`.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/artifacts.test.mjs tests/run-contract.test.mjs tests/cli.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add skills/game-character-pipeline/scripts/cli.mjs skills/game-character-pipeline/scripts/lib/artifacts.mjs skills/game-character-pipeline/scripts/lib/run-contract.mjs skills/game-character-pipeline/tests
git commit -m "feat: add immutable character runs"
```

---

### Task 4: Motion-Source Interface, Generated Stills, and PNG-Sequence Intake

**Files:**
- Create: `skills/game-character-pipeline/scripts/lib/source-adapter.mjs`
- Create: `skills/game-character-pipeline/scripts/lib/generated-still.mjs`
- Create: `skills/game-character-pipeline/scripts/lib/png-sequence.mjs`
- Create: `skills/game-character-pipeline/tests/source-adapter.test.mjs`
- Create: `skills/game-character-pipeline/tests/generated-still.test.mjs`
- Create: `skills/game-character-pipeline/tests/png-sequence.test.mjs`
- Create: `skills/game-character-pipeline/tests/fixtures/png-sequence/manifest.json`

**Interfaces:**
- Produces `registerSourceAdapter(kind, decode)` and `decodeMotionSource({ kind, source, run, options })`.
- Every adapter returns `{ kind, sourceSha256, decoder, canvas, alpha, timeBase, frames, diagnostics }`.
- Every frame is `{ index, id, path, sha256, width, height, timestampMs, durationMs, sourceRect, duplicateOf }`.
- Produces `createGenerationHandoff({ project, run, actionId })` with approved anchor hashes, pose delta, palette/canvas constraints, and structured resume argv; the environment performs image generation, then `importGeneratedCandidate` copies returned bytes into immutable source state.

- [ ] **Step 1: Write failing ordering and timing tests**

```js
test('PNG intake preserves explicit order and nonuniform durations', async () => {
  const result = await decodePngSequence({ manifest: fixture('png-sequence/manifest.json'), run });
  assert.deepEqual(result.frames.map((frame) => frame.durationMs), [80, 120, 200]);
  assert.deepEqual(result.frames.map((frame) => frame.id), ['step-contact', 'step-pass', 'step-contact-2']);
});

test('PNG intake rejects lexical guessing and omitted timing', async () => {
  await assert.rejects(decodePngSequence({ files: ['1.png', '2.png'], run }), /explicit sequence manifest/);
});

test('generated candidates remain unapproved immutable sources', async () => {
  const handoff = createGenerationHandoff({ project, run, actionId: 'unlock' });
  assert.deepEqual(handoff.next.argv.slice(0, 3), [process.execPath, cliPath, 'intake']);
  const imported = await importGeneratedCandidate({ handoff, source: generatedPng, run });
  assert.equal(imported.approval, null);
  assert.match(imported.sourceSha256, /^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/source-adapter.test.mjs tests/generated-still.test.mjs tests/png-sequence.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the closed adapter registry and result validator**

Reject unregistered kinds, adapter results with absolute paths, absent timing, unordered indices, mismatched canvases, changed hashes, negative timestamps, zero durations, and unknown diagnostics. Freeze the returned result before writing `reports/source.json`.

- [ ] **Step 4: Implement lossless PNG intake**

Read the manifest in declared order, verify every source file is a single-link PNG, copy it into `source/`, decode RGBA with Sharp, preserve alpha, and publish an independently encoded lossless PNG under `work/decoded/`. Mark byte-identical decoded frames with `duplicateOf` but never remove them.

- [ ] **Step 5: Implement built-in image-generation handoff and resume**

When no still candidate is supplied, print exit `2` JSON containing the exact approved anchor paths/hashes, action pose delta, negative constraints, canvas/palette requirements, and structured `next.cwd`/`next.argv` with a `<GENERATED_IMAGE>` token. On resume, verify the canonical handoff hash, copy the returned PNG into `source/generated/`, decode it through the same lossless path, and require Frame Studio approval; never treat a chat image URL, generation event, or successful copy as artistic approval.

- [ ] **Step 6: Run tests and commit**

Run: `node --test tests/source-adapter.test.mjs tests/generated-still.test.mjs tests/png-sequence.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add skills/game-character-pipeline/scripts/lib/source-adapter.mjs skills/game-character-pipeline/scripts/lib/generated-still.mjs skills/game-character-pipeline/scripts/lib/png-sequence.mjs skills/game-character-pipeline/tests
git commit -m "feat: import timed PNG sequences"
```

---

### Task 5: GIF, APNG, and Animated WebP Intake

**Files:**
- Create: `skills/game-character-pipeline/scripts/lib/gif-container.mjs`
- Create: `skills/game-character-pipeline/scripts/lib/apng-container.mjs`
- Create: `skills/game-character-pipeline/scripts/lib/webp-container.mjs`
- Create: `skills/game-character-pipeline/scripts/lib/animated-image.mjs`
- Create: `skills/game-character-pipeline/tests/animated-image.test.mjs`
- Create: `skills/game-character-pipeline/tests/fixtures/animated/`

**Interfaces:**
- Produces `inspectGif(bytes)`, `inspectApng(bytes)`, and `inspectAnimatedWebp(bytes)` returning ordered `{ rect, durationMs, dispose, blend, hasAlpha }` records.
- Produces `decodeAnimatedImage({ source, run }) -> MotionSourceResult` using Sharp/libvips for full composited RGBA pages and container parsers for auditable metadata.

- [ ] **Step 1: Add purpose-built fixtures and failing tests**

```js
test('GIF disposal restores the prior composited pixels and keeps delays', async () => {
  const result = await decodeAnimatedImage({ source: fixture('animated/disposal-previous.gif'), run });
  assert.deepEqual(result.frames.map((frame) => frame.durationMs), [70, 130, 90]);
  assert.equal(await pixel(result.frames[2].path, 3, 3), '00000000');
  assert.equal(result.diagnostics.some(({ code }) => code === 'PARTIAL_SOURCE_RECT'), true);
});

test('APNG and WebP retain alpha and blend metadata', async () => {
  for (const name of ['alpha.apng.png', 'alpha.webp']) {
    const result = await decodeAnimatedImage({ source: fixture(`animated/${name}`), run: freshRun() });
    assert.equal(result.alpha, true);
    assert.equal(result.frames.every((frame) => frame.width === result.canvas.width), true);
  }
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test tests/animated-image.test.mjs`

Expected: FAIL because the animated-image decoder does not exist.

- [ ] **Step 3: Implement bounded container parsers**

GIF parsing walks headers, global/local color tables, GCE blocks, image descriptors, sub-block lengths, and trailer; APNG parsing validates PNG CRCs and reads `acTL`/ordered `fcTL`/`fdAT`; WebP parsing validates RIFF bounds and reads `VP8X`/`ANIM`/ordered `ANMF`. Reject truncated chunks, frame rectangles outside canvas, missing terminal data, frame-count disagreement, zero delays, and more than 10,000 frames or 512 MiB decoded RGBA.

- [ ] **Step 4: Decode full composited pages**

Use `sharp(source, { animated: true, pages: -1, limitInputPixels: 268435456 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })`; split the stacked output by `pageHeight`, verify its page count and dimensions against parsed metadata, and write each full RGBA page as a new lossless PNG. Record `sharp.versions.vips`, format, source hash, parser version, and decoder arguments in `decoder`.

- [ ] **Step 5: Add corruption and duplicate diagnostics**

Emit only the closed codes `ZERO_DELAY`, `DUPLICATE_FRAME`, `EMPTY_FRAME`, `PARTIAL_SOURCE_RECT`, `DISPOSAL_RESTORE_BACKGROUND`, `DISPOSAL_RESTORE_PREVIOUS`, and `ALPHA_PRESENT`. Corruption is an exception and never a warning.

- [ ] **Step 6: Run tests and commit**

Run: `node --test tests/animated-image.test.mjs && npm test`

Expected: all fixtures PASS; corrupt and page-count mismatch fixtures fail closed.

```bash
git add skills/game-character-pipeline/scripts/lib/*container.mjs skills/game-character-pipeline/scripts/lib/animated-image.mjs skills/game-character-pipeline/tests
git commit -m "feat: decode animated motion sources"
```

---

### Task 6: Timestamp-Aware Video Intake

**Files:**
- Create: `skills/game-character-pipeline/scripts/lib/video.mjs`
- Create: `skills/game-character-pipeline/tests/video.test.mjs`
- Create: `skills/game-character-pipeline/tests/fixtures/video/variable-rate.webm`
- Create: `skills/game-character-pipeline/tests/fixtures/video/expected.json`

**Interfaces:**
- Produces `inspectMediaTool(file, expectedName)` and `decodeVideo({ source, run, ffmpegPath, ffprobePath })`.
- Tool identity is `{ path, sha256, size, version }`; frame timestamps come from ffprobe `best_effort_timestamp_time` and durations from adjacent timestamps plus the final packet duration.

- [ ] **Step 1: Write failing variable-frame-rate and subprocess tests**

```js
test('video intake derives nonuniform durations from presentation timestamps', async () => {
  const result = await decodeVideo({ source: fixture('video/variable-rate.webm'), run, ffmpegPath, ffprobePath });
  assert.deepEqual(result.frames.map((frame) => frame.timestampMs), [0, 40, 140, 180]);
  assert.deepEqual(result.frames.map((frame) => frame.durationMs), [40, 100, 40, 80]);
});

test('video intake rejects missing timestamps and changed tool bytes', async () => {
  await assert.rejects(decodeVideo(injectedProbeWithoutTimestamps()), /presentation timestamp/);
  await assert.rejects(decodeVideo(injectedToolChangedAfterProbe()), /tool identity changed/);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/video.test.mjs`

Expected: FAIL with missing `video.mjs`.

- [ ] **Step 3: Implement pinned tool inspection and ffprobe parsing**

Resolve defaults from `ffmpeg-static` and `ffprobe-static`, reject caller paths that are not regular executable files, hash before and after use, capture version output, and run with `shell: false`, a 60-second timeout, 8 MiB stdout/stderr limits, and no inherited stdin. Ask ffprobe for stream dimensions, alpha pixel format, frame timestamps, and packet durations in JSON.

- [ ] **Step 4: Extract dense lossless frames**

Run ffmpeg with `-i <source> -map 0:v:0 -vsync 0 -pix_fmt rgba <work>/decoded/frame-%06d.png`; reject stderr indicating decode corruption, output-count disagreement, dimensions changing midstream, or absent final duration. Bind exact argv and both executable identities into the source report.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/video.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add skills/game-character-pipeline/scripts/lib/video.mjs skills/game-character-pipeline/tests
git commit -m "feat: import timestamped video motion"
```

---

### Task 7: Frame Studio Loopback Server and Edit Revision API

**Files:**
- Create: `skills/game-character-pipeline/scripts/studio/server.mjs`
- Create: `skills/game-character-pipeline/tests/studio-server.test.mjs`
- Modify: `skills/game-character-pipeline/scripts/cli.mjs`

**Interfaces:**
- Produces `startStudioServer({ projectDir, runId, stage: 'selection'|'post-snap', reviewManifest, host: '127.0.0.1', port: 0 }) -> { origin, close }`; the default selection manifest is the immutable decoded-source manifest, while Task 13 supplies a verified snap-receipt manifest for post-snap landmark approval.
- API: `GET /api/session`, `GET /api/frame/:sha256`, `PUT /api/edits`, and `POST /api/approval`.
- Mutations require `If-Match: <current-edit-sha256>` and return the new immutable revision/hash.

- [ ] **Step 1: Write failing containment, method, origin, and concurrency tests**

```js
test('studio serves only loopback and rejects stale edits', async () => {
  const studio = await startStudioServer({ projectDir, runId, stage: 'selection', reviewManifest, port: 0 });
  const session = await getJson(`${studio.origin}/api/session`);
  const first = await putJson(`${studio.origin}/api/edits`, edit, { 'If-Match': session.editSha256 });
  await assert.rejects(putJson(`${studio.origin}/api/edits`, edit, { 'If-Match': session.editSha256 }), /409/);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/studio-server.test.mjs`

Expected: FAIL because the server is absent.

- [ ] **Step 3: Implement the loopback-only server**

Reject non-loopback hosts, unknown methods, traversal and encoded traversal, missing content types, request bodies over 1 MiB, cross-origin mutation requests, and frames not present in the current source manifest. Send CSP `default-src 'self'; img-src 'self' blob:; connect-src 'self'`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store` on state endpoints.

- [ ] **Step 4: Wire the `studio` command**

`studio --project-dir <dir> --run <id>` prints `{ status: "ready", origin, runId }` once and stays alive until SIGINT/SIGTERM, then closes without editing state.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/studio-server.test.mjs tests/cli.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add skills/game-character-pipeline/scripts/cli.mjs skills/game-character-pipeline/scripts/studio/server.mjs skills/game-character-pipeline/tests/studio-server.test.mjs
git commit -m "feat: serve local Frame Studio state"
```

---

### Task 8: Frame Studio Playback, Selection, Onion Skin, and Cycle Seam

**Files:**
- Create: `skills/game-character-pipeline/studio/index.html`
- Create: `skills/game-character-pipeline/studio/app.mjs`
- Create: `skills/game-character-pipeline/studio/frame-canvas.mjs`
- Create: `skills/game-character-pipeline/studio/timeline.mjs`
- Create: `skills/game-character-pipeline/studio/styles.css`
- Create: `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`
- Create: `skills/game-character-pipeline/playwright.config.mjs`

**Interfaces:**
- Defines `<frame-canvas>` attributes `frame`, `previous`, `next`, `first`, `last`, `zoom`, `onion-opacity`, and `seam`.
- Defines `<frame-timeline>` property `frames` and events `frame-select`, `frame-include`, `frame-duplicate`, `frame-replace`, and `frame-label`.

- [ ] **Step 1: Write failing browser interactions**

```js
test('plays real durations and supports keyboard selection', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass', { timeout: 140 });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2');
});

test('uses integer zoom and disables interpolation', async ({ page }) => {
  await openFixture(page);
  await expect(page.locator('frame-canvas canvas')).toHaveCSS('image-rendering', 'pixelated');
  await expect(page.getByLabel('Zoom')).toHaveValue('4');
});
```

- [ ] **Step 2: Run browser tests**

Run: `npx playwright install chromium && npm run test:browser`

Expected: FAIL because Frame Studio assets do not exist.

- [ ] **Step 3: Implement accessible shell and exact-duration playback**

Use semantic buttons, labels, output/status regions, roving tab index on thumbnails, Space to play/pause, arrows to select, Home/End, and Delete only for exclusion. Playback advances by each selected frame's authored `durationMs`; `once` stops at the final frame and `hold-last` keeps it visible.

- [ ] **Step 4: Implement canvas overlays**

Render at source resolution into an offscreen canvas, then scale the visible canvas by an integer CSS size with smoothing disabled. Onion skin previous/next with adjustable alpha; seam mode overlays first/last; checkerboard, clipping bounds, duplicate, palette, and drift overlays are independent toggles.

- [ ] **Step 5: Verify desktop, narrow viewport, focus, and reduced motion**

Run: `npm run test:browser`

Expected: PASS at 1440x1000 and 420x900; no horizontal page overflow; visible focus ring; reduced-motion mode removes animated UI transitions without changing clip playback timing.

- [ ] **Step 6: Commit**

```bash
git add skills/game-character-pipeline/studio skills/game-character-pipeline/tests/browser skills/game-character-pipeline/playwright.config.mjs skills/game-character-pipeline/package.json skills/game-character-pipeline/npm-shrinkwrap.json
git commit -m "feat: add Frame Studio playback"
```

---

### Task 9: Markers, Tracks, Contacts, Timing, and Non-Destructive Edits

**Files:**
- Create: `skills/game-character-pipeline/studio/markers.mjs`
- Create: `skills/game-character-pipeline/scripts/lib/edits.mjs`
- Create: `skills/game-character-pipeline/tests/edits.test.mjs`
- Modify: `skills/game-character-pipeline/studio/app.mjs`
- Modify: `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`

**Interfaces:**
- Produces `validateEditManifest(document, context)` and `renderEditRevision({ run, source, edit })`.
- Edit frame record is `{ frameId, included, label, durationMs, translation, transform, markers, contacts, groundTravel, tracks }`.
- `transform` is `null` unless explicit owner opt-in supplies integer `rotationQuarterTurns` and integer `scale` for the entire clip revision.

- [ ] **Step 1: Write failing edit and browser tests**

```js
test('edit manifest permits translation but rejects implicit fitting', () => {
  const edit = validEdit();
  edit.frames[0].translation = { x: -2, y: 1 };
  assert.equal(validateEditManifest(edit, context).frames[0].translation.x, -2);
  edit.frames[0].transform = { scale: 1.25, rotationQuarterTurns: 0 };
  assert.throws(() => validateEditManifest(edit, context), /integer global transform/);
});

test('authors pivot, foot contact, socket, and travel without changing source', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('button', { name: 'Root pivot' }).click();
  await page.locator('frame-canvas canvas').click({ position: { x: 256, y: 448 } });
  await page.getByLabel('Planted left foot').check();
  await page.getByLabel('Ground travel X').fill('2');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toContainText('Saved edit revision 2');
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/edits.test.mjs && npm run test:browser`

Expected: FAIL with missing edit/marker implementations.

- [ ] **Step 3: Implement edit validation and replay**

Require exact frame coverage in source order, explicit inclusion, positive duration, integer translations, marker coordinates inside logical canvas, known track/socket/contact names, travel only during declared intervals, and one global opt-in transform. Replaying the same source/edit hashes must produce byte-identical transparent PNG derivatives.

- [ ] **Step 4: Implement marker authoring UI**

Add tools for root pivot, baseline, left/right planted foot, hand, prop grip, effect origin, and custom sockets. Separate actor/prop/effect tracks in the timeline, display contact spans, constrain numerical fields, expose undo by returning to the prior immutable revision, and require explicit confirmation before global rotation or scale repair.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/edits.test.mjs && npm run test:browser && npm test`

Expected: all tests PASS.

```bash
git add skills/game-character-pipeline/scripts/lib/edits.mjs skills/game-character-pipeline/studio skills/game-character-pipeline/tests
git commit -m "feat: author animation alignment metadata"
```

---

### Task 10: Approval Gate and Versioned Derivative Rendering

**Files:**
- Create: `skills/game-character-pipeline/scripts/lib/approval.mjs`
- Create: `skills/game-character-pipeline/tests/approval.test.mjs`
- Modify: `skills/game-character-pipeline/scripts/cli.mjs`
- Modify: `skills/game-character-pipeline/scripts/studio/server.mjs`
- Modify: `skills/game-character-pipeline/studio/app.mjs`

**Interfaces:**
- Produces `writeApproval({ run, project, editRevision, approver, decision, notes })` and `verifyApproval({ run, file, project, source, edit })`.
- Approval binds project, source report, complete selected-frame set, edit manifest, rendered derivatives, approver, decision, notes, and timestamp hashes.

- [ ] **Step 1: Write failing approval-chain tests**

```js
test('approval rejects changed membership, source, edit, or rendered bytes', async () => {
  const approved = await writeApproval(validApprovalRequest());
  await fs.appendFile(approved.derivatives[0].path, Buffer.from([0]));
  await assert.rejects(verifyApproval({ ...verification, file: approved.path }), /derivative hash mismatch/);
});

test('rejection records notes but cannot enter production', async () => {
  const rejected = await writeApproval({ ...validApprovalRequest(), decision: 'rejected', notes: 'foot contact unreadable' });
  await assert.rejects(requireProductionApproval(rejected), /owner approval required/);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/approval.test.mjs`

Expected: FAIL because approval support is absent.

- [ ] **Step 3: Implement approval and render commands**

`render --run <id> --edit <revision>` writes a new `work/revisions/<hash>/` tree and contact sheet without replacing prior bytes. `approve --run <id> --edit <revision> --approver <id> --decision approved|rejected --notes <text>` creates an append-only approval JSON; CLI exit is `4` for rejection or missing approval and `0` only for a verified approval.

- [ ] **Step 4: Add Studio approve/reject controls**

Display exact source/edit/render hashes, require nonempty notes for rejection, require the configured approver identity, and disable approval while unsaved edits exist.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/approval.test.mjs tests/studio-server.test.mjs && npm run test:browser && npm test`

Expected: all tests PASS.

```bash
git add skills/game-character-pipeline/scripts skills/game-character-pipeline/studio skills/game-character-pipeline/tests
git commit -m "feat: bind animation owner approvals"
```

---

### Task 11: Generic Version-2 Pixel Production Contract

**Files:**
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/animation-contract.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/animation-contract.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/frame-approval.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/frame-approval.test.mjs`

**Interfaces:**
- Preserves `validateAnimationContract(v1)` and every Pop T v1 invariant.
- Produces v2 `{ version: 2, selectionApprovalSha256, character, canvas, scale, palette, tracks, sockets, contacts, clips, review }`.
- Produces named post-snap per-frame landmarks `{ root, baseline, sockets, contacts, groundTravel }` bound to the snap receipt and snapped frame hashes; this is distinct from the pre-production Frame Studio selection approval in Task 10.

- [ ] **Step 1: Write failing v1-regression and generic-v2 tests**

```js
test('v1 remains byte-for-byte valid while v2 permits generic geometry', () => {
  assert.equal(validateAnimationContract(popTContract()).version, 1);
  const generic = validateAnimationContract(clockworkCourierContract());
  assert.equal(generic.version, 2);
  assert.deepEqual(generic.canvas, { width: 96, height: 96, pivot: { x: 48, y: 84 }, baseline: 83 });
});

test('v2 rejects per-frame scale and unknown socket references', () => {
  assert.throws(() => validateAnimationContract(v2WithFrameScale()), /unknown frame field: scale/);
  assert.throws(() => validateAnimationContract(v2WithUnknownSocket()), /unknown socket/);
});
```

- [ ] **Step 2: Run existing and new focused tests**

Run: `cd skills/pixel-sprite-animation-pipeline && node --test tests/animation-contract.test.mjs tests/frame-approval.test.mjs`

Expected: existing v1 tests PASS; new v2 tests FAIL.

- [ ] **Step 3: Add version-dispatched closed validation**

Keep the current v1 validator unchanged behind `validateAnimationContractV1`. Add `validateAnimationContractV2`, dispatch only versions 1 and 2, require a 64-character `selectionApprovalSha256`, one global integer scale, stable canvas, leading transparent palette entry, known track/socket/contact references, explicit per-frame duration and loop mode, and exact ordered semantic frame IDs.

- [ ] **Step 4: Extend signed frame approvals**

Bind v2 approval payloads to every actor/prop/effect frame hash and all named landmarks. Keep the existing domain and payload for v1; use domain `pixel-sprite-frame-approval/v2` and reject cross-version verification.

- [ ] **Step 5: Run suites and commit**

Run: `node --test tests/animation-contract.test.mjs tests/frame-approval.test.mjs && npm test`

Expected: all existing v1 and new v2 tests PASS.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/animation-contract.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/frame-approval.mjs skills/pixel-sprite-animation-pipeline/tests/animation-contract.test.mjs skills/pixel-sprite-animation-pipeline/tests/frame-approval.test.mjs
git commit -m "feat: add generic animation contract v2"
```

---

### Task 12: Multi-Track Normalization, Export, and Validation

**Files:**
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/normalize.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/normalize.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/export.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/export.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/validate.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/validate.test.mjs`

**Interfaces:**
- Produces normalized actor/prop/effect PNGs using one integer scale and approved per-frame translations.
- Produces engine-neutral JSON with semantic frame IDs, durations, loop mode, pivot, sockets, contacts, ground travel, track membership, source hashes, approval hash, snap receipt hash, and output hashes.

- [ ] **Step 1: Write failing stable-scale, attachment, contact, and restart tests**

```js
test('normalization keeps scale fixed and maps sockets exactly', async () => {
  const result = await normalizeContractFrames(v2Fixture());
  assert.equal(new Set(result.frames.map((frame) => frame.scale)).size, 1);
  assert.equal(result.frames.every((frame) => frame.sockets.hand.x === 52), true);
});

test('validation rejects foot travel outside contact windows and noncyclic restart', async () => {
  assertFailure(await validateRun(travelOutsideContact()), 'GROUND_TRAVEL_CONTACT');
  assertFailure(await validateRun(onceClipThatLoops()), 'NONCYCLIC_RESTART');
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/normalize.test.mjs tests/export.test.mjs tests/validate.test.mjs`

Expected: v1 tests PASS; new v2 tests FAIL.

- [ ] **Step 3: Implement v2 normalization**

Translate visible pixels from approved landmarks to the contract root without cropping, place prop/effect tracks relative to approved named sockets, and apply one project scale with nearest-neighbor only. Reject fractional transforms, clipped required pixels, source hash changes, and missing track frames.

- [ ] **Step 4: Extend exports and objective validation**

Emit transparent per-track frames, combined frames, sheets, engine-neutral JSON, contact sheets, and lossless animated WebP. Validate palette, alpha, canvas, scale, root drift, socket attachment, contacts/travel, clip membership, durations, loop semantics, clipping, and every provenance hash.

- [ ] **Step 5: Run suites and commit**

Run: `npm test`

Expected: zero failures for both contract versions.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/normalize.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/export.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/validate.mjs skills/pixel-sprite-animation-pipeline/tests
git commit -m "feat: produce stable multi-track animations"
```

---

### Task 13: Authenticated Orchestrator Delegation and Engine-Neutral Package

**Files:**
- Create: `skills/game-character-pipeline/scripts/lib/pixel-pipeline.mjs`
- Create: `skills/game-character-pipeline/scripts/lib/export-contract.mjs`
- Create: `skills/game-character-pipeline/tests/pixel-pipeline.test.mjs`
- Create: `skills/game-character-pipeline/tests/export-contract.test.mjs`
- Modify: `skills/game-character-pipeline/scripts/cli.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/cli.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/cli.test.mjs`

**Interfaces:**
- Existing CLI produces `produce-contract --contract <v2.json> --project-dir <dir> --output <new-dir> [--snap-receipt <signed.json> --frame-approval <signed-v2.json>]`.
- Orchestrator produces `runPixelProduction({ run, project, selectionApproval, pipelineCli, node, snapReceipt, frameApproval }) -> { exitCode, next, receipt, exports, report }`.
- The v2 contract binds `selectionApprovalSha256`; the optional post-snap `frameApproval` binds the existing pixel pipeline's authenticated snap receipt.

- [ ] **Step 1: Write failing structured-handoff and tamper tests**

```js
test('production uses argv without a shell and returns authenticated outputs', async () => {
  const result = await runPixelProduction({ ...completedFixture, spawn: recordingSpawn });
  assert.equal(recordingSpawn.options.shell, false);
  assert.deepEqual(recordingSpawn.argv.slice(0, 2), [pipelineCli, 'produce-contract']);
  assert.match(result.receipt.sha256, /^[a-f0-9]{64}$/);
});

test('first production pass stops for post-snap owner approval', async () => {
  const result = await runPixelProduction({ ...fixtureWithoutFrameApproval, spawn: recordingSpawn });
  assert.equal(result.exitCode, 4);
  assert.equal(result.next.kind, 'post-snap-frame-approval');
});

test('production rejects approval or membership changes before spawning', async () => {
  await assert.rejects(runPixelProduction(changedApprovalFixture()), /approval binding mismatch/);
  assert.equal(recordingSpawn.calls.length, 0);
});
```

- [ ] **Step 2: Run focused tests in both packages**

Run: `cd skills/pixel-sprite-animation-pipeline && node --test tests/cli.test.mjs && cd ../game-character-pipeline && node --test tests/pixel-pipeline.test.mjs tests/export-contract.test.mjs`

Expected: FAIL on missing `produce-contract` and delegation modules.

- [ ] **Step 3: Add the machine-readable deterministic command**

The pixel CLI verifies the v2 contract and its bound pre-production selection-approval hash before snapping. It prints exactly one JSON object; returns `2` with structured `next.cwd`/`next.argv` when Pixel Snapper is unavailable, returns `4` with the snap receipt and a structured post-snap Frame Studio handoff when the signed v2 frame approval is absent, returns `3` for objective failures, and continues to normalization only after the selected snap receipt and frame approval verify together.

- [ ] **Step 4: Implement orchestrator delegation and package verification**

Resolve the sibling CLI with `fileURLToPath`, verify the Task 10 selection approval before spawning, and spawn `process.execPath` plus argv with `shell: false`. Cap output at 8 MiB and forward exit `2`, `3`, and `4` without claiming completion. For exit `4`, reopen Frame Studio on the immutable snapped outputs so the owner can author v2 landmarks and sign the post-snap frame approval. On the resumed successful pass, re-hash every declared artifact, copy verified outputs into a new `exports/revision-<n>/`, and bind its manifest to project/source/edit/selection-approval/snap-receipt/frame-approval hashes.

- [ ] **Step 5: Run suites and commit**

Run: `cd skills/pixel-sprite-animation-pipeline && npm test && cd ../game-character-pipeline && npm test`

Expected: both suites PASS.

```bash
git add skills/pixel-sprite-animation-pipeline skills/game-character-pipeline
git commit -m "feat: orchestrate authenticated pixel production"
```

---

### Task 14: Audit Reports and Reproducibility Gate

**Files:**
- Create: `skills/game-character-pipeline/scripts/lib/audit.mjs`
- Create: `skills/game-character-pipeline/tests/audit.test.mjs`
- Modify: `skills/game-character-pipeline/scripts/cli.mjs`

**Interfaces:**
- Produces `auditRun({ run, project, expected }) -> { passed, deterministicHashes, evidence, failures, reviews }`.
- Produces `compareRuns(left, right)` that compares only deterministic derivatives while separately reporting timestamps, run IDs, and approval identities.

- [ ] **Step 1: Write failing repeatability and tamper tests**

```js
test('two equivalent runs have identical deterministic artifact hashes', async () => {
  const left = await completeFixtureRun({ clock: fixedClock('2026-07-21T12:00:00.000Z') });
  const right = await completeFixtureRun({ clock: fixedClock('2026-07-22T12:00:00.000Z') });
  assert.deepEqual(compareRuns(left, right).changedDeterministicArtifacts, []);
});

test('audit fails on interpolation, timing defaults, drift, clipping, and broken hashes', async () => {
  for (const mutation of auditMutations()) assert.equal((await auditRun(mutation)).passed, false);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/audit.test.mjs`

Expected: FAIL with missing audit module.

- [ ] **Step 3: Implement deterministic audit comparison**

Normalize reports by excluding explicitly nondeterministic envelope fields, then compare decoded frames, edit renders, normalized tracks, sheets, JSON, previews, contact sheets, and validation report hashes. Report failures for source/approval/output tampering, interpolation, missing timing, per-frame scale, pivot/socket drift, foot/travel disagreement, clipping, membership changes, and invalid loop semantics.

- [ ] **Step 4: Wire `validate` and `audit` commands**

`validate` checks one run and exits `3` for objective failures or `4` for subjective review items. `audit --run <id> --repeat <other-id>` writes a new report and succeeds only when both runs pass and deterministic hashes match.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/audit.test.mjs tests/cli.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add skills/game-character-pipeline/scripts/lib/audit.mjs skills/game-character-pipeline/scripts/cli.mjs skills/game-character-pipeline/tests/audit.test.mjs
git commit -m "feat: audit reproducible animation runs"
```

---

### Task 15: Clockwork Courier Public Acceptance Fixture and Full CI

**Files:**
- Create: `skills/game-character-pipeline/examples/clockwork-courier/project.json`
- Create: `skills/game-character-pipeline/examples/clockwork-courier/source/`
- Create: `skills/game-character-pipeline/examples/clockwork-courier/expected-audit.json`
- Create: `skills/game-character-pipeline/tests/e2e.test.mjs`
- Modify: `skills/game-character-pipeline/package.json`
- Create: `.github/workflows/game-character-pipeline.yml`

**Interfaces:**
- Public fixture is an original right-facing brass courier with cap and satchel, actor/prop/effect tracks, `idle` loop, `walk` loop, and `unlock` hold-last action.
- `npm run acceptance` executes the committed fixture twice and compares deterministic hashes.

- [ ] **Step 1: Create the original fixture source and failing end-to-end test**

```js
test('Clockwork Courier completes the public workflow reproducibly', async () => {
  const first = await runClockworkCourier(tempRoot('courier-a-'));
  const second = await runClockworkCourier(tempRoot('courier-b-'));
  assert.equal(first.audit.passed, true);
  assert.deepEqual(compareRuns(first, second).changedDeterministicArtifacts, []);
  assert.deepEqual(first.exports.clips.map(({ id, loopMode }) => [id, loopMode]), [['idle', 'loop'], ['walk', 'loop'], ['unlock', 'hold-last']]);
});
```

- [ ] **Step 2: Run the end-to-end test**

Run: `node --test tests/e2e.test.mjs`

Expected: FAIL until fixture manifests, source files, approvals, and expected hashes are complete.

- [ ] **Step 3: Complete and license the fixture**

Store only original GameDevStuff-owned artwork and media. Include explicit nonuniform timing, partial-frame animated-image behavior, one prop socket, one effect socket, planted-foot contacts, and ground travel. Record fixture authorship and CC0-1.0 dedication in `LICENSES/THIRD_PARTY.md`; keep generated or third-party donor pixels out.

Add `"acceptance": "node --test tests/e2e.test.mjs"` to `package.json`; do not fold the browser suite into this command because the deterministic fixture gate and browser interaction gate report separately.

- [ ] **Step 4: Add full CI gates**

Add Ubuntu unit/integration/acceptance jobs, Ubuntu Playwright Chromium at 1440x1000 and 420x900, Windows unit/path tests, `npm pack --dry-run`, `python3` skill validation, dependency license checks, and an acceptance artifact upload containing only public reports/contact sheets/previews. Pin every action to a reviewed full commit SHA before merge.

- [ ] **Step 5: Run the complete local gate and commit**

Run: `cd skills/pixel-sprite-animation-pipeline && umask 0022 && npm test && cd ../game-character-pipeline && umask 0022 && npm test && npm run test:browser && npm run acceptance && npm pack --dry-run`

Expected: both package suites, browser tests, repeated fixture audit, and package audit PASS with zero failures.

```bash
git add .github/workflows/game-character-pipeline.yml LICENSES/THIRD_PARTY.md skills/game-character-pipeline/examples skills/game-character-pipeline/tests skills/game-character-pipeline/package.json skills/game-character-pipeline/npm-shrinkwrap.json
git commit -m "test: prove public character workflow"
```

---

### Task 16: Skill Guidance, Scenario Evals, and Private Pop T Audit Gate

**Files:**
- Create: `skills/game-character-pipeline/SKILL.md`
- Create: `skills/game-character-pipeline/agents/openai.yaml`
- Create: `skills/game-character-pipeline/references/workflow.md`
- Create: `skills/game-character-pipeline/references/frame-studio.md`
- Create: `skills/game-character-pipeline/references/motion-sources.md`
- Create: `skills/game-character-pipeline/references/private-audit.md`
- Create: `skills/game-character-pipeline/tests/skill-scenarios.json`
- Create: `skills/game-character-pipeline/tests/skill-scenarios.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Skill route covers approved character anchor, character brief, sprite animation, GIF/APNG/WebP/video/PNG intake, Frame Studio, pivots, sockets, contacts, Pixel Snapper delegation, and engine export.
- Private audit command accepts paths outside the repository and writes under an ignored operator-selected audit root.

- [ ] **Step 1: Define and run baseline scenarios before creating `SKILL.md`**

Create `skill-scenarios.json` with the raw user prompts and fixture paths for: imported GIF with disposal, video without timestamps, requested per-frame auto-fit, changed approved source, missing socket, once clip set to loop, unavailable ComfyUI, and a request to copy Pop T output into CockpitEscapeRoom. Run fresh-context agents without the new skill, pass only one raw scenario per agent, and save the uncommitted baseline outputs outside the skill directory. For any wording intended to change behavior, run a no-guidance control and at least five fresh-context samples; read every output rather than scoring keyword counts alone.

Expected: the baseline evidence records the exact omissions or rationalizations that the minimal skill must correct and contains no private asset bytes. If controls already comply consistently, omit guidance for that behavior.

- [ ] **Step 2: Initialize the skill metadata after RED evidence exists**

Read `/home/user1/.codex/skills/.system/skill-creator/references/openai_yaml.md`, run `init_skill.py` against a temporary directory, and use its generated structure to create only `SKILL.md`, `agents/openai.yaml`, and the four required references in the existing package. The skill name is exactly `game-character-pipeline`; frontmatter contains only `name` and a third-person description beginning `Use when...` that lists trigger situations without summarizing the workflow. Generate `agents/openai.yaml` with `generate_openai_yaml.py` and explicit `display_name`, `short_description`, and `default_prompt` values derived from the completed skill.

Run:

```bash
character_skill_scaffold="$(mktemp -d)"
python3 /home/user1/.codex/skills/.system/skill-creator/scripts/init_skill.py game-character-pipeline --path "$character_skill_scaffold" --resources scripts,references --interface display_name="Game Character Pipeline" --interface short_description="Build and audit pixel-character animation workflows" --interface default_prompt='Use $game-character-pipeline to create or audit this character animation workflow.'
```

Expected: the temporary scaffold validates and no template, example, or placeholder file is copied into the repository.

- [ ] **Step 3: Author the minimal operational skill from the baseline failures**

Require project-contract validation, immutable intake, complete decode diagnostics, Frame Studio review, explicit approval, authenticated pixel-pipeline delegation, objective validation, and audit. Route unavailable ComfyUI to import with generation recorded as skipped. Explicitly forbid CockpitEscapeRoom modification and private-asset publication.

- [ ] **Step 4: Rerun and refactor the skill scenarios**

Run the same fresh-context scenarios with `SKILL.md` loaded, passing raw artifacts rather than expected answers. Add only counters for newly observed rationalizations, then repeat until all five samples per changed wording converge. `skill-scenarios.test.mjs` validates that every scenario has a unique ID, raw prompt, fixture boundary, expected command family, expected exit class, and forbidden behavior list.

Run: `node --test tests/skill-scenarios.test.mjs`

Expected: all scenarios select the correct command/stop rule; no scenario silently defaults timing, rescales frames, bypasses approval, claims ComfyUI success, or crosses the repository boundary.

- [ ] **Step 5: Validate discovery metadata and installed-skill shape**

Run: `cd skills/game-character-pipeline && npm run validate-skill && wc -l SKILL.md`

Expected: `Skill is valid!`; `SKILL.md` stays below 500 lines; every reference is linked directly from `SKILL.md`; package contents contain no README, installation guide, changelog, eval output, or private artifact.

- [ ] **Step 6: Perform the bounded private Pop T audit outside Git**

Create an audit root with `mktemp -d`, copy only owner-approved private inputs there, run the workflow for stable height, planted-foot contact, key/hand socket attachment, and nonrestarting playback, then inspect contact sheets and lossless previews at the private production gate. Record only `{ passed, runSha256, reportSha256, approvedBy, approvedAt }` in the owner handoff; do not stage media, manifests, paths, thumbnails, or descriptive private evidence.

Expected: objective validation PASS and owner approval recorded. If owner approval is absent, exit `4` and stop without integrating downstream assets.

- [ ] **Step 7: Run final verification and commit public guidance only**

Run: `cd skills/game-character-pipeline && npm test && npm run test:browser && npm run acceptance && npm pack --dry-run && git status --short`

Expected: every public check PASS; `git status --short` lists only intended public skill/docs changes and no private audit files.

```bash
git add .gitignore skills/game-character-pipeline/SKILL.md skills/game-character-pipeline/agents skills/game-character-pipeline/references skills/game-character-pipeline/tests/skill-scenarios.json skills/game-character-pipeline/tests/skill-scenarios.test.mjs
git commit -m "docs: ship character animation workflow"
```

---

## Review Checkpoints

1. **Repository-foundation review after Task 3:** approve package/dependency licenses, donor ledger, closed contracts, and immutable run model; this is an internal checkpoint, not the design's first approval gate.
2. **Intake review after Task 6:** inspect composited GIF/APNG/WebP fixtures, nonuniform timing, alpha, video timestamps, diagnostics, and decoder identities.
3. **Design foundation gate after Task 10:** approve contracts, donor ledger, fixtures, integer zoom, real timing, onion/seam views, edits, markers, tracks, contacts, narrow viewport, and approval binding.
4. **Workflow gate after Task 15:** prove v1 compatibility, v2 multi-track normalization, authenticated delegation, engine-neutral export, browser proof, public fixture evidence, and repeatability.
5. **Private production gate after Task 16:** approve the private Pop T audit handoff and confirm `CockpitEscapeRoom` remains untouched.

## Explicit Follow-up

The optional ComfyUI/Wan capability audit requires a separate owner-approved design and implementation plan after this initial milestone passes. That plan must preflight server, node, model, license, and GPU state; use a pinned workflow JSON; record model/prompt/seed/settings hashes; and classify the local 4 GB GPU as `experimental-low-vram` until measured evidence justifies another status.
