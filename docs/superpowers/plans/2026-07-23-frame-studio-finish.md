# Frame Studio Finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the approved Frame Studio review roadmap with immutable A/B auditioning, review-only speed and loop range, proportional timing controls, and actionable motion/grounding diagnostics.

**Architecture:** Keep saved edit revision A and mutable working edit B as separate in-memory frame snapshots. Add a pure `review-state.mjs` module for playback range and review state, plus a pure `motion-diagnostics.mjs` module for authored path analysis; `app.mjs` coordinates those helpers while `timeline.mjs` remains the accessible frame-list editor. Persist only existing edit fields such as `durationMs`; comparison, speed, range, and diagnostics remain preview state.

**Tech Stack:** Browser-native ES modules and custom elements, HTML/CSS, Playwright browser tests, Node test runner.

## Global Constraints

- Source frame bytes and prior revisions remain immutable.
- A/B switching, review speed, range markers, and diagnostics never dirty or save an edit.
- Timeline duration changes use the existing integer `durationMs` field with range `1..65535`.
- Playback speed choices are exactly `0.25x`, `0.5x`, `1x`, and `2x`.
- Review range markers are temporary, inclusive, active-frame aware, and never alter authored `loopMode`.
- Diagnostics are derived from authored active-frame data and never modify markers, contacts, translation, or ground travel.
- Desktop `1440x1000` and narrow `420x900` layouts remain keyboard accessible with zero horizontal overflow.
- Browser plugin is unavailable in this session, so rendered verification uses the repository Playwright workflow.

---

### Task 1: Pure review-state model

**Files:**
- Create: `skills/game-character-pipeline/studio/review-state.mjs`
- Create: `skills/game-character-pipeline/tests/review-state.test.mjs`

**Interfaces:**
- Produces: `cloneFrameState(frames) -> Frame[]`
- Produces: `activeIndices(frames) -> number[]`
- Produces: `playbackIndices(frames, range) -> number[]`
- Produces: `nextPlaybackIndex(indices, currentIndex) -> number|null`
- Produces: `reviewDelay(durationMs, speed) -> number`

- [x] **Step 1: Write failing unit tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeIndices,
  cloneFrameState,
  nextPlaybackIndex,
  playbackIndices,
  reviewDelay
} from '../studio/review-state.mjs';

const frames = [
  { id: 'contact-a', included: true, edit: { durationMs: 80 } },
  { id: 'pass', included: false, edit: { durationMs: 120 } },
  { id: 'contact-b', included: true, edit: { durationMs: 200 } }
];

test('review state clones nested edits without sharing mutation', () => {
  const clone = cloneFrameState(frames);
  clone[0].edit.durationMs = 96;
  assert.equal(frames[0].edit.durationMs, 80);
});

test('playback range filters active frames inclusively', () => {
  assert.deepEqual(activeIndices(frames), [0, 2]);
  assert.deepEqual(playbackIndices(frames, { in: 1, out: 2 }), [2]);
  assert.equal(nextPlaybackIndex([0, 2], 0), 2);
});

test('review delay preserves authored duration at selectable speeds', () => {
  assert.equal(reviewDelay(80, 0.5), 160);
  assert.equal(reviewDelay(80, 2), 40);
  assert.throws(() => reviewDelay(80, 3), /review speed/);
});
```

- [x] **Step 2: Run the focused unit test and verify RED**

Run:

```bash
cd skills/game-character-pipeline
node --test tests/review-state.test.mjs
```

Expected: FAIL because `studio/review-state.mjs` does not exist.

- [x] **Step 3: Implement the pure helpers**

```js
const SPEEDS = new Set([0.25, 0.5, 1, 2]);

export const cloneFrameState = (frames) => structuredClone(frames ?? []);

export const activeIndices = (frames) =>
  (frames ?? []).flatMap((frame, index) => frame.included !== false ? [index] : []);

export function playbackIndices(frames, range = {}) {
  const start = Number.isInteger(range.in) ? range.in : 0;
  const end = Number.isInteger(range.out) ? range.out : Math.max(0, frames.length - 1);
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  return activeIndices(frames).filter((index) => index >= low && index <= high);
}

export function nextPlaybackIndex(indices, currentIndex) {
  if (!indices.length) return null;
  return indices.find((index) => index > currentIndex) ?? indices[0];
}

