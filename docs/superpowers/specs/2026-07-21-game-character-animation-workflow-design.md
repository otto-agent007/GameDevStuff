# Game Character Animation Workflow Design

**Date:** 2026-07-21
**Status:** Owner-approved design; implementation plan pending
**Repository:** `otto-agent007/GameDevStuff`
**Branch:** `agent/game-character-animation-workflow`

## Purpose

Extend GameDevStuff from a deterministic pixel-sprite finishing pipeline into an auditable, end-to-end character-animation workflow. The workflow will accept a locked character identity, create or import motion references, repair and approve frames interactively, normalize the entire action around stable pivots and sockets, and export validated engine-ready animation packages.

The existing `pixel-sprite-animation-pipeline` remains the deterministic production back end. A new `game-character-pipeline` skill will orchestrate the creative and approval stages above it rather than duplicating its snap, normalization, receipt, export, or validation responsibilities.

Pop T is the first private production audit subject. Character-specific assets and rules do not belong in the reusable public skill.

## Repository Boundary

All workflow implementation belongs in `/mnt/2TBHDD/GameDevStuff`, including:

- the `game-character-pipeline` skill and orchestration code;
- GIF, APNG, animated WebP, PNG-sequence, MP4, and WebM intake;
- the interactive Frame Studio;
- donor and license records;
- run, source, approval, clip, pivot, socket, timing, and export contracts;
- deterministic tests, fixtures, contact sheets, previews, and audit reports;
- the later optional ComfyUI adapter.

`CockpitEscapeRoom` is a downstream consumer and is out of scope for this implementation. Its application code and runtime assets must not be modified while the GameDevStuff workflow is being built. A private copy of approved Pop T inputs may be used for an audit run. Generated assets may enter CockpitEscapeRoom only through a separate, explicitly approved integration task.

## Goals

- Own the complete animation workflow from character brief through engine export.
- Preserve approved character identity, scale, palette, and native pixels.
- Support lightweight motion sources without requiring local AI video generation.
- Make GIFs and other animated media first-class, timing-aware inputs.
- Prevent per-frame size changes, pivot pops, foot sliding, prop detachment, and cycle restarts.
- Give an owner a practical visual tool for frame selection, onion-skin alignment, timing, contacts, pivots, and sockets.
- Keep every transformation reproducible, hash-bound, inspectable, and reversible.
- Reuse the existing Pixel Snapper and deterministic pipeline contracts instead of creating a parallel finishing system.
- Produce runtime-neutral packages that downstream engines can translate without guessing geometry or timing.

## Non-goals

- Replacing the existing `pixel-sprite-animation-pipeline`.
- Making ComfyUI or Wan generation a prerequisite for initial completion.
- Claiming that a 4 GB GPU is a supported Wan image-to-video environment before measured capability tests.
- Shipping or modifying CockpitEscapeRoom production assets during this repository milestone.
- Copying an external donor repository wholesale.
- Automatically approving artistic identity, readability, comedy timing, or motion appeal.
- Adding an unreviewed production dependency or required hosted generation service.

## Execution Architecture

The workflow has one orchestrator and one deterministic production boundary:

```text
character brief
├── still actions -> image generation or supplied pose candidates
└── locomotion -> GIF/APNG/WebP/PNG sequence/video/optional ComfyUI
                                  |
                                  v
                    timing-aware frame intake
                                  |
                                  v
                     selection and Frame Studio
                                  |
                                  v
              Pixel Snapper and sequence normalization
                                  |
                                  v
             sheets, clips, previews, reports, engine export
```

The `game-character-pipeline` owns the brief, motion-source selection, candidate generation/import, approval flow, and production-run orchestration. It delegates authenticated snapping, normalization, packaging, and objective pixel validation to the existing pipeline.

### Motion source contract

Every motion source implements the same conceptual interface:

- identify source kind and immutable source hash;
- report dimensions, alpha behavior, frame count, and time base;
- decode complete ordered RGBA frames;
- preserve source timestamps or per-frame durations;
- report disposal, partial-frame, duplicate-frame, and corruption diagnostics;
- bind decoder identity and arguments into the run manifest;
- provide a deterministic resume boundary after decoding.

Initial source kinds are:

1. lossless PNG sequence;
2. GIF, APNG, or animated WebP;
3. MP4 or WebM;
4. optional ComfyUI job output.

Image generation may supply still pose candidates through the environment's built-in image-generation capability. Generated candidates remain unapproved until they pass the same identity and frame-review gates as imported media.

## Animated-media Intake

