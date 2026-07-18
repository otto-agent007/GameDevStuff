# Configuration and Project Learning

## Precedence

Configuration is resolved in this order, with later values replacing earlier values one field at a time:

1. bundled defaults;
2. `.pixel-sprite-pipeline/profile.yaml` in the active project, or an explicitly selected profile;
3. explicit per-run overrides.

Only the documented top-level and nested keys are accepted by durable learning. Unknown keys are rejected rather than silently retained or discarded. A promoted profile is a project-local convenience, not a change to the installed skill. Explicit run overrides remain highest priority.

## Current schema

```yaml
canonical: { width: 128, height: 128 }
generation: { width: 1024, height: 1024 }
runtime: { width: 256, height: 256 }
pivot: { x: 64, y: 112 }
palette:
  mode: preserve-anchor
background:
  mode: border
  color: null                 # or { r: 0, g: 255, b: 0, a: 255 }
  tolerance: 0                # maximum per-channel RGB difference
foreground:
  retentionPolicy: all       # all | largest | reject-multiple
  minimumComponentPixels: 1
snapper:
  executable: spritefusion-pixel-snapper
  args: ['16']
correction:
  generativeAttempts: 2
  skillProposalEvidence: 3
```

All three sizes use positive integer dimensions. Generation and runtime dimensions must be exact positive integer multiples of the corresponding canonical dimensions and use the same scale on both axes. The pivot is expressed in whole canonical pixels and must be inside the canonical cell. Runtime pivot coordinates are derived by the integer runtime scale; with the defaults they are `(128, 224)`.

`foreground.retentionPolicy: all` retains every connected component at or above `minimumComponentPixels`, so detached but intentional details are not discarded. `largest` is an explicit opt-in. `reject-multiple` stops when more than one qualifying component remains.

`background.mode: border` requires `color: null` and derives the key from border pixels. `background.mode: configured` requires explicit byte-valued `r`, `g`, `b`, and `a` channels. The schema is closed: sections must contain every documented field, enums and arrays are type-checked, and unknown fields fail before a run is created or a profile is promoted.

The Pixel Snapper executable may be overridden for a process with `PIXEL_SNAPPER_BIN`. Process environment selection affects invocation but is not learned as an installed-skill rule. Export columns, animation durations, and output names are delivery arguments rather than profile fields; WebP durations must be one integer per frame in the range 11–65535 milliseconds.

## Durable state

Before a guided run is reserved, the approved source is inspected. The immutable manifest binds a redacted inspection snapshot and its hash to the source SHA-256 and decoded dimensions; absolute source paths are replaced with a marker. Standalone `createRun` callers may provide the same snapshot contract, but mismatched hashes or dimensions are rejected. Inspection reports alpha counts, component sizes/union, margins and clipping, inferred pixel-grid evidence, and smoothing suspicion with confidence and explicit heuristic limitations.

Before guided validation, the exporter atomically creates `correction-contract-v1.json`. The immutable run report binds its hash. Explicit recovery must present that hash and a failure identity; the contract, never the request or failed metadata, supplies trusted paths and expected delivery state. Contract and report replacements, stale hashes, non-target mutations, links, and arbitrary run-contained substitutes are rejected.

After the immutable report is published, the project creates `.pixel-sprite-pipeline/keys/correction-signing-v1.key` outside every run and seals a run-local `correction-receipt-v1.json`. Key creation is exclusive and concurrency-safe; on POSIX, the keys directory is created and verified as owner-controlled `0700`, and the key is at least 32 random bytes, owned by the effective user, regular, single-link, and exactly `0600`. Existing owner-only keys directories may be more restrictive. The project, state, and keys path components must be real directories rather than symlinks; the state directory must not be group/world-writable, and the keys directory must have no group/world permissions. Windows retains the type, symlink, and link-count checks but skips POSIX UID/mode checks. The key is never printed or persisted in manifests, reports, contracts, receipts, or version control. Missing/unsafe keys or receipts fail closed and require explicit revalidation/reissue. The receipt binds project/run identity, initial manifest/config/report/contract hashes, artifact inventory, timestamp, and nonce with domain-separated HMAC-SHA256.

