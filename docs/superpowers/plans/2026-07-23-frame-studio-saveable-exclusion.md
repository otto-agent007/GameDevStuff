# Frame Studio Saveable Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Frame Studio's existing saveable inclusion field usable for non-destructive frame removal, with active-frame playback, clear Exclude/Restore controls, and preserved immutable sources.

**Architecture:** Keep source and edit schemas unchanged. Centralize active-frame traversal and inclusion mutation in `studio/app.mjs`, expose the existing inclusion state through a clear selected-frame control and timeline label, and prove the complete behavior through real-browser tests.

**Tech Stack:** Browser-native HTML/CSS/JavaScript, existing Frame Studio Web Components, Playwright browser tests.

## Global Constraints

- Source PNGs, decoded frames, prior edit revisions, and rendered reviews remain immutable.
- `edit.frames[].included` remains the sole saved exclusion contract.
- At least one frame must remain active.
- Play, Replay, Previous, Next, Home, End, onion-skin neighbors, and cycle seams use active frames.
- Excluded timeline rows remain directly selectable for inspection and restoration.
- Save revision is the only operation that persists an exclusion.
- Render, approval, production, and export schemas remain unchanged.
- The current private Gate 2 revision must not be saved over or approved during the comparison.
- Desktop and narrow layouts remain keyboard accessible with zero horizontal overflow.
- Keep all repository changes uncommitted until the private audit completes.

---

## File Structure

- `skills/game-character-pipeline/studio/app.mjs`: owns active-frame traversal, guarded inclusion mutation, playback, transport, overlays, and selected-frame control state.
- `skills/game-character-pipeline/studio/index.html`: declares the selected-frame Exclude/Restore button.
- `skills/game-character-pipeline/studio/timeline.mjs`: renders the existing compact inclusion toggle and an explicit `Excluded` row label.
- `skills/game-character-pipeline/studio/styles.css`: styles the selected-frame control and excluded state without changing layout architecture.
- `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`: verifies active traversal, overlays, guarding, restoration, persistence, and responsive behavior.

### Task 1: Saveable active-frame exclusion

**Files:**
- Modify: `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`
- Modify: `skills/game-character-pipeline/studio/app.mjs`
- Modify: `skills/game-character-pipeline/studio/index.html`
- Modify: `skills/game-character-pipeline/studio/timeline.mjs`
- Modify: `skills/game-character-pipeline/studio/styles.css`

**Interfaces:**
- Consumes: existing `frames`, `selectedIndex`, `selectFrame(index)`, `stopPlayback()`, `scheduleNext()`, `setDirty(value)`, and `edit.frames[].included`.
- Produces: `activeFrameIndices(): number[]`, `adjacentActiveIndex(index: number, direction: 1 | -1): number | null`, `setFrameInclusion(index: number, included: boolean): boolean`, and the native `#toggle-frame-inclusion` button.

- [x] **Step 1: Write failing browser tests for active traversal, overlays, guarding, restoration, and persistence**

Add these tests after the existing Replay tests:

```js
test('skips excluded frames in playback and transport', async ({ page }) => {
  await page.getByRole('button', { name: 'Exclude step-pass', exact: true }).click();
  await expect(page.getByText('2 active / 3 source', { exact: true })).toBeVisible();
  await expect(page.locator('[data-frame-id="step-pass"]')).toContainText('Excluded');

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2', { timeout: 180 });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  await page.locator('[data-frame-id="step-pass"]').click();
  await expect(page.getByRole('button', { name: 'Restore to action', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact');

  await page.locator('[data-frame-id="step-pass"]').click();
  await page.getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2');
  await page.getByRole('button', { name: 'Previous frame', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact');

  const replayedFrame = await page.getByRole('button', { name: 'Replay', exact: true }).evaluate((button) => {
    button.click();
    return document.querySelector('[aria-current="true"]')?.dataset.frameId;
  });
  expect(replayedFrame).toBe('step-contact');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2', { timeout: 180 });
});

test('uses active neighbors for onion skin and cycle seams', async ({ page }) => {
  await page.getByRole('button', { name: 'Exclude step-pass', exact: true }).click();
  const finalUrl = await page.locator('[data-frame-id="step-contact-2"] img').getAttribute('src');
  await page.getByLabel('Next', { exact: true }).check();
  await expect(page.locator('frame-canvas')).toHaveAttribute('next', finalUrl);

  await page.getByRole('button', { name: 'Exclude step-contact', exact: true }).click();
  await page.locator('[data-frame-id="step-contact-2"]').click();
  await page.getByLabel('First / last seam', { exact: true }).check();
  await expect(page.locator('frame-canvas')).toHaveAttribute('first', finalUrl);
  await expect(page.locator('frame-canvas')).toHaveAttribute('last', finalUrl);
});

test('guards the final active frame and restores excluded frames', async ({ page }) => {
  await page.getByRole('button', { name: 'Exclude step-pass', exact: true }).click();
  await page.getByRole('button', { name: 'Exclude step-contact-2', exact: true }).click();
  await page.locator('[data-frame-id="step-contact"]').click();
  await page.getByRole('button', { name: 'Exclude from action', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('An action must retain at least one active frame.');
  await expect(page.locator('[data-frame-id="step-contact"]')).toHaveAttribute('data-included', 'true');

  await page.locator('[data-frame-id="step-pass"]').click();
  await page.getByRole('button', { name: 'Restore to action', exact: true }).click();
  await expect(page.locator('[data-frame-id="step-pass"]')).toHaveAttribute('data-included', 'true');
  await expect(page.getByText('2 active / 3 source', { exact: true })).toBeVisible();
});

test('persists saved exclusion across reloads', async ({ page }) => {
  await page.getByRole('button', { name: 'Exclude step-pass', exact: true }).click();
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toContainText(/Saved edit revision \d+/);
  await page.reload();

  await expect(page.locator('[data-frame-id="step-pass"]')).toHaveAttribute('data-included', 'false');
  await expect(page.getByText('2 active / 3 source', { exact: true })).toBeVisible();
  const session = await page.evaluate(() => fetch('/api/session').then((response) => response.json()));
  expect(session.source.frames).toHaveLength(3);
  expect(session.edit.frames.find(({ frameId }) => frameId === 'step-pass').included).toBe(false);
});
```

