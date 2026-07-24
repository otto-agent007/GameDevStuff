# Pose-Board Recovery and Curation Design

Status: owner-approved architecture, awaiting written-spec review
Date: 2026-07-22

## Goal

Add a first-class, auditable pose-board source path to `game-character-pipeline` so AI-generated character boards can be recovered without trusting nominal grid cells. The workflow must preserve complete poses when foreground crosses expected cell boundaries, let the owner curate the recovered candidates, and then pass only the approved ordered frames into the existing Pixel Snapper, Frame Studio, normalization, export, validation, and audit stages.

## Problem

Generated pose boards frequently violate requested grid geometry. A naïve equal-cell crop can clip one pose and include pixels from a neighboring pose even when the complete characters remain visually separable on a chroma background. Treating the grid as authoritative converts a recoverable source into frame bleeding.

The current orchestrator accepts generated single poses, PNG sequences, animated images, and video, but not a multi-pose still. Its existing connected-component recovery runs only after frames have already been separated. As a result, pose-board splitting currently falls outside the authenticated workflow.

## Approaches considered

### Fixed grid with overflow rejection

Continue equal-cell cropping and reject any source whose foreground crosses a cell boundary.

This is deterministic but preserves the failure mode. It wastes otherwise valid source art and makes prompt compliance more important than actual foreground pixels.

### Adaptive grid boundaries

Infer row and column separators from background projections, then move crop boundaries around detected foreground.

This helps boards with true rows and columns, but it still assumes grid topology. It becomes ambiguous when poses overlap nominal columns, rows have unequal counts, or effects and props occupy separator regions.

### Chroma-key component recovery plus owner curation

Treat foreground pixels as authoritative. Detect and record foreground components across the full board, propose recoverable candidate groups and ordering, show the owner an overlay and recovered thumbnails, and require an explicit hash-bound selection before frame production.

This is the selected approach. It matches the demonstrated frame-recovery workflow, supports boards whose subjects cross nominal cells, and preserves the existing approval and provenance model.

## Architecture

### Source kind and state transition

Add `pose-board` to the closed source-kind registry. Pose-board intake is a two-phase immutable run:

1. Recovery copies the original board into the run, validates its PNG bytes, computes the chroma mask and connected components, writes immutable candidate artifacts, and exits class `4` with status `awaiting-pose-selection`.
2. Curation verifies an owner-authored selection revision against the recovery report, publishes the ordered timing-aware decoded frames, and completes the normal source report.

The run ID, project hash, action ID, original board hash, recovery contract hash, mask hash, candidate hashes, selection revision, and resulting decoded-frame hashes remain bound throughout both phases.

### Recovery contract

The recovery contract is a closed JSON document containing:

- schema version `1`;
- explicit background RGBA or `border` detection mode;
- integer per-channel tolerance from `0` through `255`;
- four-neighbor connectivity;
- positive minimum component pixel count;
- maximum decoded RGBA byte count;
- integer transparent padding on every recovered candidate;
- minimum and maximum expected candidate counts;
- optional deterministic component-group proposals;
- whether unassigned eligible foreground is permitted, defaulting to `false`.

Unknown fields, unsafe numbers, missing expected counts, unsupported connectivity, or a changed contract hash fail before artifact publication.

### Pixel mask and components

Decode the source once to an immutable RGBA snapshot. Resolve the background from the contract, then create a binary foreground mask. Use four-neighbor connectivity to label components and record each component's ID, bounds, centroid, pixel count, and source-pixel hash.

Noise below the configured minimum is recorded but cannot enter a candidate. Eligible foreground remains source evidence and may not be silently discarded.

### Candidate grouping

One connected component may be a complete actor, while a valid pose can also include disconnected props or effects. Recovery therefore separates detection from grouping:

- automatic proposals may group components only through deterministic contract rules;
- the recovery report always exposes the underlying component IDs;
- the owner may accept, split a proposed group back into its whole components, merge whole components, omit, or reorder proposed groups in the selection revision;
- recovery never divides the pixels of one connected component; that would be an image-editing operation outside this stage;
- one component cannot belong to more than one selected candidate;
- unassigned eligible components block publication unless the contract explicitly permits them;
- actor, prop, and effect membership is recorded rather than flattened into an unverifiable crop.

Each recovered candidate uses the union bounds of its selected components plus contract padding. Background pixels become transparent, foreground RGBA bytes are copied without resampling, and pixels outside the selected components remain transparent.

### Ordering and timing

Centroid row-major order is only a proposed presentation order. It is never treated as semantic truth. The owner selects the final subset and order and supplies an explicit duration for every selected frame.

The selection revision binds:

- ordered candidate IDs;
- semantic frame IDs;
- positive integer durations;
- selected component groups and track roles;
- owner identity, decision, notes, and timestamp;
- recovery report SHA-256 and every selected candidate SHA-256.

Changing the source, contract, candidate bytes, grouping, order, timing, or selection invalidates the approval.

Recovered candidate crops may have different bounds. When the approved selection becomes a normal motion-source result, the adapter chooses the maximum selected candidate width and height, centers every selected candidate on that transparent canvas using integer offsets, and records each placement. It never rescales candidate pixels. This satisfies the existing identical-canvas source contract while leaving final root alignment to the post-snap stage.

