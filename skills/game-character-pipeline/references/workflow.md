# Workflow

Run commands from `skills/game-character-pipeline`. Use an absolute project directory; private projects must live outside the repository.

## 1. Initialize

```bash
node scripts/cli.mjs init \
  --contract /absolute/path/project.json \
  --project-dir /absolute/path/character-project
```

The contract closes the canvas, scale, approved anchor, actions, loop modes, tracks, sockets, contacts, timing rules, and review identities. Revise the contract instead of applying export-only overrides.

## 2. Intake

```bash
node scripts/cli.mjs intake \
  --project-dir /absolute/path/character-project \
  --action walk \
  --kind gif \
  --source /absolute/path/walk.gif
```

Use `--resume <run-id>` only with the same immutable action and source kind. Select source-specific options from [motion-sources.md](motion-sources.md). Intake must retain source hashes and complete decoder diagnostics.

## 3. Review and approve

```bash
node scripts/cli.mjs studio --project-dir /absolute/path/character-project --run <run-id>

node scripts/cli.mjs render \
  --project-dir /absolute/path/character-project \
  --run <run-id> \
  --edit <revision>

node scripts/cli.mjs approve \
  --project-dir /absolute/path/character-project \
  --run <run-id> \
  --edit <revision> \
  --approver <configured-id> \
  --decision approved \
  --notes '<review notes>'
```

Use `--allow-global-transform` only when the owner intentionally approves one shared integer transform. Changed source bytes invalidate old edits and approvals. Reusing the stale approval is exit class `3`; create a new run and review chain, which later stops at exit class `4` until the owner supplies a fresh decision.

## 4. Produce

```bash
node scripts/cli.mjs produce \
  --project-dir /absolute/path/character-project \
  --run <run-id> \
  --approval /absolute/path/selection-approval.json \
  --snap-receipt /absolute/path/snap-receipt.json \
  --frame-approval /absolute/path/frame-approval.json \
  --output /absolute/path/pixel-production
```

Do not substitute unsigned files. The delegated response must bind the same contract and input-manifest hashes. Missing receipts or review artifacts are handoffs, not permission to bypass the gate.

## 5. Validate and audit

```bash
node scripts/cli.mjs validate \
  --project-dir /absolute/path/character-project \
  --run <run-id> \
  --revision <export-revision>

node scripts/cli.mjs audit \
  --project-dir /absolute/path/character-project \
  --run <run-id> \
  --repeat <equivalent-run-id>
```

Validation checks deterministic artifacts, engine metadata, integer block scaling, source timing, landmark drift, provenance, clipping, and artifact hashes. Audit compares deterministic hashes while allowing envelope fields such as run IDs and timestamps to differ.

## Exit classes

| Class | Meaning | Required action |
| --- | --- | --- |
| `0` | Requested stage complete | Report the evidence produced |
| `1` | Invocation or unexpected failure | Correct the command or diagnose the failure |
| `2` | External generation/import handoff | Return the handoff and wait for the artifact |
| `3` | Objective contract or validation failure | Stop; correct the source, edit, contract, or output |
| `4` | Owner review required or rejected | Stop without publishing or integrating |