- [x] **Step 2: Run the focused desktop tests and verify RED**

Run:

```bash
cd skills/game-character-pipeline
npx playwright test tests/browser/frame-studio.spec.mjs --project=desktop -g "excluded|active neighbors|final active|saved exclusion"
```

Expected: the tests fail because playback still visits excluded frames, no selected-frame Exclude/Restore button or active/source count exists, overlays still use source neighbors, and the final active frame is not guarded.

- [x] **Step 3: Add active-frame traversal and guarded inclusion mutation**

In `studio/app.mjs`, add these helpers after `includedFrames`:

```js
const activeFrameIndices = () => frames.flatMap((frame, index) => frame.included !== false ? [index] : []);
const firstActiveIndex = () => activeFrameIndices()[0] ?? null;
const lastActiveIndex = () => activeFrameIndices().at(-1) ?? null;

function adjacentActiveIndex(index, direction) {
  const active = activeFrameIndices();
  if (!active.length) return null;
  if (direction > 0) return active.find((candidate) => candidate > index) ?? active[0];
  return active.findLast((candidate) => candidate < index) ?? active.at(-1);
}

function setFrameInclusion(index, included) {
  const frame = frames[index];
  if (!frame || frame.included === included) return false;
  if (!included && includedFrames().length === 1) {
    status.textContent = 'An action must retain at least one active frame.';
    return false;
  }
  frame.included = included;
  frame.edit.included = included;
  setDirty(true);
  render();
  status.textContent = `${included ? 'Restored' : 'Excluded'} ${frame.id} ${included ? 'to' : 'from'} the action; save to create a revision.`;
  return true;
}
```

Replace source-neighbor selection in `updateCanvas`:

```js
const previousIndex = adjacentActiveIndex(selectedIndex, -1);
const nextIndex = adjacentActiveIndex(selectedIndex, 1);
const firstIndex = firstActiveIndex();
const lastIndex = lastActiveIndex();
const previous = frames[previousIndex] ?? frame;
const next = frames[nextIndex] ?? frame;
const first = frames[firstIndex] ?? frame;
const last = frames[lastIndex] ?? frame;
canvas.setAttribute('frame', frame.url);
canvas.setAttribute('first', first.url);
canvas.setAttribute('last', last.url);
```

Update `updateReadout`:

```js
const active = includedFrames();
document.querySelector('#frame-count').textContent = `${active.length} active / ${frames.length} source`;
const inclusionButton = document.querySelector('#toggle-frame-inclusion');
const isIncluded = frame?.included !== false;
inclusionButton.textContent = isIncluded ? 'Exclude from action' : 'Restore to action';
inclusionButton.dataset.included = String(isIncluded);
```

Replace `scheduleNext` and `startPlayback` with active traversal:

```js
function scheduleNext() {
  if (!playing) return;
  const current = frames[selectedIndex];
  playbackTimer = setTimeout(() => {
    const atEnd = selectedIndex === lastActiveIndex();
    if (atEnd && action?.loopMode !== 'loop') {
      stopPlayback();
      return;
    }
    selectFrame(atEnd ? firstActiveIndex() : adjacentActiveIndex(selectedIndex, 1));
    scheduleNext();
  }, current.edit.durationMs);
}

function startPlayback({ fromStart = false } = {}) {
  if (!includedFrames().length) return;
  stopPlayback();
  if (fromStart) selectFrame(firstActiveIndex());
  else if (frames[selectedIndex]?.included === false) selectFrame(adjacentActiveIndex(selectedIndex, 1));
  playing = true;
  playButton.textContent = 'Pause';
  scheduleNext();
}
```

Replace the `frame-include` listener with:

```js
timeline.addEventListener('frame-include', ({ detail }) => {
  setFrameInclusion(detail.index, detail.included);
});
```

