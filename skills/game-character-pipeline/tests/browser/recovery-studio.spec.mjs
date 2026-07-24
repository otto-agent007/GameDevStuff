import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { recoverPoseBoard } from '../../scripts/lib/pose-board.mjs';
import { createProject, createRun } from '../../scripts/lib/run-contract.mjs';
import { startRecoveryStudioServer } from '../../scripts/studio/recovery-server.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const projectFixture = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');
const BACKGROUND = [0, 255, 0, 255];
let root;
let studio;

function writePixel(pixels, width, x, y, rgba) {
  pixels.set(rgba, ((y * width) + x) * 4);
}

async function startFixture() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-recovery-browser-'));
  const source = path.join(root, 'board.png');
  const contract = path.join(root, 'recovery.json');
  const width = 12;
  const height = 8;
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(BACKGROUND, offset);
  for (const [color, points] of [
    [[214, 30, 42, 255], [[4, 1], [5, 1], [6, 1], [7, 1], [5, 2], [6, 2]]],
    [[44, 77, 221, 255], [[0, 4], [1, 4], [2, 4], [1, 5]]],
    [[248, 198, 34, 255], [[9, 5], [10, 5], [9, 6], [10, 6]]]
  ]) {
    for (const [x, y] of points) writePixel(pixels, width, x, y, color);
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(source);
  await fs.writeFile(contract, JSON.stringify({
    schemaVersion: 1,
    background: { mode: 'color', rgba: BACKGROUND, tolerance: 8 },
    connectivity: 4,
    minimumComponentPixels: 4,
    maxDecodedRgbaBytes: 1024 * 1024,
    padding: 2,
    expectedCandidates: { min: 3, max: 3 },
    allowUnassigned: true,
    groups: []
  }));
  const projectRoot = path.join(root, 'project');
  const project = await createProject({ root: projectRoot, contractFile: projectFixture });
  const run = await createRun({
    projectRoot,
    project,
    sourceRequest: { actionId: 'idle', kind: 'pose-board' }
  });
  await recoverPoseBoard({ source, recoveryContract: contract, run, project });
  studio = await startRecoveryStudioServer({ projectDir: projectRoot, runId: run.id });
}

test.beforeEach(async ({ page }) => {
  await startFixture();
  const messages = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      messages.push(message.text());
    }
  });
  await page.goto(studio.origin);
  await expect(page).toHaveTitle('Pose Recovery Studio');
  await expect(page.getByRole('heading', { name: 'Pose Recovery Studio' })).toBeVisible();
  expect(messages).toEqual([]);
});

test.afterEach(async () => {
  await studio?.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('recovery Studio curates, saves, and approves a numbered sequence', async ({ page }) => {
  await expect(
    page.getByRole('img', { name: 'Pose-board component overlay' })
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /candidate-0001/ })).not.toBeChecked();
  await page.getByRole('checkbox', { name: /candidate-0001/ }).check();
  await page.getByRole('button', { name: 'Move candidate-0002 earlier' }).click();
  await expect(page.getByRole('status')).toContainText('2 eligible components omitted');
  await page.getByLabel('stride-01 duration').fill('80');
  await page.getByRole('button', { name: 'Save recovery revision' }).click();
  await expect(page.getByRole('status')).toContainText(/Saved recovery revision 1/);
  await page.getByLabel('Approval notes').fill('Selected pose and timing reviewed.');
  await page.getByRole('button', { name: 'Approve recovered sequence' }).click();
  await expect(page.getByRole('status')).toContainText('Approved');
});

test('recovery Studio surfaces invalid duplicate membership and stale revisions', async ({ page }) => {
  const session = await page.evaluate(() => (
    fetch('/api/recovery-session').then((response) => response.json())
  ));
  const candidate = session.recovery.candidates[0];
  const duplicate = {
    schemaVersion: 1,
    kind: 'pose-board-selection',
    projectSha256: session.projectSha256,
    runId: session.runId,
    actionId: session.actionId,
    recoverySha256: session.recoverySha256,
    frames: [
      {
        id: 'stride-01',
        candidateId: candidate.id,
        durationMs: 80,
        tracks: [{ role: 'actor', componentIds: candidate.componentIds }]
      },
      {
        id: 'stride-02',
        candidateId: session.recovery.candidates[1].id,
        durationMs: 80,
        tracks: [{ role: 'actor', componentIds: candidate.componentIds }]
      }
    ]
  };
  const invalid = await page.evaluate(async ({ value, sha256 }) => {
    const response = await fetch('/api/pose-selections', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': sha256
      },
      body: JSON.stringify(value)
    });
    return { status: response.status, body: await response.json() };
  }, { value: duplicate, sha256: session.selectionSha256 });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error).toContain('component membership must be unique');

  await page.getByRole('checkbox', { name: /candidate-0001/ }).check();
  await page.getByRole('button', { name: 'Save recovery revision' }).click();
  const stale = await page.evaluate(async ({ value, sha256 }) => {
    const response = await fetch('/api/pose-selections', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': sha256
      },
      body: JSON.stringify(value)
    });
    return { status: response.status, body: await response.json() };
  }, {
    value: {
      ...duplicate,
      frames: [duplicate.frames[0]]
    },
    sha256: session.selectionSha256
  });
  expect(stale.status).toBe(409);
  expect(stale.body.error).toContain('stale pose selection');
});

test('recovery Studio is keyboard accessible at narrow reduced-motion viewports', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBe(0);
  const checkbox = page.getByRole('checkbox', { name: /candidate-0001/ });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  const outline = await checkbox.evaluate(
    (element) => getComputedStyle(element).outlineStyle
  );
  expect(outline).not.toBe('none');
  const transitions = await page.locator('.recovery-shell').evaluate(
    (element) => getComputedStyle(element).transitionDuration
  );
  expect(transitions).toBe('0s');
});
