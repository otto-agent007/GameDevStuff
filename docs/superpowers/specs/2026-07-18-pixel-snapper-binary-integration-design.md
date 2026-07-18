# Pixel Snapper Binary Integration Design

**Date:** 2026-07-18
**Status:** Revised after Sol High review; awaiting written-spec review
**Repository:** `otto-agent007/GameDevStuff`

## Purpose

Make Sprite Fusion Pixel Snapper a dependable, cross-platform stage of the Pixel Sprite Animation Pipeline without vendoring its Rust source or requiring every user to install Rust. This integration will let ChatGPT/Codex complete the Pop T animation workflow from generated poses through snapped, normalized, anchored, validated, and exported runtime assets.

Pixel Snapper remains an external MIT-licensed tool. GameDevStuff builds approved upstream source into downloadable binaries, publishes immutable release assets, and verifies every downloaded binary before execution.

## Goals

- Support Windows x64, macOS Intel, macOS Apple Silicon, Linux x64, and Linux ARM64.
- Use an already installed Pixel Snapper binary when one is explicitly configured.
- Provide an explicit `setup-snapper` command when no trusted binary is available.
- Download only a manually approved, pinned upstream version.
- Verify archive metadata, extracted executable identity, and SHA-256 before installing and again before running a cached binary.
- Preserve Pixel Snapper's MIT license and attribution in every binary release.
- Keep the existing manual handoff available when setup cannot complete.
- Bind every snap batch to an authenticated stage receipt without mutating the run manifest.
- Require an approved animation contract and authored frame anchors before a Pop T batch can be accepted.
- Make a complete Pop T animation run provenance-reproducible from its contract, receipts, hashes, and tool identity.

## Non-goals

- Automatically upgrading Pixel Snapper.
- Tracking upstream `main` or automatically following upstream tags.
- Committing compiled binaries to the Git repository.
- Vendoring or modifying Pixel Snapper's Rust source.
- Replacing human review for character identity, pose quality, or animation appeal.
- Generating missing artistic poses inside the setup command.
- Promising byte-identical executable archives across operating systems; reproducibility means identical source/tool provenance and exact deterministic fixture pixels per target.

## Selected Approach

GameDevStuff will publish immutable, tool-specific GitHub Releases. A release tag will identify both the upstream semantic version and exact source commit, for example:

```text
pixel-snapper-v1.0.0-commit.5743009
```

The approved immutable upstream `v1.0.0` tag peels to `5743009265051098831ad7298092072325d1149b`. The formerly reviewed `ae20461f60fb39e75d15f184bab1ebec1219511c` differs only in README content and is historical context, not the release pin; the Rust source, `Cargo.lock`, `Cargo.toml`, and `LICENSE` (including the reviewed executable-relevant bytes) are unchanged. The abbreviated commit is only a readable tag suffix. The release metadata and pinned tool manifest always contain and verify the full 40-character upstream commit SHA. The release will contain one archive per target, the upstream MIT license, third-party notices, checksums, an SBOM, provenance, and machine-readable build metadata. A manually dispatched workflow is the only way to create a supported tool version; an existing release tag or asset is never replaced.

Alternatives were rejected as follows:

- A Git submodule makes Codex worktrees, recursive checkout, and CI setup more fragile.
- Vendored source increases repository size and creates an unnecessary maintenance fork.
- Runtime Cargo installation requires Rust and performs an unbounded external build on the user's machine.
- Automatically downloading during `snap` would introduce unexpected network and executable changes during an asset run.

## Components

### 1. Binary release workflow

A manually triggered GitHub Actions workflow accepts an approved upstream tag and full commit SHA. It must reject a moving branch name or an abbreviated-only revision as the build source.

The initial build matrix is native on every target:

| Asset | GitHub runner | Rust target | Archive |
|---|---|---|---|
| Windows x64 | `windows-2025` | `x86_64-pc-windows-msvc` | ZIP |
| macOS Intel | `macos-15-intel` | `x86_64-apple-darwin` | TAR.GZ |
| macOS Apple Silicon | `macos-15` | `aarch64-apple-darwin` | TAR.GZ |
| Linux x64 | `ubuntu-24.04` | `x86_64-unknown-linux-musl` | TAR.GZ |
| Linux ARM64 | `ubuntu-24.04-arm` | `aarch64-unknown-linux-musl` | TAR.GZ |

