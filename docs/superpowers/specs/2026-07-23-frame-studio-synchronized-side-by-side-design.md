# Frame Studio Synchronized Side-by-Side Design

Date: 2026-07-23
Status: approved
Scope: `skills/game-character-pipeline` Frame Studio

## Goal

Let an owner play saved Review A and working Review B next to each other on one
shared clock, making pose, timing, grounding, and transition differences easier
to judge than repeated A/B switching.

## Chosen interaction

- Add a third audition control labeled `Side by side` beside `Review A` and
  `Review B`.
- `Review A` and `Review B` retain the existing single-preview modes.
- `Side by side` shows two equally weighted preview panes: immutable Review A
  on the left and working Review B on the right.
- Entering comparison mode keeps the timeline, authoring tools, diagnostics,
  Save revision behavior, and approval controls bound to working Review B.
- Clicking either single-side control exits comparison mode and opens that side
  in the existing editor.
- Comparison mode is review state only. Entering it, leaving it, or playing it
  does not dirty an edit, create a revision, or alter source, edit, render, or
  approval hashes.

## Shared elapsed-time playback

One monotonic elapsed-time clock drives both panes. Each side independently
resolves its visible frame from its own included frames and authored durations.
This preserves meaningful timing differences instead of forcing both sides to
advance by frame number.

- `Play`, `Pause`, `Replay`, review speed, the temporary range, and the scrub
  readout control both panes.
- `Replay` resets shared elapsed time to zero and starts both sides immediately.
- Changing review speed changes only how quickly shared elapsed time advances;
  authored durations remain unchanged.
- Each side filters excluded frames independently within the same source-index
  range boundaries.
- Manual selection in the Review B timeline moves shared elapsed time to the
  start of that B frame, then resolves the corresponding Review A pose at that
  same elapsed time. This aligns alternative frames even when their source
  indices differ.
- For a full `hold-last` action, comparison playback ends when the longer side
  reaches its end. A shorter side holds its final active pose meanwhile.
- A temporary playback range continues to loop for review. Each side wraps
  within its own active ranged duration using the same shared elapsed time.
- For an authored `loop` action, each side wraps at its own authored active
  duration while the shared clock continues.
- An empty active sequence is not valid and remains prevented by the existing
  final-active-frame exclusion guard.

The time-to-frame resolver will be a small pure function in
`studio/review-state.mjs`. It will accept frames, elapsed milliseconds, range,
and loop/hold behavior and return the active frame index plus timing metadata.
Keeping this logic outside the DOM makes divergent-duration and exclusion
semantics deterministic and directly testable.

## Preview layout and pixel fidelity

- The existing single `frame-canvas` remains the editable Review B canvas in
  comparison mode.
- A second `frame-canvas` renders immutable Review A and does not accept marker
  authoring.
- Each pane has a persistent `Review A` or `Review B` label and its currently
  resolved frame ID.
- Preview-only overlay settings apply to both panes; marker editing remains
  available only on B.
- Both panes use the same effective integer zoom. A resize-aware fit calculation
  caps the requested zoom at the largest whole-number scale that fits each pane,
  preserving crisp pixels instead of browser-resampling a too-large canvas.
- At desktop widths the panes form two columns. At narrow widths they stack A
  above B with no horizontal page overflow.
- The timeline and inspector keep their current locations; comparison mode does
  not duplicate editing controls or approval panels.

## State and data boundaries

- No project, source, edit, render, approval, or export schema changes are
  required.
- No new server endpoint is required.
- Review A continues to come from the last immutable saved edit, or source
  defaults when no saved revision exists.
- Review B continues to use the unsaved working copy.
- Comparison mode owns only transient UI state: mode, shared elapsed time,
  playing state, speed, range, and effective preview zoom.
- Saving while comparison mode is open has the same meaning as saving working
  Review B today; the comparison itself contributes no persisted fields.

## Failure and edge behavior

- If Review A has no saved revision, its pane is labeled `Source defaults`.
- Missing or undecodable frame media uses the existing frame-canvas failure
  behavior independently per pane and must not stop the other pane's clock.
- Switching modes or changing speed cancels the prior playback scheduler before
  starting another, preventing duplicate timers.
- Pausing preserves shared elapsed time; resuming continues from that point.
- Returning to a single-side mode resolves that side at the current shared
  elapsed time so the visible pose does not jump unnecessarily.
- Reduced-motion preferences do not disable authored playback; they continue to
  suppress only decorative interface animation.

## Verification

### Unit tests

- Resolve two sequences with different durations at the same elapsed time and
  prove that they can display different frame indices.
- Prove excluded frames and temporary range boundaries are handled per side.
- Prove hold-last clamps the shorter side while the longer side continues.
- Prove loop mode wraps independently without modifying authored durations.
- Prove elapsed-time resolution at zero, exact frame boundaries, and the final
  millisecond.

### Browser tests

- Enter `Side by side` and verify two labeled, visible frame canvases.
- Create a dirty working B with different timing, press Replay, and verify both
  panes advance from one shared elapsed clock according to their own durations.
- Verify the shorter hold-last side remains on its final active frame until the
  longer side finishes.
- Verify Play/Pause, Replay, speed changes, range playback, and manual B timeline
  selection update both panes.
- Verify A remains immutable and B remains editable in comparison mode.
- Verify comparison actions leave edit revision, edit hash, and dirty state
  unchanged.
- Verify both panes use an integer effective zoom.
- Verify the desktop two-column and narrow stacked layouts have no horizontal
  overflow.
- Re-run all existing single-side A/B, Replay, timing, range, exclusion,
  authoring, diagnostics, and approval tests unchanged.

## Out of scope

- Diff heatmaps or automatic visual scoring
- Independent transport controls per pane
- More than two simultaneous revisions
- Pop-out windows
- Persisting comparison mode in edit revisions or project files
