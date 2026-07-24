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
const editableCanvas = (page) => page.locator('#review-b-canvas');
const editableBitmap = (page) => editableCanvas(page).locator('canvas');

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

async function startFixture(actionId = 'idle') {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'game-character-frame-studio-browser-'));
  const projectRoot = path.join(root, 'project');
  const project = await createProject({ root: projectRoot, contractFile: projectFixture });
  const run = await createRun({ projectRoot, project, sourceRequest: { actionId, kind: 'png-sequence' } });
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
}

test.beforeEach(async ({ page }) => {
  await startFixture();
  const messages = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') messages.push(message.text());
  });
  await page.goto(studio.origin);
  await expect(page).toHaveTitle('Frame Studio');
  await expect(page.getByRole('heading', { name: 'Frame Studio' })).toBeVisible();
  expect(messages).toEqual([]);
});

test.afterEach(async () => {
  await studio?.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('renders the complete editor shell and source timeline', async ({ page }, testInfo) => {
  await expect(page.getByText('Clockwork Courier / Idle')).toBeVisible();
  await expect(page.getByText('Selection', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save revision' })).toBeVisible();
  await expect(page.locator('frame-timeline')).toBeVisible();
  await expect(editableCanvas(page)).toBeVisible();
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
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass', { timeout: 180 });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2');
  await page.keyboard.press('Home');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact');
  await page.keyboard.press('End');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2');
});

test('replay starts a held final pose from frame one', async ({ page }) => {
  await page.keyboard.press('End');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2');

  const replayedFrame = await page.getByRole('button', { name: 'Replay', exact: true }).evaluate((button) => {
    button.click();
    return document.querySelector('[aria-current="true"]')?.dataset.frameId;
  });

  expect(replayedFrame).toBe('step-contact');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass', { timeout: 180 });
});

test('replay restarts active playback from frame one', async ({ page }) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass', { timeout: 180 });

  const replayedFrame = await page.getByRole('button', { name: 'Replay', exact: true }).evaluate((button) => {
    button.click();
    return document.querySelector('[aria-current="true"]')?.dataset.frameId;
  });

  expect(replayedFrame).toBe('step-contact');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass', { timeout: 180 });
});

test('skips excluded frames in playback and transport', async ({ page }) => {
  await page.getByRole('button', { name: 'Exclude step-pass', exact: true }).click();
  await expect(page.getByText('2 active / 3 source', { exact: true })).toBeVisible();
  await expect(page.locator('[data-frame-id="step-pass"]')).toContainText('Excluded');

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2', { timeout: 180 });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  await page.locator('[data-frame-id="step-pass"] .frame-thumb').click();
  await expect(page.getByRole('button', { name: 'Restore to action', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact');

  await page.locator('[data-frame-id="step-pass"] .frame-thumb').click();
  await page.getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2');
  await page.getByRole('button', { name: 'Previous frame', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact');

  const replayedFrame = await page.getByRole('button', { name: 'Replay', exact: true }).evaluate((button) => {
    button.click();
    return document.querySelector('[aria-current="true"]')?.dataset.frameId;
  });
  expect(replayedFrame).toBe('step-contact');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2', { timeout: 180 });
});

test('uses active neighbors for onion skin and cycle seams', async ({ page }) => {
  await page.getByRole('button', { name: 'Exclude step-pass', exact: true }).click();
  const finalUrl = await page.locator('[data-frame-id="step-contact-2"] img').getAttribute('src');
  await page.getByLabel('Next', { exact: true }).check();
  await expect(editableCanvas(page)).toHaveAttribute('next', finalUrl);

  await page.getByRole('button', { name: 'Exclude step-contact', exact: true }).click();
  await page.locator('[data-frame-id="step-contact-2"] .frame-thumb').click();
  await page.getByLabel('First / last seam', { exact: true }).check();
  await expect(editableCanvas(page)).toHaveAttribute('first', finalUrl);
  await expect(editableCanvas(page)).toHaveAttribute('last', finalUrl);
});

test('guards the final active frame and restores excluded frames', async ({ page }) => {
  await page.getByRole('button', { name: 'Exclude step-pass', exact: true }).click();
  await page.getByRole('button', { name: 'Exclude step-contact-2', exact: true }).click();
  await page.locator('[data-frame-id="step-contact"] .frame-thumb').click();
  await page.getByRole('button', { name: 'Exclude from action', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('An action must retain at least one active frame.');
  await expect(page.locator('[data-frame-id="step-contact"]')).toHaveAttribute('data-included', 'true');

  await page.locator('[data-frame-id="step-pass"] .frame-thumb').click();
  await page.getByRole('button', { name: 'Restore to action', exact: true }).click();
  await expect(page.locator('[data-frame-id="step-pass"]')).toHaveAttribute('data-included', 'true');
  await expect(page.getByText('2 active / 3 source', { exact: true })).toBeVisible();
});

test('persists saved exclusion across reloads', async ({ page }) => {
  await page.getByRole('button', { name: 'Exclude step-pass', exact: true }).click();
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toContainText(/Saved edit revision \d+/);
  await page.reload();

  await expect(page.locator('[data-frame-id="step-pass"]')).toHaveAttribute('data-included', 'false');
  await expect(page.getByText('2 active / 3 source', { exact: true })).toBeVisible();
  const session = await page.evaluate(() => fetch('/api/session').then((response) => response.json()));
  expect(session.source.frames).toHaveLength(3);
  expect(session.edit.frames.find(({ frameId }) => frameId === 'step-pass').included).toBe(false);
});

test('A/B auditioning keeps saved A immutable and working B editable', async ({ page }) => {
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toContainText('Saved edit revision 1.');
  await page.getByLabel('Duration step-contact', { exact: true }).fill('96');
  await page.getByLabel('Duration step-contact', { exact: true }).blur();
  await expect(page.getByRole('status')).toContainText('Updated authored frame duration.');

  await page.getByRole('button', { name: 'Review A', exact: true }).click();

  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact');
  await expect(page.getByLabel('Duration step-contact', { exact: true })).toHaveValue('80');
  await expect(page.getByLabel('Duration step-contact', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Label step-contact', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Exclude step-contact', exact: true })).toBeDisabled();
  await expect(page.locator('#review-a-state')).toContainText('Revision 1');
  await expect(page.locator('#review-b-state')).toContainText('Unsaved working copy');

  await page.getByRole('button', { name: 'Review B', exact: true }).click();

  await expect(page.getByLabel('Duration step-contact', { exact: true })).toHaveValue('96');
  await expect(page.getByLabel('Duration step-contact', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Label step-contact', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Exclude step-contact', exact: true })).toBeEnabled();
});

test('side-by-side preview is accessible and responsive', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: 'Side by side', exact: true }).click();

  const reviewA = page.getByRole('region', { name: 'Review A preview' });
  const reviewB = page.getByRole('region', { name: 'Review B preview' });
  await expect(reviewA).toBeVisible();
  await expect(reviewB).toBeVisible();
  await expect(reviewA.locator('frame-canvas')).toBeVisible();
  await expect(reviewB.locator('frame-canvas')).toBeVisible();

  const [aBox, bBox] = await Promise.all([reviewA.boundingBox(), reviewB.boundingBox()]);
  expect(aBox).not.toBeNull();
  expect(bBox).not.toBeNull();
  if (testInfo.project.name === 'narrow') expect(aBox.y).toBeLessThan(bBox.y);
  else expect(aBox.x).toBeLessThan(bBox.x);

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBe(0);
});

test('side-by-side playback uses one shared elapsed clock without mutating reviews', async ({ page }) => {
  await studio.close();
  await fs.rm(root, { recursive: true, force: true });
  await startFixture('unlock');
  await page.goto(studio.origin);

  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toContainText('Saved edit revision 1.');
  const savedSession = await page.evaluate(() => fetch('/api/session').then((response) => response.json()));

  for (const [name, duration] of [
    ['Timeline duration step-contact', '40'],
    ['Timeline duration step-pass', '40'],
    ['Timeline duration step-contact-2', '40']
  ]) {
    await page.getByLabel(name, { exact: true }).fill(duration);
    await page.getByLabel(name, { exact: true }).blur();
  }

  await page.getByRole('button', { name: 'Side by side', exact: true }).click();
  await page.getByLabel('Review speed').selectOption('0.5');
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(page.locator('#review-a-frame')).toHaveText('step-contact');
  await expect(page.locator('#review-b-frame')).toHaveText('step-contact');

  await expect(page.locator('#review-b-frame')).toHaveText('step-contact-2', { timeout: 340 });
  await expect(page.locator('#review-a-frame')).toHaveText('step-pass');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible({ timeout: 950 });

  const reviewedSession = await page.evaluate(() => fetch('/api/session').then((response) => response.json()));
  expect(reviewedSession.editRevision).toBe(savedSession.editRevision);
  expect(reviewedSession.editSha256).toBe(savedSession.editSha256);
  await expect(page.locator('#review-b-state')).toContainText('Unsaved working copy');
});

test('review speed changes playback timing without changing authored duration', async ({ page }) => {
  await page.getByLabel('Review speed').selectOption('0.25');
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await page.waitForTimeout(140);
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  await page.getByLabel('Review speed').selectOption('2');
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass', { timeout: 100 });
  await expect(page.getByText('400 ms total', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Review A', exact: true }).click();
  await expect(page.getByLabel('Review speed')).toHaveValue('2');
});

test('temporary inclusive loop range wraps a hold-last action', async ({ page }) => {
  await studio.close();
  await fs.rm(root, { recursive: true, force: true });
  await startFixture('unlock');
  await page.goto(studio.origin);

  await page.locator('[data-frame-id="step-pass"] .frame-thumb').click();
  await page.getByRole('button', { name: 'Set in', exact: true }).click();
  await expect(page.locator('[data-frame-id="step-pass"]')).toHaveAttribute('data-range-in', 'true');

  await page.locator('[data-frame-id="step-contact-2"] .frame-thumb').click();
  await page.getByRole('button', { name: 'Set out', exact: true }).click();
  await expect(page.locator('[data-frame-id="step-contact-2"]')).toHaveAttribute('data-range-out', 'true');
  await expect(page.locator('#range-readout')).toContainText('step-pass → step-contact-2');

  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass');
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2', { timeout: 180 });
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass', { timeout: 260 });
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Clear range', exact: true }).click();
  await expect(page.locator('#range-readout')).toHaveText('Full action');
});

test('timing bars scale proportionally and edit authored duration accessibly', async ({ page }) => {
  const widths = await page.locator('[data-frame-id] .timing-bar-fill').evaluateAll((bars) =>
    bars.map((bar) => Number.parseFloat(getComputedStyle(bar).width))
  );
  expect(widths[0]).toBeLessThan(widths[1]);
  expect(widths[1]).toBeLessThan(widths[2]);

  const duration = page.getByLabel('Timeline duration step-contact', { exact: true });
  await duration.fill('240');
  await duration.blur();

  await expect(page.getByText('560 ms total', { exact: true })).toBeVisible();
  await expect(page.locator('#review-b-state')).toContainText('Unsaved working copy');
  const updatedWidths = await page.locator('[data-frame-id] .timing-bar-fill').evaluateAll((bars) =>
    bars.map((bar) => Number.parseFloat(getComputedStyle(bar).width))
  );
  expect(updatedWidths[0]).toBeGreaterThan(updatedWidths[2]);

  for (const invalid of ['0', '65536', '1.5']) {
    await duration.fill(invalid);
    await duration.blur();
    await expect(duration).toHaveValue('240');
    await expect(page.getByRole('status')).toContainText('whole milliseconds from 1 to 65535');
  }
});

test('motion diagnostics surface foot slide and jump to the implicated frame', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Motion & grounding' })).toBeVisible();

  await page.getByRole('button', { name: 'Root pivot', exact: true }).click();
  await editableBitmap(page).click({ position: { x: 20, y: 20 } });
  await page.getByRole('button', { name: 'Left foot', exact: true }).click();
  await editableBitmap(page).click({ position: { x: 20, y: 48 } });
  await page.getByLabel('Planted left foot').check();

  await page.locator('[data-frame-id="step-pass"] .frame-thumb').click();
  await page.getByRole('button', { name: 'Root pivot', exact: true }).click();
  await editableBitmap(page).click({ position: { x: 22, y: 20 } });
  await page.getByRole('button', { name: 'Left foot', exact: true }).click();
  await editableBitmap(page).click({ position: { x: 34, y: 48 } });
  await page.getByLabel('Planted left foot').check();

  await expect(page.getByRole('button', { name: 'Go to step-pass: foot-slide', exact: true })).toBeVisible();
  await expect(page.locator('#motion-path-plot polyline')).not.toHaveCount(0);

  await page.locator('[data-frame-id="step-contact-2"] .frame-thumb').click();
  await page.getByRole('button', { name: 'Go to step-pass: foot-slide', exact: true }).click();

  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-pass');
  await expect(page.locator('#review-b-state')).toContainText('Unsaved working copy');
});

test('hold-last playback stops on the final authored frame', async ({ page }) => {
  await studio.close();
  await fs.rm(root, { recursive: true, force: true });
  await startFixture('unlock');
  await page.goto(studio.origin);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2', { timeout: 500 });
  await page.waitForTimeout(250);
  await expect(page.locator('[aria-current="true"]')).toHaveAttribute('data-frame-id', 'step-contact-2');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveText('Play');
});

test('uses integer zoom, disables interpolation, and toggles overlays', async ({ page }) => {
  const reviewB = page.getByRole('region', { name: 'Review B preview' });
  await expect(reviewB.locator('frame-canvas canvas')).toHaveCSS('image-rendering', 'pixelated');
  await expect(page.getByLabel('Zoom')).toHaveValue('4');
  await page.getByLabel('Zoom').fill('6');
  await expect(page.getByLabel('Zoom')).toHaveValue('6');
  await page.getByLabel('Previous', { exact: true }).check();
  await page.getByLabel('First / last seam', { exact: true }).check();
  await expect(reviewB.locator('frame-canvas')).toHaveAttribute('previous', /api\/frame/);
  await expect(reviewB.locator('frame-canvas')).toHaveAttribute('seam', 'true');
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

test('authors landmarks, contact intervals, travel, timing, and explicit tracks', async ({ page }) => {
  for (const name of ['Root pivot', 'Baseline', 'Left foot', 'Right foot', 'Hand', 'Prop grip', 'Effect origin']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  for (const name of ['Actor track', 'Prop track', 'Effect track']) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Root pivot', exact: true }).click();
  await editableBitmap(page).click({ position: { x: 32, y: 48 } });
  await page.getByLabel('Planted left foot').check();
  await expect(page.getByText('left-foot', { exact: true })).toBeVisible();
  await page.getByLabel('Ground travel X').fill('2');
  await page.getByLabel('Duration step-contact', { exact: true }).fill('96');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toContainText(/Saved edit revision \d+/);
  const session = await page.evaluate(() => fetch('/api/session').then((response) => response.json()));
  const current = session.edit.frames.find(({ frameId }) => frameId === 'step-contact');
  expect(session.edit.kind).toBe('frame-studio-edit');
  expect(current.markers).toContainEqual(expect.objectContaining({ id: 'root', kind: 'root-pivot' }));
  expect(current.contacts).toContain('left-foot');
  expect(current.groundTravel.x).toBe(2);
  expect(current.durationMs).toBe(96);
  await page.getByLabel('Ground travel X').fill('3');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toContainText(/Saved edit revision \d+/);
  await page.getByRole('button', { name: 'Restore prior revision' }).click();
  await expect(page.getByRole('status')).toContainText(/Restored edit revision \d+/);
  await expect(page.getByLabel('Ground travel X')).toHaveValue('2');
});

test('renders hashes and binds configured owner approval only to saved edits', async ({ page }, testInfo) => {
  await expect(page.getByText('Approval gate', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Approver identity')).toHaveValue('owner');
  await expect(page.getByRole('button', { name: 'Approve revision' })).toBeDisabled();
  await page.getByLabel('Label step-contact', { exact: true }).fill('owner-reviewed contact');
  await expect(page.getByRole('button', { name: 'Approve revision' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.getByRole('button', { name: 'Render review' }).click();
  await expect(page.getByRole('status')).toContainText(/Rendered edit revision \d+/);
  for (const label of ['Source hash', 'Edit hash', 'Render hash']) {
    await expect(page.getByLabel(label)).toHaveText(/[a-f0-9]{64}/);
  }
  await expect(page.getByRole('button', { name: 'Approve revision' })).toBeEnabled();
  await page.getByLabel('Approval notes').fill('Timing, identity, and planted contacts approved.');
  await page.getByRole('button', { name: 'Approve revision' }).click();
  await expect(page.getByRole('status')).toContainText(/Approved selection revision \d+/);
  if (process.env.FRAME_STUDIO_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.FRAME_STUDIO_SCREENSHOT_DIR, { recursive: true });
    await page.locator('.inspector').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({
      path: path.join(process.env.FRAME_STUDIO_SCREENSHOT_DIR, `approval-${testInfo.project.name}.png`),
      fullPage: true
    });
  }
});

test('fits desktop and narrow viewports with visible focus and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
  await page.getByRole('button', { name: 'Play', exact: true }).focus();
  const outline = await page.getByRole('button', { name: 'Play', exact: true }).evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe('none');
  const transitions = await page.locator('.app-shell').evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(transitions).toBe('0s');
});
