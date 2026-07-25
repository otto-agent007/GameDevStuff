import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const documentation = [
  {
    plan: '2026-07-17-pixel-sprite-animation-pipeline.md',
    spec: '2026-07-17-pixel-sprite-animation-pipeline-design.md',
    pullRequests: [1]
  },
  {
    plan: '2026-07-18-pixel-snapper-binary-integration.md',
    spec: '2026-07-18-pixel-snapper-binary-integration-design.md',
    pullRequests: [2, 3, 4, 5, 6, 7]
  },
  {
    plan: '2026-07-21-game-character-animation-workflow.md',
    spec: '2026-07-21-game-character-animation-workflow-design.md',
    pullRequests: [9, 10]
  },
  {
    plan: '2026-07-22-pose-board-recovery.md',
    spec: '2026-07-22-pose-board-recovery-design.md',
    pullRequests: [11]
  },
  {
    plan: '2026-07-23-frame-studio-saveable-exclusion.md',
    spec: '2026-07-23-frame-studio-review-roadmap-design.md',
    pullRequests: [11]
  },
  {
    plan: '2026-07-23-frame-studio-finish.md',
    spec: '2026-07-23-frame-studio-review-roadmap-design.md',
    pullRequests: [11]
  },
  {
    plan: '2026-07-23-frame-studio-replay-control.md',
    spec: '2026-07-23-frame-studio-replay-control-design.md',
    pullRequests: [11]
  },
  {
    plan: '2026-07-23-frame-studio-synchronized-side-by-side.md',
    spec: '2026-07-23-frame-studio-synchronized-side-by-side-design.md',
    pullRequests: [11]
  }
];

test('reader-oriented documentation keeps plans and specs together behind a complete index', async () => {
  const index = await fs.readFile(path.join(repositoryRoot, 'docs/README.md'), 'utf8');

  await assert.rejects(fs.access(path.join(repositoryRoot, 'docs/superpowers')));
  for (const entry of documentation) {
    await fs.access(path.join(repositoryRoot, 'docs/plans', entry.plan));
    await fs.access(path.join(repositoryRoot, 'docs/specs', entry.spec));
    assert.match(index, new RegExp(`\\[.*?\\]\\(plans/${entry.plan}\\)`));
    assert.match(index, new RegExp(`\\[.*?\\]\\(specs/${entry.spec}\\)`));
    for (const pullRequest of entry.pullRequests) {
      assert.match(
        index,
        new RegExp(`\\[PR #${pullRequest}\\]\\(https://github\\.com/otto-agent007/GameDevStuff/pull/${pullRequest}\\)`)
      );
    }
  }

  assert.match(index, /Shipped/);
  assert.match(index, /Superseded by/);
});

test('root README directs readers to documentation and CI workflows without losing operational guidance', async () => {
  const readme = await fs.readFile(path.join(repositoryRoot, 'README.md'), 'utf8');

  assert.match(readme, /actions\/workflows\/skills\.yml\/badge\.svg\?branch=main/);
  assert.match(readme, /actions\/workflows\/pixel-snapper-release\.yml\/badge\.svg\?branch=main/);
  assert.match(readme, /\[Documentation index\]\(docs\/README\.md\)/);
  assert.match(readme, /Node\.js 22\.12\.0 or newer/);
  assert.match(readme, /install-by-copy/);
  assert.match(readme, /@img\/sharp-win32-x64/);
  assert.match(readme, /must match the workspace `sharp` version/);
  assert.match(readme, /## Exit classes/);
});

test('skill descriptions are concise, specific routing triggers', async () => {
  const character = await fs.readFile(path.join(repositoryRoot, 'skills/game-character-pipeline/SKILL.md'), 'utf8');
  const pixel = await fs.readFile(path.join(repositoryRoot, 'skills/pixel-sprite-animation-pipeline/SKILL.md'), 'utf8');
  const descriptionFor = (source) => source.match(/^description:\s*(.+)$/m)?.[1] ?? '';
  const characterDescription = descriptionFor(character);
  const pixelDescription = descriptionFor(pixel);

  assert.ok(characterDescription.split(/\s+/).length <= 35, 'character routing description must stay concise');
  assert.ok(pixelDescription.split(/\s+/).length <= 35, 'Pixel routing description must stay concise');
  for (const term of [
    /GIF/,
    /APNG/,
    /WebP/,
    /video/i,
    /PNG sequence/i,
    /pose[- ]board/i,
    /Frame Studio/,
    /Pixel Snapper/,
    /sprite[- ]sheet/i,
    /pivots/i,
    /sockets/i
  ]) {
    assert.match(characterDescription, term);
  }
  for (const term of [
    /Pixel Snapper/,
    /pixel-art frames/i,
    /runtime PNG sequences/i,
    /sprite sheets/i,
    /animated WebP previews/i,
    /pivots/i,
    /signed receipts/i
  ]) {
    assert.match(pixelDescription, term);
  }
});
