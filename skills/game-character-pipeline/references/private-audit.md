# Private Audit

A private audit proves the reusable workflow without publishing or integrating the character. It does not authorize downstream use.

## Boundary

- Create an operator-selected audit root outside every Git worktree, preferably with `mktemp -d`, and restrict it to the owner on POSIX systems.
- Copy only inputs the owner explicitly approved for this audit.
- Keep source media, manifests, paths, reports, contact sheets, previews, thumbnails, exports, and descriptive evidence inside that root.
- Never enter, edit, copy into, build, test, or otherwise operate on `/mnt/2TBHDD/CockpitEscapeRoom`. Moving approved output there is a separate explicitly approved integration task.
- Do not add the private audit root to npm contents or Git. The repository ignores defensive local names, but an external absolute root remains mandatory.

Example setup:

```bash
private_audit_root="$(mktemp -d)"
chmod 700 "$private_audit_root"
```

Run `init`, immutable `intake`, Frame Studio review, `render`, `approve`, authenticated `produce`, `validate`, and repeat-run `audit` with `--project-dir` and output paths under that root. See [workflow.md](workflow.md).

## Pop T audit checks

At the private production gate, inspect only inside the audit root and require:

- stable character height and one shared integer scale;
- planted-foot contacts and contract-exact ground travel;
- key/hand or other required socket attachment on every required frame;
- one-shot or hold-last playback that does not restart as a loop;
- lossless previews and contact sheets reviewed by the configured owner;
- objective validation and reproducibility comparison with no deterministic artifact drift.

## Owner handoff

Record only this shape in the private owner handoff:

`{ passed, runSha256, reportSha256, approvedBy, approvedAt }`

Do not include media, manifests, filesystem paths, thumbnails, or descriptive private evidence. If validation fails, use exit class `3`. If owner approval is absent or rejected, use exit class `4` and stop without copying, publishing, or integrating any asset. The handoff itself is not downstream integration approval.