### GIF, APNG, and animated WebP

Animated image decoding must composite each frame according to its format's disposal and blending rules before publishing full RGBA frames. Naive extraction of stored frame rectangles is invalid because it can create missing pixels, trails, and ghosting.

The intake stage must:

- retain every original frame delay, including nonuniform timing;
- detect zero-delay, duplicate, empty, and partial frames;
- preserve alpha where the source format supports it;
- retain the immutable original media;
- publish composited lossless working frames;
- record any timing normalization as an explicit editable decision;
- export production frames in a lossless format rather than GIF.

### Video and PNG sequences

Video intake extracts a dense, timestamped PNG sequence before selection. Variable-frame-rate input must be represented by timestamps rather than assumed constant spacing. PNG sequences require an explicit ordering and timing source; missing timing is an authoring decision and cannot silently default.

All media kinds converge on the same selected-frame and approval contracts after decoding.

## Frame Studio

GameDevStuff will own a local Frame Studio for the judgment-heavy portion of the workflow. It is an authoring surface, not a replacement for deterministic validation.

Required capabilities:

- lossless nearest-neighbor display at integer zoom levels;
- ordered thumbnails and real-duration playback;
- frame inclusion, exclusion, duplication, replacement, and semantic labeling;
- previous/next onion skinning with adjustable opacity;
- first/last cycle-seam overlay;
- one locked character scale profile across the project;
- root pivot, baseline, planted-foot, hand, prop-grip, effect-origin, and custom socket markers;
- contact windows and ground-travel authoring;
- separate actor, prop, and effect tracks;
- non-destructive per-frame translation corrections;
- explicit opt-in rotation or scale repair, never automatic per-frame fitting;
- clipping, bounds, palette, duplicate, and anchor-drift overlays;
- contact-sheet and animated-preview generation;
- explicit owner approval or rejection with notes.

Frame Studio edits are metadata. The immutable decoded source frames remain unchanged. Rendering an approved revision produces new versioned derivatives bound to the edit-manifest hash.

### Stable animation rules

- A character uses one approved logical height and global scale across all actions.
- Root pivots and named sockets are authored against visible pixels, not inferred independently from each foreground bounding box.
- Ground travel occurs only in authored travel intervals and is checked against foot-contact windows.
- Props and effects remain separate tracks attached through named sockets.
- Noncyclic actions default to `once` or `hold-last`; only genuinely cyclic motion defaults to `loop`.
- Resampling uses nearest-neighbor only during pixel-art stages.

These rules directly address Pop T size popping, unstable hand/key attachment, foot sliding, and background movement being used to conceal actor drift.

## Run and Artifact Model

Each project begins with a versioned brief containing:

- character identity and approved anchor hashes;
- logical canvas, character height, pivot, baseline, palette, and pixel scale;
- required actions and semantic pose descriptions;
- prop and effect tracks;
- required sockets and contacts;
- engine targets;
- preferred and fallback motion sources;
- approval identities and status.

Each run uses this artifact layout:

```text
source/       immutable input media
work/         generated candidates and decoded frames
edits/        non-destructive alignment, timing, contact, and socket metadata
approved/     owner-approved frames and clips
exports/      frames, spritesheets, previews, and engine-neutral JSON
reports/      validation, provenance, hashes, contact sheets, and audit evidence
run.json      complete reproducible run manifest
```

Approved and source artifacts are append-only. A changed source, animation contract, approval manifest, or selected frame set starts a new revision or downstream run rather than overwriting prior evidence.

## Clip and Export Contract

Every exported clip declares:

- stable clip and semantic frame IDs;
- ordered, nonuniform frame sequence;
- authored duration for every frame;
- loop mode: `loop`, `once`, or `hold-last`;
- logical cell and global scale profile;
- root pivot and named sockets;
- contact windows and authored ground travel;
- actor, prop, and effect track membership;
- source, decode, edit, approval, snap, and output hashes;
- palette and alpha information;
- validation status and unresolved subjective review items.

Exports include individual transparent PNG frames, transparent spritesheets, engine-neutral JSON, lossless animated WebP previews, contact sheets, and validation reports. Engine-specific adapters may translate this contract, but may not infer missing timing, pivots, or sockets.

## Selective Donor Policy

Donor work is pinned, license-reviewed, and adopted by concept or isolated component. No donor becomes the architecture.

