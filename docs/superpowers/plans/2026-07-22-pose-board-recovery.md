# Pose-Board Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover complete, owner-curated animation frames from chroma-key pose boards without trusting nominal grid boundaries.

**Architecture:** Add a two-phase `pose-board` source adapter to `game-character-pipeline`. Phase one immutably captures and analyzes the full board, publishes foreground components and recovered candidates, and exits class `4`; Phase two verifies a numbered owner approval, pads the selected candidates to one transparent canvas without resampling, and publishes the normal timing-aware source report. A recovery stage in Frame Studio owns grouping, ordering, naming, roles, timing, and approval.

**Tech Stack:** Node.js 20+, ES modules, Sharp, Node test runner, Playwright, existing immutable artifact helpers, existing Frame Studio HTTP shell.

## Global Constraints

- Preserve original pose-board bytes and every published derivative hash.
- Use four-neighbor foreground components and never divide one connected component.
- Treat centroid row-major order as a proposal only.
- Never resample recovered candidate pixels.
- Do not allow eligible foreground to be silently lost or assigned to multiple selected candidates.
- Keep owner selection, order, roles, names, and durations hash-bound.
- Use only synthetic public fixtures in Git; never encode private assets, hashes, paths, or descriptions.
- Do not modify a downstream game repository.
- Preserve the existing deterministic Pixel Snapper boundary and post-snap alignment/approval chain.
- Keep all repository changes uncommitted until the active private audit authorizes branch completion.
- Execute inline and sequentially; stop on the first failed verification and debug it before continuing.

---

### Task 1: Validate recovery contracts and detect full-board foreground

**Files:**
- Create: `skills/game-character-pipeline/scripts/lib/pose-board-contract.mjs`
- Create: `skills/game-character-pipeline/scripts/lib/pose-board-recovery.mjs`
- Create: `skills/game-character-pipeline/tests/pose-board-recovery.test.mjs`

**Interfaces:**
- Consumes: PNG bytes and a closed recovery contract.
- Produces: `validatePoseBoardContract(value)`, `analyzePoseBoard({ bytes, contract })`, and `renderRecoveredCandidate({ analysis, componentIds })`.

- [x] **Step 1: Write the failing closed-contract tests**

Add tests that require this exact contract shape and reject unknown fields, invalid connectivity, unsafe counts, excessive padding, non-RGBA colors, duplicate group membership, and unknown component IDs:

```js
const contract = {
  schemaVersion: 1,
  background: { mode: 'color', rgba: [0, 255, 0, 255], tolerance: 8 },
  connectivity: 4,
  minimumComponentPixels: 4,
  maxDecodedRgbaBytes: 1024 * 1024,
  padding: 2,
  expectedCandidates: { min: 2, max: 8 },
  allowUnassigned: false,
  groups: []
};
const selected = validatePoseBoardContract(contract);
assert.equal(Object.isFrozen(selected), true);
assert.throws(() => validatePoseBoardContract({ ...contract, connectivity: 8 }), /connectivity/);
assert.throws(() => validatePoseBoardContract({ ...contract, surprise: true }), /unknown pose-board recovery contract field/);
```

- [x] **Step 2: Run the contract test and verify RED**

Run:

```bash
cd skills/game-character-pipeline
umask 0077
node --test tests/pose-board-recovery.test.mjs
```

Expected: FAIL because `pose-board-contract.mjs` does not exist.

- [x] **Step 3: Implement the closed recovery contract**

Use existing `exactObject`, `integer`, `portableId`, `uniqueList`, `deepFreeze`, and `sha256Value`. Export:

```js
export function validatePoseBoardContract(value) {
  const document = structuredClone(value);
  exactObject(document, [
    'schemaVersion', 'background', 'connectivity', 'minimumComponentPixels',
    'maxDecodedRgbaBytes', 'padding', 'expectedCandidates',
    'allowUnassigned', 'groups'
  ], 'pose-board recovery contract');
  // Validate every nested field and return a deeply frozen clone.
  return deepFreeze(document);
}

export function poseBoardContractHash(value) {
  return sha256Value(validatePoseBoardContract(value));
}
```

