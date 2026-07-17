# Pixel Sprite Animation Pipeline Skill Design

## Purpose

Create a reusable personal Codex skill named `pixel-sprite-animation-pipeline` that turns an approved pixel-art character anchor into consistent, game-ready animations. The skill must support both an end-to-end guided workflow and independently callable stages. Pop T is the first validation fixture, but no character-specific rules belong in the reusable workflow.

The skill is intended for ChatGPT and Codex environments that support personal skills and file-processing tools. It is not initially a standalone Windows application. Its deterministic scripts may later serve as the foundation for a separate user-facing program.

## Default Configuration

All defaults are configurable per project:

- Canonical logical cell: 128 x 128 pixels.
- Canonical pivot: `(64, 112)`.
- Generation plate: 1024 x 1024 pixels.
- Generation scaling: exact 8x nearest-neighbor.
- Pixel matrix: 1024 x 1024 with 8 x 8 alternating black-and-white blocks.
- Runtime cell: 256 x 256 pixels.
- Runtime scaling: exact 2x nearest-neighbor from the canonical cell.
- Runtime pivot: derived from the canonical pivot; the default is `(128, 224)`.
- Palette: preserve the approved anchor palette unless explicitly overridden.
- Background key: detected from the anchor border or supplied by configuration.

Canvas padding and artwork scaling are distinct operations. The skill must never distort a non-square source merely to reach the canonical dimensions. It pads and positions the original pixels first, then performs only integer nearest-neighbor scaling.

## Operating Modes

### Guided end-to-end mode

The user supplies an approved snapped anchor and a motion description. The skill prepares references, guides or performs pose generation, invokes Pixel Snapper when available, normalizes the frames, exports runtime assets, validates the results, and produces a run report.

### Independent stage mode

Each stage can run separately:

- Inspect an anchor or frame set.
- Prepare a canonical anchor.
- Build generation references.
- Prepare per-frame generation prompts.
- Pixel-snap supplied frames.
- Normalize snapped frames.
- Export sheets, metadata, and previews.
- Validate an existing animation package.

Every stage accepts existing upstream artifacts, so users can perform image generation or pixel snapping manually and resume later.

## Pipeline

### 1. Inspect

Measure and report:

- Canvas dimensions.
- Foreground bounds.
- Background color and alpha behavior.
- Palette size and colors.
- Suspected pixel-grid size.
- Evidence of smoothing, mixed pixel sizes, clipping, or multiple foreground components.

The inspection result becomes the initial run manifest. The original file is retained unchanged.

### 2. Prepare the canonical anchor

- Remove or isolate the background without damaging subject colors.
- Preserve the native snapped pixels.
- Pad to the configured canonical cell without resampling.
- Place the subject at the configured pivot and foot baseline.
- Produce both transparent and flat chroma-key canonical anchors.
- Reject any operation that introduces fractional scaling or antialiasing.

### 3. Build generation references

- Upscale the complete canonical cell to the configured generation resolution using exact integer nearest-neighbor scaling.
- Generate a separate black-and-white pixel matrix whose block size matches the integer generation scale.
- Use the upscaled anchor as the identity, costume, proportion, outline, and palette reference.
- Use the matrix as a pixel-cluster constraint reference rather than as a runtime background.

### 4. Generate poses

Articulated characters must use one generation request per frame from the same locked anchor. A multi-pose board may be used as a motion reference, but it is not a production spritesheet.

Each prompt describes only the pose delta and motion state while explicitly preserving identity, direction, scale, costume, palette, full-body framing, and flat background. The default run-cycle plan uses eight mechanically distinct phases in loop order. Other motions can configure their own frame count and pose list.

### 5. Pixel-snap

- Detect a supported Pixel Snapper CLI before processing.
- If present, invoke it with recorded parameters and retain both source and snapped outputs.
- If absent, stop at a clear handoff point and provide exact manual instructions, expected filenames, and validation criteria.
- Resume from user-supplied snapped frames without repeating completed stages.
- Do not reimplement grid recovery unless the design is explicitly revised later.

### 6. Normalize

- Recover foreground components rather than assuming that a generated pose board is already a clean grid.
- Normalize all frames as a set.
- Preserve one global scale; never resize each frame independently.
- Align frames to the configured shared pivot and baseline.
- Preserve intended motion offsets while removing accidental framing drift.
- Detect clipping, duplicate poses, incorrect direction, component loss, and frame bleeding.

### 7. Export

Produce versioned outputs without overwriting approved inputs:

- Individual transparent PNG frames at canonical resolution.
- Individual transparent PNG frames at runtime resolution.
- A transparent PNG spritesheet.
- JSON containing frame rectangles, ordering, durations, canonical and runtime pivots, source hashes, palette information, and configuration.
- An animated WebP or GIF preview.
- A validation and correction report.

