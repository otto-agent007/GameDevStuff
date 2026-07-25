import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const packageDir = path.resolve(import.meta.dirname, '..');

async function resolveNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    if (path.basename(candidate).toLowerCase() !== 'npm-cli.js') continue;
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error('could not locate npm-cli.js for shell-free package inspection');
}

test('installable pixel package keeps runtime files without a nested shrinkwrap', async () => {
  const packed = spawnSync(process.execPath, [await resolveNpmCli(), 'pack', '--dry-run', '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
    shell: false
  });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map(({ path: file }) => file.replaceAll('\\', '/'));
  assert.ok(files.includes('SKILL.md'));
  assert.ok(files.includes('scripts/cli.mjs'));
  assert.ok(files.includes('references/pixel-snapper.md'));
  assert.equal(files.includes('npm-shrinkwrap.json'), false);
  assert.equal(
    files.some((file) => file.startsWith('tests/')),
    false
  );
});
