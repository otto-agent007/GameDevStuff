import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

const SCHEMA = Object.freeze({
  canonical: ['width', 'height'], generation: ['width', 'height'], runtime: ['width', 'height'], pivot: ['x', 'y'],
  palette: ['mode'], background: ['mode', 'color', 'tolerance'], foreground: ['retentionPolicy', 'minimumComponentPixels'],
  snapper: ['executable', 'args'], correction: ['generativeAttempts', 'skillProposalEvidence']
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  try { return structuredClone(value); }
  catch { throw new Error('config must contain only cloneable data'); }
}

export const DEFAULT_CONFIG = deepFreeze({
  canonical: { width: 128, height: 128 },
  generation: { width: 1024, height: 1024 },
  runtime: { width: 256, height: 256 },
  pivot: { x: 64, y: 112 },
  palette: { mode: 'preserve-anchor' },
  background: { mode: 'border', color: null, tolerance: 0 },
  foreground: { retentionPolicy: 'all', minimumComponentPixels: 1 },
  snapper: { executable: 'spritefusion-pixel-snapper', args: ['16'] },
  correction: { generativeAttempts: 2, skillProposalEvidence: 3 }
});

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertClosed(config, { partial = false } = {}) {
  assertObject(config, 'config');
  for (const key of Object.keys(config)) if (!(key in SCHEMA)) throw new Error(`unknown config key: ${key}`);
  for (const [section, fields] of Object.entries(SCHEMA)) {
    if (!(section in config)) {
      if (!partial) throw new Error(`config ${section} is required`);
      continue;
    }
    assertObject(config[section], `config ${section}`);
    for (const key of Object.keys(config[section])) if (!fields.includes(key)) throw new Error(`unknown config key: ${section}.${key}`);
    if (!partial) for (const key of fields) if (!(key in config[section])) throw new Error(`config ${section}.${key} is required`);
  }
}

function merge(base, extra = {}) {
  assertClosed(extra, { partial: true });
  const result = clone(base);
  for (const [section, value] of Object.entries(extra)) Object.assign(result[section], clone(value));
  return result;
}

function validRgba(color) {
  return color && typeof color === 'object' && !Array.isArray(color) &&
    Object.keys(color).sort().join(',') === 'a,b,g,r' &&
    ['r', 'g', 'b', 'a'].every((key) => Number.isInteger(color[key]) && color[key] >= 0 && color[key] <= 255);
}

export function validateConfig(input) {
  const config = clone(input);
  assertClosed(config);
  for (const [name, size] of Object.entries({ canonical: config.canonical, generation: config.generation, runtime: config.runtime })) {
    for (const dimension of ['width', 'height']) if (!Number.isInteger(size[dimension]) || size[dimension] <= 0) throw new Error(`${name} ${dimension} must be a positive integer`);
  }
  for (const [name, size] of [['generation', config.generation], ['runtime', config.runtime]]) {
    if (size.width % config.canonical.width !== 0) throw new Error(`${name} width must be an integer multiple of canonical width`);
    if (size.height % config.canonical.height !== 0) throw new Error(`${name} height must be an integer multiple of canonical height`);
    if (size.width / config.canonical.width !== size.height / config.canonical.height) throw new Error(`${name} must use a uniform scale`);
  }
  if (!Number.isInteger(config.pivot.x) || !Number.isInteger(config.pivot.y)) throw new Error('pivot coordinates must be integers');
  if (config.pivot.x < 0 || config.pivot.x >= config.canonical.width || config.pivot.y < 0 || config.pivot.y >= config.canonical.height) throw new Error('pivot must be inside the canonical cell');
  if (config.palette.mode !== 'preserve-anchor') throw new Error('palette mode must be preserve-anchor');
  if (!['border', 'configured'].includes(config.background.mode)) throw new Error('background mode must be border or configured');
  if (!Number.isInteger(config.background.tolerance) || config.background.tolerance < 0 || config.background.tolerance > 255) throw new Error('background tolerance must be an integer from 0 to 255');
  if (config.background.mode === 'border' && config.background.color !== null) throw new Error('border background color must be null');
  if (config.background.mode === 'configured' && !validRgba(config.background.color)) throw new Error('configured background requires a valid RGBA color');
  if (!['all', 'largest', 'reject-multiple'].includes(config.foreground.retentionPolicy)) throw new Error('foreground retentionPolicy must be one of: all, largest, reject-multiple');
  if (!Number.isInteger(config.foreground.minimumComponentPixels) || config.foreground.minimumComponentPixels < 1) throw new Error('foreground minimumComponentPixels must be a positive integer');
  if (typeof config.snapper.executable !== 'string' || config.snapper.executable.trim() === '') throw new Error('snapper executable must be a nonempty string');
  if (!Array.isArray(config.snapper.args) || config.snapper.args.some((item) => typeof item !== 'string')) throw new Error('snapper args must be an array of strings');
  if (!Number.isInteger(config.correction.generativeAttempts) || config.correction.generativeAttempts < 0) throw new Error('correction generativeAttempts must be a nonnegative integer');
  if (!Number.isInteger(config.correction.skillProposalEvidence) || config.correction.skillProposalEvidence < 1) throw new Error('correction skillProposalEvidence must be a positive integer');
  return deepFreeze(config);
}

async function readProfile(selected) {
  let profile = {};
  try { profile = YAML.parse(await fs.readFile(selected, 'utf8')) ?? {}; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return profile;
}

export async function loadConfigWithProvenance({ cwd, profilePath, overrides = {} }) {
  const selected = profilePath ?? path.join(cwd, '.pixel-sprite-pipeline', 'profile.yaml');
  const profile = await readProfile(selected);
  const source = Object.hasOwn(overrides.snapper ?? {}, 'executable') ? 'override'
    : Object.hasOwn(profile.snapper ?? {}, 'executable') ? 'profile' : 'default';
  return { config: validateConfig(merge(merge(DEFAULT_CONFIG, profile), overrides)), provenance: deepFreeze({ snapperExecutable: source }) };
}

export async function loadConfig(options) {
  return (await loadConfigWithProvenance(options)).config;
}
