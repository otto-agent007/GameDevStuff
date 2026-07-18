# Pixel Snapper Binary Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship checksum-verified Pixel Snapper binaries for five desktop targets and integrate them into an authenticated, landmark-stable Pop T animation pipeline.

**Architecture:** GameDevStuff builds one immutable Pixel Snapper release from an approved upstream commit, while the Node.js skill installs and verifies the correct target asset into project-local state. A resolver produces a truthful binary identity; signed snap receipts and post-snap frame-approval manifests form an immutable provenance chain that landmark-based normalization, contract-driven export, and validation consume.

**Tech Stack:** Node.js 20.9+ ESM, `sharp` 0.35.3, `commander` 15.0.0, `yaml` 2.9.0, `fflate` 0.8.3, `tar-stream` 3.2.0, Node `node:test`, Rust 1.88.0, Cargo, cargo-sbom 0.10.0, cargo-about 0.8.4, GitHub Actions and Releases.

**Scope and sequencing:** This is one plan because the production tool manifest cannot exist until the five-target release succeeds, authenticated snap receipts require the verified resolver and installer, and landmark-stable export requires both receipt and frame-approval state. Tasks 1–9 can be implemented and tested against fixtures before Task 10 publishes; Task 11 is the deliberate integration gate that consumes the immutable release.

## Global Constraints

- Supported targets are Windows x64, macOS Intel, macOS Apple Silicon, Linux x64 musl, and Linux ARM64 musl.
- Build natively on `windows-2025`, `macos-15-intel`, `macos-15`, `ubuntu-24.04`, and `ubuntu-24.04-arm` respectively.
- Build Pixel Snapper with Rust 1.88.0 and `cargo build --locked --release --target` followed by the current matrix target triple.
- Pin every GitHub Action by reviewed full commit SHA; build jobs have `contents: read`, no secrets, and cannot publish.
- Never resolve a `latest` release, moving branch, abbreviated-only source revision, or unverified executable.
- Managed-cache binaries must be regular contained files and match pinned byte size and SHA-256 on every resolution.
- Downloads use HTTPS, at most three redirects, bounded streaming, a closed GitHub-host allowlist, and preflighted in-process archive extraction.
- Archive limits are 25 MiB compressed, 16 entries, 100 MiB total uncompressed, 50 MiB per entry, and 100:1 compression ratio.
- Snap subprocesses use structured arguments and `shell: false`.
- The immutable run manifest is never mutated; provenance is added through authenticated chained receipts.
- Manual handoff provenance is explicitly unverified and cannot satisfy Pop T release acceptance.
- The Pop T contract fixes 128×128 canonical, 1024×1024 generation, 256×256 runtime, `pixelSize: 8`, pivot `(64,112)`, and baseline `111`.
- The Pop T palette and durations are contract inputs; never quantize each frame independently or substitute 100 ms defaults.
- Actual landmark coordinates are authored after snapping and must map exactly to `(64,112)` during normalization.
- Preserve all original source files and keep private Pop T assets, receipts, and reports outside the public Git history and npm package.

---

## File Map

### New runtime units

- `skills/pixel-sprite-animation-pipeline/references/pixel-snapper-tool-manifest.json` — reviewed production release identity and per-target hashes.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/state-auth.mjs` — shared secure signing-key access, canonical hashing, atomic signed document creation, and verification.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/tool-manifest.mjs` — closed manifest schema and platform/architecture selection.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/tool-identity.mjs` — PATH resolution, realpath containment, executable hashing, version/help probes, and deterministic fixture probe.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/download.mjs` — bounded HTTPS fetch with manual redirect validation.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/archive.mjs` — preflighted ZIP/TAR parsing and safe extraction.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/setup-lock.mjs` — cross-process setup lock and stale-owner policy.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/setup-snapper.mjs` — idempotent verified installation and atomic activation.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/snap-receipt.mjs` — verified-tool and manual-handoff receipts.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/animation-contract.mjs` — closed pre-generation contract validation and hashing.
- `skills/pixel-sprite-animation-pipeline/scripts/lib/frame-approval.mjs` — signed post-snap landmark approval manifests.

### New release units

- `.github/workflows/pixel-snapper-release.yml` — unprivileged five-target build matrix and credentialed publish job.
- `skills/pixel-sprite-animation-pipeline/scripts/release/package-pixel-snapper.mjs` — deterministic archive layout and target metadata.
- `skills/pixel-sprite-animation-pipeline/scripts/release/assemble-release.mjs` — asset completeness, hash aggregation, and production manifest generation.
- `skills/pixel-sprite-animation-pipeline/scripts/release/verify-release.mjs` — post-publish download and hash verification.
- `skills/pixel-sprite-animation-pipeline/references/pixel-snapper-upstream.LICENSE` — upstream MIT notice.
- `skills/pixel-sprite-animation-pipeline/references/pixel-snapper-about.hbs` — cargo-about third-party-notice template.

### Modified units

- `skills/pixel-sprite-animation-pipeline/package.json` and `npm-shrinkwrap.json` — pinned archive dependencies and packaged manifest/license files.
- `scripts/lib/config.mjs` — preserve snapper executable provenance.
- `scripts/lib/contract.mjs` — consume shared state-auth primitives without weakening existing correction receipts.
- `scripts/lib/snapper.mjs` — resolve verified identities, use contract arguments, and emit receipts.
- `scripts/lib/normalize.mjs` — place frames from authored landmarks rather than changing bounds.
- `scripts/lib/export.mjs` — export exact contract clips, durations, and loop modes.
- `scripts/lib/validate.mjs` — validate contract order, palette, landmark drift, timings, and loop evidence.
- `scripts/cli.mjs` — add `setup-snapper`, animation contract, snap receipt, frame approval, and contract-driven guided flow.
- `SKILL.md` and `references/pixel-snapper.md` — setup and provenance workflow.
- `.github/workflows/pixel-sprite-skill.yml` — installer and contract integration tests.
- `.gitignore` — downloaded tools and private approval state.

---

### Task 1: Shared State Authentication and Configuration Provenance

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/state-auth.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/state-auth.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/config.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/contract.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/config.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/contract.test.mjs`

**Interfaces:**
- Produces: `stableHash(value)`, `writeSignedState({ projectDir, file, domain, payload, createKey })`, and `readSignedState({ projectDir, file, domain })`.
- Produces: `loadConfigWithProvenance(options) -> { config, provenance: { snapperExecutable: 'default'|'profile'|'override' } }`.
- Preserves: `loadConfig(options) -> config` and all existing correction-contract behavior.

- [ ] **Step 1: Write failing authentication and provenance tests**