- [x] **Step 4: Run the contract test and verify GREEN**

Run the Task 1 test command. Expected: contract tests pass while analysis tests remain absent.

- [x] **Step 5: Write the failing crossing-boundary recovery test**

Build a synthetic `12x8` board in memory with a solid chroma background, two connected actor shapes that cross nominal `6px` columns, one disconnected prop component, and two one-pixel noise components. Assert:

```js
const analysis = await analyzePoseBoard({ bytes, contract });
assert.equal(analysis.width, 12);
assert.equal(analysis.height, 8);
assert.deepEqual(analysis.components.map(({ id }) => id), [
  'component-0001', 'component-0002', 'component-0003'
]);
assert.equal(analysis.ignoredNoise.length, 2);
assert.deepEqual(analysis.proposedOrder, [
  'candidate-0001', 'candidate-0002', 'candidate-0003'
]);
assert.match(analysis.maskSha256, /^[a-f0-9]{64}$/);
```

Also prove border mode, tolerance, memory limits, candidate-count limits, deterministic IDs, and unchanged input bytes.

- [x] **Step 6: Run the recovery test and verify RED**

Run the Task 1 test command. Expected: FAIL because `analyzePoseBoard` is not exported.

- [x] **Step 7: Implement deterministic mask and component analysis**

In `pose-board-recovery.mjs`:

```js
export async function analyzePoseBoard({ bytes, contract }) {
  const selected = validatePoseBoardContract(contract);
  const { data, info } = await sharp(bytes, { limitInputPixels: 268435456 })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (data.length > selected.maxDecodedRgbaBytes) {
    throw new Error('pose-board decoded RGBA exceeds the configured byte limit');
  }
  // Resolve configured or dominant border background.
  // Build one-byte foreground mask.
  // Traverse four-neighbor components in scan order.
  // Filter noise, assign stable IDs, calculate bounds/centroid/pixel hashes.
  // Apply optional whole-component group proposals.
  // Return JSON-safe evidence plus the captured RGBA snapshot internally.
}
```

Hash component evidence from ordered `{x,y,rgba}` tuples. Propose candidate order by centroid row and then centroid x, with candidate ID as the final tie-breaker.

- [x] **Step 8: Implement exact candidate rendering**

Export:

```js
export async function renderRecoveredCandidate({ analysis, componentIds }) {
  // Validate unique known eligible IDs.
  // Compute union bounds plus contract padding.
  // Copy only selected source RGBA pixels to a transparent buffer.
  // Return { bytes, width, height, placement, componentIds, sha256 }.
}
```

The test must compare every nontransparent output RGBA pixel to its exact source RGBA byte tuple and prove no unselected pixel appears.

- [x] **Step 9: Run Task 1 tests and checkpoint**

Run:

```bash
umask 0077
node --test tests/pose-board-recovery.test.mjs
git diff --check -- scripts/lib/pose-board-contract.mjs scripts/lib/pose-board-recovery.mjs tests/pose-board-recovery.test.mjs
```

Expected: all Task 1 tests pass and `git diff --check` is silent. Do not commit.

---

### Task 2: Publish immutable recovery evidence and resume from owner approval

**Files:**
- Create: `skills/game-character-pipeline/scripts/lib/pose-board.mjs`
- Create: `skills/game-character-pipeline/scripts/lib/pose-selection.mjs`
- Create: `skills/game-character-pipeline/tests/pose-board.test.mjs`
- Modify: `skills/game-character-pipeline/scripts/lib/project-contract.mjs`
- Modify: `skills/game-character-pipeline/scripts/lib/source-adapter.mjs`
- Modify: `skills/game-character-pipeline/scripts/cli.mjs`
- Modify: `skills/game-character-pipeline/tests/project-contract.test.mjs`
- Modify: `skills/game-character-pipeline/tests/cli.test.mjs`

