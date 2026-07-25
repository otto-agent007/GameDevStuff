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

test('formatted documentation and donor changes run quality without selecting package gates', async () => {
  const workflow = await readYaml('.github/workflows/skills.yml');
  const qualityOnlyPaths = ['README.md', 'AGENTS.md', 'docs/**', 'references/donors/**'];

  for (const eventName of ['push', 'pull_request']) {
    for (const qualityOnlyPath of qualityOnlyPaths) {
      assert.ok(
        workflow.on[eventName].paths.includes(qualityOnlyPath),
        `${eventName} must trigger the repository-wide formatting check for ${qualityOnlyPath}`
      );
    }
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
    'quality must be unconditional so event-path-only documentation changes run Prettier'
  );
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
