import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
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
