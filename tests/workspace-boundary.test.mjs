import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

test('root manifest declares the two private skill workspaces and shared developer tools', async () => {
  const manifest = await readJsonOrNull(path.join(repositoryRoot, 'package.json'));
  assert.ok(manifest, 'the repository root needs a package.json workspace manifest');
  if (!manifest) return;

  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.workspaces, ['skills/game-character-pipeline', 'skills/pixel-sprite-animation-pipeline']);
  assert.deepEqual(manifest.scripts, {
    test: 'npm run test:workspace && npm run test:workspaces',
    'test:workspace': 'node --test tests/*.test.mjs',
    'test:workspaces': 'npm run test --workspaces --if-present',
    lint: 'eslint .',
    'format:check': 'prettier --check .',
    'format:write': 'prettier --write .',
    browser: 'npm run test:browser --workspace=game-character-pipeline',
    acceptance: 'npm run acceptance --workspace=game-character-pipeline',
    'package-boundary':
      'node --test skills/game-character-pipeline/tests/package-boundary.test.mjs skills/pixel-sprite-animation-pipeline/tests/package-boundary.test.mjs'
  });
  assert.deepEqual(manifest.devDependencies, {
    '@eslint/js': '9.39.5',
    '@playwright/test': '1.61.1',
    eslint: '9.39.5',
    globals: '16.5.0',
    prettier: '3.9.6'
  });
  assert.deepEqual(
    manifest.optionalDependencies,
    { '@img/sharp-win32-x64': '0.35.3' },
    'the cross-platform lock must retain Sharp’s Windows runtime package for CI'
  );
});

test('workspaces retain only their exact runtime dependencies and use the root lockfile', async () => {
  const character = await readJsonOrNull(path.join(repositoryRoot, 'skills/game-character-pipeline/package.json'));
  const pixel = await readJsonOrNull(path.join(repositoryRoot, 'skills/pixel-sprite-animation-pipeline/package.json'));

  assert.deepEqual(character.dependencies, {
    commander: '15.0.0',
    sharp: '0.35.3'
  });
  assert.deepEqual(pixel.dependencies, {
    commander: '15.0.0',
    fflate: '0.8.3',
    sharp: '0.35.3',
    'tar-stream': '3.2.0',
    yaml: '2.9.0'
  });
  assert.equal(Object.hasOwn(character, 'devDependencies'), false);
  assert.equal(Object.hasOwn(pixel, 'devDependencies'), false);
  assert.equal(character.files.includes('npm-shrinkwrap.json'), false);
  assert.equal(pixel.files.includes('npm-shrinkwrap.json'), false);
  await assert.rejects(fs.access(path.join(repositoryRoot, 'skills/game-character-pipeline/npm-shrinkwrap.json')));
  await assert.rejects(
    fs.access(path.join(repositoryRoot, 'skills/pixel-sprite-animation-pipeline/npm-shrinkwrap.json'))
  );
});

test('package-boundary tests use the Node 22-compatible module URL path API', async () => {
  for (const packageBoundaryTest of [
    'skills/game-character-pipeline/tests/package-boundary.test.mjs',
    'skills/pixel-sprite-animation-pipeline/tests/package-boundary.test.mjs'
  ]) {
    const source = await fs.readFile(path.join(repositoryRoot, packageBoundaryTest), 'utf8');
    assert.match(source, /from 'node:url'/);
    assert.match(source, /path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/);
    assert.doesNotMatch(source, /import\.meta\.dirname/);
  }
});

test('Prettier does not exclude tracked fixtures or donor ledgers from the baseline', async () => {
  const prettierIgnore = await fs.readFile(path.join(repositoryRoot, '.prettierignore'), 'utf8');
  for (const excludedTrackedSource of [
    'integration/fixtures/',
    'references/donors/',
    'skills/game-character-pipeline/tests/fixtures/',
    'skills/pixel-sprite-animation-pipeline/tests/fixtures/'
  ]) {
    assert.equal(prettierIgnore.includes(excludedTrackedSource), false, `${excludedTrackedSource} must stay formatted`);
  }
});
