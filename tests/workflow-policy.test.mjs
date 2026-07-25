import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repositoryRoot, 'skills/pixel-sprite-animation-pipeline/package.json'));
const YAML = require('yaml');
const workflowsDirectory = path.join(repositoryRoot, '.github', 'workflows');

async function readYaml(relativePath) {
  return YAML.parse(await fs.readFile(path.join(repositoryRoot, relativePath), 'utf8'));
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(repositoryRoot, relativePath), 'utf8'));
}

function stepNamed(job, name) {
  return job.steps.find((step) => step.name === name);
}

test('public Node support starts at 22.12.0 and CI exercises Node 22 and Node 24 only', async () => {
  const expectedNodeRange = '>=22.12.0';
  const manifests = [
    'package.json',
    'skills/game-character-pipeline/package.json',
    'skills/pixel-sprite-animation-pipeline/package.json'
  ];

  for (const manifestPath of manifests) {
    const manifest = await readJson(manifestPath);
    assert.equal(manifest.engines.node, expectedNodeRange, `${manifestPath} must declare the public Node floor`);
  }

  assert.equal((await fs.readFile(path.join(repositoryRoot, '.nvmrc'), 'utf8')).trim(), '22.12.0');

  for (const guidancePath of [
    'README.md',
    'skills/game-character-pipeline/SKILL.md',
    'skills/pixel-sprite-animation-pipeline/SKILL.md'
  ]) {
    const guidance = await fs.readFile(path.join(repositoryRoot, guidancePath), 'utf8');
    assert.match(guidance, /Node\.js 22\.12\.0 or newer/, `${guidancePath} must state the installed Node floor`);
  }

  const skillsWorkflow = await readYaml('.github/workflows/skills.yml');
  const matrixStep = skillsWorkflow.jobs.changes.steps.find((step) => step.id === 'matrix');
  assert.match(matrixStep.run, /\[22, 24\]/, 'the unit matrix must cover Node 22 and Node 24');

  for (const workflowPath of ['.github/workflows/skills.yml', '.github/workflows/pixel-snapper-release.yml']) {
    const source = await fs.readFile(path.join(repositoryRoot, workflowPath), 'utf8');
    assert.doesNotMatch(
      source,
      /node-version:\s*20(?:\.|\b)|\[20, 24\]/,
      `${workflowPath} must not claim Node 20 support`
    );
  }
});

test('ordinary skill CI is consolidated and every workflow action uses an immutable full SHA', async () => {
  await fs.access(path.join(workflowsDirectory, 'skills.yml'));
  await fs.access(path.join(workflowsDirectory, 'pixel-snapper-release.yml'));
  await assert.rejects(fs.access(path.join(workflowsDirectory, 'game-character-pipeline.yml')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(workflowsDirectory, 'pixel-sprite-skill.yml')), { code: 'ENOENT' });

  const workflowFiles = (await fs.readdir(workflowsDirectory)).filter((file) => /\.ya?ml$/.test(file));
  const actionPins = [];
  for (const workflowFile of workflowFiles) {
    const source = await fs.readFile(path.join(workflowsDirectory, workflowFile), 'utf8');
    actionPins.push(...[...source.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]));
  }

  assert.ok(actionPins.length > 0);
  assert.ok(
    actionPins.every((pin) => /^[^@\s]+@[a-f0-9]{40}$/.test(pin)),
    `every action must use a full SHA, received: ${actionPins.join(', ')}`
  );
  assert.ok(
    actionPins.some((pin) => /^dorny\/paths-filter@[a-f0-9]{40}$/.test(pin)),
    'the path filter must remain present and full-SHA pinned'
  );
});

test('CI policy tests do not pin a Dependabot-managed action revision', async () => {
  const source = await fs.readFile(path.join(repositoryRoot, 'tests/workflow-policy.test.mjs'), 'utf8');
  assert.doesNotMatch(source, /dorny\/paths-filter@d1c1ffe0248fe513906c8e24db8ea791d46f8590/);
});