The Linux policy is static musl rather than an undocumented minimum glibc version. The workflow pins Rust `1.88.0`, runs `cargo build --locked --release --target <target>`, and pins every GitHub Action by a reviewed full commit SHA rather than a mutable tag. Before the workflow is merged, a matrix-only probe must prove that all five runner labels are enabled for this public repository. No release may claim a target that did not execute its fixture natively on that target.

Build jobs use `permissions: contents: read`, receive no secrets, and cannot publish. The separate publish job uses `contents: write`, downloads the completed build artifacts, validates their declared file set and hashes without executing the binaries, and creates the immutable release. This prevents compiled upstream code from running in the credentialed job.

For each supported target, the workflow will:

1. Check out the exact upstream commit.
2. Verify that the supplied upstream tag peels to the supplied full commit and that `HEAD` equals it.
3. Record Rust/Cargo versions, target triple, upstream `Cargo.lock` hash, and the GameDevStuff workflow commit.
4. Build the native CLI with the pinned toolchain and upstream lockfile.
5. Run and record both required compatibility probes, `--version` and `--help`.
6. Process the same deterministic input, then compare decoded dimensions, palette, and exact RGBA pixel hash with the approved fixture expectation.
7. Generate an SPDX SBOM and third-party dependency notices from the locked Rust dependency graph.
8. Package only the binary, upstream MIT license, third-party notices, SBOM, and target metadata.
9. Calculate SHA-256 and byte size for both the executable and final archive.

The publish job will collect all platform archives and produce:

- `pixel-snapper-windows-x64.zip`
- `pixel-snapper-macos-x64.tar.gz`
- `pixel-snapper-macos-arm64.tar.gz`
- `pixel-snapper-linux-x64.tar.gz`
- `pixel-snapper-linux-arm64.tar.gz`
- `checksums.json`
- `build-metadata.json`
- `LICENSE-Pixel-Snapper`
- `THIRD-PARTY-NOTICES`
- `pixel-snapper.spdx.json`

Release publishing must fail unless every required target, native fixture result, archive/executable checksum and size, license, notices file, SBOM, and provenance record is present. GitHub's artifact attestation is published when available, but the pinned manifest hashes remain the runtime trust root.

### 2. Pinned tool manifest

The skill package will contain a reviewed manifest that specifies:

- release tag and immutable GitHub release URL;
- upstream repository, version, and full commit SHA;
- supported platform/architecture keys;
- archive filename, SHA-256, and byte size per target;
- executable name, relative archive path, SHA-256, and byte size;
- Rust/Cargo versions, target triple, upstream lockfile hash, and workflow commit;
- approved deterministic fixture input hash and exact decoded RGBA output hash;
- license, notices, SBOM, and provenance filenames and hashes;
- manifest schema version.

The manifest is a closed schema and the pipeline never resolves `latest`. Updating it is the deliberate upgrade action and requires the full test suite plus platform CI. Release metadata is informative; the reviewed manifest committed with the skill is the source of expected hashes.

### 3. Binary resolution

The snap stage will resolve Pixel Snapper in this order:

1. `PIXEL_SNAPPER_BIN` environment variable;
2. an explicitly overridden `snapper.executable` project configuration (not the built-in default name);
3. the verified installation under `.pixel-sprite-pipeline/tools/pixel-snapper/<release-tag>/`;
4. the default executable name on `PATH`.

Configuration loading must preserve whether `snapper.executable` came from an explicit project override or the built-in default; the merged value alone is insufficient. Resolution returns an origin enum (`environment`, `project-config`, `managed-cache`, or `path`) and a canonical physical executable path. Windows PATH lookup scans entries deterministically using the executable name and `.EXE` from `PATHEXT`; it does not invoke `where.exe` or a shell.

Every candidate must be a regular file and pass shell-free `--version`, `--help`, and deterministic-fixture probes. Explicit invalid environment/config candidates fail clearly rather than falling through. A managed-cache candidate additionally must have no symlinked path component, remain physically contained in its version directory, and match the pinned executable size and SHA-256 on every resolution. If no candidate is usable, `snap` returns the existing resumable handoff plus the exact `setup-snapper` command.

Environment, config, and PATH binaries are user-selected rather than GameDevStuff-managed. Their real executable hash, size, physical path, origin, compatibility output, and fixture result are recorded, but they receive a pinned release tag/upstream commit only if the executable hash matches a pinned manifest entry.

### 4. Authenticated snap-stage receipt

The immutable run manifest is not modified after creation. Each successful snap batch instead writes `snap-receipt.json` plus an HMAC signature using the pipeline's existing protected project-local signing key. The receipt binds:

