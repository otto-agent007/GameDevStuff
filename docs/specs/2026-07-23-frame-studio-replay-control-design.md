# Frame Studio Replay Control Design

Date: 2026-07-23
Status: approved
Scope: `skills/game-character-pipeline` Frame Studio

## Goal

Add a visible `Replay` button to Frame Studio so an owner can immediately review an authored animation from frame 1 without manually scrubbing back from a held final pose.

## Behavior

- Place a text button labeled `Replay` beside the existing `Play` button in the playback controls.
- Clicking `Replay` stops any active playback timer, selects the first authored frame, and immediately starts playback using the saved per-frame durations.
- Clicking `Replay` while playback is already running restarts the animation from frame 1 immediately.
- The existing `Play` / `Pause` behavior remains unchanged.
- Non-looping actions still stop on their final frame. Replay does not change an action's authored `loopMode`.
- Replay is preview-only: it does not dirty the edit, create a revision, or alter approval and provenance hashes.

## Interface and accessibility

- Use a native `button` with visible `Replay` text and the existing Frame Studio focus treatment.
- Keep the control in the playback region so its accessible grouping remains `Playback controls`.
- Preserve usable spacing at both desktop and narrow test viewports.
- Do not add a keyboard shortcut in this change; the visible, focusable button is the sole new interface.

## Implementation boundary

- Add the button to `studio/index.html`.
- Add the smallest playback helper needed in `studio/app.mjs` to restart from frame 1 and schedule playback.
- Reuse existing button styling unless narrow layout verification demonstrates that one targeted style adjustment is required.
- Do not change source frames, Frame Studio edit schemas, render artifacts, approval logic, or the saved review revision.

## Verification

- Add a browser test that starts from the final frame, clicks `Replay`, observes frame 1 immediately, and then observes frame 2 according to authored timing.
- Verify that the Play control reads `Pause` during replay.
- Verify that clicking Replay during active playback restarts at frame 1.
- Run the Frame Studio browser test on desktop and narrow projects.
- Run the complete browser suite and `git diff --check`.