Wire active transport and selected-frame inclusion:

```js
document.querySelector('#toggle-frame-inclusion').addEventListener('click', () => {
  const frame = frames[selectedIndex];
  if (frame) setFrameInclusion(selectedIndex, frame.included === false);
});
document.querySelector('#previous-frame').addEventListener('click', () => selectFrame(adjacentActiveIndex(selectedIndex, -1), { manual: true }));
document.querySelector('#next-frame').addEventListener('click', () => selectFrame(adjacentActiveIndex(selectedIndex, 1), { manual: true }));
```

Update document-level keyboard actions:

```js
const keyActions = {
  ArrowLeft: () => selectFrame(adjacentActiveIndex(selectedIndex, -1), { manual: true, focus: true }),
  ArrowRight: () => selectFrame(adjacentActiveIndex(selectedIndex, 1), { manual: true, focus: true }),
  Home: () => selectFrame(firstActiveIndex(), { manual: true, focus: true }),
  End: () => selectFrame(lastActiveIndex(), { manual: true, focus: true })
};
```

In `timeline.mjs`, replace source-index keyboard navigation with semantic transport events:

```js
const transport = {
  ArrowLeft: 'previous',
  ArrowUp: 'previous',
  ArrowRight: 'next',
  ArrowDown: 'next',
  Home: 'first',
  End: 'last'
};
if (Object.hasOwn(transport, event.key)) {
  event.preventDefault();
  event.stopPropagation();
  this.#emit('frame-transport', { command: transport[event.key] });
} else if (event.key === 'Delete') {
  event.preventDefault();
  event.stopPropagation();
  this.#emit('frame-include', { index, included: false });
}
```

Handle those commands beside the other timeline listeners in `app.mjs`:

```js
timeline.addEventListener('frame-transport', ({ detail }) => {
  const targets = {
    previous: adjacentActiveIndex(selectedIndex, -1),
    next: adjacentActiveIndex(selectedIndex, 1),
    first: firstActiveIndex(),
    last: lastActiveIndex()
  };
  selectFrame(targets[detail.command], { manual: true, focus: true });
});
```

Replace the document-level Delete mutation with:

```js
} else if (event.key === 'Delete' && frames[selectedIndex]) {
  event.preventDefault();
  setFrameInclusion(selectedIndex, false);
}
```

- [x] **Step 4: Add discoverable Exclude/Restore interface state**

In `studio/index.html`, add the selected-frame control after the frame details list:

```html
<button id="toggle-frame-inclusion" class="selection-inclusion-button" type="button">Exclude from action</button>
```

In `timeline.mjs`, append a visible state label for excluded rows:

```js
if (frame.included === false) {
  const state = document.createElement('span');
  state.className = 'frame-state';
  state.textContent = 'Excluded';
  copy.append(state);
}
```

In `studio/styles.css`, add:

```css
.frame-state {
  grid-column: 1 / -1;
  color: var(--danger);
  font-size: 8px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.selection-inclusion-button {
  width: 100%;
  margin-top: 12px;
  border-color: var(--danger);
  color: #ff93a8;
}
.selection-inclusion-button[data-included="false"] {
  border-color: var(--cyan);
  color: var(--cyan);
}
```

Do not change the timeline's existing compact `Exclude <frame-id>` / `Include <frame-id>` accessible labels.

- [x] **Step 5: Run focused tests and verify GREEN on desktop and narrow projects**

Run:

```bash
npx playwright test tests/browser/frame-studio.spec.mjs -g "excluded|active neighbors|final active|saved exclusion"
```

Expected: 8 passed across desktop and narrow projects.

- [x] **Step 6: Run complete browser and formatting verification**

Run:

```bash
npx playwright test
git diff --check
```

Expected: 34 browser tests pass and `git diff --check` exits successfully.

- [x] **Step 7: Verify a temporary middle-frame comparison without saving a new revision**

Use the already-running private Frame Studio or start it with:

```bash
node scripts/cli.mjs studio \
  --project-dir /absolute/path/character-project \
  --run <run-id> \
  --stage selection
```

In the browser:

- Select a middle frame and click `Exclude from action`.
- Verify the active count decreases by one while the source count remains unchanged.
- Replay and verify the sequence transitions directly from the preceding active frame to the following active frame.
- Verify non-looping playback still stops on the final active frame.
- Verify the excluded row remains selectable and offers `Restore to action`.
- Keep any desktop, narrow, and timed comparison artifacts inside the owner-only audit root.
- Do not click Save revision, Render review, Approve revision, or Reject revision.
- Reload the page to discard the temporary working exclusion.
- Recompute and confirm the saved edit-revision SHA-256 remains unchanged.

- [x] **Step 8: Preserve the uncommitted audit checkpoint**

Update the private checkpoint with:

- Phase 1 repository implementation and verification status
- Browser test count `34`
- Owner-only comparison evidence
- Explicit confirmation that revision 1 remains unchanged and Gate 2 still awaits owner approval

Do not stage, commit, push, publish, or deploy.