export function reviewDelay(durationMs, speed) {
  if (!Number.isInteger(durationMs) || durationMs < 1) throw new Error('authored duration must be a positive integer');
  if (!SPEEDS.has(speed)) throw new Error('review speed is unsupported');
  return durationMs / speed;
}
```

- [x] **Step 4: Run the focused unit test and verify GREEN**

Run: `node --test tests/review-state.test.mjs`

Expected: 3 passed.

- [x] **Step 5: Commit**

```bash
git add skills/game-character-pipeline/studio/review-state.mjs skills/game-character-pipeline/tests/review-state.test.mjs
git commit -m "feat: model frame studio review state"
```

---

### Task 2: Immutable A/B auditioning

**Files:**
- Modify: `skills/game-character-pipeline/studio/index.html`
- Modify: `skills/game-character-pipeline/studio/app.mjs`
- Modify: `skills/game-character-pipeline/studio/markers.mjs`
- Modify: `skills/game-character-pipeline/studio/timeline.mjs`
- Modify: `skills/game-character-pipeline/studio/styles.css`
- Test: `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`

**Interfaces:**
- Consumes: `cloneFrameState(frames)`
- Produces: `markerAuthoring.setDisabled(disabled)`
- Produces: `FrameTimeline.readOnly`

- [x] **Step 1: Write failing browser tests**

Add a test that:

```js
await page.getByLabel('Timeline duration step-contact').fill('96');
await page.getByRole('button', { name: 'Review A' }).click();
await expect(page.getByText('Saved revision', { exact: false })).toBeVisible();
await expect(page.getByLabel('Timeline duration step-contact')).toHaveValue('80');
await expect(page.getByLabel('Timeline duration step-contact')).toBeDisabled();
await page.getByRole('button', { name: 'Review B' }).click();
await expect(page.getByLabel('Timeline duration step-contact')).toHaveValue('96');
await expect(page.getByText('Unsaved working copy')).toBeVisible();
```

Also assert that the selected frame and review speed remain unchanged across A/B switches.

- [x] **Step 2: Run the A/B tests and verify RED**

Run:

```bash
npx playwright test tests/browser/frame-studio.spec.mjs --project=desktop -g "A/B"
```

Expected: FAIL because Review A and Review B controls do not exist.

- [x] **Step 3: Add the comparison interface**

Add a `review-card` containing native buttons with `aria-pressed`, plus revision/hash labels:

```html
<section class="review-card" aria-labelledby="review-heading">
  <div>
    <span class="eyebrow">Audition</span>
    <h3 id="review-heading">Saved A / Working B</h3>
  </div>
  <div class="review-switch" role="group" aria-label="A/B review side">
    <button id="review-a" type="button" aria-pressed="false">Review A</button>
    <button id="review-b" type="button" aria-pressed="true">Review B</button>
  </div>
  <dl class="review-state-list">
    <div><dt>A</dt><dd id="review-a-state"></dd></div>
    <div><dt>B</dt><dd id="review-b-state"></dd></div>
  </dl>
</section>
```

- [x] **Step 4: Keep saved and working snapshots separate**

In `app.mjs`, store `savedFrames`, `reviewSide`, and `displayFrames()`. On load and after save, clone the saved frames. A switching handler stops and resumes playback at the same selected index when necessary, never calls `setDirty`, and renders A as read-only.

- [x] **Step 5: Disable mutation controls while reviewing A**

Add `FrameTimeline.readOnly`, suppress mutation events, and disable label, duration, include, and duplicate controls. Add `markerAuthoring.setDisabled(true)` to disable authoring controls. Keep playback, overlays, range, and frame selection available.

- [x] **Step 6: Run A/B browser tests and verify GREEN**

Run: `npx playwright test tests/browser/frame-studio.spec.mjs -g "A/B"`

Expected: desktop and narrow A/B cases pass.

- [x] **Step 7: Commit**

```bash
git add skills/game-character-pipeline/studio skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs
git commit -m "feat: add frame studio A/B auditioning"
```

---

### Task 3: Review speed and inclusive loop range

**Files:**
- Modify: `skills/game-character-pipeline/studio/index.html`
- Modify: `skills/game-character-pipeline/studio/app.mjs`
- Modify: `skills/game-character-pipeline/studio/timeline.mjs`
- Modify: `skills/game-character-pipeline/studio/styles.css`
- Test: `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`

**Interfaces:**
- Consumes: `playbackIndices(frames, range)`, `nextPlaybackIndex(indices, currentIndex)`, `reviewDelay(durationMs, speed)`
- Produces: `FrameTimeline.rangeIn` and `FrameTimeline.rangeOut`

- [x] **Step 1: Write failing browser tests**

Add one test proving `2x` advances an `80 ms` frame within `60 ms`, while `0.25x` does not. Add another test that sets in/out around two active frames and proves playback loops inside that inclusive range even for a hold-last action.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx playwright test tests/browser/frame-studio.spec.mjs --project=desktop -g "review speed|loop range"
```