**Interfaces:**
- Consumes: `analyzePoseBoard`, `renderRecoveredCandidate`, immutable run/project state, recovery contract file, optional approved selection file.
- Produces: `recoverPoseBoard`, `writePoseSelection`, `approvePoseSelection`, `loadApprovedPoseSelection`, and a standard `pose-board` motion-source result.

- [x] **Step 1: Write failing source-kind and CLI-surface tests**

Require `pose-board` in project contracts and the intake options:

```js
assert.equal(help.stdout.includes('--recovery-contract <file>'), true);
assert.equal(help.stdout.includes('--selection-approval <file>'), true);
```

Update the valid synthetic project contract in test setup so one action permits `pose-board`.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
umask 0077
node --test tests/project-contract.test.mjs tests/cli.test.mjs
```

Expected: FAIL because `pose-board` and its CLI arguments are not registered.

- [x] **Step 3: Register the closed source kind and CLI options**

Add `pose-board` to `SOURCE_KINDS`, register its adapter, and add:

```js
.option('--recovery-contract <file>', 'closed pose-board recovery contract')
.option('--selection-approval <file>', 'approved numbered pose selection')
```

The pose-board branch requires `--source` and `--recovery-contract`; it passes the optional approval path to the adapter.

- [x] **Step 4: Write the failing immutable recovery test**

Create an owner-only project/run and synthetic board. Call:

```js
await assert.rejects(
  decodePoseBoard({ source, recoveryContract, run, project }),
  (error) => error.exitCode === 4 &&
    error.handoff.status === 'awaiting-pose-selection'
);
```

Assert that the run contains:

```text
source/pose-board/original.png
source/pose-board/recovery-contract.json
work/pose-board/foreground-mask.png
work/pose-board/candidate-overlay.png
work/pose-board/candidates/candidate-0001.png
reports/pose-board-recovery.json
```

Assert the report binds source, contract, mask, component, candidate, overlay, project, run, and action hashes. Retry must reuse identical bytes; changed source, contract, or candidate bytes must fail.

- [x] **Step 5: Run the immutable recovery test and verify RED**

Run:

```bash
umask 0077
node --test tests/pose-board.test.mjs
```

Expected: FAIL because `pose-board.mjs` does not exist.

- [x] **Step 6: Implement staged immutable recovery publication**

`recoverPoseBoard` must:

```js
export async function recoverPoseBoard({ source, recoveryContract, run, project }) {
  const capturedSource = await copyImmutable({
    source, root: run.root, relative: 'source/pose-board/original.png'
  });
  const capturedContract = await copyImmutable({
    source: recoveryContract, root: run.root,
    relative: 'source/pose-board/recovery-contract.json'
  });
  // Analyze captured bytes, write mask/overlay/candidates, then write report last.
  // Verify any existing report and every bound artifact before reuse.
}
```

Write candidates before the report; the immutable report is the publication boundary. A partial directory without a valid report cannot authorize resume.

- [x] **Step 7: Write failing selection validation and approval tests**

Use this exact selection shape:

```js
{
  schemaVersion: 1,
  kind: 'pose-board-selection',
  projectSha256,
  runId,
  actionId,
  recoverySha256,
  frames: [{
    id: 'stride-01',
    candidateId: 'candidate-0001',
    durationMs: 80,
    tracks: [{ role: 'actor', componentIds: ['component-0001'] }]
  }]
}
```

Require unique portable frame IDs, unique candidate IDs, positive durations, whole known component IDs, no duplicate component membership, and complete eligible-component disposition unless `allowUnassigned` is true. Approval must bind selection hash, recovery hash, approver, decision, notes, and ISO timestamp. Reject stale or changed ancestry.

- [x] **Step 8: Implement numbered selection revisions and approvals**

Export:

```js
export async function writePoseSelection({ run, project, recovery, value }) {
  return writeRevision({ root: run.root, area: 'edits', stem: 'pose-selection', value: validated });
}

