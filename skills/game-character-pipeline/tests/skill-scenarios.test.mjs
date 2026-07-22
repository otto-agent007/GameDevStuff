import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const scenariosFile = path.join(packageRoot, 'tests', 'skill-scenarios.json');

async function loadScenarios() {
  return JSON.parse(await fs.readFile(scenariosFile, 'utf8'));
}

test('skill scenarios have complete, unique evaluation contracts', async () => {
  const scenarios = await loadScenarios();
  assert.equal(scenarios.length, 8);
  assert.equal(new Set(scenarios.map(({ id }) => id)).size, scenarios.length);

  for (const scenario of scenarios) {
    assert.match(scenario.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(typeof scenario.prompt, 'string');
    assert.ok(scenario.prompt.trim().length >= 20);
    assert.equal(typeof scenario.fixtureBoundary, 'string');
    assert.ok(scenario.fixtureBoundary.trim());
    assert.equal(typeof scenario.expectedCommandFamily, 'string');
    assert.match(scenario.expectedCommandFamily, /^game-character-pipeline (?:intake|render|approve|validate|audit)/);
    assert.ok([0, 2, 3, 4].includes(scenario.expectedExitClass));
    assert.ok(Array.isArray(scenario.forbiddenBehaviors));
    assert.ok(scenario.forbiddenBehaviors.length > 0);
    assert.equal(new Set(scenario.forbiddenBehaviors).size, scenario.forbiddenBehaviors.length);
  }
});

test('the skill directly links every operational reference and packages them', async () => {
  const references = ['workflow.md', 'frame-studio.md', 'motion-sources.md', 'private-audit.md'];
  const skill = await fs.readFile(path.join(packageRoot, 'SKILL.md'), 'utf8');
  const packageDocument = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));

  assert.match(skill, /^---\nname: game-character-pipeline\ndescription: Use when[^\n]+\n---\n/);
  assert.deepEqual(packageDocument.files.includes('references/'), true);
  for (const reference of references) {
    await fs.access(path.join(packageRoot, 'references', reference));
    assert.match(skill, new RegExp(`\\[references/${reference.replace('.', '\\.')}\\]\\(references/${reference.replace('.', '\\.')}\\)`));
  }
});

test('the private boundary and exit-class rules are explicit', async () => {
  const skill = await fs.readFile(path.join(packageRoot, 'SKILL.md'), 'utf8');
  const privateAudit = await fs.readFile(path.join(packageRoot, 'references', 'private-audit.md'), 'utf8');
  const combined = `${skill}\n${privateAudit}`;

  assert.match(combined, /CockpitEscapeRoom/);
  assert.match(combined, /separate(?:ly)?[^.\n]*approved integration task/i);
  assert.match(combined, /exit(?: code| class)? `?4`?/i);
  assert.match(combined, /\{ passed, runSha256, reportSha256, approvedBy, approvedAt \}/);
  assert.doesNotMatch(combined, /copy private (?:media|assets).*CockpitEscapeRoom/i);
});
