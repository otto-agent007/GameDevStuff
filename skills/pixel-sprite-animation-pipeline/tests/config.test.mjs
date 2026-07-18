import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, loadConfig, validateConfig } from '../scripts/lib/config.mjs';

test('defaults preserve the approved 128 to 1024 to 256 workflow', async () => {
  assert.deepEqual(DEFAULT_CONFIG.canonical, { width: 128, height: 128 });
  assert.deepEqual(DEFAULT_CONFIG.generation, { width: 1024, height: 1024 });
  assert.deepEqual(DEFAULT_CONFIG.runtime, { width: 256, height: 256 });
  assert.deepEqual(DEFAULT_CONFIG.pivot, { x: 64, y: 112 });
  assert.deepEqual(DEFAULT_CONFIG.foreground, { retentionPolicy: 'all', minimumComponentPixels: 1 });
});

test('foreground recovery settings are configurable and validated', async () => {
  const config = await loadConfig({
    cwd: process.cwd(),
    overrides: { foreground: { retentionPolicy: 'reject-multiple', minimumComponentPixels: 3 } }
  });
  assert.deepEqual(config.foreground, { retentionPolicy: 'reject-multiple', minimumComponentPixels: 3 });

  assert.throws(
    () => validateConfig({
      ...structuredClone(DEFAULT_CONFIG),
      foreground: { retentionPolicy: 'discard-small', minimumComponentPixels: 1 }
    }),
    /foreground retentionPolicy must be one of/
  );
  assert.throws(
    () => validateConfig({
      ...structuredClone(DEFAULT_CONFIG),
      foreground: { retentionPolicy: 'all', minimumComponentPixels: 0 }
    }),
    /foreground minimumComponentPixels must be a positive integer/
  );
});

test('derived scale factors must be positive integers', async () => {
  await assert.rejects(
    loadConfig({ cwd: process.cwd(), overrides: { generation: { width: 1000, height: 1024 } } }),
    /generation width must be an integer multiple of canonical width/
  );
});

for (const [section, dimension, value] of [
  ['canonical', 'width', 0],
  ['canonical', 'height', -1],
  ['generation', 'width', 1024.5],
  ['generation', 'height', 0],
  ['runtime', 'width', -256],
  ['runtime', 'height', 256.5]
]) {
  test(`${section} ${dimension} must be a positive integer`, () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config[section][dimension] = value;

    assert.throws(
      () => validateConfig(config),
      new RegExp(`${section} ${dimension} must be a positive integer`)
    );
  });
}

test('validated configurations are deeply frozen', async () => {
  const config = await loadConfig({ cwd: process.cwd() });

  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.canonical));
  assert.ok(Object.isFrozen(config.snapper));
  assert.ok(Object.isFrozen(config.snapper.args));
  assert.throws(() => { config.canonical.width = 64; }, TypeError);
  assert.throws(() => { config.snapper.args.push('32'); }, TypeError);
});

test('configuration is a closed schema with complete nested sections', () => {
  for (const mutate of [
    (c) => { c.surprise = true; },
    (c) => { c.background.surprise = true; },
    (c) => { delete c.snapper.args; }
  ]) {
    const config = structuredClone(DEFAULT_CONFIG);
    mutate(config);
    assert.throws(() => validateConfig(config), /(unknown config key|required)/);
  }
});

test('configuration rejects malformed pivots, scales, enums, colors, and limits', () => {
  const probes = [
    ['fractional pivot', (c) => { c.pivot.x = 63.5; }, /pivot coordinates must be integers/],
    ['nonuniform generation scale', (c) => { c.generation.height = 512; }, /uniform scale/],
    ['palette enum', (c) => { c.palette.mode = 'adaptive'; }, /palette mode/],
    ['background enum', (c) => { c.background.mode = 'corner'; }, /background mode/],
    ['configured missing color', (c) => { c.background.mode = 'configured'; }, /requires a valid RGBA/],
    ['border has color', (c) => { c.background.color = { r: 0, g: 0, b: 0, a: 255 }; }, /border background color must be null/],
    ['malformed rgba', (c) => { c.background.mode = 'configured'; c.background.color = { r: 0, g: 0, b: 0, a: 256 }; }, /valid RGBA/],
    ['fractional tolerance', (c) => { c.background.tolerance = 1.5; }, /tolerance must be an integer/],
    ['empty snapper', (c) => { c.snapper.executable = ''; }, /executable must be a nonempty string/],
    ['bad snapper args', (c) => { c.snapper.args = [16]; }, /args must be an array of strings/],
    ['fractional retries', (c) => { c.correction.generativeAttempts = 1.5; }, /generativeAttempts must be a nonnegative integer/],
    ['zero evidence', (c) => { c.correction.skillProposalEvidence = 0; }, /skillProposalEvidence must be a positive integer/]
  ];
  for (const [name, mutate, expected] of probes) {
    const config = structuredClone(DEFAULT_CONFIG);
    mutate(config);
    assert.throws(() => validateConfig(config), expected, name);
  }
});

test('validation returns a detached deeply frozen canonical clone', () => {
  const source = structuredClone(DEFAULT_CONFIG);
  const validated = validateConfig(source);
  source.canonical.width = 64;
  source.snapper.args.push('--changed');
  assert.equal(validated.canonical.width, 128);
  assert.deepEqual(validated.snapper.args, ['16']);
});
