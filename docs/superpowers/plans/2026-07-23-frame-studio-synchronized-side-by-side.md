# Frame Studio Synchronized Side-by-Side Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a synchronized side-by-side Frame Studio mode that plays immutable Review A and working Review B from one elapsed-time clock while preserving each side's authored timing.

**Architecture:** Add pure elapsed-time sequence resolution to `review-state.mjs`, then extend the existing Frame Studio review mode from A/B to A/B/side-by-side. The dual preview reuses two `frame-canvas` elements, keeps all editing bound to B, and drives both panes from one monotonic browser clock without adding persisted fields or server routes.

**Tech Stack:** Native JavaScript modules, Web Components, HTML/CSS, Node.js test runner, Playwright.

## Global Constraints

- Preserve the existing single-side Review A and Review B modes.
- Use shared elapsed time; never force the two sides to advance by frame ordinal.
- Review A remains immutable and Review B remains the only editable state.
- Comparison controls must not dirty edits or alter revision, source, render, or approval hashes.
- Use each side's own included frames and authored durations.
- Hold a shorter `hold-last` side on its final active frame until the longer side finishes.
- Preserve temporary range and authored loop behavior as review-only state.
- Use integer effective zoom on both canvases.
- Stack panes without horizontal overflow at the existing `420x900` narrow viewport.
- Do not add schemas, dependencies, server endpoints, or persistent comparison fields.
- Preserve all unrelated uncommitted repository changes.

---

### Task 1: Deterministic elapsed-time sequence resolution

**Files:**
- Modify: `skills/game-character-pipeline/studio/review-state.mjs`
- Test: `skills/game-character-pipeline/tests/review-state.test.mjs`

**Interfaces:**
- Consumes: existing `playbackIndices(frames, range)`
- Produces: `sequenceDurationMs(frames, range) -> number`
- Produces: `frameStartElapsedMs(frames, frameIndex, range) -> number`
- Produces: `resolveElapsedFrame(frames, elapsedMs, { range, loop }) -> { index, totalDurationMs, elapsedMs, frameElapsedMs, complete }`

- [ ] **Step 1: Write failing duration and frame-resolution tests**

Add tests that prove exact boundary behavior, exclusions, hold-last clamping, and independent loop wrapping:

```js
test('elapsed review resolution preserves each sequence timing', () => {
  const alternate = cloneFrameState(frames);
  alternate[0].edit.durationMs = 200;

  assert.deepEqual(resolveElapsedFrame(frames, 100), {
    index: 2,
    totalDurationMs: 280,
    elapsedMs: 100,
    frameElapsedMs: 20,
    complete: false
  });
  assert.equal(resolveElapsedFrame(alternate, 100).index, 0);
  assert.equal(resolveElapsedFrame(frames, 280).index, 2);
  assert.equal(resolveElapsedFrame(frames, 280).complete, true);
  assert.equal(resolveElapsedFrame(frames, 300, { loop: true }).index, 0);
  assert.equal(sequenceDurationMs(frames), 280);
  assert.equal(frameStartElapsedMs(frames, 2), 80);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/review-state.test.mjs
```

Expected: FAIL because the three new exports do not exist.

- [ ] **Step 3: Implement the pure sequence helpers**

Implement the helpers using `playbackIndices`, positive integer authored durations, modulo only for loop mode, and clamping to the final active frame for hold-last mode. Exact frame boundaries select the next active frame. An elapsed value at or beyond total duration returns the last active index with `complete: true`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npm test -- tests/review-state.test.mjs
```

Expected: all review-state tests pass.

### Task 2: Accessible dual-preview shell and responsive layout

**Files:**
- Modify: `skills/game-character-pipeline/studio/index.html`
- Modify: `skills/game-character-pipeline/studio/styles.css`
- Modify: `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`

**Interfaces:**
- Consumes: existing Review A/B card and `frame-canvas` element
- Produces: `#review-side-by-side`, `#review-a-pane`, `#review-b-pane`, `#review-a-canvas`, `#review-b-canvas`, `#review-a-frame`, and `#review-b-frame`

