# GameDevStuff

Auditable game-asset workflows for Codex. This repository contains two install-by-copy skill bundles; neither is published to npm.

## Skills

- **Game Character Pipeline** orchestrates character-animation intake, Frame Studio review, approvals, deterministic production, validation, and audit evidence.
- **Pixel Sprite Animation Pipeline** (Pixel Snapper) prepares, snaps, normalizes, exports, and validates pixel-art animation assets with reproducible contracts and receipts.

## Prerequisites

- Node.js 20.9 or newer.
- `ffmpeg` and `ffprobe` for video intake.
- Rust 1.88 only when building Pixel Snapper release binaries; normal skill use consumes verified releases and does not require Rust.

## Quick start

Clone this repository, then install dependencies in the bundle you need. Keep the bundle in your Codex skills location or copy it into the project that will run it; do not use `npm publish`.

```bash
git clone https://github.com/otto-agent007/GameDevStuff.git
cd GameDevStuff/skills/game-character-pipeline
npm ci
node scripts/cli.mjs --help

cd ../pixel-sprite-animation-pipeline
npm ci
node scripts/cli.mjs --help
```

Run the checks from each bundle with `npm test`; use `npm pack --dry-run` to inspect the install-by-copy package boundary.

## Exit classes

| Class | Meaning | Required action |
| --- | --- | --- |
| `0` | Requested stage complete | Report the evidence produced |
| `1` | Invocation or unexpected failure | Correct the command or diagnose the failure |
| `2` | External generation/import handoff | Return the handoff and wait for the artifact |
| `3` | Objective contract or validation failure | Stop; correct the source, edit, contract, or output |
| `4` | Owner review required or rejected | Stop without publishing or integrating |

Private inputs, audit roots, and downstream integration locations stay outside Git and package contents. Configure them locally; do not place private paths or assets in public skill files.

For Pixel Sprite path protection, create the ignored `.pixel-sprite-pipeline/profile.yaml` in the active project from [`profile.example.yaml`](skills/pixel-sprite-animation-pipeline/references/profile.example.yaml). Set the private project ID and any downstream roots that this tool must never read or write there.