Expected: FAIL because speed and range controls do not exist.

- [x] **Step 3: Add review-only controls**

Add a speed `select` with exact options and buttons `Set in`, `Set out`, and `Clear range`, plus a polite range readout. Store `reviewSpeed` and `{ in, out }` only in memory.

- [x] **Step 4: Route playback through the range helpers**

Schedule `reviewDelay(current.edit.durationMs, reviewSpeed)`. When a range marker exists, filter active frames inclusively and wrap at the range end regardless of authored loop mode. Without a range, preserve authored loop or hold-last behavior.

- [x] **Step 5: Mark range boundaries in the timeline**

Expose `rangeIn` and `rangeOut` properties and render visible `In`/`Out` badges. Excluded markers remain selectable but cannot become a playback boundary until restored.

- [x] **Step 6: Run focused tests and verify GREEN**

Run: `npx playwright test tests/browser/frame-studio.spec.mjs -g "review speed|loop range"`

Expected: desktop and narrow cases pass.

- [x] **Step 7: Commit**

```bash
git add skills/game-character-pipeline/studio skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs
git commit -m "feat: add frame studio review range controls"
```

---

### Task 4: Proportional timing bars and timeline duration editing

**Files:**
- Modify: `skills/game-character-pipeline/studio/timeline.mjs`
- Modify: `skills/game-character-pipeline/studio/app.mjs`
- Modify: `skills/game-character-pipeline/studio/styles.css`
- Test: `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`

**Interfaces:**
- Produces: `frame-duration` event `{ index, durationMs }`

- [x] **Step 1: Write failing browser tests**

Assert that each active row has a timing bar, that widths follow `80 < 120 < 200`, and that changing `Timeline duration step-contact` to `240` marks B unsaved, updates the readout to `560 ms total`, and makes its bar widest. Assert values `0`, `65536`, and fractional values are rejected without changing the edit.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx playwright test tests/browser/frame-studio.spec.mjs --project=desktop -g "timing bars"
```

Expected: FAIL because timing bars and timeline duration inputs do not exist.

- [x] **Step 3: Render timing controls**

For each timeline row, render:

```html
<label class="timeline-duration-field">
  <span>Timing</span>
  <input type="number" min="1" max="65535" step="1">