- [ ] **Step 1: Write a failing browser shell test**

Add a test that clicks `Side by side`, expects two labeled preview regions and two visible canvases, then checks desktop horizontal ordering or narrow vertical ordering based on `testInfo.project.name`. Verify `document.documentElement.scrollWidth <= document.documentElement.clientWidth`.

- [ ] **Step 2: Run the focused browser test and verify RED**

Run:

```bash
npx playwright test tests/browser/frame-studio.spec.mjs --grep "side-by-side preview"
```

Expected: FAIL because the Side by side button does not exist.

- [ ] **Step 3: Add the semantic preview markup**

Add the third review button:

```html
<button id="review-side-by-side" type="button" aria-pressed="false">Side by side</button>
```

Replace the single preview canvas with two named panes. A is hidden in single-B mode; B retains marker authoring:

```html
<div class="comparison-preview" id="comparison-preview" data-review-mode="B">
  <section class="preview-pane" id="review-a-pane" aria-label="Review A preview" hidden>
    <header><strong>Review A</strong><span id="review-a-frame">—</span></header>
    <frame-canvas id="review-a-canvas" zoom="4" onion-opacity="0.28" seam="false"></frame-canvas>
  </section>
  <section class="preview-pane" id="review-b-pane" aria-label="Review B preview">
    <header><strong>Review B</strong><span id="review-b-frame">—</span></header>
    <frame-canvas id="review-b-canvas" zoom="4" onion-opacity="0.28" seam="false"></frame-canvas>
  </section>
</div>
```

- [ ] **Step 4: Add responsive comparison styling**

Use a two-column grid for `[data-review-mode="AB"]`, a single pane for A or B, and a narrow media rule that stacks comparison panes. Keep pane headers compact, preserve checkerboard stages, constrain each canvas, and maintain zero horizontal page overflow.

- [ ] **Step 5: Run the focused browser test**

Run the same Playwright grep. Expected: PASS for desktop and narrow.

### Task 3: Shared monotonic playback and immutable comparison behavior

**Files:**
- Modify: `skills/game-character-pipeline/studio/app.mjs`
- Test: `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`

**Interfaces:**
- Consumes: Task 1 helpers and Task 2 DOM IDs
- Produces: transient review modes `A`, `B`, and `AB`
- Produces: shared comparison elapsed state driven by `performance.now()`

- [ ] **Step 1: Write failing synchronized-playback browser tests**

Create immutable Review A, make working B timing shorter, enter Side by side, and verify:

```js
await page.getByRole('button', { name: 'Save revision' }).click();
for (const [name, duration] of [
  ['Timeline duration step-contact', '40'],
  ['Timeline duration step-pass', '40'],
  ['Timeline duration step-contact-2', '40']
]) {
  await page.getByLabel(name, { exact: true }).fill(duration);
  await page.getByLabel(name, { exact: true }).blur();
}
await page.getByRole('button', { name: 'Side by side', exact: true }).click();
await page.getByLabel('Review speed').selectOption('2');
await page.getByRole('button', { name: 'Replay', exact: true }).click();
await expect(page.locator('#review-b-frame')).toHaveText('step-contact-2', { timeout: 160 });
await expect(page.locator('#review-a-frame')).toHaveText('step-pass');
await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveText('Play', { timeout: 260 });
```

Also record the saved edit hash before auditioning and verify it is unchanged afterward; B must remain marked as an unsaved working copy.

- [ ] **Step 2: Run the synchronized test and verify RED**

Run:

```bash
npx playwright test tests/browser/frame-studio.spec.mjs --grep "shared elapsed clock"
```

Expected: FAIL because comparison mode does not yet drive either pane.

- [ ] **Step 3: Extend review mode without changing edit semantics**

