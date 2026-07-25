# GameDevStuff

Auditable game-asset workflows for Codex. This repository contains two install-by-copy skill bundles; neither is published to npm.

[![Skills CI](https://github.com/otto-agent007/GameDevStuff/actions/workflows/skills.yml/badge.svg?branch=main)](https://github.com/otto-agent007/GameDevStuff/actions/workflows/skills.yml) [![Pixel Snapper release](https://github.com/otto-agent007/GameDevStuff/actions/workflows/pixel-snapper-release.yml/badge.svg?branch=main)](https://github.com/otto-agent007/GameDevStuff/actions/workflows/pixel-snapper-release.yml)

Read the [Documentation index](docs/README.md) for shipped features, their plans, and supporting designs.

## Skills

- **Game Character Pipeline** orchestrates character-animation intake, Frame Studio review, approvals, deterministic production, validation, and audit evidence.
- **Pixel Sprite Animation Pipeline** (Pixel Snapper) prepares, snaps, normalizes, exports, and validates pixel-art animation assets with reproducible contracts and receipts.

## Prerequisites

- Node.js 22.12.0 or newer.
- `ffmpeg` and `ffprobe` for video intake.
- Rust 1.88 only when building Pixel Snapper release binaries; normal skill use consumes verified releases and does not require Rust.

## Quick start

Clone this repository, then install the shared workspace dependencies from the repository root. Keep a bundle in your Codex skills location or copy it into the project that will run it; do not use `npm publish`.

```bash
git clone https://github.com/otto-agent007/GameDevStuff.git
cd GameDevStuff
npm ci

npm run test
npm run lint
npm run format:check

node skills/game-character-pipeline/scripts/cli.mjs --help
node skills/pixel-sprite-animation-pipeline/scripts/cli.mjs --help
```

Run `npm run package-boundary` to inspect both install-by-copy package boundaries. An installed or copied bundle has no root lockfile, so install only its runtime dependencies with `npm install --omit=dev` from that bundle directory before use.

## Skill releases

Both skills are versioned and released together as immutable GitHub Release assets named `skills-vX.Y.Z`. They are install-by-copy bundles, not npm packages: download both `.tgz` files and `SHA256SUMS` from the release, verify `sha256sum -c SHA256SUMS`, then copy or install each bundle where it will run. Maintainers dispatch **Skills release** from `main` with the exact shared version after updating `CHANGELOG.md`; the protected publish environment approves the release.

## Exit classes

| Class | Meaning                                  | Required action                                     |
| ----- | ---------------------------------------- | --------------------------------------------------- |
| `0`   | Requested stage complete                 | Report the evidence produced                        |
| `1`   | Invocation or unexpected failure         | Correct the command or diagnose the failure         |
| `2`   | External generation/import handoff       | Return the handoff and wait for the artifact        |
| `3`   | Objective contract or validation failure | Stop; correct the source, edit, contract, or output |
| `4`   | Owner review required or rejected        | Stop without publishing or integrating              |

Private inputs, audit roots, and downstream integration locations stay outside Git and package contents. Configure them locally; do not place private paths or assets in public skill files.

For Pixel Sprite path protection, create the ignored `.pixel-sprite-pipeline/profile.yaml` in the active project from [`profile.example.yaml`](skills/pixel-sprite-animation-pipeline/references/profile.example.yaml). Set the private project ID and any downstream roots that this tool must never read or write there.