export async function approvePoseSelection({ run, project, recovery, selection, approver, decision, notes, clock }) {
  return writeRevision({ root: run.root, area: 'approved', stem: 'pose-selection-approval', value: approval });
}
```

`loadApprovedPoseSelection` must verify the selected files, hashes, current recovery ancestry, configured owner identity, and `decision === 'approved'`.

- [x] **Step 9: Write the failing resume-to-source-result test**

Resume with a valid approval and assert:

```js
assert.equal(result.kind, 'pose-board');
assert.deepEqual(result.frames.map(({ id }) => id), ['stride-01', 'stride-02']);
assert.deepEqual(result.frames.map(({ durationMs }) => durationMs), [80, 120]);
assert.equal(new Set(result.frames.map(({ width }) => width)).size, 1);
assert.equal(new Set(result.frames.map(({ height }) => height)).size, 1);
```

Decode the output and prove candidates were centered on the maximum selected transparent canvas without resampling.

- [x] **Step 10: Implement pose-board resume**

If no approval is supplied, throw an error with:

```js
error.exitCode = 4;
error.handoff = {
  status: 'awaiting-pose-selection',
  runId: run.id,
  recovery: { path: report.path, sha256: report.sha256 },
  next: {
    kind: 'pose-board-selection',
    cwd: packageRoot,
    argv: [process.execPath, cliPath, 'studio', '--stage', 'recovery',
      '--project-dir', project.root, '--run', run.id]
  }
};
```

With an approved selection, render selected candidates again from the bound source/component evidence, center them on the maximum selected canvas, publish `work/decoded/<frame-id>.png`, and return a standard motion-source result with explicit timestamps and durations.

- [x] **Step 11: Teach the CLI to preserve exit class `4`**

Extend the final catch:

```js
if ([2, 4].includes(error.exitCode) && error.handoff) {
  print(error.handoff);
  process.exitCode = error.exitCode;
}
```

- [x] **Step 12: Run Task 2 tests and checkpoint**

Run:

```bash
umask 0077
node --test tests/project-contract.test.mjs tests/cli.test.mjs tests/pose-board-recovery.test.mjs tests/pose-board.test.mjs
git diff --check
```

Expected: focused tests pass and diff check is silent. Do not commit.

---

### Task 3: Add the Frame Studio recovery stage

**Files:**
- Create: `skills/game-character-pipeline/studio/recovery.html`
- Create: `skills/game-character-pipeline/studio/recovery-app.mjs`
- Create: `skills/game-character-pipeline/studio/recovery-server.mjs`
- Create: `skills/game-character-pipeline/tests/recovery-studio.test.mjs`
- Create: `skills/game-character-pipeline/tests/browser/recovery-studio.spec.mjs`
- Modify: `skills/game-character-pipeline/scripts/cli.mjs`
- Modify: `skills/game-character-pipeline/studio/server.mjs`
- Modify: `skills/game-character-pipeline/package.json`

**Interfaces:**
- Consumes: verified recovery report and candidate artifacts.
- Produces: immutable `pose-selection` revisions and `pose-selection-approval` revisions accepted by Task 2.

- [x] **Step 1: Write failing recovery-server security tests**

Require loopback-only binding, stage `recovery`, no-store/CSP headers, immutable candidate allowlisting by hash, origin/method/content-type/body-size checks, stale `If-Match` rejection, and serialized revision publication.

- [x] **Step 2: Run the server test and verify RED**

Run:

```bash
umask 0077
node --test tests/recovery-studio.test.mjs
```

Expected: FAIL because `recovery-server.mjs` does not exist.

- [x] **Step 3: Implement the recovery server**

Expose only:

```text
GET  /api/recovery-session
GET  /api/candidate/<sha256>
GET  /api/overlay/<sha256>
PUT  /api/pose-selections
POST /api/pose-selection-approval
```

Reuse the existing server's loopback, origin, body-limit, path containment, immutable file identity, and stale-revision patterns. Route writes through Task 2 functions; never accept arbitrary artifact paths from the browser.

- [x] **Step 4: Write failing browser interaction tests**

The Playwright test must verify:

```js
await expect(page.getByRole('img', { name: 'Pose-board component overlay' })).toBeVisible();
await page.getByRole('checkbox', { name: /candidate-0001/ }).check();
await page.getByRole('button', { name: 'Move candidate-0002 earlier' }).click();
await page.getByLabel('stride-01 duration').fill('80');
await page.getByRole('button', { name: 'Save recovery revision' }).click();
await page.getByRole('button', { name: 'Approve recovered sequence' }).click();
await expect(page.getByRole('status')).toContainText('Approved');
```

Also test keyboard access, visible focus, narrow viewport, reduced motion, omitted eligible foreground warnings, duplicate component membership, and stale revision rejection.

- [x] **Step 5: Implement the recovery surface**

The page must show the overlay and candidate thumbnails, allow whole-component grouping/splitting, selection, role assignment, portable frame names, reordering, and durations. Disable approval until every selected frame is valid and eligible foreground is fully dispositioned.

The browser sends the exact Task 2 selection schema. No client-generated hash or path is trusted.

- [x] **Step 6: Route `studio --stage recovery`**

Add:

```js
.option('--stage <stage>', 'selection or recovery', 'selection')
```

`selection` keeps existing behavior. `recovery` loads and verifies the run's published recovery report before starting `startRecoveryStudioServer`.

- [x] **Step 7: Run server and browser tests**

Run:

```bash
umask 0077
node --test tests/recovery-studio.test.mjs tests/studio-server.test.mjs
npm run test:browser -- --grep "recovery"
```

Expected: recovery and existing selection Studio tests pass.

- [x] **Step 8: Run Task 3 package checkpoint**

Run:

```bash
umask 0077
npm test
npm run test:browser
git diff --check
```

Expected: all game-character unit and browser tests pass. Do not commit.

---

### Task 4: Prove downstream per-frame production and reproducibility

**Files:**
- Create: `skills/game-character-pipeline/tests/pose-board-e2e.test.mjs`
- Modify: `skills/game-character-pipeline/examples/clockwork-courier/run-fixture.mjs`
- Modify: `skills/game-character-pipeline/tests/skill-scenarios.json`
- Modify: `skills/game-character-pipeline/tests/skill-scenarios.test.mjs`

**Interfaces:**
- Consumes: approved pose-board source result from Tasks 1-3 and existing Pixel Snapper delegation.
- Produces: public synthetic end-to-end evidence that each selected recovered frame is snapped separately and remains reproducible.

- [x] **Step 1: Write the failing end-to-end test**

Build a synthetic board at test runtime whose actors cross nominal grid columns. Execute:

```text
init
pose-board intake -> exit 4
selection revision
owner selection approval
pose-board intake resume
Frame Studio selection/render/approval
produce -> post-snap approval handoff
post-snap approval
produce resume
validate
equivalent repeat
audit
```

Assert the Pixel Snapper receipt has one ordered input/output per selected candidate, never the whole board, and both runs have identical deterministic artifact hashes.

- [x] **Step 2: Run the end-to-end test**

Run:

```bash
umask 0077
node --test tests/pose-board-e2e.test.mjs
```

Expected: PASS because Tasks 1-3 publish the standard motion-source result consumed by the existing downstream contract. If it fails, stop and amend this plan from the exact failing boundary before changing Pixel Snapper or export code.

- [x] **Step 3: Verify the downstream boundary remained generic**

The end-to-end assertions must prove:

```js
assert.equal(delegated.receipt.document.payload.inputs.length, selectedFrameCount);
assert.equal(delegated.receipt.document.payload.outputs.length, selectedFrameCount);
assert.equal(
  delegated.receipt.document.payload.inputs.some(({ sha256 }) => sha256 === wholeBoardSha256),
  false
);
```

No Pixel Snapper, normalization, export, or audit production file changes belong to this task. A failure in those generic consumers is a design-boundary blocker, not authorization for an unplanned compatibility patch.

- [x] **Step 4: Add workflow-skill scenarios**

Add scenarios proving the skill:

- recovers chroma-key pose boards before curation;
- never uses naïve grid crops when foreground crosses cells;
- requires owner selection before Snapper;
- snaps selected frames separately;
- aligns and approves post-snap frames;
- never publishes private evidence.

- [x] **Step 5: Run Task 4 tests and checkpoint**

Run:

```bash
umask 0077
node --test tests/pose-board-e2e.test.mjs tests/skill-scenarios.test.mjs
npm run acceptance
git diff --check
```

Expected: end-to-end, skill scenarios, and public acceptance pass. Do not commit.

---

### Task 5: Document the workflow and run complete verification

**Files:**
- Modify: `skills/game-character-pipeline/SKILL.md`
- Modify: `skills/game-character-pipeline/references/motion-sources.md`
- Modify: `skills/game-character-pipeline/references/workflow.md`
- Modify: `skills/game-character-pipeline/references/frame-studio.md`
- Modify: `skills/game-character-pipeline/agents/openai.yaml`
- Modify: `skills/game-character-pipeline/package.json`

**Interfaces:**
- Consumes: verified command surface and artifact contracts from Tasks 1-4.
- Produces: discoverable operational instructions and complete regression evidence.

- [x] **Step 1: Update operational instructions**

Document the exact pose-board flow:

```bash
node scripts/cli.mjs intake \
  --project-dir /absolute/path/character-project \
  --action walk \
  --kind pose-board \
  --source /absolute/path/pose-board.png \
  --recovery-contract /absolute/path/recovery.json