test('Dependabot checks the root npm workspace and GitHub Actions every week', async () => {
  const dependabot = await readYaml('.github/dependabot.yml');

  assert.equal(dependabot.version, 2);
  assert.deepEqual(
    dependabot.updates.map((entry) => ({
      ecosystem: entry['package-ecosystem'],
      directory: entry.directory,
      interval: entry.schedule.interval
    })),
    [
      { ecosystem: 'npm', directory: '/', interval: 'weekly' },
      { ecosystem: 'github-actions', directory: '/', interval: 'weekly' }
    ]
  );
});

test('changed paths select the package unit matrix and compatibility gates', async () => {
  const workflow = await readYaml('.github/workflows/skills.yml');
  const changes = workflow.jobs.changes;
  const filterStep = changes.steps.find((step) => step.id === 'filter');
  const filters = YAML.parse(filterStep.with.filters);

  assert.match(filterStep.uses, /^dorny\/paths-filter@[a-f0-9]{40}$/);
  assert.deepEqual(filters, {
    pixel: ['skills/pixel-sprite-animation-pipeline/**'],
    character: ['skills/game-character-pipeline/**', 'integration/fixtures/**'],
    root: [
      '.github/dependabot.yml',
      '.github/workflows/**',
      '.editorconfig',
      '.nvmrc',
      '.prettierignore',
      '.prettierrc.json',
      'eslint.config.mjs',
      'package.json',
      'package-lock.json',
      'tests/**',
      'LICENSES/**'
    ]
  });
  assert.deepEqual(changes.outputs, {
    pixel: '${{ steps.filter.outputs.pixel }}',
    character: '${{ steps.filter.outputs.character }}',
    root: '${{ steps.filter.outputs.root }}',
    unit_matrix: '${{ steps.matrix.outputs.unit_matrix }}'
  });

  const matrixStep = changes.steps.find((step) => step.id === 'matrix');
  assert.deepEqual(matrixStep.env, {
    PIXEL_CHANGED: '${{ steps.filter.outputs.pixel }}',
    CHARACTER_CHANGED: '${{ steps.filter.outputs.character }}',
    ROOT_CHANGED: '${{ steps.filter.outputs.root }}'
  });
  for (const required of [
    "['pixel-sprite-animation-pipeline', 'game-character-pipeline']",
    "selected.add('pixel-sprite-animation-pipeline')",
    "selected.add('game-character-pipeline')",
    "['ubuntu-latest', 'windows-latest']",
    '[22, 24]',
    'unit_matrix='
  ]) {
    assert.match(matrixStep.run, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.equal(workflow.jobs.unit.strategy.matrix, '${{ fromJSON(needs.changes.outputs.unit_matrix) }}');
  assert.equal(
    workflow.jobs.browser.if,
    "needs.changes.outputs.character == 'true' || needs.changes.outputs.root == 'true'"
  );
  assert.equal(
    workflow.jobs.acceptance.if,
    "needs.changes.outputs.pixel == 'true' || needs.changes.outputs.character == 'true' || needs.changes.outputs.root == 'true'"
  );
});

test('every push and pull request runs quality without selecting unrelated package gates', async () => {
  const workflow = await readYaml('.github/workflows/skills.yml');
  const qualityOnlyPaths = [
    'README.md',
    'AGENTS.md',
    'CHANGELOG.md',
    'LICENSE',
    '.gitignore',
    '.gitattributes',
    'docs/**',
    'references/donors/**'
  ];

  for (const eventName of ['push', 'pull_request']) {
    assert.equal(
      workflow.on[eventName]?.paths,
      undefined,
      `${eventName} must not be limited by top-level path filters`
    );
  }

  const filterStep = workflow.jobs.changes.steps.find((step) => step.id === 'filter');
  const filters = YAML.parse(filterStep.with.filters);
  for (const qualityOnlyPath of qualityOnlyPaths) {
    for (const filterName of ['pixel', 'character', 'root']) {
      assert.equal(
        filters[filterName].includes(qualityOnlyPath),
        false,
        `${qualityOnlyPath} must not select package unit, browser, or acceptance gates`
      );
    }
  }
  assert.ok(workflow.jobs.quality.steps.some((step) => step.run === 'npm run format:check'));
  assert.equal(
    Object.hasOwn(workflow.jobs.quality, 'if'),
    false,
    'quality must be unconditional so every event runs repository policy checks'
  );
  assert.equal(Object.hasOwn(workflow.jobs.quality, 'needs'), false, 'quality must start without waiting for changes');
});

test('unified CI installs once from the root lock and uses root workspace commands', async () => {
  const workflow = await readYaml('.github/workflows/skills.yml');

  for (const jobName of ['quality', 'unit', 'browser', 'acceptance']) {
    const job = workflow.jobs[jobName];
    const setup = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    const install = stepNamed(job, 'Install locked workspace dependencies');
    assert.equal(setup.with.cache, 'npm', `${jobName} must use the npm cache`);
    assert.equal(setup.with['cache-dependency-path'], 'package-lock.json');
    assert.equal(install.run, 'npm ci --ignore-scripts');
    assert.equal(Object.hasOwn(install, 'working-directory'), false);
  }

  const qualityRuns = workflow.jobs.quality.steps.map((step) => step.run).filter(Boolean);
  assert.ok(qualityRuns.includes('npm run test:workspace'));
  assert.ok(qualityRuns.includes('npm run lint'));
  assert.ok(qualityRuns.includes('npm run format:check'));
  assert.ok(qualityRuns.includes('npm run coverage'), 'Linux quality must enforce workspace coverage once');
  assert.equal(
    qualityRuns.filter((command) => command === 'npm run coverage').length,
    1,
    'coverage must run only in the Linux quality job, not the cross-platform unit matrix'
  );

  const unitRuns = workflow.jobs.unit.steps.map((step) => step.run).filter(Boolean);
  assert.ok(unitRuns.includes('npm test --workspace=${{ matrix.workspace }}'));
  assert.ok(unitRuns.includes('npm pack --dry-run --workspace=${{ matrix.workspace }}'));
  const validator = stepNamed(workflow.jobs.unit, 'Validate skill when the official validator is installed');
  assert.equal(validator.shell, 'python');
  assert.deepEqual(validator.env, { WORKSPACE: '${{ matrix.workspace }}' });
  assert.match(validator.run, /quick_validate\.py/);
  assert.match(validator.run, /Official quick_validate\.py is not installed on this runner; skipping\./);
  assert.ok(workflow.jobs.browser.steps.some((step) => step.run === 'npm run browser'));
  assert.ok(workflow.jobs.acceptance.steps.some((step) => step.run === 'npm run acceptance'));
});

test('Pixel Snapper release attests only validated target archives before a protected publish', async () => {
  const workflow = await readYaml('.github/workflows/pixel-snapper-release.yml');
  const source = await fs.readFile(path.join(repositoryRoot, '.github/workflows/pixel-snapper-release.yml'), 'utf8');
  const build = workflow.jobs.build;
  const publish = workflow.jobs.publish;

  assert.deepEqual(build.permissions, {
    contents: 'read',
    'id-token': 'write',
    attestations: 'write'
  });
  const packageStepIndex = build.steps.findIndex(
    (step) => step.name === 'Execute native probes and package exact files'
  );
  const attestationStepIndex = build.steps.findIndex((step) => step.name === 'Attest validated target archive');
  assert.ok(attestationStepIndex > packageStepIndex, 'the archive must exist before it is attested');
  const attestation = build.steps[attestationStepIndex];
  assert.equal(attestation.uses, 'actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6');
  assert.equal(attestation.with['subject-path'], 'packaged/${{ matrix.key }}/pixel-snapper-${{ matrix.key }}.*');
  assert.doesNotMatch(attestation.with['subject-path'], /target\//, 'only the final archive may be attested');

  assert.equal(publish.if, "github.ref == 'refs/heads/main'");
  assert.equal(publish.environment, 'pixel-snapper-release');
  assert.deepEqual(publish.permissions, { contents: 'write', attestations: 'read' });
  const inputValidation = stepNamed(publish, 'Validate immutable inputs');
  assert.match(inputValidation.run, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  const attestationVerificationIndex = publish.steps.findIndex(
    (step) => step.name === 'Verify assembled archive attestations'
  );
  const releaseIndex = publish.steps.findIndex((step) => step.name === 'Publish immutable release');
  assert.ok(attestationVerificationIndex > -1 && attestationVerificationIndex < releaseIndex);
  const verification = publish.steps[attestationVerificationIndex];
  assert.match(verification.run, /gh attestation verify/);
  for (const target of [
    'windows-x64.zip',
    'macos-x64.tar.gz',
    'macos-arm64.tar.gz',
    'linux-x64.tar.gz',
    'linux-arm64.tar.gz'
  ]) {
    assert.match(verification.run, new RegExp(`pixel-snapper-${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  assert.match(source, /gh attestation verify[\s\S]*gh release create/);
});

test('immutable release jobs install and cache npm dependencies only from the root lockfile', async () => {
  const workflow = await readYaml('.github/workflows/pixel-snapper-release.yml');
  const buildSetup = workflow.jobs.build.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  const publishSetup = workflow.jobs.publish.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  const buildInstall = stepNamed(workflow.jobs.build, 'Install release-tool dependencies');
  const publishInstall = stepNamed(workflow.jobs.publish, 'Install release-tool dependencies');

  assert.equal(buildSetup.with['cache-dependency-path'], 'release-tools/package-lock.json');
  assert.equal(publishSetup.with['cache-dependency-path'], 'package-lock.json');
  assert.equal(buildInstall.run, 'npm ci --ignore-scripts');
  assert.equal(buildInstall['working-directory'], 'release-tools');
  assert.equal(publishInstall.run, 'npm ci --ignore-scripts');
  assert.equal(Object.hasOwn(publishInstall, 'working-directory'), false);
});

test('skill bundles release together from an immutable, protected, install-by-copy workflow', async () => {
  const version = '0.2.0';
  const manifestPaths = [
    'package.json',
    'skills/game-character-pipeline/package.json',
    'skills/pixel-sprite-animation-pipeline/package.json'
  ];
  for (const manifestPath of manifestPaths) {
    assert.equal((await readJson(manifestPath)).version, version, `${manifestPath} must release in lockstep`);
  }

  const changelog = await fs.readFile(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^## \[?0\.2\.0\]?/m);
  assert.match(changelog, /^### Game Character Pipeline$/m);
  assert.match(changelog, /^### Pixel Sprite Animation Pipeline$/m);

  const workflowPath = '.github/workflows/skills-release.yml';
  const workflow = await readYaml(workflowPath);
  const source = await fs.readFile(path.join(repositoryRoot, workflowPath), 'utf8');
  assert.ok(workflow.on.workflow_dispatch.inputs.version.required);
  assert.match(source, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  for (const jobName of ['immutability-preflight', 'validate', 'publish']) {
    assert.equal(workflow.jobs[jobName].if, "github.ref == 'refs/heads/main'");
  }
  assert.match(source, /\[1-9\]\[0-9\]\*/);
  assert.match(source, /skills-v\$\{\{ inputs\.version \}\}/);
  assert.match(source, /IMMUTABLE_RELEASES_TOKEN/);
  assert.match(source, /immutable-releases/);
  assert.match(source, /npm ci --ignore-scripts/);
  for (const command of ['npm test', 'npm run lint', 'npm run format:check', 'npm run package-boundary']) {
    assert.match(source, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const publish = workflow.jobs.publish;
  assert.deepEqual(publish.permissions, { contents: 'write' });
  assert.equal(publish.environment, 'skills-release');
  const checkout = publish.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.match(source, /game-character-pipeline-\$\{VERSION\}\.tgz/);
  assert.match(source, /pixel-sprite-animation-pipeline-\$\{VERSION\}\.tgz/);
  assert.match(source, /SHA256SUMS/);
  assert.match(source, /git ls-remote.*RELEASE_TAG/s);
  assert.match(source, /gh release view.*RELEASE_TAG/s);
  assert.match(source, /gh release create.*RELEASE_TAG/s);
  assert.match(source, /--json isImmutable/);
  assert.match(source, /gh release download.*RELEASE_TAG/s);
  assert.match(source, /sha256sum -c SHA256SUMS/);

  const actionPins = [...source.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(actionPins.length > 0);
  assert.ok(actionPins.every((pin) => /^[^@\s]+@[a-f0-9]{40}$/.test(pin)));
});