```js
test('signed state is domain-separated and fails after payload tampering', async () => {
  const projectDir = await secureProject('state-auth-');
  const file = path.join(projectDir, '.pixel-sprite-pipeline', 'receipt.json');
  await writeSignedState({ projectDir, file, domain: 'pixel-sprite-snap/v1', payload: { runId: 'run-1' }, createKey: true });
  assert.deepEqual((await readSignedState({ projectDir, file, domain: 'pixel-sprite-snap/v1' })).payload, { runId: 'run-1' });
  const changed = JSON.parse(await fs.readFile(file, 'utf8'));
  changed.payload.runId = 'run-2';
  await fs.writeFile(file, JSON.stringify(changed));
  await assert.rejects(readSignedState({ projectDir, file, domain: 'pixel-sprite-snap/v1' }), /signature mismatch/);
});

test('config records whether snapper executable was explicitly selected', async () => {
  const plain = await loadConfigWithProvenance({ cwd: fixtureDir });
  assert.equal(plain.provenance.snapperExecutable, 'default');
  const explicit = await loadConfigWithProvenance({ cwd: fixtureDir, overrides: { snapper: { executable: '/trusted/snapper' } } });
  assert.equal(explicit.provenance.snapperExecutable, 'override');
});
```

- [ ] **Step 2: Run the focused tests and verify the missing exports**

Run: `cd skills/pixel-sprite-animation-pipeline && node --test tests/state-auth.test.mjs tests/config.test.mjs tests/contract.test.mjs`

Expected: FAIL because `state-auth.mjs` and `loadConfigWithProvenance` do not exist.

- [ ] **Step 3: Extract the existing secure key lifecycle into `state-auth.mjs`**

```js
export function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export async function writeSignedState({ projectDir, file, domain, payload, createKey = false }) {
  const key = await signingKey(projectDir, { create: createKey });
  const signature = crypto.createHmac('sha256', key).update(`${domain}\0`).update(JSON.stringify(stable(payload))).digest('hex');
  const document = { version: 1, payload, signature };
  await atomicNew(file, `${JSON.stringify(document, null, 2)}\n`);
  return { document, sha256: stableHash(document) };
}

export async function readSignedState({ projectDir, file, domain }) {
  const key = await signingKey(projectDir);
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  const expected = crypto.createHmac('sha256', key).update(`${domain}\0`).update(JSON.stringify(stable(document.payload))).digest('hex');
  const left = Buffer.from(document.signature ?? '', 'hex');
  const right = Buffer.from(expected, 'hex');
  if (document.version !== 1 || left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw new Error('signed state signature mismatch');
  return { ...document, sha256: stableHash(document) };
}
```

Move the current ownership, mode, link-count, symlink, concurrent-key-creation, and atomic-new checks unchanged from `contract.mjs`; import the new primitives there and retain the correction receipt domain `pixel-sprite-correction-receipt/v1`.

- [ ] **Step 4: Add config provenance without changing existing callers**

```js
export async function loadConfigWithProvenance({ cwd, profilePath, overrides = {} }) {
  const selected = profilePath ?? path.join(cwd, '.pixel-sprite-pipeline', 'profile.yaml');
  const profile = await readProfile(selected);
  const source = Object.hasOwn(overrides.snapper ?? {}, 'executable') ? 'override'
    : Object.hasOwn(profile.snapper ?? {}, 'executable') ? 'profile' : 'default';
  return { config: validateConfig(merge(merge(DEFAULT_CONFIG, profile), overrides)), provenance: deepFreeze({ snapperExecutable: source }) };
}

export async function loadConfig(options) {
  return (await loadConfigWithProvenance(options)).config;
}
```

- [ ] **Step 5: Run the focused and full suites**

Run: `node --test tests/state-auth.test.mjs tests/config.test.mjs tests/contract.test.mjs && npm test`

Expected: focused tests PASS; full suite reports zero failures with only the existing environment-dependent ownership skip.

- [ ] **Step 6: Commit**

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/state-auth.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/config.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/contract.mjs skills/pixel-sprite-animation-pipeline/tests/state-auth.test.mjs skills/pixel-sprite-animation-pipeline/tests/config.test.mjs skills/pixel-sprite-animation-pipeline/tests/contract.test.mjs
git commit -m "refactor: share authenticated pipeline state"
```

---

### Task 2: Tool Manifest, Platform Mapping, and Truthful Binary Identity

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/tool-manifest.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/tool-identity.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/tool-manifest.test.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/tool-identity.test.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/fixtures/tool-manifest.fixture.json`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/snapper.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/snapper.test.mjs`

**Interfaces:**
- Produces: `validateToolManifest(document)`, `platformKey({ platform, arch })`, and `selectToolAsset(manifest, platform)`.
- Produces: `resolvePixelSnapper({ projectDir, config, configProvenance, manifest, env, pathValue })`.
- Produces identity `{ origin, path, physicalPath, size, sha256, version, helpSha256, fixtureRgbaSha256, pinnedReleaseTag, upstreamCommit }`.

- [ ] **Step 1: Write failing closed-schema, PATH, and tampered-cache tests**

```js
test('platform mapping is closed and explicit', () => {
  assert.equal(platformKey({ platform: 'win32', arch: 'x64' }), 'windows-x64');
  assert.equal(platformKey({ platform: 'darwin', arch: 'arm64' }), 'macos-arm64');
  assert.throws(() => platformKey({ platform: 'freebsd', arch: 'x64' }), /unsupported Pixel Snapper platform/);
});

test('managed cache is rejected after executable replacement', async () => {
  const fixture = await managedBinaryFixture();
  await fs.appendFile(fixture.executable, 'tampered');
  await assert.rejects(resolvePixelSnapper(fixture.resolveOptions), /managed Pixel Snapper hash mismatch/);
});

test('external binary records no pinned identity unless its hash matches', async () => {
  const resolved = await resolvePixelSnapper(await externalBinaryFixture());
  assert.equal(resolved.origin, 'environment');
  assert.equal(resolved.pinnedReleaseTag, null);
  assert.equal(resolved.upstreamCommit, null);
});
```

- [ ] **Step 2: Run the focused tests**

Run: `node --test tests/tool-manifest.test.mjs tests/tool-identity.test.mjs tests/snapper.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the manifest and target contract**

```js
const TARGETS = Object.freeze({
  'win32/x64': 'windows-x64',
  'darwin/x64': 'macos-x64',
  'darwin/arm64': 'macos-arm64',
  'linux/x64': 'linux-x64',
  'linux/arm64': 'linux-arm64'
});

export function platformKey({ platform = process.platform, arch = process.arch } = {}) {
  const key = TARGETS[`${platform}/${arch}`];
  if (!key) throw new Error(`unsupported Pixel Snapper platform: ${platform}/${arch}`);
  return key;
}

export function validateToolManifest(input) {
  assertClosedObject(input, ['schemaVersion', 'release', 'upstream', 'build', 'fixture', 'assets']);
  if (input.schemaVersion !== 1 || !FULL_SHA.test(input.upstream.commit) || !FULL_SHA.test(input.build.workflowCommit)) throw new Error('invalid pinned Pixel Snapper manifest');
  for (const target of Object.values(TARGETS)) validateAsset(input.assets[target], target);
  return deepFreeze(structuredClone(input));
}
```