node scripts/cli.mjs studio \
  --stage recovery \
  --project-dir /absolute/path/character-project \
  --run <run-id>

node scripts/cli.mjs intake \
  --project-dir /absolute/path/character-project \
  --action walk \
  --kind pose-board \
  --resume <run-id> \
  --source /absolute/path/pose-board.png \
  --recovery-contract /absolute/path/recovery.json \
  --selection-approval /absolute/path/pose-selection-approval-0001.json
```

State explicitly that grid geometry is never authoritative when foreground crosses boundaries.

- [x] **Step 2: Verify package contents and skill discovery**

Run:

```bash
npm pack --dry-run
npm run validate-skill
```

Expected: recovery Studio assets are packaged, tests/private data are excluded, and skill validation passes with `python3`-compatible discovery.

- [x] **Step 3: Run complete local gates**

Run:

```bash
umask 0077
npm test --prefix skills/pixel-sprite-animation-pipeline
npm test --prefix skills/game-character-pipeline
npm run test:browser --prefix skills/game-character-pipeline
npm run acceptance --prefix skills/game-character-pipeline
npm run validate-skill --prefix skills/game-character-pipeline
git diff --check
```

Expected: every suite passes with no warnings or diff errors.

- [x] **Step 4: Audit privacy and scope**

Run:

```bash
rg -n -i "private-audit|private character|cockpitescaperoom|/tmp/|/mnt/" \
  skills/game-character-pipeline docs/superpowers/specs/2026-07-22-pose-board-recovery-design.md \
  docs/superpowers/plans/2026-07-22-pose-board-recovery.md
git status --short
```

Expected: no private asset evidence or private filesystem paths in the new feature; only generic policy references are permitted. Existing unrelated uncommitted changes remain preserved and explicitly reported.

- [x] **Step 5: Stop without commit**

Record the passing test counts and changed-file scope in the private audit checkpoint. Do not commit, push, open a PR, publish a package, deploy, or integrate downstream.
