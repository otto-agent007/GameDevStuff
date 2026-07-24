import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertPathsOutsideForbiddenRoots,
  canonicalPath,
  canonicalRelativePath,
  isPathContained,
  sameCanonicalPath
} from '../scripts/lib/path-security.mjs';

const aliases = new Map([
  ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\run', 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\run'],
  ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\run\\frames\\idle.png', 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\run\\frames\\idle.png'],
  ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\outside.png', 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\outside.png']
]);

const fsImpl = {
  realpath: async (file) => aliases.get(file) ?? file
};

test('canonical path comparison accepts Windows short-name aliases for the same artifact', async () => {
  assert.equal(await sameCanonicalPath(
    'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\run\\frames\\idle.png',
    'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\run\\frames\\idle.png',
    { fsImpl, pathApi: path.win32 }
  ), true);
});

test('canonical containment accepts an aliased child but rejects an aliased sibling', async () => {
  const root = await canonicalPath('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\run', { fsImpl, pathApi: path.win32 });
  const child = await canonicalPath('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\run\\frames\\idle.png', { fsImpl, pathApi: path.win32 });
  const sibling = await canonicalPath('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\outside.png', { fsImpl, pathApi: path.win32 });

  assert.equal(isPathContained(root, child, path.win32), true);
  assert.equal(isPathContained(root, sibling, path.win32), false);
});

test('canonical relative paths serialize a Windows short-name child portably', async () => {
  assert.equal(await canonicalRelativePath(
    'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\run',
    'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\run\\frames\\idle.png',
    { fsImpl, pathApi: path.win32 }
  ), 'frames/idle.png');
});

test('forbidden integration roots reject direct, nested, and symlinked paths without blocking siblings', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-policy-'));
  const forbidden = path.join(workspace, 'forbidden');
  const allowed = path.join(workspace, 'allowed');
  const alias = path.join(workspace, 'alias');
  await fs.mkdir(forbidden);
  await fs.mkdir(allowed);
  await fs.symlink(forbidden, alias);

  await assert.rejects(
    assertPathsOutsideForbiddenRoots({
      candidates: [path.join(forbidden, 'nested', 'output.json')],
      forbiddenRoots: [forbidden]
    }),
    /forbidden integration path/
  );
  await assert.rejects(
    assertPathsOutsideForbiddenRoots({
      candidates: [path.join(alias, 'output.json')],
      forbiddenRoots: [forbidden]
    }),
    /forbidden integration path/
  );
  await assert.doesNotReject(
    assertPathsOutsideForbiddenRoots({
      candidates: [path.join(allowed, 'output.json')],
      forbiddenRoots: [forbidden]
    })
  );
});