The fixture manifest uses 64-character synthetic hashes and local fixture archives; production code receives the real manifest path rather than special-casing tests.

- [ ] **Step 4: Implement deterministic resolution and identity inspection**

```js
export async function resolvePixelSnapper({ projectDir, config, configProvenance, manifest, env = process.env, pathValue = env.PATH ?? '' }) {
  const candidates = candidateList({ projectDir, config, configProvenance, manifest, env, pathValue });
  for (const candidate of candidates) {
    if (candidate.explicit) return inspectPixelSnapperBinary({ ...candidate, manifest });
    try { return await inspectPixelSnapperBinary({ ...candidate, manifest }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

export async function inspectPixelSnapperBinary({ path: selected, origin, managed, manifest }) {
  const secure = await secureExecutable(selected, { managedRoot: managed?.root });
  const sha = await sha256(secure.physicalPath);
  if (managed && (secure.stat.size !== managed.asset.executableSize || sha !== managed.asset.executableSha256)) throw new Error('managed Pixel Snapper hash mismatch');
  const version = probe(secure.physicalPath, ['--version']);
  const help = probe(secure.physicalPath, ['--help']);
  const fixtureRgbaSha256 = await runFixtureProbe(secure.physicalPath, manifest.fixture);
  const pinned = Object.values(manifest.assets).find((asset) => asset.executableSha256 === sha && asset.executableSize === secure.stat.size);
  return { origin, path: selected, physicalPath: secure.physicalPath, size: secure.stat.size, sha256: sha, version: version.stdout.trim(), helpSha256: hashText(help.stdout), fixtureRgbaSha256, pinnedReleaseTag: pinned ? manifest.release.tag : null, upstreamCommit: pinned ? manifest.upstream.commit : null };
}
```

On Windows, `candidateList` scans PATH entries itself and tests the candidate basename with an `.exe` suffix when `.EXE` is in `PATHEXT`; it never invokes a shell or `where.exe`.

- [ ] **Step 5: Make the snapper adapter consume resolved identities**

Change `detectPixelSnapper` to an async compatibility wrapper around `resolvePixelSnapper`; keep handoff creation when it returns `null`. Pass the identity object into `runPixelSnapper` rather than re-resolving per frame.

- [ ] **Step 6: Run tests and commit**

Run: `node --test tests/tool-manifest.test.mjs tests/tool-identity.test.mjs tests/snapper.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/tool-manifest.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/tool-identity.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/snapper.mjs skills/pixel-sprite-animation-pipeline/tests/tool-manifest.test.mjs skills/pixel-sprite-animation-pipeline/tests/tool-identity.test.mjs skills/pixel-sprite-animation-pipeline/tests/snapper.test.mjs skills/pixel-sprite-animation-pipeline/tests/fixtures/tool-manifest.fixture.json
git commit -m "feat: resolve verified Pixel Snapper identities"
```

---

### Task 3: Bounded Download and Safe Archive Extraction

**Files:**
- Modify: `skills/pixel-sprite-animation-pipeline/package.json`
- Modify: `skills/pixel-sprite-animation-pipeline/npm-shrinkwrap.json`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/download.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/archive.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/download.test.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/archive.test.mjs`

**Interfaces:**
- Produces: `downloadPinnedAsset({ url, expectedSize, expectedSha256, fetchImpl, output })`.
- Produces: `inspectArchive({ bytes, format, expectedFiles, limits })` and `extractInspectedArchive({ inspection, outputDir })`.

- [ ] **Step 1: Install exact archive dependencies**

Run: `npm install --save-exact fflate@0.8.3 tar-stream@3.2.0 && npm shrinkwrap`

Expected: package and shrinkwrap contain exactly `fflate: 0.8.3` and `tar-stream: 3.2.0`.

- [ ] **Step 2: Write failing redirect, size, traversal, link, bomb, and collision tests**

```js
test('download rejects downgrade and foreign redirect hosts', async () => {
  const fetchImpl = scriptedFetch([{ status: 302, location: 'http://evil.example/tool.zip' }]);
  await assert.rejects(downloadPinnedAsset({ ...request, fetchImpl }), /unsafe Pixel Snapper redirect/);
});

test('archive preflight writes nothing for a case-fold collision', async () => {
  const bytes = zipFixture([{ name: 'Tool.exe', data: 'a' }, { name: 'tool.exe', data: 'b' }]);
  assert.throws(() => inspectArchive({ bytes, format: 'zip', expectedFiles: ['tool.exe'], limits: LIMITS }), /case-fold collision/);
  assert.deepEqual(await fs.readdir(outputDir), []);
});

test('archive rejects links, ADS, reserved names, and excessive ratio', () => {
  for (const fixture of unsafeArchives()) assert.throws(() => inspectArchive(fixture), fixture.expectedError);
});
```

- [ ] **Step 3: Run tests and verify failures**

Run: `node --test tests/download.test.mjs tests/archive.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 4: Implement manual redirect and bounded streaming**

```js
export async function downloadPinnedAsset({ url, expectedSize, expectedSha256, fetchImpl = fetch, output }) {
  let current = approvedInitialUrl(url);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchImpl(current, { redirect: 'manual' });
    if (REDIRECTS.has(response.status)) { current = approvedRedirect(current, response.headers.get('location'), redirects); continue; }
    if (!response.ok || !response.body) throw new Error(`Pixel Snapper download failed: HTTP ${response.status}`);
    const handle = await fs.open(output, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 25 * 1024 * 1024 || size > expectedSize) throw new Error('Pixel Snapper archive exceeded pinned size');
        hash.update(chunk); await handle.write(chunk);
      }
      if (size !== expectedSize || hash.digest('hex') !== expectedSha256) throw new Error('Pixel Snapper archive size or checksum mismatch');
    } catch (error) {
      await handle.close();
      await fs.rm(output, { force: true });
      throw error;
    }
    await handle.close();
    return { output, size, sha256: expectedSha256 };
  }
  throw new Error('Pixel Snapper redirect limit exceeded');
}
```

- [ ] **Step 5: Implement preflight-first archive parsing**

`inspectArchive` collects metadata and bounded entry buffers in memory, normalizes every path, validates all entries and the complete expected file set, then returns an opaque frozen inspection. No output path is opened until the whole archive passes. `extractInspectedArchive` writes each approved regular file with `flag: 'wx'`, mode `0700` for the executable and `0600` for data files.

