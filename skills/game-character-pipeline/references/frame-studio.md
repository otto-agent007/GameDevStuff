# Frame Studio

Frame Studio is the mandatory review surface between immutable intake and approval. Open it with:

```bash
node scripts/cli.mjs studio --project-dir /absolute/path/character-project --run <run-id>
```

## Pose-board recovery stage

Before the normal selection stage, pose-board runs require:

```bash
node scripts/cli.mjs studio \
  --stage recovery \
  --project-dir /absolute/path/character-project \
  --run <run-id>
```

Review the full-board component overlay and every exact candidate crop. Select candidates, reorder them, name frames with portable IDs, set explicit durations, and assign every whole component to an action track role. Multiple components in one recovered candidate may share a role or be split across actor, prop, and effect roles; no component may be divided, duplicated, or silently dropped unless the recovery contract explicitly allows an unassigned disposition.

The recovery server accepts only hash-allowlisted artifacts from the immutable report. Saving creates a numbered `pose-selection` revision. Approval binds that selection to the current project, run, action, and recovery report hashes. Any changed source, contract, candidate, selection, or approval ancestry invalidates resume.

## Review controls

- `Review A` shows the last saved immutable edit revision. `Review B` shows the working edit. A remains read-only, and switching sides preserves the selected frame and review speed without dirtying either side.
- Review speed is temporary and limited to `0.25x`, `0.5x`, `1x`, and `2x`. It divides playback delay only; it never rewrites authored frame durations.
- `Set in` and `Set out` create an inclusive temporary playback range over active frames. A range loops for focused review even when the authored action is `once` or `hold-last`; clearing it restores authored playback behavior.
- Timeline timing bars scale each active frame against the longest active duration. Timeline duration fields edit the existing integer `durationMs` value in the range `1..65535` and therefore dirty working revision B.
- Motion diagnostics derive a world-space point as `marker + translation - groundTravel`. Root paths use the project pivot as a visible fallback and warn when a root marker is absent. Planted-foot paths warn when a continuous authored contact moves or lacks its matching marker.
- Diagnostic warnings are navigation aids. Selecting one jumps to its implicated frame without modifying markers, contacts, translation, ground travel, timing, or approval state.

## Review checklist

- Inspect the full composited animation at source timing, plus frame order, dimensions, alpha, disposal/blend diagnostics, decoder identity, and warnings.
- Select poses and frame ranges without rewriting immutable intake artifacts.
- Keep a single shared integer scale and rotation across a clip. Never auto-fit each frame independently.
- Set the root pivot and baseline consistently. Use per-frame translation only where the contract permits it.
- Author every required socket on every required frame. Never place a prop near a wrist, key, or attachment point by eye when a required socket is missing.
- Author contact markers and ground travel for planted-foot and moving-root actions. Review landmark drift across adjacent frames.
- Preserve contract timing and playback semantics. An export-time request to change a `once` or `hold-last` action into a loop is exit class `3`; do not apply it. If behavior must change, revise the contract and stop at exit class `4` for fresh owner approval.
- Review each required track independently and in the combined preview. Do not merge an independently animated prop into the actor merely to bypass a missing attachment.
- After Pixel Snapper, use the post-snap review stage to align the separately snapped frames and approve final landmarks. A pre-snap recovery or selection approval cannot substitute for post-snap frame approval.

## Revision and approval chain

Edits, rendered review artifacts, and approvals are immutable revisions. Render a new revision after any correction. Approval binds the project, source report, edit revision, and review evidence hashes.

If source bytes change—even by one pixel—stop with exit class `3` when the stale approval is presented. Preserve the old run for audit, intake the new bytes into a new run, reopen Frame Studio, and obtain fresh selection, snap, and post-snap frame approvals. Waiting for that new owner approval is exit class `4`.