Runtime enlargement must use exact integer nearest-neighbor scaling. For the default 256 x 256 output, every canonical pixel becomes a 2 x 2 runtime block.

## Learning and Self-Correction

The skill implements procedural learning, not autonomous model training. It uses three bounded levels.

### Run-level correction

Classify validation failures and apply safe corrections during the current run. Supported categories include:

- Aspect-ratio or canvas-padding mistakes.
- Non-integer or interpolated scaling.
- Background-key failure or chroma fringe.
- Pivot and baseline drift.
- Global scale inconsistency.
- Palette drift.
- Frame clipping or bleeding.
- Duplicate or incorrectly ordered poses.
- Character identity or costume drift.
- Poor first-to-last loop transition.

Deterministic corrections may run automatically. Generative corrections are limited to two targeted attempts per failed frame, retain every version, and must compare the new result against the failed measurements.

### Project-level learning

Store verified settings in a project-local profile, including cell sizes, pivots, scale factors, palette source, background key, Pixel Snapper parameters, frame timing, and successful correction choices. Subsequent runs in that project reuse the verified profile while allowing explicit overrides.

Only a correction that passes validation may update the project profile. Failed attempts remain in the run report but do not become defaults.

Project state lives under `.pixel-sprite-pipeline/` in the active workspace. `profile.yaml` contains the currently verified settings, while `runs/<run-id>/manifest.json` and `runs/<run-id>/report.json` preserve inputs, outputs, measurements, corrections, and results. Generated image files may remain in a user-selected asset directory, but the manifests record their relative paths and hashes.

### Skill-level improvement

Record structured lessons containing the failure category, evidence, suspected cause, correction attempted, before-and-after measurements, validation result, and user feedback. The skill may propose a change to its installed defaults or instructions only after the same correction has passed validation in at least three independent runs. A user may request a proposal earlier, but the reduced evidence must be disclosed.

The skill must never silently rewrite itself. It presents the proposed rule change and supporting run evidence, then waits for explicit user approval before updating the personal skill.

## Safety and Stop Rules

The skill may automatically perform reversible deterministic operations such as padding, integer scaling, background removal, pivot calculation, sheet assembly, metadata repair, and export regeneration.

It must stop for user guidance when:

- A correction materially changes the approved character design.
- Multiple artistically valid alternatives exist.
- Palette remapping removes meaningful detail.
- Two generative retries fail to improve the measured result.
- A proposed lesson conflicts with an existing rule.
- Pixel Snapper is unavailable and no snapped frames have been supplied.

All outputs are versioned. Original and approved assets are never overwritten.

## Validation

Every completed run checks:

- Exact canvas sizes and frame count.
- Integer scaling ratios and nearest-neighbor pixel blocks.
- Absence of antialiasing and unintended intermediate colors.
- Palette consistency against the approved anchor.
- Transparent runtime backgrounds.
- Expected foreground component count.
- Shared pivot and baseline placement.
- Global scale consistency.
- No clipping, overlap, or frame bleeding.
- Valid animation order, timing, and metadata.
- A reasonable first-to-last loop seam in the animated preview.

The report distinguishes hard failures from subjective review items. Objective failures block delivery; subjective motion or style concerns are shown for user review.

## Skill Package

The installed personal skill will contain:

- A concise `SKILL.md` that selects modes and orchestrates the workflow.
- UI metadata under `agents/openai.yaml`.
- Deterministic scripts for inspection, anchor preparation, matrix generation, normalization, export, validation, and run reporting.
- Focused references for generation prompting, Pixel Snapper integration, configuration, and correction taxonomy.
- Minimal validation fixtures, including the approved Pop T anchor only where needed to test behavior.

Bundled resources must remain general. Project-specific output assets and accumulated project profiles stay in their respective workspaces rather than inside the installed skill.

## Acceptance Criteria

The skill is complete when it can:

1. Prepare the supplied Pop T snapped anchor without changing its native character pixels.
2. Produce exact 128 x 128 canonical, 1024 x 1024 generation, and 256 x 256 runtime assets using integer nearest-neighbor scaling.
3. Produce a correct 1024 x 1024 pixel matrix for the default configuration.
4. Detect Pixel Snapper and provide a reliable manual handoff when it is absent.
5. Normalize a supplied multi-frame animation around one global scale and shared pivot.
6. Export transparent frames, a spritesheet, JSON metadata, and an animated preview.
7. Detect intentionally introduced aspect, blur, palette, clipping, and anchoring failures.
8. Correct safe deterministic failures, verify the corrected output, and record the successful lesson.
9. Require user approval before changing installed skill-level defaults.
10. Work with a non-Pop-T fixture without relying on game-specific assumptions.