```js
const DEFAULT_LIMITS = Object.freeze({ entries: 16, compressed: 25 << 20, total: 100 << 20, perFile: 50 << 20, ratio: 100 });

function validateEntry(entry, seen) {
  const name = normalizePortable(entry.name);
  if (unsafePortablePath(name) || entry.type !== 'file') throw new Error(`unsafe archive entry: ${entry.name}`);
  const folded = name.normalize('NFC').toLocaleLowerCase('en-US');
  if (seen.has(folded)) throw new Error(`archive case-fold collision: ${name}`);
  seen.add(folded);
  return name;
}
```

- [ ] **Step 6: Run tests and commit**

Run: `node --test tests/download.test.mjs tests/archive.test.mjs && npm test && npm pack --dry-run`

Expected: tests PASS; package includes runtime archive modules but not tests.

```bash
git add skills/pixel-sprite-animation-pipeline/package.json skills/pixel-sprite-animation-pipeline/npm-shrinkwrap.json skills/pixel-sprite-animation-pipeline/scripts/lib/download.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/archive.mjs skills/pixel-sprite-animation-pipeline/tests/download.test.mjs skills/pixel-sprite-animation-pipeline/tests/archive.test.mjs
git commit -m "feat: securely download Pixel Snapper archives"
```

---

### Task 4: Concurrent-Safe Setup and `setup-snapper` CLI

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/setup-lock.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/setup-snapper.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/setup-lock.test.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/setup-snapper.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/cli.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/cli.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `withSetupLock({ projectDir, releaseTag, operation, now, processProbe })`.
- Produces: `setupPixelSnapper({ projectDir, manifestPath, fetchImpl, force }) -> { status, executable, identity, receipt }`.
- Adds CLI: `pixel-sprite-pipeline setup-snapper [--project-dir PATH] [--force]`.

- [ ] **Step 1: Write failing concurrency, stale-lock, idempotence, interruption, and tamper tests**

```js
test('concurrent setup publishes one verified installation', async () => {
  const calls = await Promise.all(Array.from({ length: 8 }, () => setupPixelSnapper(fixture.options)));
  assert.equal(new Set(calls.map((item) => item.executable)).size, 1);
  assert.equal(calls.filter((item) => item.status === 'installed').length, 1);
});

test('setup quarantines a changed cached executable until force restore', async () => {
  const first = await setupPixelSnapper(fixture.options);
  await fs.appendFile(first.executable, 'tamper');
  await assert.rejects(setupPixelSnapper(fixture.options), /managed Pixel Snapper hash mismatch/);
  assert.equal((await setupPixelSnapper({ ...fixture.options, force: true })).status, 'installed');
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/setup-lock.test.mjs tests/setup-snapper.test.mjs tests/cli.test.mjs`

Expected: FAIL with missing setup modules and command.

- [ ] **Step 3: Implement the atomic setup lock**

```js
export async function withSetupLock({ projectDir, releaseTag, operation, now = Date.now, processProbe = defaultProcessProbe }) {
  const lock = path.join(projectDir, '.pixel-sprite-pipeline', 'tools', '.locks', safeTag(releaseTag));
  const owner = { pid: process.pid, createdAt: now(), nonce: crypto.randomUUID() };
  await acquireDirectoryLock(lock, owner, { now, processProbe, staleMs: 10 * 60_000, waitMs: 30_000 });
  try { return await operation(); }
  finally { await releaseOwnedLock(lock, owner); }
}
```

`processProbe(pid)` returns `alive`, `dead`, or `unknown`. A lock is reclaimed only when it is older than ten minutes and the probe returns `dead`; `unknown` fails closed. `releaseOwnedLock` rereads the owner document and removes the directory only when its nonce matches the caller's nonce.

- [ ] **Step 4: Implement verified installation and activation**

```js
export async function setupPixelSnapper({ projectDir, manifestPath, fetchImpl = fetch, force = false }) {
  const manifest = await loadToolManifest(manifestPath);
  const target = platformKey();
  const asset = selectToolAsset(manifest, target);
  return withSetupLock({ projectDir, releaseTag: manifest.release.tag, operation: async () => {
    const finalDir = installationDir(projectDir, manifest.release.tag, target);
    if (!force && await exists(finalDir)) return verifyInstalledTool({ finalDir, manifest, asset });
    const stage = await createInstallStage(projectDir, manifest.release.tag);
    try {
      const archive = await downloadPinnedAsset({ url: asset.url, expectedSize: asset.archiveSize, expectedSha256: asset.archiveSha256, fetchImpl, output: path.join(stage, 'download') });
      const inspection = await inspectDownloadedArchive(archive, asset);
      await extractInspectedArchive({ inspection, outputDir: path.join(stage, 'content') });
      const identity = await verifyStagedExecutable({ stage, manifest, asset });
      const receipt = await writeInstallationReceipt({ stage, manifest, asset, identity });
      await publishInstallation({ stage, finalDir, force });
      return { status: 'installed', executable: installedExecutable(finalDir, asset), identity, receipt };
    } catch (error) { await cleanupInstallStage(stage); throw error; }
  }});
}
```

- [ ] **Step 5: Add the CLI command and ignored state**

```js
program.command('setup-snapper')
  .option('--project-dir <path>')
  .option('--force')
  .action(async (options) => print(await setupPixelSnapper({ projectDir: resolveCwd(options), manifestPath: packagedToolManifest(), force: options.force === true })));
```

Ensure `.pixel-sprite-pipeline/tools/` remains ignored and no setup path is included by `npm pack --dry-run`.

- [ ] **Step 6: Verify and commit**

Run: `node --test tests/setup-lock.test.mjs tests/setup-snapper.test.mjs tests/cli.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add .gitignore skills/pixel-sprite-animation-pipeline/scripts/lib/setup-lock.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/setup-snapper.mjs skills/pixel-sprite-animation-pipeline/scripts/cli.mjs skills/pixel-sprite-animation-pipeline/tests/setup-lock.test.mjs skills/pixel-sprite-animation-pipeline/tests/setup-snapper.test.mjs skills/pixel-sprite-animation-pipeline/tests/cli.test.mjs
git commit -m "feat: install pinned Pixel Snapper binaries"
```

---

### Task 5: Verified Snap Receipts and Honest Manual Handoffs

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/snap-receipt.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/snap-receipt.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/snapper.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/cli.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/snapper.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/e2e.test.mjs`

**Interfaces:**
- Produces: `writeSnapReceipt({ projectDir, run, contract, inputs, outputs, args, identity })`.
- Produces: `writeManualHandoffReceipt({ projectDir, run, handoff, inputs, outputs })`.
- Produces: `verifySnapReceipt({ projectDir, file, expectedRun, expectedContract })`.

- [ ] **Step 1: Write failing standard/manual receipt and retry tests**

```js
test('verified receipt binds tool, contract, ordered inputs, arguments, and outputs', async () => {
  const receipt = await writeSnapReceipt(verifiedFixture);
  assert.equal(receipt.document.payload.toolProvenanceVerified, true);
  await fs.appendFile(verifiedFixture.outputs[0], 'tamper');
  await assert.rejects(verifySnapReceipt({ ...verifiedFixture.verify, file: receipt.path }), /output hash mismatch/);
});

