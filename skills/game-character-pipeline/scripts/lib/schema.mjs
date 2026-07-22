import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_UNSAFE = /[<>:"|?*\u0000-\u001f]/;

export function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} ${key} is required`);
  }
  return value;
}

export function portableId(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${label} must be a portable ID`);
  }
  const stem = value.split('.')[0];
  if (WINDOWS_RESERVED.test(stem) || value.endsWith('.') || value.endsWith(' ')) {
    throw new Error(`${label} must be a portable ID`);
  }
  return value;
}

export function portableRelativePath(value, label) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\\') ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === '.' ||
    value === '..' ||
    value.startsWith('../')
  ) {
    throw new Error(`${label} must be a contained portable relative path`);
  }

  for (const component of value.split('/')) {
    if (
      component === '' ||
      component === '.' ||
      component === '..' ||
      WINDOWS_RESERVED.test(component) ||
      WINDOWS_UNSAFE.test(component) ||
      component.endsWith('.') ||
      component.endsWith(' ')
    ) {
      throw new Error(`${label} must be a contained portable relative path`);
    }
  }
  return value;
}

export function integer(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

export function isoDate(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO date`);
  }
  return value;
}

export function uniqueList(value, label, { min = 1, key = (item) => item } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    throw new Error(`${label} must be a unique list with at least ${min} item(s)`);
  }
  const keys = value.map(key);
  if (new Set(keys).size !== keys.length) throw new Error(`${label} must be unique`);
  return value;
}

function stableValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('value must contain only JSON-safe plain objects');
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  throw new Error('value must be JSON-safe');
}

export function hashString(value) {
  if (typeof value !== 'string') throw new Error('hash input must be a string');
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sha256Value(value) {
  return hashString(canonicalJson(value));
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

export async function sha256File(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
