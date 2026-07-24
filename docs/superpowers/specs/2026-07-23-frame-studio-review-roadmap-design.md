# Frame Studio Review Roadmap Design

Date: 2026-07-23
Status: approved
Scope: `skills/game-character-pipeline` Frame Studio

## Goal

Develop Frame Studio into a fast, reversible animation-review surface while preserving immutable sources, explicit authored timing, approval hashes, and engine-neutral output.

## Delivery order

1. Saveable Exclude/Restore
2. A/B auditioning
3. Playback speed and loop range
4. Visual timing bars
5. Motion-path and grounding diagnostics

Each phase receives its own implementation plan and verification checkpoint. Approval of this roadmap does not authorize later phases to be bundled into Phase 1.

## Product principles

- Source frame bytes remain immutable and recoverable.
- Review operations are non-destructive unless the owner explicitly saves a new edit revision.
- Preview controls never silently alter authored durations, loop mode, markers, contacts, tracks, or approval hashes.
- Saved edit operations flow through existing render, approval, production, validation, and audit boundaries.
- Frame Studio clearly distinguishes source-frame count, active-frame count, and active duration.
- Desktop and narrow layouts remain keyboard accessible with no horizontal overflow.

## Phase 1: Saveable Exclude/Restore

### Interface

- Keep every source frame visible in the timeline.
- Add a clear `Exclude from action` button to the selected frame's Frame details card.
- When the selected frame is excluded, replace that control with `Restore to action`.
- Retain the compact timeline inclusion toggle for fast batch review, but give excluded rows a visible `Excluded` label in addition to reduced opacity.
- Keep excluded rows selectable so the owner can inspect and restore them.
- Update the timeline summary to show both counts, for example `9 active / 10 source`.

### Editing behavior

- Excluding a frame sets its existing `included` edit field to `false` and marks the working edit dirty.
- Restoring a frame sets `included` to `true` and marks the working edit dirty.
- Excluding the final active frame is rejected with a clear status message; an action must always retain at least one active frame.
- Saving creates a new immutable edit revision. Until Save revision is used, the exclusion remains a working change.
- Restore prior revision continues to restore the prior saved inclusion state.
- No source PNG, decoded frame, prior edit revision, or rendered review is deleted or overwritten.

### Preview behavior

- Play and Replay traverse active frames only.
- Replay always starts on the first active frame.
- If Play begins while an excluded frame is selected, playback starts on the next active frame, wrapping to the first active frame when necessary.
- Previous/Next transport buttons and arrow-key transport skip excluded frames.
- Clicking an excluded timeline row still selects it for inspection.
- Onion-skin Previous/Next and first/last seam overlays use active-frame neighbors.
- Non-looping actions stop on the last active frame.
- The total-duration readout sums active frames only.

### Downstream behavior

- The existing saved `included` field remains the sole exclusion contract.
- Rendered reviews, contact sheets, production, and exports continue to omit saved excluded frames through their existing inclusion filters.
- Approval remains bound to the newly saved edit revision and its newly rendered review.
- The current saved revision remains unchanged until the owner explicitly saves and renders a new revision.

### Phase 1 verification

- Browser tests exclude the middle fixture frame and prove Play and Replay transition directly from the first active frame to the last active frame.
- Browser tests prove Previous/Next skip the excluded frame while direct timeline selection can still inspect and restore it.
- Browser tests prove the final active frame cannot be excluded.
- Browser tests prove saving and reloading preserves exclusion.
- Desktop and narrow browser tests verify visible controls, active/source counts, focus treatment, and zero horizontal overflow.
- An owner-controlled private run temporarily excludes one middle frame, records comparison evidence outside Git, and stops for owner review before saving a new edit revision.

## Phase 2: A/B auditioning

- Compare the last saved revision (A) with the current working edit (B).
- Keep the same playback origin and review speed when switching sides.
- Display which revision and hashes are under review.
- Do not mutate either side while auditioning.

## Phase 3: Playback speed and loop range

- Add review-only speeds of `0.25x`, `0.5x`, `1x`, and `2x`.
- Add temporary inclusive in/out frame markers for focused looping.
- Preserve authored durations and action loop mode; speed and range are review state only.

## Phase 4: Visual timing bars

- Represent active-frame duration proportionally on the timeline.
- Allow keyboard-accessible duration editing with the same numeric constraints as the current duration fields.
- Mark the working edit dirty and update total active duration immediately.
- Never infer or normalize nonuniform timing automatically.

## Phase 5: Motion-path and grounding diagnostics

- Plot root travel and planted-foot paths across active frames.
- Surface objective drift and foot-sliding warnings without automatically changing markers or travel.
- Allow the owner to jump from a diagnostic to the implicated frame.

## Deferred candidates

- Frame-bound sound, VFX, impact, and gameplay events
- Actor, prop, and effect track solo/mute controls
- Named undo history and revision diff views
- Hitbox, hurtbox, socket, and attachment-point preview

These candidates require separate designs because they expand export schemas or revision semantics.