- schema version, run ID, and SHA-256 of the immutable run manifest when a run context exists;
- standalone request ID when `snap` is invoked outside a guided run;
- animation-contract SHA-256;
- ordered source paths and hashes;
- ordered output paths and hashes;
- exact structured arguments, color count, palette hash, and pixel-size override;
- binary origin, canonical physical path, size, SHA-256, compatibility output, and deterministic fixture result;
- pinned release tag and upstream full commit only when the binary hash matches the pinned manifest;
- creation timestamp and receipt payload SHA-256.

The receipt and signature are published atomically and never overwritten. Standalone `snap` always emits them next to its outputs. Retrying the snap stage in the same run requires the same signed binary identity, animation contract, arguments, and source hashes; otherwise the user must start a new run.

Landmark coordinates are intentionally absent from the pre-generation animation contract and snap receipt because they do not exist until the snapped pixels exist. After snapping, the user or an approved authoring tool creates a separate signed `frame-approval-manifest.json`. It binds the animation-contract hash, snap-receipt payload hash, exact ordered output hashes, semantic frame IDs, authored snapped-image landmark coordinates, and visual approval status. It is atomically published and immutable. If landmarks need revision before normalization, a new numbered approval manifest is created; normalization accepts exactly one explicitly selected approved version and records its hash in every downstream artifact. Once normalization begins, changing the selected approval manifest starts a new downstream run.

Downstream normalization verifies both chains: run manifest → snap receipt → snapped outputs, and animation contract + snap receipt → frame approval → authored landmarks. Later downstream resumes rely on those authenticated hashes and do not require the executable still to exist.

### 5. Explicit setup command

The CLI will add:

```text
pixel-sprite-pipeline setup-snapper
```

The command will:

1. Detect the operating system and CPU architecture.
2. Acquire a per-release setup lock using atomic directory creation; concurrent callers wait for the owner or return a bounded `setup-in-progress` result.
3. Select the exact asset from the pinned manifest.
4. Download to a unique temporary file under `.pixel-sprite-pipeline/tools/.downloads/`.
5. Enforce HTTPS, at most three redirects, no protocol downgrade, the approved initial GameDevStuff release path, and a closed redirect-host allowlist for GitHub release storage.
6. Stream the response with a 25 MiB archive limit and verify archive size and SHA-256 before extraction.
7. Parse ZIP/TAR in-process with pinned dependencies and preflight every entry before writing anything.
8. Extract into a unique versioned temporary directory using exclusive file creation.
9. Verify the extracted executable's regular-file status, physical containment, size, and SHA-256.
10. Run the compatibility probe and deterministic fixture, comparing exact decoded RGBA hash.
11. Write an installation receipt containing the manifest hash, executable identity, fixture result, and installed file hashes.
12. Atomically publish the verified versioned installation and release the setup lock.

Archive preflight rejects absolute and traversal paths, NULs, symlinks, hardlinks, devices, FIFOs, sockets, drive/UNC paths, alternate data streams, trailing dots/spaces, Windows reserved names, case-fold collisions, duplicate normalized paths, and unexpected files. Limits are 16 entries, 100 MiB total uncompressed data, 50 MiB per file, and a 100:1 maximum compression ratio.

The setup lock records PID, process-start identity when available, and timestamp. A lock is reclaimed only when its process is confirmed absent and its age exceeds the documented stale threshold; interruption cleanup is best-effort, while final publication remains atomic. The tool cache is generated local state and remains ignored by Git. Setup is idempotent only after revalidating the installation receipt and current executable hash. A `--force` option may redownload the same pinned version but cannot select another version.

### 6. Failure and fallback behavior

Setup failures must leave no partially active installation. Diagnostics distinguish unsupported platform, setup lock contention, network/redirect failure, missing release, size/checksum mismatch, unsafe archive, extraction failure, executable mismatch, and probe/fixture failure.

On setup failure, the user can still:

- set `PIXEL_SNAPPER_BIN` to a trusted manual installation;
- configure `snapper.executable`; or
- follow the existing manual handoff and resume the pipeline afterward.

Checksum mismatch, archive safety failure, executable mismatch, and binary fixture failure are hard failures and never fall through to executing the downloaded file. A tampered managed cache is quarantined from resolution until `setup-snapper --force` restores the exact pinned installation.