```text
.pixel-sprite-pipeline/
├── profile.yaml
├── lessons.jsonl
└── runs/
    └── <run-id>/
        ├── manifest.json
        ├── report.json
        ├── report-02.json
        └── correction-01/
            └── manifest.json
```

Run IDs use Windows-safe characters and reject reserved device stems (including names with extensions), trailing dots/spaces, and control characters on every operating system. Production IDs combine a colon-free UTC timestamp with a UUID. A run manifest is written in a private staging directory and published atomically; an existing run is never overwritten. Inputs are resolved physically after every path component is checked; file and parent-directory symlinks are rejected rather than followed. True project-local regular files receive normalized project-relative identifiers, while physically external regular files require an explicit portable identifier. Inputs record SHA-256 hashes and JSON-safe provenance. Absolute private paths and secret-like fields are rejected from durable learning records.

`report.json` is immutable. A later, different result must use an explicit numbered version such as `report-02.json`. Reports name their run ID and exact manifest hash. Profile publication uses a lock and atomic replacement, so a failed validation or write leaves the previous profile intact.

Report and lesson-index publication is recoverable. If a process publishes a report but fails while reading or updating `lessons.jsonl`, repair or quarantine the malformed index and retry the exact same call. Identical report bytes and hash are accepted only to finish lesson publication; conflicting bytes are rejected and require a new report version. Lesson rows are deduplicated by run, report, correction manifest, and action index, so recovery is idempotent.

Temporary files and `*.lock` files indicate an interrupted writer. Temporary files can be removed after confirming no pipeline process is active. A stale run lock may also be removed after that check; the corresponding final run directory, if present, remains authoritative. Never repair a published manifest or report in place—create a new run or versioned report.

## Evidence policy

A passing boolean is not learning evidence by itself. Project profile promotion requires all of the following:

- the report names the selected immutable run and its current manifest hash;
- validation is marked passing;
- at least one relative artifact path and SHA-256 hash is present;
- each referenced artifact is a regular, non-symlink, single-link file physically contained under the run, with no symlinked path segment, and matches its hash;
- the effective manifest configuration passes configuration validation.

A lesson has a stricter chain. It must reference the canonical `correction-NN/manifest.json` path whose schema version and correction number match its directory and whose run ID/manifest hash bind it to the selected immutable run. The selected per-failure action must be approved as `applied` or `deduplicated`, match the exact code/correction/target, contain a failing before-validation record and passing after-validation record, use different hashes, and reference regular contained artifacts matching both hashes. The learning layer then inspects the artifacts again for correction-specific objective improvement; caller-authored `passed`, `valid`, `approved`, expected sizes, actual sizes, or measurement booleans are never sufficient. Canvas repadding requires an unambiguous `canonical`, `runtime`, or `generation` target stage and derives the expected dimensions only from the bound run configuration before decoding both images. Background cleanup likewise derives its key and tolerance from that configuration. Other correction classes remain recorded for audit but cannot become lesson evidence until an equally objective verifier is added.

Lesson rows also bind the run manifest and versioned report by hash. Malformed JSON or malformed row schemas in `lessons.jsonl` stop proposal evaluation with the row number; they are never silently counted or skipped.

Skill-rule proposals count distinct immutable run IDs once, even if a run records the same lesson more than once. The threshold is `correction.skillProposalEvidence` (three by default). A caller may request a lower positive threshold, but the returned proposal discloses both thresholds and the reduced evidence. Every proposal includes its evidence run IDs and hashes for audit.

## Approval boundary

Project learning and installed-skill changes are deliberately separate:

- `promoteVerifiedProfile` may atomically reuse verified settings only in the active project.
- `proposeSkillRule` only returns a proposal. It always sets `requiresUserApproval: true` and never edits configuration, skill instructions, or installed files.

Changing the installed skill requires a separate, explicit user approval and the normal skill update workflow. Insufficient evidence is reported rather than treated as success.