| Donor | Pin | License | Candidate contribution |
|---|---|---|---|
| `openai/skills` `hatch-pet` | `49f948faa9258a0c61caceaf225e179651397431` | Apache-2.0 | run manifests, canonical sources, layout guides, scoped repair, contact sheets, deterministic validation |
| `0x0funky/agent-sprite-forge` | `64fd0b57d3f2ae117ef0a95e4c2decc25b4c9dd2` | MIT | anchor sheets, identity locking, body/effect separation, scale profiles, cross-action checks, engine contracts |
| `kyh/vibedgames` | `902ec9e2c42d799446631b9dfb3162b3c61fbc17` | MIT | pose-board prompting, animated-sprite concepts, chroma cleanup, sequence-wide pixel snapping |
| `notque/vexjoy-agent` | `8b07c8eecf0d56d72f00fb44d2d41d4d54e8c4c1` | MIT | video frame intake, selection, timing metadata, QA artifacts |

Before code is imported, an implementation plan must identify the exact file, useful behavior, rejected behavior, license obligation, and whether GameDevStuff will copy, adapt, or independently implement it. Copied or materially adapted code receives per-file provenance and its required license notice.

Explicitly rejected donor behavior includes:

- naive equal-cell or equal-time slicing;
- per-frame fit scaling or Lanczos resampling;
- treating a pose board as a finished spritesheet;
- banning image-to-video as an input category;
- unsafe agent invocations that bypass approval or sandbox boundaries;
- silently changing approved source or scale contracts.

No suitable donor was identified for the full interactive onion-skin and landmark-authoring surface, so Frame Studio will be GameDevStuff-owned.

## Error Handling and Stop Rules

The workflow must fail closed when it detects:

- changed approved source bytes;
- unresolved GIF disposal or incomplete compositing;
- missing or unordered frames;
- absent authored timing;
- interpolation or non-integer scaling in a pixel stage;
- inconsistent global scale;
- missing, out-of-bounds, or unauthenticated pivots and sockets;
- excessive unexplained anchor motion;
- clipped required pixels;
- changed clip membership after approval;
- broken receipt or artifact hashes.

Deterministic, reversible repairs may be previewed and applied as a new edit revision. Identity, silhouette, costume, palette meaning, motion appeal, timing readability, and alternative valid poses require owner review.

Unavailable ComfyUI capability routes the user to media import and records generation as skipped. It never fabricates a successful generation receipt.

## ComfyUI Boundary

ComfyUI is a future optional motion-source adapter, not part of initial acceptance. The current workstation has an NVIDIA GeForce GTX 1050 Ti with 4 GB VRAM, no detected ComfyUI installation, and no detected Wan model inventory. That environment must be classified as `experimental-low-vram` until measured otherwise.

The future adapter will:

- preflight the ComfyUI API and installed node/model inventory;
- use a pinned workflow JSON and record its hash;
- record model hashes, prompt, seed, settings, source image, and output hash;
- submit, monitor, and cancel through the ComfyUI API;
- classify the environment as `ready`, `experimental-low-vram`, or `unavailable`;
- pass resulting media through the same immutable intake boundary as imported video.

Native ComfyUI workflows are preferred for the first capability test. Community GGUF or Wan wrapper nodes may be evaluated later as optional profiles, but cannot be required by the core workflow without a separate security, license, and reproducibility review.

No ComfyUI installation, model download, Wan generation, or capability claim occurs until the deterministic workflow is complete and its audit passes.

## Delivery Stages

### 1. Foundation

- Create the donor/provenance ledger.
- Define closed schemas for briefs, runs, motion sources, edits, approvals, clips, pivots, sockets, timing, contacts, and exports.
- Add small licensed or purpose-built fixtures.
- Define the boundary with the existing pipeline.

### 2. Media intake

- Implement disposal-aware animated-image decoding.
- Implement PNG-sequence and timestamp-aware video intake.
- Publish immutable source records and complete RGBA working frames.
- Add corruption, timing, duplicate, and alpha diagnostics.

### 3. Frame Studio

- Implement selection, playback, onion skins, alignment, cycle comparison, markers, tracks, timing, and approvals.
- Persist only non-destructive edits and versioned derived artifacts.
- Validate approximately desktop and narrow-browser presentations without creating a separate mobile authoring product.

### 4. Deterministic production

- Connect approved frames to Pixel Snapper and existing authenticated receipts.
- Apply sequence-wide normalization and stable pivot/socket contracts.
- Export sheets, metadata, previews, contact sheets, and reports.

### 5. Workflow audit