Manual resume has a distinct provenance path. After verifying the handoff manifest, exact expected filenames, and source/output hashes, it creates a signed `manual-handoff-receipt.json` whose origin is `manual-handoff`, whose `toolProvenanceVerified` field is `false`, and whose binary identity and arguments are explicitly `null` rather than inferred. This receipt permits ordinary normalization while preserving an honest audit trail, but it is ineligible for reproducible Pop T release acceptance. To promote a manual batch, the pipeline must actually rerun a verified binary with the approved arguments and produce byte-identical snapped output hashes under a standard snap receipt.

## Pop T End-to-End Flow

The integration does not invent artistic poses. Before generation, the private Pop T project must provide a signed or hash-bound, user-approved `animation-contract.json`. The public skill defines its closed schema; the private project supplies the creative values. A contract is invalid unless it contains:

- approved anchor image hash and locked character-trait reference hashes;
- canonical size `128×128`, generation size `1024×1024`, runtime size `256×256`;
- generation-to-canonical Pixel Snapper `pixelSize: 8`;
- canonical pivot `(64,112)` and baseline `111`;
- a frozen palette derived from the approved transparent anchor, including exact ordered RGBA values, palette hash, and an ordered six-digit RGB `snapperPaletteHex` list that excludes the transparent entry;
- one or more named clips;
- exact ordered frame IDs and semantic pose labels for every clip;
- one duration in milliseconds per frame;
- loop mode (`loop`, `once`, or `hold-last`) and, for loops, the transition from final frame to first;
- the required landmark semantic for each frame (for example, character root or planted-foot contact) and its target canonical origin `(64,112)`;
- required post-snap visual review checkpoints and authorized approver identities.

The CLI may not substitute default 100 ms durations or independently choose a palette per frame. Snapper arguments come from the contract: fixed color count, `--pixel-size 8`, and the same frozen opaque RGB `--palette` for the entire batch; transparency remains governed by the anchor/pipeline alpha rules. Missing clip, frame, duration, palette, or landmark semantic stops before generation/snap. Changing the contract hash starts a new run.

After snapping, the signed frame-approval manifest supplies the actual coordinate for each contract-required landmark semantic. The landmark represents the stable character root/contact point, not the changing foreground bounding-box center. Normalization cannot begin without an authenticated approved manifest covering every expected output hash. It applies one global integer scale and translates each frame so its approved landmark maps to `(64,112)`. Foreground bounds remain clipping evidence only. This prevents an extended arm, leg, or prop from shifting Pop T's torso. The validator reports per-frame landmark drift and requires zero pixel drift after normalization; loop clips additionally require human review of the last-to-first root motion and silhouette transition.

A complete Pop T run uses this sequence:

1. Load and authenticate the approved animation contract and 128×128 anchor.
2. Generate exactly the contract's ordered pose set at 1024×1024 using the separate pixel matrix reference.
3. Run every pose through the resolved Pixel Snapper binary with the contract's shared 16-color-or-fewer palette and explicit `--pixel-size 8`.
4. Authenticate the snap receipt and require the exact expected frame IDs, order, and output hashes.
5. Author and approve a signed frame-approval manifest containing the post-snap landmark coordinate for every output.
6. Normalize using those approved landmarks, one global integer scale, shared canvas, pivot, and baseline.
7. Export 256×256 runtime frames, per-clip sprite sheets, JSON metadata, and lossless animated WebP previews using the exact contract durations and loop modes.
8. Validate pixels, frozen palette, frame order/count, durations, source hashes, clipping, background, landmark/pivot/baseline, sheet cells, preview fidelity, and loop-root continuity.
9. Apply allowlisted deterministic corrections and revalidate; stop for human review on identity, pose readability, motion appeal, or loop quality.

The real private Pop T batch is a release acceptance fixture, not a public repository fixture. Its acceptance report records the animation-contract hash, ordered private source/output hashes, selected frame-approval-manifest hash, landmark results, visual approval, and the authenticated verified-tool snap receipt. Manual-handoff receipts are rejected for this acceptance. The report may be retained privately while the public PR records only pass/fail and non-sensitive measurements.

## Security and Licensing

