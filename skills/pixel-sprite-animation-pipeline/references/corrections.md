# Correction Policy

Validation reads the produced PNG, JSON, and WebP artifacts and compares them with their recorded hashes, palettes, dimensions, pivots, and timing. Measurements supplied by a caller are supporting provenance, not a substitute for inspecting the files.

## Automatic deterministic actions

| Failure | Action |
|---|---|
| `CANVAS_SIZE` | Re-pad the unchanged native foreground. |
| `NON_INTEGER_SCALE` | Re-export from the nearest canonical ancestor with an equal integer scale on both axes. |
| `INTERMEDIATE_COLORS` | Re-export with nearest-neighbor pixel blocks. |
| `BACKGROUND_REMAINS` | Re-key with the recorded background color and tolerance. |
| `PIVOT_DRIFT`, `BASELINE_DRIFT` | Re-align to the shared configured pivot. |
| `GLOBAL_SCALE_DRIFT` | Re-normalize the set with one integer scale. |
| `FRAME_BLEED` | Re-pad or rebuild the affected sheet cell. |
| Metadata-only `FRAME_COUNT` or `SOURCE_HASH_MISMATCH` with a trusted artifact | Re-export metadata from the independently verified artifact. |
| `TIMING_MISMATCH`, `METADATA_MISMATCH` | Re-export metadata from verified artifacts. |
| `PREVIEW_MISMATCH` | Re-export the animated preview. |

Automatic operations are allowlisted and reversible. The complete batch is preflighted before a correction directory is created. A batch is staged, receives a versioned manifest, and is atomically moved into a numbered `correction-NN` directory. An output path outside that directory, a path/symlink/hard-link alias of an input, an unavailable operation, or any operation error rejects the batch and removes its staging directory. Equivalent work is identified by operation, target, and failed input; it shares one execution while every original failure keeps a traceable action record.

The `correct` CLI accepts a versioned request containing only `runId`, `contractSha256`, `receiptSha256`, `receiptSignature`, `declaredFailure`, and an optional report version. The immutable report binds `correction-contract-v1.json`; that contract binds the manifest/config hashes, approved anchor, normalization ancestors and outputs, runtime outputs, palettes/dimensions/hashes, delivery geometry/pivots/timing/name/source hashes, and sheet/metadata/preview. A canonical receipt additionally binds the report, contract, manifest, config, and artifact-inventory hashes using an external project signing key and domain-separated HMAC-SHA256. Callers cannot provide ancestor paths. Every non-target artifact must still match; a target hash mismatch is tolerated only when objective validation finds the declared failure. The pipeline rebuilds from authenticated ancestors using the existing normalize/export primitives and publishes a correction only if the evidence chain verifies.

Pivot and baseline correction follows ownership: canonical/runtime image drift uses `realign`; metadata canonical/runtime pivot fields use `reexport-metadata`; preview or sheet manifestations re-export that delivery artifact. A JSON correction is never passed through an image verifier, and image-stage drift never accepts metadata-only evidence.

An objective correction may be approved when its exact failure is removed and the only remaining failures are artistic, generative, or user-review classes. The correction remains versioned and the command exits 4; no passing delivery report or profile promotion is emitted. Any remaining deterministic/objective failure blocks approval. Artistic failures are never executed automatically. `promote-profile` and `propose-rule` remain separate explicit gates.

Lesson publication is narrower than correction execution. Canvas repadding and background rekeying currently have independent artifact-specific learning verifiers. Other automatic classes remain auditable correction actions but do not emit lessons until an equally objective decoder/verifier exists, so a successful correction can never fail afterward merely because unsupported learning evidence was proposed.

Every action records its failed input, candidate output, and failure-specific before/after validation reports. Approval requires explicit `validationPassed: true`, explicit `improved: true`, a failing before report, a passing after report, the exact target failure in the before report and absent from the after report, and artifact paths with hashes that the pipeline independently verifies. Before and after bytes must differ. Image corrections must decode as images; dimension, pivot, baseline, background, and scaling corrections must also report matching failure-specific after measurements. Arbitrary changed objects, unrelated reports, invalid files, byte-identical outputs, and unverifiable evidence are not improvement. A failed or non-improving candidate remains versioned and unapproved; it never replaces an input or approved artifact.

Metadata corrections must parse as JSON and deep-equal the complete trusted document—including columns, rows, sheet/preview names, palettes, frame size, canonical/runtime pivots, configuration, source hashes, frame records, durations, and future delivery fields—after only explicit delivery-path basename normalization. Frame-count validation follows its stage: metadata-stage corrections verify metadata, while preview-stage corrections verify the preview. Preview corrections must decode to the expected page count and dimensions, with each page matching the referenced runtime frame pixels. Multi-page delays must match exactly; for a single page, where Sharp omits delay metadata, timing must match the already trusted metadata duration. Sheet corrections must match expected cell geometry and frame pixels, and every unused cell must remain transparent. A parseable but unrelated artifact never passes revalidation.

One deterministic execution may serve equivalent failures, but every original failure receives its own revalidation record and approval decision. A remaining or undocumented failure is unapproved even when another failure from the shared execution passes. All nested references to staged artifacts are rewritten to final correction paths, recorded in the manifest, and checked after the atomic move.

## User-review actions

| Failure | Action |
|---|---|
| `PALETTE_DRIFT` | Preview a nearest-palette remap and ask whether meaningful detail is preserved. |
| `LOOP_SEAM` | Review timing or a possible transition frame. |
| Unknown code | Stop for review; never infer a new automatic operation. |

Frame-count and source-hash failures are not automatically metadata problems. Metadata may be regenerated only when the failure is confined to metadata and an independently trusted artifact establishes the correct value. Runtime count disagreements, changed source files, anchor hash changes, and ambiguous provenance stop for review.

Stop whenever more than one artistically valid correction exists, palette remapping may remove meaningful detail, a correction would change the approved character design, or a proposed action conflicts with an installed rule.

## Generative-retry actions

| Failure | Action |
|---|---|
| `CLIPPED_FOREGROUND` | Regenerate only the affected frame with more padding. |
| `IDENTITY_DRIFT` | Regenerate only the affected frame from the locked anchor. |
| `DUPLICATE_POSE` | Regenerate only the duplicate pose. |

Identity, pose duplication, and loop quality are artistic or semantic checks. They stay human/generative-gated unless the run supplies explicit review evidence; deterministic pixel metrics must not claim to prove identity.

Retry accounting is per nonnegative integer frame ID, with two attempts by default. Retry keys and nonnegative integer counts are validated before staging, and remaining attempts are clamped to the configured cap. The correction report states the attempts remaining for each affected frame. This stage never calls an image generator. Stop when a frame has no attempts remaining or two retries fail to improve it, and retain all versions for review.