### Recovery review surface

Add a `recovery` stage to Frame Studio. It shows:

- the original board with numbered component and candidate boxes;
- eligible, ignored-noise, and unassigned component diagnostics;
- recovered candidate thumbnails on transparent and chroma backgrounds;
- controls to select, merge, split, reorder, assign actor/prop/effect roles, name frames, and set durations;
- warnings for overlaps, omitted eligible foreground, duplicates, clipping, or unsafe candidate counts.

The UI writes only an immutable selection revision. It never edits the source or candidate bytes.

### Downstream handoff

After selection approval, pose-board intake publishes the same timing-aware complete RGBA frame shape used by other source adapters. Existing downstream stages remain responsible for:

1. per-frame Pixel Snap using one contract-bound pixel size and palette;
2. post-snap Frame Studio alignment with onion skins, shared scale, roots, sockets, and contacts;
3. post-snap owner approval bound to the aligned frame set;
4. normalization to the stable pivot and canvas;
5. engine-neutral export, validation, and reproducibility audit.

The recovery selection approves candidate membership, semantic order, and timing only. It does not approve alignment or replace the existing post-snap frame approval.

Grid cropping is permitted only as an explicitly verified optimization when the foreground mask proves that no eligible foreground touches or crosses any declared cell boundary. It is never a fallback for ambiguous boards.

## Artifact model

Pose-board recovery adds these immutable run artifacts:

- original board copy and source record;
- recovery contract copy and hash;
- foreground-mask PNG and hash;
- component report;
- candidate overlay PNG;
- recovered candidate PNGs;
- recovery report binding all inputs and outputs;
- numbered selection revisions;
- owner selection approval;
- final timing-aware source report and decoded frames.

Every relative path is portable and contained. Source and derived files must be regular single-link files with no symlinked path component. Publication uses a staged directory and atomic rename; existing destinations are never overwritten.

## Failure behavior

- Exit class `2`: reserved for a missing externally generated board.
- Exit class `3`: malformed source, unsafe path or permissions, invalid recovery contract, decode failure, memory limit, candidate-count violation, overlapping selected groups, lost or duplicated foreground, changed hashes, or tampered artifacts.
- Exit class `4`: recovery candidates are ready for owner curation, or the owner rejects the proposed selection.
- Exit class `0`: the approved selection has produced a complete immutable source report.

No automatic recovery claim may hide unassigned eligible foreground or substitute an inferred semantic order.

## Testing

### Unit tests

Use purpose-built synthetic PNGs only. Cover:

- two complete poses crossing nominal grid boundaries;
- deterministic chroma masking and four-neighbor components;
- configured and border-detected backgrounds with bounded tolerance;
- noise filtering without silent eligible-pixel loss;
- disconnected actor and prop components grouped into one candidate;
- stable component IDs, bounds, centroids, hashes, and proposed order;
- exact source-pixel preservation with transparent padding;
- overlapping groups, duplicate membership, unassigned eligible components, unsafe counts, excessive memory, and changed input rejection;
- immutable retry and tamper rejection.

### CLI and integration tests

Prove that:

- `intake --kind pose-board` publishes recovery artifacts and exits `4`;
- an approved numbered selection revision resumes the same run;
- order and nonuniform durations reach the normal source report exactly;
- changed candidate bytes, source bytes, recovery contract, or selection ancestry fail closed;
- selected recovered frames enter per-frame Pixel Snap rather than a whole-board grid crop.

### Browser tests

Verify component overlays, candidate selection, grouping, reordering, timing, keyboard access, focus visibility, narrow and desktop layouts, reduced motion, and stale-revision rejection.

### Acceptance

Add a public synthetic board whose two actors visibly cross nominal grid boundaries. Complete recovery, curation, Pixel Snap, alignment, normalization, export, validation, and repeatability without private assets.

## Scope boundaries

- Do not publish or encode private character assets, hashes, paths, or descriptive evidence in tests, fixtures, documentation, or package contents.
- Do not modify or integrate any downstream game repository.
- Do not add model-specific generation APIs or ComfyUI dependencies.
- Do not infer artistic quality, identity, semantic order, or timing from component geometry.
- Do not replace Pixel Snapper, Frame Studio alignment, or the existing export and audit contracts.
- Keep repository changes uncommitted until the active private audit authorizes branch completion.

## Acceptance criteria

The feature is complete when:

1. A board with foreground crossing nominal grid boundaries recovers complete candidates without grid bleeding.
2. Every eligible source foreground component is explicitly selected, intentionally omitted under contract, or blocks publication.
3. Recovered candidate pixels are source-identical apart from background transparency and padding.
4. Owner-approved grouping, order, roles, names, and timing are immutable and hash-bound.
5. Selected candidates pass through per-frame Pixel Snap and existing alignment/normalization stages.
6. Tampering or stale approval ancestry fails objectively.
7. Synthetic unit, integration, browser, acceptance, package, and skill-validation gates pass.
8. No private or downstream repository data enters Git or package artifacts.
