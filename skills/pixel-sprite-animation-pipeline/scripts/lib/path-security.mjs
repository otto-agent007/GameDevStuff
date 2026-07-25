import fs from 'node:fs/promises';
import path from 'node:path';

function comparisonKey(value, pathApi) {
  const normalized = pathApi.normalize(value);
  return pathApi.sep === '\\' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export async function canonicalPath(file, { fsImpl = fs, pathApi = path } = {}) {
  return pathApi.normalize(await fsImpl.realpath(pathApi.resolve(file)));
}

async function canonicalPathForCreation(file, { fsImpl = fs, pathApi = path } = {}) {
  const suffix = [];
  let current = pathApi.resolve(file);
  while (true) {
    try {
      return pathApi.normalize(pathApi.join(await fsImpl.realpath(current), ...suffix));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = pathApi.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(pathApi.basename(current));
      current = parent;
    }
  }
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

export async function canonicalRelativePath(root, candidate, options = {}) {
  const pathApi = options.pathApi ?? path;
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    canonicalPath(root, options),
    canonicalPath(candidate, options)
  ]);
  if (!isPathContained(canonicalRoot, canonicalCandidate, pathApi)) throw new Error('canonical path escaped its root');
  return pathApi.relative(canonicalRoot, canonicalCandidate).split(pathApi.sep).join('/');
}

export async function assertPathsOutsideForbiddenRoots({ candidates, forbiddenRoots, ...options }) {
  if (!Array.isArray(candidates) || candidates.some((candidate) => typeof candidate !== 'string' || candidate === ''))
    throw new Error('integration candidates must be nonempty path strings');
  if (!Array.isArray(forbiddenRoots) || forbiddenRoots.some((root) => typeof root !== 'string' || root === ''))
    throw new Error('integration forbidden roots must be path strings');
  const pathApi = options.pathApi ?? path;
  const roots = await Promise.all(forbiddenRoots.map((root) => canonicalPathForCreation(root, options)));
  for (const candidate of candidates) {
    const canonicalCandidate = await canonicalPathForCreation(candidate, options);
    if (roots.some((root) => isPathContained(root, canonicalCandidate, pathApi)))
      throw new Error(`forbidden integration path: ${candidate}`);
  }
}