- Complete one public-fixture run from source through export.
- Repeat it and compare all deterministic artifact hashes.
- Review donor provenance, interpolation, timing, scale, pivots, sockets, contacts, cycle seams, and unsafe inherited behavior.
- Complete one bounded private Pop T run proving stable height, planted-foot behavior, prop attachment, and nonrestarting playback.
- Keep the Pop T assets and sensitive run evidence private.

### 6. ComfyUI capability audit

- Add the adapter behind the already-tested motion-source interface.
- Inventory hardware, server, nodes, and models.
- Test the smallest suitable pinned workflow.
- Record memory use, duration, failures, and output suitability.
- Decide from evidence whether to retain a local experimental Wan profile.

## Testing Strategy

Implementation follows test-driven development. Every new production behavior begins with a focused test that fails for the expected missing behavior.

### Unit tests

- closed-schema validation and unknown-field rejection;
- source hashing and immutable-path behavior;
- GIF disposal/blending and nonuniform delay preservation;
- APNG/WebP alpha and frame timing;
- video timestamp handling and deterministic selection;
- duplicate, empty, partial, corrupt, and missing-frame diagnostics;
- edit-manifest replay and version binding;
- pivot, socket, contact, bounds, scale, and timing validation;
- clip loop-mode and noncyclic restart protection;
- nearest-neighbor and palette integrity;
- donor/provenance record completeness.

### Integration tests

- one end-to-end GIF fixture with disposal and nonuniform timing;
- one alpha-bearing animated-image fixture;
- one timestamped video or injected decoder fixture;
- Frame Studio edit round-trip through approved export;
- existing Pixel Snapper receipt and approval-chain integration;
- repeated run with identical deterministic output hashes;
- tampered source, edit, approval, and output rejection.

### Browser and visual tests

- onion skins, frame selection, timing playback, marker editing, keyboard access, focus visibility, and reduced motion;
- integer zoom and absence of browser interpolation;
- cycle-seam and planted-foot inspection;
- long filenames, errors, narrow viewport, and large desktop viewport;
- contact sheets and animated previews reviewed against the same approved revision.

### Workflow-skill tests

The new skill is tested as process documentation before deployment:

- record baseline agent behavior without the new skill on representative workflow prompts;
- identify omissions, unsafe shortcuts, or contract violations;
- author the minimal skill guidance addressing observed failures;
- rerun the same scenarios with the skill loaded;
- close observed loopholes and repeat until the workflow is followed reliably.

## Approval Gates

1. **Foundation gate:** contracts, donor ledger, fixtures, and Frame Studio interaction proof.
2. **Workflow gate:** uninterrupted fixture run, reproducibility evidence, browser proof, and audit report.
3. **Private production gate:** Pop T contact sheets, animated previews, pivot/socket/contact evidence, and approved private output package.
4. **Capability gate:** separately reviewed ComfyUI/Wan evidence after the deterministic workflow audit.

The workflow does not publish generated Pop T assets to CockpitEscapeRoom at any GameDevStuff gate.

## Acceptance Criteria

The initial GameDevStuff milestone is complete when it can:

1. Create a versioned project from an approved character anchor and animation brief.
2. Import GIF, APNG, animated WebP, PNG-sequence, and video motion sources without losing frame composition, alpha, ordering, or timing.
3. Let an owner select, align, time, annotate, and approve frames in Frame Studio.
4. Preserve one global character scale and stable root pivot across frames and actions.
5. Author and validate named sockets, prop/effect tracks, contact windows, and ground travel.
6. Pass approved frames through the existing authenticated Pixel Snapper and normalization boundary.
7. Export transparent frames, sheets, engine-neutral JSON, contact sheets, lossless previews, provenance, hashes, and validation reports.
8. Reproduce deterministic derivatives from immutable sources and edit metadata.
9. Reject tampering, interpolation, silent timing defaults, per-frame fitting, anchor drift, clipping, and invalid approval chains.
10. Complete public-fixture and private Pop T audit runs without modifying CockpitEscapeRoom.

ComfyUI generation is explicitly excluded from these initial acceptance criteria. Its later capability gate must report measured facts rather than assuming that the local 4 GB GPU can support Wan generation.

## Reviewed References

- OpenAI Skills: <https://github.com/openai/skills>
- Agent Sprite Forge: <https://github.com/0x0funky/agent-sprite-forge>
- VibeDGames: <https://github.com/kyh/vibedgames>
- Vexjoy Agent: <https://github.com/notque/vexjoy-agent>
- ComfyUI Wan2.2 documentation: <https://docs.comfy.org/tutorials/video/wan/wan2_2>
- Official Wan2.1 repository: <https://github.com/Wan-Video/Wan2.1>
