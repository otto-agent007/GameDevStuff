---
name: pixel-sprite-animation-pipeline
description: Use when working from a pixel-art anchor or sprite frames, building idle, walk, or run cycles, using Pixel Snapper, repairing blurry or interpolated pixels, correcting inconsistent scale, pivot, or baseline, or preparing generation art for game runtime.
---

# Pixel Sprite Animation Pipeline

Preserve approved inputs and write every attempt to a new versioned run. Use `node scripts/cli.mjs --help` for command syntax; run `npm ci --omit=dev` in this directory first when dependencies are absent.

## Required workflow

1. Inspect the approved, pixel-snapped anchor.
2. Pad and position it in the canonical cell without stretching artwork. The default is 128×128 with pivot `(64,112)`.
3. Prepare the 1024×1024 nearest-neighbor anchor and a separate 1024×1024 black-and-white matrix of exact 8×8 blocks. The matrix constrains square pixel clusters; never composite it into the character art.
4. Generate each articulated frame separately with the same locked anchor and matrix references. Change only the requested pose delta. A pose board is reference material only; never generate a one-shot production sheet.
5. Run Pixel Snapper. If unavailable, follow the exit-2 JSON handoff using its structured `next.cwd` and `next.argv` fields; resume with the expected snapped files. Never reconstruct a shell command by joining argv.
6. Normalize every snapped frame using one global integer scale and one shared pivot/baseline. Never scale or auto-crop frames independently.
7. Export the default 256×256 runtime PNGs, sheet, JSON, and animated WebP with nearest-neighbor scaling.
8. Validate objective pixels, palette, dimensions, scale, pivot, baseline, metadata, and preview; then obtain human review for identity, pose uniqueness, and loop quality.

Use guided `run` for the full sequence or call `inspect`, `prepare`, `snap`, `normalize`, `export`, and `validate` independently. After an objective failure, `correct --request <version-1-request> --project-dir <project>` accepts only a run ID, immutable contract hash, signed-receipt hash/signature, and declared failure identity; it derives every artifact path from authenticated state. The project signing key is never printed or copied into run artifacts. The command may rebuild allowlisted deterministic corrections, objectively revalidate, and record only lesson classes with independent artifact verification. JSON is written to stdout; actionable errors go to stderr. Exit 2 is resumable, 3 is an unresolved objective failure, and 4 requires user judgment. Do not claim completion for a nonzero exit.

## Correction and learning gates

Apply only reversible deterministic corrections classified by validation, preserve before/after artifacts, and revalidate. Stop for artistic, pose, or identity ambiguity. Allow at most two targeted generative retries per frame; then ask the user.

Record only verified project-local evidence. Passing a run may make profile promotion eligible, but promotion still requires explicit user approval. Never silently edit this installed skill or its defaults. Skill-rule changes require an explicit proposal and approval; normally require three independent verified runs, and disclose any reduced threshold.

Use `promote-profile` only after explicit approval. Use `propose-rule` to inspect accumulated evidence; it emits a proposal and never applies it.

## References

- Read [configuration.md](references/configuration.md) when changing sizes, pivots, palette, background, foreground retention, or retry limits.
- Read [generation-prompts.md](references/generation-prompts.md) before image generation or a targeted generative correction.
- Read [pixel-snapper.md](references/pixel-snapper.md) for executable discovery and manual handoffs.
- Read [corrections.md](references/corrections.md) for failure classification, deterministic gates, retry accounting, and stop rules.

Use a strong coding model at high reasoning when installing or changing this pipeline. Normal/default reasoning is sufficient for routine runs unless validation is ambiguous.