Update `reviewSide` to accept `AB`. In AB:

- `displayFrames()` returns working B for timeline, inspector, and editing.
- Save and authoring remain enabled as B behavior.
- `updateReviewState()` presses only Side by side.
- Review A and Review B buttons exit AB into their existing single modes.
- `#review-a-pane` and `#review-b-pane` visibility follows A/B/AB.

- [ ] **Step 4: Implement the shared clock**

Track `comparisonElapsedMs`, `comparisonStartedAt`, and one animation-frame handle. On Replay, reset elapsed to zero. During AB playback, compute elapsed from `performance.now()` and review speed, resolve A and B independently with `resolveElapsedFrame`, update both canvases in one render pass, and stop only when both full hold-last sequences are complete. Pause captures elapsed before canceling the scheduler.

- [ ] **Step 5: Keep manual selection, range, speed, and overlays coherent**

- Manual B timeline selection sets shared elapsed with `frameStartElapsedMs`.
- Range boundaries remain source-index boundaries and resolve independently per side.
- Speed changes preserve elapsed before adopting the new speed.
- Overlay attributes update both canvases.
- Marker authoring attaches only to `#review-b-canvas`.
- Returning to A or B resolves that side at current shared elapsed.

- [ ] **Step 6: Add resize-aware integer comparison zoom**

Observe the comparison preview size. In AB, cap the requested zoom to the largest positive integer fitting both panes using project canvas dimensions; in single mode retain the requested zoom. Apply the same effective integer to both canvases without mutating the Zoom input.

- [ ] **Step 7: Run synchronized and existing focused browser tests**

Run:

```bash
npx playwright test tests/browser/frame-studio.spec.mjs --grep "side-by-side preview|shared elapsed clock|A/B auditioning|review speed|temporary inclusive loop range|integer zoom"
```

Expected: all selected tests pass on desktop and narrow.

### Task 4: Regression, rendered QA, and private comparison handoff

**Files:**
- Modify: `/mnt/2TBHDD/private-audits/game-character-popt-baseball-slide-2026-07-22/implementation-checkpoint.md`
- Modify: `/mnt/2TBHDD/private-audits/game-character-popt-baseball-slide-2026-07-22/audit-checkpoint.json`
- Preserve: all existing private Frame Studio comparison evidence

**Interfaces:**
- Consumes: completed synchronized comparison mode
- Produces: owner-visible live Frame Studio AB playback and private verification evidence

- [ ] **Step 1: Run unit and complete browser regression suites**

Run:

```bash
npm test -- tests/review-state.test.mjs
npx playwright test tests/browser/frame-studio.spec.mjs
```

Expected: all tests pass. If the pre-existing narrow hold-last timeout recurs, preserve its trace, rerun only that unchanged test three times, and report both results rather than hiding the flake.

- [ ] **Step 2: Run package-level checks**

Run:

```bash
npm test
npm run validate-skill
git diff --check
```

Expected: zero failures and no whitespace errors.

- [ ] **Step 3: Validate the rendered private comparison**

Use the existing owner-only post-snap Frame Studio run. Verify the flow:

```text
Frame Studio loads -> Side by side opens A and B -> Replay advances both on
one clock -> original remains left -> snapped candidate remains right ->
Review A revision bytes and working B unsaved state remain unchanged.
```

Check desktop and narrow layout, page identity, nonblank content, no error
overlay, console health, interaction state, and screenshot evidence.

- [ ] **Step 4: Update the private checkpoint**

Record the live origin, synchronized playback verification, A/B identities,
active counts, authored totals, screenshot hashes, browser console result,
owner-only permissions, and the fact that no selection or production
replacement occurred.

- [ ] **Step 5: Stop at owner visual review**

Leave Frame Studio visibly open in Side by side mode with Replay available.
Do not save working B, select the candidate, normalize production, export,
integrate downstream, or commit private evidence.
