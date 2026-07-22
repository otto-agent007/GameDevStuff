---
name: game-character-pipeline
description: Use when a user needs to create, import, review, produce, validate, or audit game-character sprite animation from an approved anchor, character brief, PNG sequence, animated GIF, APNG, WebP, video, or generated still, including Frame Studio, pivots, sockets, contacts, Pixel Snapper, engine export, reproducibility, or private production audits.
---

# Game Character Pipeline

Run the auditable character-animation workflow from this package. Keep source bytes, review decisions, delegated production, and exported evidence hash-bound from intake through audit.

## Hard boundaries

- Treat the project contract and immutable run artifacts as authoritative. Never guess timing, pivots, sockets, contacts, track membership, loop behavior, or approvals.
- Never reuse an approval after any bound source, edit, contract, receipt, or frame-approval hash changes. Treat attempted stale-approval reuse as an objective binding failure with exit class `3`; a later request for a fresh owner decision is exit class `4`.
- Never scale poses independently. Per-frame translation is allowed only by the contract; scale and rotation remain shared across the clip unless the owner explicitly revises the contract.
- Treat any export-time override of approved timing or playback semantics, including `once` or `hold-last` to `loop`, as an objective contract failure with exit class `3`. A later request to approve a revised contract is exit class `4`.
- Never enter, edit, copy files into, build, test, or otherwise integrate with `/mnt/2TBHDD/CockpitEscapeRoom` while using this skill. That downstream repository requires a separate explicitly approved integration task, even when private output appears to exist there already.
- Never publish private assets, paths, manifests, media, thumbnails, reports, or descriptive private evidence. Keep private work outside Git and npm package contents.

## Route the request

1. Validate or initialize the versioned character project before intake.
2. Create or resume an immutable run and decode the motion source without inventing data.
3. Open Frame Studio, review complete decode diagnostics, and author non-destructive edits plus required landmarks.
4. Render the review revision and obtain explicit hash-bound owner approval.
5. Delegate approved frames through the authenticated Pixel Snapper contract. Require the signed snap receipt and signed post-snap frame approval.
6. Publish only after objective validation passes. Run a single-run validation and, when reproducibility is required, compare an equivalent repeat run.

Use [references/workflow.md](references/workflow.md) for commands, state transitions, and exit classes.

## Source and review routing

- For PNG sequences, GIF, APNG, WebP, MP4, WebM, or generated stills, read [references/motion-sources.md](references/motion-sources.md).
- For stable framing, edit revisions, pivots, sockets, contacts, root travel, timing, playback, and approvals, read [references/frame-studio.md](references/frame-studio.md).
- For private Pop T or another private production audit, read [references/private-audit.md](references/private-audit.md) before touching any input. Stop at the audit handoff; do not integrate downstream.

## Stop rules

- Exit class `2`: an external handoff is required, such as a generated image that the environment has not returned. Report the handoff and wait; do not claim completion.
- Exit class `3`: objective validation failed. Stop and identify the violated contract or artifact binding; do not soften the result into a warning.
- Exit class `4`: owner review or approval is required or rejected. Stop without production, publication, or downstream integration.
- Exit class `0`: the requested stage completed with its required evidence. Do not describe a partial handoff as full production completion.

If ComfyUI is unavailable, do not block on restarting it. Record generation as `skipped/unavailable`, immediately start the generated-still intake handoff, return exit class `2`, and ask for an owner-supplied image. Never fabricate a generation record or claim that unavailable generation succeeded.
