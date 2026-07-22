import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { copyImmutable, writeImmutableJson } from './artifacts.mjs';
import { decodePngArtifact } from './png-sequence.mjs';
import { exactObject, integer, portableId, sha256File, sha256Value } from './schema.mjs';

function contractedAction(project, run, actionId, poseId) {
  portableId(actionId, 'generation action ID');
  portableId(poseId, 'generation pose ID');
  if (run.document.projectSha256 !== project.sha256) throw new Error('generation project hash mismatch');
  if (run.document.sourceRequest.actionId !== actionId || run.document.sourceRequest.kind !== 'generated-still') {
    throw new Error('generation handoff does not match the immutable run request');
  }
  const action = project.document.actions.find(({ id }) => id === actionId);
  if (!action) throw new Error(`generation action is unknown: ${actionId}`);
  if (!action.poses.includes(poseId)) throw new Error(`generation pose is unknown: ${poseId}`);
  return action;
}

export async function createGenerationHandoff({ project, run, actionId, poseId, cliPath }) {
  const action = contractedAction(project, run, actionId, poseId);
  const document = {
    schemaVersion: 1,
    kind: 'generated-still',
    runId: run.id,
    projectSha256: project.sha256,
    actionId,
    poseId,
    prompt: {
      characterIdentity: project.document.character.identity,
      actionSemantic: action.semantic,
      poseDelta: poseId,
      negativeConstraints: [
        'do not change character identity, silhouette, costume, palette meaning, or facing direction',
        'do not resize, crop, rotate, interpolate, or add a background',
        'return one transparent lossless PNG candidate, not a spritesheet or pose board'
      ]
    },
    anchors: project.document.character.anchors.map(({ id, path: anchorPath, sha256 }) => ({ id, path: anchorPath, sha256 })),
    canvas: project.document.canvas,
    scale: project.document.scale,
    palette: project.document.palette
  };
  const written = await writeImmutableJson({
    root: run.root,
    relative: 'work/generation-handoff.json',
    value: document,
    reuse: true
  });
  const selectedCli = path.resolve(cliPath);
  const next = {
    cwd: project.root,
    argv: [
      process.execPath,
      selectedCli,
      'intake',
      '--resume', run.id,
      '--project-dir', project.root,
      '--action', actionId,
      '--kind', 'generated-still',
      '--pose', poseId,
      '--handoff', written.path,
      '--generated-image', '<GENERATED_IMAGE>',
      '--duration-ms', '<DURATION_MS>'
    ]
  };
  return { ...written, next };
}

async function verifyGenerationHandoff(handoff, run) {
  if (!handoff?.path || !handoff.sha256) throw new Error('generation handoff identity is required');
  const expectedPath = path.join(run.root, 'work', 'generation-handoff.json');
  const [actualPath, immutablePath] = await Promise.all([
    fs.realpath(path.resolve(handoff.path)),
    fs.realpath(expectedPath)
  ]);
  const stat = await fs.lstat(expectedPath);
  if (actualPath !== immutablePath || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('generation resume requires the immutable generation handoff from this run');
  }
  const actualSha256 = await sha256File(handoff.path);
  if (actualSha256 !== handoff.sha256) throw new Error('generation handoff hash mismatch');
  const document = JSON.parse(await fs.readFile(handoff.path, 'utf8'));
  if (sha256Value(document) !== handoff.sha256) throw new Error('generation handoff hash mismatch');
  exactObject(
    document,
    ['schemaVersion', 'kind', 'runId', 'projectSha256', 'actionId', 'poseId', 'prompt', 'anchors', 'canvas', 'scale', 'palette'],
    'generation handoff'
  );
  if (
    document.schemaVersion !== 1 ||
    document.kind !== 'generated-still' ||
    document.runId !== run.id ||
    document.projectSha256 !== run.document.projectSha256 ||
    document.actionId !== run.document.sourceRequest.actionId
  ) throw new Error('generation handoff binding mismatch');
  portableId(document.poseId, 'generation handoff pose ID');
  return document;
}

export async function loadGenerationHandoff({ file, run }) {
  const pathValue = path.resolve(file);
  const document = JSON.parse(await fs.readFile(pathValue, 'utf8'));
  const handoff = { path: pathValue, relative: path.relative(run.root, pathValue).replaceAll('\\', '/'), sha256: sha256Value(document), document };
  await verifyGenerationHandoff(handoff, run);
  return handoff;
}

export async function importGeneratedCandidate({ handoff, source, run, durationMs }) {
  integer(durationMs, 'explicit candidate duration', { min: 1, max: 65535 });
  const document = await verifyGenerationHandoff(handoff, run);
  const copied = await copyImmutable({
    source: path.resolve(source),
    root: run.root,
    relative: `source/generated/${document.poseId}.png`
  });
  const decoded = await decodePngArtifact({
    run,
    sourceRelative: copied.relative,
    frameId: document.poseId,
    durationMs
  });
  const diagnostics = [];
  if (decoded.alpha) diagnostics.push({ code: 'ALPHA_PRESENT', frameId: document.poseId });
  if (decoded.empty) diagnostics.push({ code: 'EMPTY_FRAME', frameId: document.poseId });
  return {
    kind: 'generated-still',
    sourceSha256: copied.sha256,
    decoder: {
      name: 'sharp-generated-still',
      version: sharp.versions.sharp,
      arguments: ['ensureAlpha', 'png:compressionLevel=9', 'png:adaptiveFiltering=false']
    },
    canvas: { width: decoded.width, height: decoded.height },
    alpha: decoded.alpha,
    timeBase: { numerator: 1, denominator: 1000 },
    frames: [{
      index: 0,
      id: document.poseId,
      path: decoded.output.relative,
      sha256: decoded.output.sha256,
      width: decoded.width,
      height: decoded.height,
      timestampMs: 0,
      durationMs,
      sourceRect: { x: 0, y: 0, width: decoded.width, height: decoded.height },
      duplicateOf: null
    }],
    diagnostics,
    approval: null
  };
}