test('manual handoff is truthful and cannot claim binary identity', async () => {
  const receipt = await writeManualHandoffReceipt(manualFixture);
  assert.equal(receipt.document.payload.origin, 'manual-handoff');
  assert.equal(receipt.document.payload.toolProvenanceVerified, false);
  assert.equal(receipt.document.payload.binary, null);
  assert.equal(receipt.document.payload.arguments, null);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/snap-receipt.test.mjs tests/snapper.test.mjs tests/e2e.test.mjs`

Expected: FAIL with missing receipt module.

- [ ] **Step 3: Implement domain-separated receipt payloads**

```js
const SNAP_DOMAIN = 'pixel-sprite-snap-receipt/v1';
const MANUAL_DOMAIN = 'pixel-sprite-manual-handoff-receipt/v1';

export async function writeSnapReceipt({ projectDir, run, contract, inputs, outputs, args, identity }) {
  const payload = { version: 1, origin: identity.origin, toolProvenanceVerified: true, run: await runBinding(run), animationContractSha256: contract.sha256, inputs: await records(inputs), outputs: await records(outputs), arguments: [...args], binary: identity, createdAt: new Date().toISOString() };
  const file = path.join(run.outputDir, 'snap-receipt.json');
  return { ...(await writeSignedState({ projectDir, file, domain: SNAP_DOMAIN, payload, createKey: true })), path: file };
}

export async function writeManualHandoffReceipt({ projectDir, run, handoff, inputs, outputs }) {
  const payload = { version: 1, origin: 'manual-handoff', toolProvenanceVerified: false, run: await runBinding(run), handoffSha256: await sha256(handoff), inputs: await records(inputs), outputs: await records(outputs), arguments: null, binary: null, createdAt: new Date().toISOString() };
  const file = path.join(run.outputDir, 'manual-handoff-receipt.json');
  return { ...(await writeSignedState({ projectDir, file, domain: MANUAL_DOMAIN, payload, createKey: true })), path: file };
}
```

- [ ] **Step 4: Integrate receipt creation and retry identity checks**

`runPixelSnapper` resolves once, uses contract arguments, hashes every output, then publishes the standard receipt. Manual resume validates exact handoff filenames and publishes only the manual receipt. Re-running snap in one run compares the existing receipt's contract, source, arguments, and binary SHA before any subprocess execution.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/snap-receipt.test.mjs tests/snapper.test.mjs tests/e2e.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/snap-receipt.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/snapper.mjs skills/pixel-sprite-animation-pipeline/scripts/cli.mjs skills/pixel-sprite-animation-pipeline/tests/snap-receipt.test.mjs skills/pixel-sprite-animation-pipeline/tests/snapper.test.mjs skills/pixel-sprite-animation-pipeline/tests/e2e.test.mjs
git commit -m "feat: authenticate Pixel Snapper batches"
```

---

### Task 6: Animation Contract and Post-Snap Frame Approval

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/animation-contract.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/lib/frame-approval.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/animation-contract.test.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/tests/frame-approval.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/cli.mjs`

**Interfaces:**
- Produces: `loadAnimationContract(file) -> { document, sha256 }`.
- Produces: `writeFrameApproval({ projectDir, runDir, contract, snapReceipt, frames, approvals, version })`.
- Produces: `verifyFrameApproval({ projectDir, file, contract, snapReceipt })`.

- [ ] **Step 1: Write failing contract and approval-chain tests**

```js
test('Pop T contract rejects implicit timing, palette, or landmark semantics', async () => {
  for (const field of ['clips', 'snapperPaletteHex', 'landmarkSemantic']) {
    await assert.rejects(loadAnimationContract(await contractMissing(field)), new RegExp(field));
  }
});

test('frame approval is created only after snap and covers every ordered output hash', async () => {
  const approval = await writeFrameApproval(frameApprovalFixture);
  assert.equal(approval.document.payload.snapReceiptSha256, frameApprovalFixture.snapReceipt.sha256);
  assert.deepEqual(approval.document.payload.frames.map((item) => item.landmark), [{ x: 61, y: 109 }, { x: 62, y: 110 }]);
  await assert.rejects(writeFrameApproval({ ...frameApprovalFixture, approvals: frameApprovalFixture.approvals.slice(1) }), /approval for every snapped frame/);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/animation-contract.test.mjs tests/frame-approval.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the closed pre-generation contract**

```js
export async function loadAnimationContract(file) {
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  assertExactKeys(document, ['version', 'anchor', 'sizes', 'pivot', 'baseline', 'palette', 'clips', 'review']);
  assert.equal(document.version, 1);
  assert.deepEqual(document.sizes, { canonical: [128, 128], generation: [1024, 1024], runtime: [256, 256], pixelSize: 8 });
  validatePalette(document.palette);
  validateClips(document.clips);
  return deepFreeze({ document, sha256: stableHash(document) });
}
```

`validateClips` requires unique clip/frame IDs, exact order, one integer duration in `11..65535` per frame, loop mode in `loop|once|hold-last`, and a nonempty `landmarkSemantic` with target `{ x: 64, y: 112 }` for every frame.

- [ ] **Step 4: Implement signed numbered frame approvals**

```js
export async function writeFrameApproval({ projectDir, runDir, contract, snapReceipt, approvals, version }) {
  const outputs = snapReceipt.document.payload.outputs;
  if (!Number.isInteger(version) || version < 1 || approvals.length !== outputs.length) throw new Error('frame approval requires one approval for every snapped frame');
  const frames = outputs.map((output, index) => validateApproval(approvals[index], output, contract.document.clips));
  const payload = { version: 1, approvalVersion: version, animationContractSha256: contract.sha256, snapReceiptSha256: snapReceipt.sha256, frames, approvedBy: approvals[0].approvedBy, createdAt: new Date().toISOString() };
  const file = path.join(runDir, `frame-approval-${String(version).padStart(2, '0')}.json`);
  return writeSignedState({ projectDir, file, domain: 'pixel-sprite-frame-approval/v1', payload, createKey: true });
}
```

- [ ] **Step 5: Add CLI commands for contract inspection and approval creation**

Add `contract inspect --file` and `approve-frames --contract --snap-receipt --approval-request --version`; both print JSON and never open an editor or infer coordinates.

- [ ] **Step 6: Verify and commit**

Run: `node --test tests/animation-contract.test.mjs tests/frame-approval.test.mjs tests/cli.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/animation-contract.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/frame-approval.mjs skills/pixel-sprite-animation-pipeline/scripts/cli.mjs skills/pixel-sprite-animation-pipeline/tests/animation-contract.test.mjs skills/pixel-sprite-animation-pipeline/tests/frame-approval.test.mjs skills/pixel-sprite-animation-pipeline/tests/cli.test.mjs
git commit -m "feat: define authenticated animation approvals"
```

---

### Task 7: Landmark-Stable Normalization

**Files:**
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/normalize.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/normalize.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/validate.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/validate.test.mjs`

**Interfaces:**
- Changes: `normalizeFrames({ inputs, outputDir, config, scaleFactor, landmarks })` requires one `{ frameId, source: {x,y}, target: {x,y} }` per frame when an animation contract is present.
- Adds measurement fields: `frameId`, `sourceLandmark`, `canonicalLandmark`, `landmarkDrift`.

- [ ] **Step 1: Write the extended-limb regression first**

```js
test('authored roots stay fixed when pose bounds change', async () => {
  const { frames, landmarks } = await makeExtendedLimbFrames();
  const result = await normalizeFrames({ inputs: frames, landmarks, outputDir, config: DEFAULT_CONFIG, scaleFactor: 1 });
  assert.deepEqual(result.measurements.map((item) => item.canonicalLandmark), [{ x: 64, y: 112 }, { x: 64, y: 112 }]);
  assert.deepEqual(result.measurements.map((item) => item.landmarkDrift), [{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  assert.equal(await torsoX(result.frames[0]), await torsoX(result.frames[1]));
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/normalize.test.mjs tests/validate.test.mjs`

Expected: FAIL because bounds-based placement moves the torso and has no landmark fields.

- [ ] **Step 3: Replace center/baseline placement with landmark translation**

```js
const scaledLandmark = {
  x: (landmark.source.x - recovered.bounds.left) * scaleFactor,
  y: (landmark.source.y - recovered.bounds.top) * scaleFactor
};
const left = landmark.target.x - scaledLandmark.x;
const top = landmark.target.y - scaledLandmark.y;
const right = left + scaled.width;
const bottom = top + scaled.height;
if (left < 0 || top < 0 || right > config.canonical.width || bottom > config.canonical.height) throw new Error(`frame ${landmark.frameId} exceeds canonical cell at approved landmark`);
const canonicalLandmark = { x: left + scaledLandmark.x, y: top + scaledLandmark.y };
const landmarkDrift = { x: canonicalLandmark.x - landmark.target.x, y: canonicalLandmark.y - landmark.target.y };
```

Keep foreground bounds for clipping/component evidence, not placement. Preserve legacy bounds placement only for runs without an animation contract, so existing generic users do not break.

- [ ] **Step 4: Validate zero landmark drift and loop root continuity evidence**

Add objective `LANDMARK_DRIFT` when either axis is nonzero. Add `HUMAN_REVIEW_REQUIRED` with check `LOOP_ROOT_TRANSITION` for every loop clip unless explicit semantic evidence approves the last-to-first transition.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/normalize.test.mjs tests/validate.test.mjs && npm test`

Expected: all tests PASS and the extended-limb torso remains stationary.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/normalize.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/validate.mjs skills/pixel-sprite-animation-pipeline/tests/normalize.test.mjs skills/pixel-sprite-animation-pipeline/tests/validate.test.mjs
git commit -m "feat: normalize animation frames by authored landmarks"
```

---

### Task 8: Contract-Driven Clip Export and Validation

**Files:**
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/export.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/validate.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/export.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/validate.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/cli.mjs`

**Interfaces:**
- Produces: `exportContractAnimation({ normalized, contract, outputDir, config, columns }) -> { clips, metadata }`.
- Each clip returns ordered runtime frames, sheet, preview, exact durations, and loop mode.

- [ ] **Step 1: Write failing exact-duration, order, palette, and loop tests**

```js
test('contract export preserves frame order and nonuniform durations', async () => {
  const result = await exportContractAnimation(contractFixture);
  assert.deepEqual(result.clips.run.frames.map((item) => item.id), ['run-00', 'run-01', 'run-02']);
  assert.deepEqual(result.clips.run.durations, [80, 90, 110]);
  assert.equal(result.clips.run.loopMode, 'loop');
  assert.deepEqual((await sharp(result.clips.run.preview, { animated: true }).metadata()).delay, [80, 90, 110]);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/export.test.mjs tests/validate.test.mjs`

Expected: FAIL because export accepts one flat duration list and no clip contract.

- [ ] **Step 3: Add per-clip export composition**

```js
export async function exportContractAnimation({ normalized, contract, outputDir, config, columns = 8 }) {
  const byId = new Map(normalized.frames.map((file, index) => [normalized.measurements[index].frameId, file]));
  const clips = {};
  for (const clip of contract.document.clips) {
    const frames = clip.frames.map((frame) => requiredFrame(byId, frame.id));
    const durations = clip.frames.map((frame) => frame.durationMs);
    clips[clip.id] = { ...(await exportAnimation({ frames, durations, outputDir: path.join(outputDir, clip.id), config, columns, name: clip.id })), frames: clip.frames.map((frame, index) => ({ id: frame.id, file: frames[index] })), durations, loopMode: clip.loopMode };
  }
  return { clips, metadata: await writeContractIndex(outputDir, contract, normalized, clips) };
}
```

- [ ] **Step 4: Extend validation**

Validate exact contract hash, clip set, ordered IDs, per-frame durations, loop mode, frozen palette hash, `snapperPaletteHex`, selected frame-approval hash, landmark measurements, sheet cells, and preview pixels/delays. Missing or extra frames are objective failures; artistic loop quality remains human review.

- [ ] **Step 5: Remove guided-run 100 ms substitution**

The guided CLI must pass `clip.frames.map(frame => frame.durationMs)` from the loaded contract. Reject `--duration` flags when a contract is supplied so two timing sources cannot conflict.

- [ ] **Step 6: Verify and commit**

Run: `node --test tests/export.test.mjs tests/validate.test.mjs tests/cli.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/lib/export.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/validate.mjs skills/pixel-sprite-animation-pipeline/scripts/cli.mjs skills/pixel-sprite-animation-pipeline/tests/export.test.mjs skills/pixel-sprite-animation-pipeline/tests/validate.test.mjs skills/pixel-sprite-animation-pipeline/tests/cli.test.mjs
git commit -m "feat: export animation clips from approved contracts"
```

---

### Task 9: Guided End-to-End Receipt and Approval State Machine

**Files:**
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/cli.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/scripts/lib/learning.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/e2e.test.mjs`
- Modify: `skills/pixel-sprite-animation-pipeline/tests/repair.test.mjs`

**Interfaces:**
- Guided run states add `awaiting-frame-approval` between snapped frames and normalization.
- Run manifests bind the animation contract at creation; they remain immutable afterward.
- Downstream artifacts record selected snap-receipt and frame-approval hashes.

- [ ] **Step 1: Write the failing state-transition tests**

```js
test('guided animation waits for signed frame approval after verified snapping', async () => {
  const run = await startAnimationRun(fixture);
  const snapped = await resumeWithGeneratedFrames(run);
  assert.equal(snapped.state, 'awaiting-frame-approval');
  await assert.rejects(resumeNormalization(snapped), /signed frame approval is required/);
  const approved = await approveAndResume(snapped);
  assert.equal(approved.state, 'complete');
});

test('manual handoff can normalize but cannot pass Pop T release acceptance', async () => {
  const result = await completeManualRun(manualFixture);
  assert.equal(result.report.toolProvenanceVerified, false);
  assert.equal(result.report.popTAcceptance.eligible, false);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/e2e.test.mjs tests/repair.test.mjs`

Expected: FAIL because the state machine normalizes immediately after snapping.

- [ ] **Step 3: Add the approval handoff**

The canonical handoff records contract hash, snap-receipt hash, ordered output hashes, expected frame IDs, and the structured `approve-frames` invocation. Resume accepts only a verified signed approval whose contract, snap receipt, and output hashes match that handoff.

```js
const approvalHandoff = {
  schema: 'pixel-sprite-frame-approval-handoff/v1',
  runId,
  state: 'awaiting-frame-approval',
  animationContractSha256: contract.sha256,
  snapReceiptSha256: snapReceipt.sha256,
  frames: snapReceipt.document.payload.outputs.map((item, index) => ({ id: contractFrames[index].id, path: portablePath(runDir, item.path), sha256: item.sha256, landmarkSemantic: contractFrames[index].landmarkSemantic }))
};
```

- [ ] **Step 4: Bind downstream reports and correction contracts**

Add `animationContractSha256`, `snapReceiptSha256`, `frameApprovalSha256`, and `toolProvenanceVerified` to the delivery report and correction contract. Existing deterministic correction sealing must authenticate these fields before repairing any animation artifact.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/e2e.test.mjs tests/repair.test.mjs tests/contract.test.mjs && npm test`

Expected: all tests PASS.

```bash
git add skills/pixel-sprite-animation-pipeline/scripts/cli.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/learning.mjs skills/pixel-sprite-animation-pipeline/scripts/lib/contract.mjs skills/pixel-sprite-animation-pipeline/tests/e2e.test.mjs skills/pixel-sprite-animation-pipeline/tests/repair.test.mjs skills/pixel-sprite-animation-pipeline/tests/contract.test.mjs
git commit -m "feat: gate animation delivery on signed approvals"
```

---

### Task 10: Five-Target Binary Release Workflow

**Files:**
- Create: `.github/workflows/pixel-snapper-release.yml`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/release/package-pixel-snapper.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/release/assemble-release.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/scripts/release/verify-release.mjs`
- Create: `skills/pixel-sprite-animation-pipeline/references/pixel-snapper-about.hbs`
- Create: `skills/pixel-sprite-animation-pipeline/references/pixel-snapper-upstream.LICENSE`
- Create: `skills/pixel-sprite-animation-pipeline/tests/release-tools.test.mjs`

**Interfaces:**
- Workflow inputs: `upstream_tag`, `upstream_commit` (40 hex), and `release_tag` matching `pixel-snapper-v` plus a semantic version and `-commit.` plus the first seven source-SHA characters.
- Build artifacts contain binary, upstream license, `THIRD-PARTY-NOTICES`, `pixel-snapper.spdx.json`, and `target-metadata.json`.
- `assemble-release.mjs` emits `checksums.json`, `build-metadata.json`, and the production tool manifest.

- [ ] **Step 1: Write failing release assembly tests**

```js
test('release assembly rejects a missing native target or mismatched fixture pixels', async () => {
  await assert.rejects(assembleRelease({ inputs: fourTargetFixture }), /missing release target: linux-arm64/);
  await assert.rejects(assembleRelease({ inputs: changedPixelFixture }), /fixture RGBA hash mismatch/);
});

test('production manifest contains full source and workflow commits', async () => {
  const result = await assembleRelease({ inputs: fiveTargetFixture });
  assert.match(result.manifest.upstream.commit, /^[a-f0-9]{40}$/);
  assert.match(result.manifest.build.workflowCommit, /^[a-f0-9]{40}$/);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/release-tools.test.mjs`

Expected: FAIL with missing release scripts.

- [ ] **Step 3: Implement deterministic packaging and assembly**

`package-pixel-snapper.mjs` validates the native fixture result and packages exactly five files. `assemble-release.mjs` requires all five target keys, exact identical upstream/lock/workflow/toolchain identities, exact fixture RGBA hash, and unique asset names before writing release metadata.

```js
const REQUIRED_TARGETS = ['windows-x64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64'];
for (const target of REQUIRED_TARGETS) if (!records.has(target)) throw new Error(`missing release target: ${target}`);
for (const record of records.values()) {
  if (record.fixture.rgbaSha256 !== expectedFixtureHash) throw new Error(`fixture RGBA hash mismatch: ${record.target}`);
  assertFullSha(record.upstreamCommit); assertFullSha(record.workflowCommit);
}
```

- [ ] **Step 4: Add the unprivileged build matrix**

```yaml
permissions:
  contents: read
jobs:
  build:
    strategy:
      fail-fast: true
      matrix:
        include:
          - { key: windows-x64, os: windows-2025, target: x86_64-pc-windows-msvc }
          - { key: macos-x64, os: macos-15-intel, target: x86_64-apple-darwin }
          - { key: macos-arm64, os: macos-15, target: aarch64-apple-darwin }
          - { key: linux-x64, os: ubuntu-24.04, target: x86_64-unknown-linux-musl }
          - { key: linux-arm64, os: ubuntu-24.04-arm, target: aarch64-unknown-linux-musl }
    runs-on: ${{ matrix.os }}
```

Use only these reviewed action pins in the workflow: `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`, `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`, `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`, and `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`. Install Rust and targets with `rustup`, and publish with the preinstalled GitHub CLI so no additional action is needed. Build steps verify the upstream tag peels to the full input SHA, install Rust 1.88.0 and the matrix target, run `cargo build --locked --release --target "${{ matrix.target }}"`, execute `--version`, `--help`, and the deterministic fixture natively, install exact `cargo-sbom 0.10.0` and `cargo-about 0.8.4`, and upload the packaged build artifact.

- [ ] **Step 5: Add the separate publish job**

The publish job has `permissions: contents: write`, depends on every build, downloads but never executes binaries, runs `assemble-release.mjs`, rejects an existing release/tag, creates the immutable release, uploads assets, then runs `verify-release.mjs` against the public URLs and expected hashes.

- [ ] **Step 6: Verify workflow structure and commit**

Run: `node --test tests/release-tools.test.mjs && npm test && ruby -e "require 'yaml'; YAML.load_file('../../.github/workflows/pixel-snapper-release.yml'); puts 'workflow yaml ok'"`

Expected: tests PASS and output contains `workflow yaml ok`.

```bash
git add .github/workflows/pixel-snapper-release.yml skills/pixel-sprite-animation-pipeline/scripts/release skills/pixel-sprite-animation-pipeline/references/pixel-snapper-about.hbs skills/pixel-sprite-animation-pipeline/references/pixel-snapper-upstream.LICENSE skills/pixel-sprite-animation-pipeline/tests/release-tools.test.mjs
git commit -m "feat: build verified Pixel Snapper release binaries"
```

- [ ] **Step 7: Review and publish the first immutable binary release**

The immutable-tag checkpoint is satisfied: upstream `v1.0.0` peels to the approved source commit `5743009265051098831ad7298092072325d1149b`. The formerly reviewed `ae20461f60fb39e75d15f184bab1ebec1219511c` differs only in README content and is historical context, not the release pin; Rust source, `Cargo.lock`, `Cargo.toml`, and `LICENSE` remain identical. Publication remains a later manual action: when authorized, dispatch `pixel-snapper-release.yml` with release tag `pixel-snapper-v1.0.0-commit.5743009`. Do not publish until all five native jobs pass. Download every release metadata artifact into `/tmp/pixel-snapper-release-verify`, run `verify-release.mjs --metadata-dir /tmp/pixel-snapper-release-verify`, and retain that directory for Task 11.

Expected: one immutable GameDevStuff release with five platform archives, checksums, metadata, license, notices, SBOM, and provenance.

---

### Task 11: Production Manifest, Documentation, CI, and Pop T Acceptance

**Files:**
- Create: `skills/pixel-sprite-animation-pipeline/references/pixel-snapper-tool-manifest.json`
- Modify: `skills/pixel-sprite-animation-pipeline/package.json`
- Modify: `skills/pixel-sprite-animation-pipeline/SKILL.md`
- Modify: `skills/pixel-sprite-animation-pipeline/references/pixel-snapper.md`
- Modify: `skills/pixel-sprite-animation-pipeline/references/configuration.md`
- Modify: `.github/workflows/pixel-sprite-skill.yml`
- Modify: `.gitignore`
- Create: `skills/pixel-sprite-animation-pipeline/tests/package.test.mjs`
- Create privately, do not commit: `examples/private/pop-t/animation-contract.json`
- Create privately, do not commit: `examples/private/pop-t/frame-approval-request.json`

**Interfaces:**
- The packaged skill discovers the production manifest relative to `scripts/cli.mjs`.
- CI installs a fixture release through injected transport; post-release verification installs the real current target asset.
- Private acceptance produces a non-public signed report and public pass/fail measurements only.

- [ ] **Step 1: Install the generated production manifest**

Run: `node scripts/release/assemble-release.mjs --metadata-dir /tmp/pixel-snapper-release-verify --release-base https://github.com/otto-agent007/GameDevStuff/releases/download/pixel-snapper-v1.0.0-commit.5743009 --manifest references/pixel-snapper-tool-manifest.json`

Expected: manifest validates with five assets, full upstream/workflow SHAs, real archive/executable sizes and hashes, fixture hash, and license/notices/SBOM hashes. Hash values are derived from the verified files in `/tmp/pixel-snapper-release-verify`; none are typed manually.

- [ ] **Step 2: Write package and documentation tests first**

```js
test('packed skill includes manifest and license but no binaries or private approvals', async () => {
  const files = await packedFileList();
  assert(files.includes('package/references/pixel-snapper-tool-manifest.json'));
  assert(files.includes('package/references/pixel-snapper-upstream.LICENSE'));
  assert.equal(files.some((file) => /\.exe$|examples\/private|frame-approval-\d+\.json$/.test(file)), false);
});
```

- [ ] **Step 3: Update skill instructions and references**

Document resolution order, `setup-snapper`, verified/manual receipt distinction, contract creation, post-snap landmark approval, `awaiting-frame-approval`, and the rule that Pop T acceptance requires verified-tool provenance. Configuration docs explain explicit executable provenance and why cached tools are versioned local state.

- [ ] **Step 4: Extend CI**

Keep Ubuntu/Windows × Node 20/24 tests. Add package validation, fixture installer tests, workflow-policy assertions, and a current-target real-release install smoke job that runs only after the production manifest changes. Never upload downloaded binaries as repository artifacts from the ordinary skill workflow.

- [ ] **Step 5: Run full public verification**

Run:

```bash
cd skills/pixel-sprite-animation-pipeline
npm ci
npm test
python /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
npm pack --dry-run
node scripts/cli.mjs setup-snapper --project-dir "$(mktemp -d)"
git diff --check
```

Expected: full suite has zero failures; official skill validation passes; package contains no binaries/private assets; setup downloads, verifies, and probes the current platform binary; diff check is clean.

- [ ] **Step 6: Run private Pop T acceptance**

Use the private approved animation contract with exact clips/order/durations/loop modes, the frozen anchor palette, `pixelSize: 8`, and landmark semantics. Generate or supply every contracted 1024×1024 pose, run the verified snapper, author and sign the frame approvals, normalize to `(64,112)`, export 256×256 clips, and validate.

Expected private report:

```json
{
  "toolProvenanceVerified": true,
  "manualHandoff": false,
  "canonical": [128, 128],
  "generation": [1024, 1024],
  "runtime": [256, 256],
  "pixelSize": 8,
  "pivot": [64, 112],
  "baseline": 111,
  "landmarkDriftPixels": 0,
  "objectiveValidationPassed": true,
  "humanIdentityMotionLoopApproved": true,
  "sourceHashesUnchanged": true
}
```

Store private frames, receipts, manifests, previews, and the full report only in ignored private state. The PR summary may include the booleans and non-sensitive dimensions above.

- [ ] **Step 7: Commit final integration**

```bash
git add .github/workflows/pixel-sprite-skill.yml .gitignore skills/pixel-sprite-animation-pipeline/package.json skills/pixel-sprite-animation-pipeline/npm-shrinkwrap.json skills/pixel-sprite-animation-pipeline/SKILL.md skills/pixel-sprite-animation-pipeline/references/pixel-snapper-tool-manifest.json skills/pixel-sprite-animation-pipeline/references/pixel-snapper.md skills/pixel-sprite-animation-pipeline/references/configuration.md skills/pixel-sprite-animation-pipeline/tests/package.test.mjs
git commit -m "feat: complete verified Pop T sprite workflow"
```

- [ ] **Step 8: Request final review and update the PR**

Use `superpowers:requesting-code-review`, address any findings, rerun the full verification block, push the branch, update the PR summary with release URLs and CI matrix, and keep private Pop T artifacts excluded.

Expected: GitHub Actions passes on every required job and the PR remains mergeable.
