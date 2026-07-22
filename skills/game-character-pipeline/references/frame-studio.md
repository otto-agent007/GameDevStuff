# Frame Studio

Frame Studio is the mandatory review surface between immutable intake and approval. Open it with:

```bash
node scripts/cli.mjs studio --project-dir /absolute/path/character-project --run <run-id>
```

## Review checklist

- Inspect the full composited animation at source timing, plus frame order, dimensions, alpha, disposal/blend diagnostics, decoder identity, and warnings.
- Select poses and frame ranges without rewriting immutable intake artifacts.
- Keep a single shared integer scale and rotation across a clip. Never auto-fit each frame independently.
- Set the root pivot and baseline consistently. Use per-frame translation only where the contract permits it.
- Author every required socket on every required frame. Never place a prop near a wrist, key, or attachment point by eye when a required socket is missing.
- Author contact markers and ground travel for planted-foot and moving-root actions. Review landmark drift across adjacent frames.
- Preserve contract timing and playback semantics. An export-time request to change a `once` or `hold-last` action into a loop is exit class `3`; do not apply it. If behavior must change, revise the contract and stop at exit class `4` for fresh owner approval.
- Review each required track independently and in the combined preview. Do not merge an independently animated prop into the actor merely to bypass a missing attachment.

## Revision and approval chain

Edits, rendered review artifacts, and approvals are immutable revisions. Render a new revision after any correction. Approval binds the project, source report, edit revision, and review evidence hashes.

If source bytes change—even by one pixel—stop with exit class `3` when the stale approval is presented. Preserve the old run for audit, intake the new bytes into a new run, reopen Frame Studio, and obtain fresh selection, snap, and post-snap frame approvals. Waiting for that new owner approval is exit class `4`.
