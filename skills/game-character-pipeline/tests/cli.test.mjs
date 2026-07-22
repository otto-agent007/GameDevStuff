import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageDir, '..', '..');

test('CLI advertises the complete initial command surface', async () => {
  const result = await execFile(process.execPath, ['scripts/cli.mjs', '--help'], {
    cwd: packageDir
  });

  for (const command of ['init', 'intake', 'studio', 'render', 'approve', 'produce', 'validate', 'audit']) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test('skill validation fails clearly when the official validator is unavailable', async () => {
  const codexRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-validator-'));
  try {
    await assert.rejects(
      execFile(process.execPath, ['scripts/validate-skill.mjs'], {
        cwd: packageDir,
        env: { ...process.env, CODEX_HOME: codexRoot }
      }),
      (error) => {
        assert.match(error.stderr, /official skill validator is not installed/);
        return true;
      }
    );
  } finally {
    await fs.rm(codexRoot, { recursive: true, force: true });
  }
});

test('donor and dependency ledgers pin every reviewed source boundary', async () => {
  const donorFile = path.join(repositoryRoot, 'references', 'donors', 'game-character-animation.json');
  const ledger = JSON.parse(await fs.readFile(donorFile, 'utf8'));
  assert.equal(ledger.schemaVersion, 1);
  assert.deepEqual(
    ledger.donors.map(({ commit }) => commit),
    [
      '49f948faa9258a0c61caceaf225e179651397431',
      '64fd0b57d3f2ae117ef0a95e4c2decc25b4c9dd2',
      '902ec9e2c42d799446631b9dfb3162b3c61fbc17',
      '8b07c8eecf0d56d72f00fb44d2d41d4d54e8c4c1'
    ]
  );
  assert.equal(ledger.donors.every(({ mode, files }) => mode === 'concept-only' && files.length === 0), true);

  const notices = await fs.readFile(path.join(repositoryRoot, 'LICENSES', 'THIRD_PARTY.md'), 'utf8');
  for (const dependency of ['commander 15.0.0', 'sharp 0.35.3', '@playwright/test 1.61.1']) {
    assert.match(notices, new RegExp(dependency.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(notices, /^\| ffmpeg-static /m);
  assert.doesNotMatch(notices, /^\| ffprobe-static /m);
});

test('package installation never downloads an unauthenticated media executable', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(manifest.dependencies, 'ffmpeg-static'), false);
  assert.equal(Object.hasOwn(manifest.dependencies, 'ffprobe-static'), false);
});
