import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { validateAnimationContract } from './animation-contract.mjs';
import { extractPrimaryComponent, foregroundPredicate } from './components.mjs';
import { readRgba } from './image.mjs';
import { stableHash } from './state-auth.mjs';

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} schema is invalid`);
}

function coordinate(value, label) {
  exact(value, ['x', 'y'], label);
  if (!Number.isInteger(value.x) || !Number.isInteger(value.y) || value.x < 0 || value.y < 0) throw new Error(`${label} must use non-negative integer coordinates`);
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function snapshotContract(animationContract, config) {
  if (animationContract === undefined) return null;
  exact(animationContract, ['document', 'sha256'], 'normalization animation contract');
  const document = structuredClone(animationContract.document);
  validateAnimationContract(document);
  if (animationContract.sha256 !== stableHash(document)) throw new Error('normalization animation contract hash is invalid');
  if (!same(document.sizes.canonical, [config.canonical.width, config.canonical.height]) || !same(document.pivot, config.pivot)) throw new Error('normalization animation contract geometry does not match the selected config');
  return { document, sha256: animationContract.sha256 };
}

function contractFrames(contract) {
  return contract?.document.clips.flatMap((clip) => clip.frames) ?? null;
}

function validateLandmarkBatch(landmarks, inputs, config, contract) {
  if (landmarks === undefined && !contract) return null;
  if (!Array.isArray(landmarks) || landmarks.length !== inputs.length) throw new Error('normalization requires exactly one landmark per input frame');
  const definitions = contractFrames(contract);
  if (definitions && definitions.length !== inputs.length) throw new Error('normalization input count does not match the ordered animation contract frames');
  const frameIds = new Set();
  return landmarks.map((landmark, index) => {
    exact(landmark, ['frameId', 'source', 'target'], 'normalization landmark');
    if (typeof landmark.frameId !== 'string' || landmark.frameId === '' || frameIds.has(landmark.frameId)) throw new Error('normalization landmark frameId values must be non-empty and unique');
    frameIds.add(landmark.frameId);
    coordinate(landmark.source, 'normalization landmark source');
    coordinate(landmark.target, 'normalization landmark target');
    if (landmark.target.x >= config.canonical.width || landmark.target.y >= config.canonical.height) throw new Error(`normalization landmark target for frame ${landmark.frameId} must be inside the canonical cell`);
    const expected = definitions?.[index];
    if (expected && landmark.frameId !== expected.id) throw new Error(`normalization landmark frame order does not match the animation contract at index ${index}`);
    const expectedTarget = expected?.landmarkSemantic.target ?? config.pivot;
    if (!same(landmark.target, expectedTarget)) throw new Error(`normalization landmark target for frame ${landmark.frameId} must match its contracted pivot`);
    return { frameId: landmark.frameId, source: { ...landmark.source }, target: { ...landmark.target } };
  });
}

function snapshotConfig(config, retentionPolicy, minimumComponentPixels) {
  return {
    background: config.background ? structuredClone(config.background) : undefined,
    canonical: { ...config.canonical },
    pivot: { ...config.pivot },
    retentionPolicy,
    minimumComponentPixels
  };
}

export async function normalizeFrames({
  inputs,
  outputDir,
  config,
  scaleFactor = 1,
  landmarks,
  animationContract,
  retentionPolicy = config.foreground?.retentionPolicy ?? 'all',
  minimumComponentPixels = config.foreground?.minimumComponentPixels ?? 1
}) {
  if (!Number.isInteger(scaleFactor) || scaleFactor < 1) {
    throw new Error('scaleFactor must be a positive integer');
  }
  const inputFiles = [...inputs];
  const selectedConfig = snapshotConfig(config, retentionPolicy, minimumComponentPixels);
  const selectedContract = snapshotContract(animationContract, selectedConfig);
  const approvedLandmarks = validateLandmarkBatch(landmarks, inputFiles, selectedConfig, selectedContract);
  const planned = [];

  for (let index = 0; index < inputFiles.length; index += 1) {
    const input = inputFiles[index];
    const image = await readRgba(input);
    const isForeground = foregroundPredicate(image, {
      color: selectedConfig.background?.color,
      tolerance: selectedConfig.background?.tolerance ?? 0
    });
    const recovered = await extractPrimaryComponent(input, {
      image,
      isForeground,
      retentionPolicy: selectedConfig.retentionPolicy,
      minimumComponentPixels: selectedConfig.minimumComponentPixels
    });
    const landmark = approvedLandmarks?.[index] ?? null;
    if (landmark && (landmark.source.x >= image.width || landmark.source.y >= image.height)) throw new Error(`normalization landmark source for frame ${landmark.frameId} must be inside its input frame`);
    const width = recovered.bounds.width * scaleFactor;
    const height = recovered.bounds.height * scaleFactor;
    const scaledLandmark = landmark ? {
      x: (landmark.source.x - recovered.bounds.left) * scaleFactor,
      y: (landmark.source.y - recovered.bounds.top) * scaleFactor
    } : null;
    const left = landmark ? landmark.target.x - scaledLandmark.x : selectedConfig.pivot.x - Math.floor(width / 2);
    const top = landmark ? landmark.target.y - scaledLandmark.y : selectedConfig.pivot.y - height;
    if (
      left < 0 || top < 0 ||
      left + width > selectedConfig.canonical.width ||
      top + height > selectedConfig.canonical.height
    ) {
      if (landmark) throw new Error(`frame ${landmark.frameId} exceeds canonical cell at approved landmark`);
      throw new Error(`frame ${input} exceeds canonical cell at global scale ${scaleFactor}`);
    }

    const canonicalLandmark = landmark ? { x: left + scaledLandmark.x, y: top + scaledLandmark.y } : null;
    const landmarkDrift = landmark ? { x: canonicalLandmark.x - landmark.target.x, y: canonicalLandmark.y - landmark.target.y } : null;

    planned.push({
      input,
      output: path.join(outputDir, `frame-${String(index).padStart(2, '0')}.png`),
      recovered,
      left,
      top,
      width,
      height,
      landmark,
      canonicalLandmark,
      landmarkDrift
    });
  }

  await fs.mkdir(outputDir, { recursive: true });
  const frames = [];
  const measurements = [];
  for (const plan of planned) {
    const crop = await sharp(plan.recovered.image.data, {
      raw: {
        width: plan.recovered.image.width,
        height: plan.recovered.image.height,
        channels: plan.recovered.image.channels
      }
    })
      .resize(plan.width, plan.height, { kernel: 'nearest' })
      .png()
      .toBuffer();
    await sharp({
      create: {
        width: selectedConfig.canonical.width,
        height: selectedConfig.canonical.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).composite([{ input: crop, left: plan.left, top: plan.top }]).png().toFile(plan.output);

    frames.push(plan.output);
    measurements.push({
      input: plan.input,
      output: plan.output,
      ...(plan.landmark ? {
        frameId: plan.landmark.frameId,
        sourceLandmark: { ...plan.landmark.source },
        canonicalLandmark: { ...plan.canonicalLandmark },
        landmarkDrift: { ...plan.landmarkDrift }
      } : {}),
      left: plan.left,
      top: plan.top,
      width: plan.width,
      height: plan.height,
      bottom: plan.top + plan.height - 1,
      scaleFactor,
      componentCount: plan.recovered.componentCount,
      retainedComponentCount: plan.recovered.retainedComponentCount,
      retainedPixelCount: plan.recovered.retainedPixelCount,
      retentionPolicy: plan.recovered.retentionPolicy,
      minimumComponentPixels: plan.recovered.minimumComponentPixels
    });
  }

  return {
    frames,
    canonicalPivot: { ...selectedConfig.pivot },
    scaleFactor,
    measurements
  };
}
