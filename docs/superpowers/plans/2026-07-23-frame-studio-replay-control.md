# Frame Studio Replay Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visible Replay button that immediately restarts Frame Studio playback from frame 1 without changing authored animation data.

**Architecture:** Extend the existing playback transport with one native button and one small `startPlayback` helper. The helper owns the shared transition into playback, while Replay requests a frame-1 restart and the existing Play control preserves its current resume behavior.

**Tech Stack:** Browser-native HTML/CSS/JavaScript, Web Components already used by Frame Studio, Playwright browser tests.

## Global Constraints

- Replay immediately stops any active timer, selects frame 1, and starts playback with saved per-frame durations.
- Replay never changes the action's authored `loopMode`.
- Replay does not dirty the edit, create a revision, or alter approval and provenance hashes.
- Use a native visible-text `Replay` button inside the existing `Playback controls` region.
- Preserve desktop and narrow layouts and existing focus treatment.
- Add no keyboard shortcut and no schema, render, approval, or source-frame changes.
- Keep all repository changes uncommitted until the private audit completes.

---

## File Structure

- `skills/game-character-pipeline/studio/index.html`: declares the Replay transport button beside Play.
- `skills/game-character-pipeline/studio/app.mjs`: centralizes playback startup and wires Replay to a frame-1 restart.
- `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`: proves held-final and active-playback restart behavior in real browsers.

### Task 1: Replay transport behavior

**Files:**
- Modify: `skills/game-character-pipeline/tests/browser/frame-studio.spec.mjs`
- Modify: `skills/game-character-pipeline/studio/index.html`
- Modify: `skills/game-character-pipeline/studio/app.mjs`

**Interfaces:**
- Consumes: existing `frames`, `selectedIndex`, `playing`, `playbackTimer`, `selectFrame(index)`, `stopPlayback()`, and `scheduleNext()` playback state.
- Produces: `startPlayback({ fromStart?: boolean }): void` and the native `#replay` button.

- [x] **Step 1: Write failing browser tests for held-final and active Replay**

Add these tests after the existing authored-duration playback test:

```js
test('replay starts a held final pose from frame one', async ({ page }) => {
  await page.keyboard.press('End');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2');

  const replayedFrame = await page.getByRole('button', { name: 'Replay', exact: true }).evaluate((button) => {
    button.click();
    return document.querySelector('[aria-current="true"]')?.dataset.frameId;
  });

  expect(replayedFrame).toBe('step-contact');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass', { timeout: 180 });
});

test('replay restarts active playback from frame one', async ({ page }) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass', { timeout: 180 });

  const replayedFrame = await page.getByRole('button', { name: 'Replay', exact: true }).evaluate((button) => {
    button.click();
    return document.querySelector('[aria-current="true"]')?.dataset.frameId;
  });

  expect(replayedFrame).toBe('step-contact');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass', { timeout: 180 });
});
```

- [x] **Step 2: Run the focused desktop tests and verify RED**

Run:

```bash
cd skills/game-character-pipeline
npx playwright test tests/browser/frame-studio.spec.mjs --project=desktop -g "replay"
```

Expected: both tests fail because no button with accessible name `Replay` exists.

- [x] **Step 3: Add the Replay button and minimal shared playback helper**

In `studio/index.html`, place Replay directly after Play:

```html
<button id="play" class="play-button" type="button">Play</button>
<button id="replay" class="play-button" type="button">Replay</button>
```

In `studio/app.mjs`, bind the button:

```js
const playButton = document.querySelector('#play');
const replayButton = document.querySelector('#replay');
```

Replace the direct playback start inside `togglePlayback` with:

```js
function startPlayback({ fromStart = false } = {}) {
  if (!frames.length) return;
  stopPlayback();
  if (fromStart) selectFrame(0);
  playing = true;
  playButton.textContent = 'Pause';
  scheduleNext();
}

function togglePlayback() {
  if (playing) {
    stopPlayback();
    return;
  }
  startPlayback();
}
```

Wire the new control beside the existing Play listener:

```js
playButton.addEventListener('click', togglePlayback);
replayButton.addEventListener('click', () => startPlayback({ fromStart: true }));
```

- [x] **Step 4: Run the focused tests and verify GREEN on both viewports**

Run:

```bash
npx playwright test tests/browser/frame-studio.spec.mjs -g "replay"
```

Expected: 4 passed, covering the two Replay behaviors on desktop and narrow projects.

- [x] **Step 5: Verify the complete browser suite and formatting**

Run:

```bash
npx playwright test
git diff --check
```

Expected: 26 browser tests pass and `git diff --check` exits successfully.

- [x] **Step 6: Perform a saved-run visual check**

Start Frame Studio with:

```bash
node scripts/cli.mjs studio \
  --project-dir /absolute/path/character-project \
  --run <run-id> \
  --stage selection
```

Verify in the browser:

- Replay is visible beside Play at desktop and narrow widths.
- From the final frame, Replay immediately selects the first frame and starts the authored sequence.
- During playback, Replay immediately restarts at the first frame.
- Non-looping playback still stops on the final frame.
- The saved edit hash remains unchanged.

- [x] **Step 7: Preserve the uncommitted audit checkpoint**

Keep owner-controlled visual evidence outside Git and preserve the current approval boundary.
