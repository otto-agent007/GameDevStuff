import fs from 'node:fs/promises';
import path from 'node:path';

function comparisonKey(value, pathApi) {
  const normalized = pathApi.normalize(value);
  return pathApi.sep === '\\' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export async function canonicalPath(file, { fsImpl = fs, pathApi = path } = {}) {
  return pathApi.normalize(await fsImpl.realpath(pathApi.resolve(file)));
}

export function isPathContained(root, candidate, pathApi = path) {
  const relative = pathApi.relative(comparisonKey(root, pathApi), comparisonKey(candidate, pathApi));
  return relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

export async function sameCanonicalPath(left, right, options = {}) {
  const pathApi = options.pathApi ?? path;
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonicalPath(left, options),
    canonicalPath(right, options)
  ]);
  return comparisonKey(canonicalLeft, pathApi) === comparisonKey(canonicalRight, pathApi);
}