</label>
<span class="timing-bar" aria-hidden="true"><span></span></span>
```

Set `--duration-ratio` to the active duration divided by the longest active duration. Excluded frames receive ratio `0`.

- [x] **Step 4: Validate and emit edits**

On `change`, require an integer in `1..65535`. Restore the rendered current value and emit no event on invalid input. On success, emit `frame-duration`; `app.mjs` updates `frame.edit.durationMs`, mirrors `frame.durationMs`, sets B dirty, rerenders, and announces the change.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `npx playwright test tests/browser/frame-studio.spec.mjs -g "timing bars"`

Expected: desktop and narrow cases pass.

- [x] **Step 6: Commit**

```bash
git add skills/game-character-pipeline/studio skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs
git commit -m "feat: visualize frame studio timing"
```

---

### Task 5: Motion-path and grounding diagnostics

**Files:**
- Create: `skills/game-character-pipeline/studio/motion-diagnostics.mjs`
- Create: `skills/game-character-pipeline/tests/motion-diagnostics.test.mjs`
- Modify: `skills/game-character-pipeline/studio/index.html`
- Modify: `skills/game-character-pipeline/studio/app.mjs`
- Modify: `skills/game-character-pipeline/studio/styles.css`
- Modify: `skills/game-character-pipeline/scripts/studio/server.mjs`
- Test: `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`

**Interfaces:**
- Produces: `analyzeMotion(frames, canvas) -> { rootPath, footPaths, issues }`
- Produces: `renderMotionDiagnostics(root, analysis, onSelect)`

- [x] **Step 1: Write failing unit tests**

Use three active frames with root and planted-foot markers. Assert:

- root points include translation and subtract authored ground travel;
- a continuous planted contact with changed world-space foot coordinates emits `foot-slide`;
- missing root markers emit `missing-root`;
- excluded frames are absent;
- each issue includes the implicated source frame index.

- [x] **Step 2: Run diagnostics unit tests and verify RED**

Run: `node --test tests/motion-diagnostics.test.mjs`

Expected: FAIL because `studio/motion-diagnostics.mjs` does not exist.

- [x] **Step 3: Implement pure analysis**

Use:

```js
worldPoint(marker, edit, fallback) = {
  x: (marker?.x ?? fallback.x) + edit.translation.x - edit.groundTravel.x,
  y: (marker?.y ?? fallback.y) + edit.translation.y - edit.groundTravel.y
}
```

Root fallback is the project pivot. A foot path point exists only when the matching contact is active and its planted-foot marker exists. Consecutive active contact points that differ emit `foot-slide`; missing active contact markers emit `missing-contact-marker`.

- [x] **Step 4: Add the diagnostics card**

Add a `Motion & grounding` card with a responsive SVG plot, summary text, and issue buttons. Render root in cyan, left foot in amber, right foot in pink, and include a legend. Clicking an issue calls `selectFrame(issue.frameIndex, { manual: true, focus: true })`.

- [x] **Step 5: Write and run failing browser interaction test**

Author two contact markers with drift, assert the issue button appears, click it, and assert the implicated timeline row becomes current.

- [x] **Step 6: Make the browser test GREEN**

Refresh diagnostics on frame edits, inclusion changes, A/B switches, and saves. Do not call `setDirty` from analysis or issue navigation.

- [x] **Step 7: Commit**

```bash
git add skills/game-character-pipeline/studio skills/game-character-pipeline/scripts/studio/server.mjs skills/game-character-pipeline/tests
git commit -m "feat: diagnose frame studio motion"
```

---

### Task 6: Full rendered verification and documentation

**Files:**
- Modify: `skills/game-character-pipeline/references/frame-studio.md`
- Modify: `docs/superpowers/plans/2026-07-23-frame-studio-finish.md`

**Interfaces:**
- Consumes all prior tasks.

- [x] **Step 1: Document completed review controls**

Document A/B immutability, preview-only speed/range state, timeline duration persistence, diagnostics formulas, and the owner-review boundary.

- [x] **Step 2: Run all automated checks**

```bash
cd skills/game-character-pipeline
npm test
npm run test:browser
npm run acceptance
npm run validate-skill
npm pack --dry-run
cd ../pixel-sprite-animation-pipeline
npm test
npm run validate-skill
npm pack --dry-run
```

Expected:

- Game Character unit tests: all pass.
- Browser tests: all pass on desktop and narrow.
- Acceptance: 2 pass.
- Pixel Sprite tests: 370 pass with 1 platform skip.
- Both skill validations pass.
- Package dry-runs exclude tests, reports, screenshots, and private working data.

- [x] **Step 3: Run rendered Playwright QA**

Capture screenshots outside Git at `1440x1000` and `420x900`. Verify page identity, meaningful content, no error overlay, no console errors/warnings, zero horizontal overflow, visible focus, and interactions for A/B, speed/range, timing edit, and diagnostic navigation.

- [x] **Step 4: Run repository boundary checks**

```bash
git diff --check
git status --short
git diff -U0 | rg '^\+[^+]' | rg '/(mnt|home)/[^ ]*(audit|private)|operator-private|run-[0-9]{10,}|[a-f0-9]{64}'
```

Expected: formatting passes, only intended public files are changed, and no private audit paths, run IDs, or hashes appear in added lines.

- [x] **Step 5: Commit and push**

```bash
git add docs/superpowers/plans/2026-07-23-frame-studio-finish.md skills/game-character-pipeline
git commit -m "docs: finish frame studio review workflow"
git push origin agent/game-character-animation-workflow
```
