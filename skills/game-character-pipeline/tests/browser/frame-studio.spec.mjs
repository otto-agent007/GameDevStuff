import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { writeImmutableBytes, writeImmutableJson } from '../../scripts/lib/artifacts.mjs';
import { createProject, createRun } from '../../scripts/lib/run-contract.mjs';
import { startStudioServer } from '../../scripts/studio/server.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const projectFixture = path.join(packageDir, 'tests', 'fixtures', 'project.valid.json');
let root;
let studio;

function spriteFrame(index) {
  const width = 16;
  const height = 16;
  const pixels = Buffer.alloc(width * height * 4);
  const colors = [[245, 158, 11], [70, 180, 220], [149, 204, 92]];
  for (let y = 3; y < 13; y += 1) {
    for (let x = 4 + index; x < 11 + index; x += 1) {
      const offset = (y * width + x) * 4;
      pixels.set([...colors[index], 255], offset);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-frame-studio-browser-'));
  const projectRoot = path.join(root, 'project');
  const project = await createProject({ root: projectRoot, contractFile: projectFixture });
  const run = await createRun({ projectRoot, project, sourceRequest: { actionId: 'idle', kind: 'png-sequence' } });
  const definitions = [
    { id: 'step-contact', durationMs: 80 },
    { id: 'step-pass', durationMs: 120 },
    { id: 'step-contact-2', durationMs: 200 }
  ];
  let timestampMs = 0;
  const frames = [];
  for (const [index, definition] of definitions.entries()) {
    const artifact = await writeImmutableBytes({
      root: run.root,
      relative: `work/decoded/${definition.id}.png`,
      bytes: await spriteFrame(index)
    });
    frames.push({
      index,
      id: definition.id,
      path: artifact.relative,
      sha256: artifact.sha256,
      width: 16,
      height: 16,
      timestampMs,
      durationMs: definition.durationMs,
      sourceRect: { x: 0, y: 0, width: 16, height: 16 },
      duplicateOf: null
    });
    timestampMs += definition.durationMs;
  }
  const source = {
    kind: 'png-sequence',
    sourceSha256: 'b'.repeat(64),
    decoder: { name: 'browser-fixture', version: '1', arguments: [] },
    canvas: { width: 16, height: 16 },
    alpha: true,
    timeBase: { numerator: 1, denominator: 1000 },
    frames,
    diagnostics: [],
    approval: null
  };
  await writeImmutableJson({ root: run.root, relative: 'reports/source.json', value: source });
  studio = await startStudioServer({ projectDir: projectRoot, runId: run.id, stage: 'selection' });
});

test.afterAll(async () => {
  await studio?.close();
  await fs.rm(root, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  const messages = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') messages.push(message.text());
  });
  await page.goto(studio.origin);
  await expect(page).toHaveTitle('Frame Studio');
  await expect(page.getByRole('heading', { name: 'Frame Studio' })).toBeVisible();
  expect(messages).toEqual([]);
});

test('renders the complete editor shell and source timeline', async ({ page }, testInfo) => {
  await expect(page.getByText('Clockwork Courier / Idle')).toBeVisible();
  await expect(page.getByText('Selection', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save revision' })).toBeVisible();
  await expect(page.locator('frame-timeline')).toBeVisible();
  await expect(page.locator('frame-canvas')).toBeVisible();
  await expect(page.locator('[data-frame-id]')).toHaveCount(3);
  await expect(page.getByText('Frame 1 of 3')).toBeVisible();
  await expect(page.getByText('400 ms total')).toBeVisible();
  for (const label of ['Previous', 'Next', 'First / last seam', 'Clipping', 'Duplicates', 'Palette', 'Drift']) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  if (process.env.FRAME_STUDIO_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.FRAME_STUDIO_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(process.env.FRAME_STUDIO_SCREENSHOT_DIR, `${testInfo.project.name}.png`),
      fullPage: true
    });
  }
});

test('plays authored durations and supports keyboard frame selection', async ({ page }) => {
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact');
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass', { timeout: 180 });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2');
  await page.keyboard.press('Home');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact');
  await page.keyboard.press('End');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2');
});

test('uses integer zoom, disables interpolation, and toggles overlays', async ({ page }) => {
  await expect(page.locator('frame-canvas canvas')).toHaveCSS('image-rendering', 'pixelated');
  await expect(page.getByLabel('Zoom')).toHaveValue('4');
  await page.getByLabel('Zoom').fill('6');
  await expect(page.getByLabel('Zoom')).toHaveValue('6');
  await page.getByLabel('Previous', { exact: true }).check();
  await page.getByLabel('First / last seam', { exact: true }).check();
  await expect(page.locator('frame-canvas')).toHaveAttribute('previous', /api\/frame/);
  await expect(page.locator('frame-canvas')).toHaveAttribute('seam', 'true');
});

test('supports inclusion, duplication, labels, and immutable save revisions', async ({ page }) => {
  await page.getByRole('button', { name: 'Exclude step-pass' }).click();
  await expect(page.locator('[data-frame-id="step-pass"]')).toHaveAttribute('data-included', 'false');
  await page.getByRole('button', { name: 'Duplicate step-contact', exact: true }).click();
  await expect(page.locator('[data-frame-id]')).toHaveCount(4);
  await page.getByLabel('Label step-contact', { exact: true }).fill('contact pose');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toContainText(/Saved edit revision \d+/);
});

test('fits desktop and narrow viewports with visible focus and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
  await page.getByRole('button', { name: 'Play' }).focus();
  const outline = await page.getByRole('button', { name: 'Play' }).evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe('none');
  const transitions = await page.locator('.app-shell').evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(transitions).toBe('0s');
});