- No downloaded archive or extracted executable is used before archive, contents, executable hash, and deterministic fixture verification.
- Downloads begin at the approved GameDevStuff release URL encoded in the pinned manifest; redirects remain HTTPS and restricted to the documented GitHub release-storage hosts.
- Child processes use structured arguments with `shell: false`.
- Installation uses bounded streaming, preflighted in-process extraction, an interprocess setup lock, versioned directories, and atomic publication.
- Managed binaries are hash-checked on every resolution; explicit external binaries are never misrepresented as a pinned upstream release.
- Snap receipts are authenticated with the existing protected project-local signing key and bind tool, contract, input, arguments, and outputs.
- Source and generated frames are never overwritten.
- Release archives include Pixel Snapper's original MIT license and copyright notice.
- Release archives also include generated third-party dependency notices and an SPDX SBOM.
- GameDevStuff documentation identifies the upstream project, exact unmodified source revision, locked dependency graph, toolchain, workflow commit, and artifact hashes for each build.

## Testing

### Unit tests

- platform and architecture mapping;
- manifest schema and closed-field validation;
- config-origin preservation, resolution precedence, PATH/PATHEXT behavior, and explicit-path failure;
- archive and executable size/hash success and mismatch;
- cached executable tampering, symlink/path-component swap, and physical-containment rejection;
- ZIP/TAR traversal, links, bombs, case collisions, reserved names, UNC/drive/ADS paths, trailing dots/spaces, and unexpected entries;
- redirect limits, foreign hosts, protocol downgrade, streaming size limits, and interrupted downloads;
- setup locking, stale-lock policy, concurrent setup, idempotence, atomic activation, and killed extraction cleanup;
- signed snap-receipt creation, standalone receipt output, post-snap frame-approval chaining/version selection, tampering rejection, and manifest/contract/input/output binding;
- honest manual-handoff receipt creation, null binary provenance, ordinary normalization eligibility, and Pop T acceptance rejection;
- binary identity matching, truthful external-binary provenance, snap retry identity enforcement, and downstream receipt verification;
- animation-contract schema, ordered clips/durations/loop modes, frozen palette, authored landmarks, and zero anchor drift.

### Integration tests

- a dependency-injected fetch transport serving valid/corrupted archives without weakening production HTTPS and host enforcement;
- successful setup into an isolated project cache;
- shell-free compatibility and exact decoded-pixel fixture execution;
- fallback handoff when no binary is installed;
- real built-archive install tests for every release asset;
- installed-binary snap followed by receipt verification, landmark normalization, per-contract export, and validation;
- a multi-frame fixture whose extended limb proves foreground-bound recentering cannot move the authored root.

### CI and release tests

- Node 20 and 24 pipeline tests on Ubuntu and Windows;
- installer smoke tests on every binary-build target;
- native execution of the deterministic fixture on every target runner;
- cross-platform release asset completeness;
- archive/executable checksum and pixel-fixture verification against downloaded release assets;
- unprivileged-build/credentialed-publish job separation checks;
- SBOM, third-party notices, license, and provenance completeness;
- package inspection proving binaries and private sprite fixtures are not included in the npm package.

## Upgrade Procedure

Upgrades are manual and reviewable:

1. Select an upstream release and full commit SHA.
2. Review upstream license, source, locked dependency, and CLI behavior changes.
3. Dispatch the binary release workflow for a new immutable tag.
4. Verify native fixture pixels, licenses/notices, SBOM, provenance, and archive/executable hashes for all platform artifacts.
5. Update the pinned tool manifest in a pull request.
6. Run the full pipeline suite and a private Pop T contract acceptance run without changing that contract.
7. Merge only after platform CI and visual review pass.

Existing releases are never overwritten. Rollback consists of restoring the prior pinned manifest entry.

## Acceptance Criteria

The binary integration is complete when each clean supported target can run `setup-snapper`, obtain and revalidate an archive- and executable-verified binary without Rust, and complete a snap batch through the existing CLI with an authenticated receipt. Tampering, unsafe archives, changed binary identity, contract drift, and interrupted/concurrent setup must fail closed without activating partial state.

The Pop T pipeline is complete only when the real private, user-approved pre-generation animation contract contains exact clips, frame order/count, durations, loop modes, frozen palette, `pixelSize: 8`, and required landmark semantics; every expected pose is snapped with the same authenticated verified tool identity; a signed post-snap frame-approval manifest supplies an approved coordinate for every output hash; every selected landmark maps exactly to `(64,112)` without foreground-driven jitter; and the 256×256 runtime frames, per-clip sheets, metadata, and previews pass objective validation plus human identity/motion/loop review. Manual-handoff provenance cannot satisfy this gate. The final private report must bind the contract, run manifest, verified-tool snap receipt, selected frame-approval manifest, source/output hashes, tool provenance, and approval evidence while proving the original source files remain unchanged.
