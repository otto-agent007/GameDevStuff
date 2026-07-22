import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { validateAnimationContract } from './animation-contract.mjs';
import { extractPrimaryComponent, foregroundPredicate } from './components.mjs';
import { readRgba, sha256 } from './image.mjs';
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

const SHA256 = /^[a-f0-9]{64}$/;

function portableRelativePath(value, label) {
  if (typeof value !== 'string' || value === '' || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\\') || value === '.' || value === '..' || value.startsWith('../') || path.posix.normalize(value) !== value) throw new Error(`${label} must be a contained portable relative path`);
}

function namedCoordinates(values, expectedIds, label, canvas) {
  if (!Array.isArray(values) || values.length !== expectedIds.length) throw new Error(`v2 normalization ${label} must cover every contracted name in order`);
  return Object.fromEntries(values.map((value, index) => {
    exact(value, ['id', 'x', 'y'], `v2 normalization ${label.slice(0, -1)}`);
    if (value.id !== expectedIds[index] || !Number.isInteger(value.x) || !Number.isInteger(value.y) || value.x < 0 || value.y < 0 || value.x >= canvas.width || value.y >= canvas.height) throw new Error(`v2 normalization ${label} contain an invalid or unknown name`);
    return [value.id, { x: value.x, y: value.y }];
  }));
}

function snapshotV2Request({ contract, frameApproval, outputDir }) {
  exact(contract, ['document', 'sha256'], 'v2 normalization animation contract');
  const document = structuredClone(contract.document);
  validateAnimationContract(document);
  if (document.version !== 2 || contract.sha256 !== stableHash(document)) throw new Error('v2 normalization animation contract binding is invalid');
  if (!frameApproval || typeof frameApproval !== 'object' || typeof frameApproval.path !== 'string' || !SHA256.test(frameApproval.sha256 ?? '')) throw new Error('v2 normalization requires one verified frame approval');
  const payload = structuredClone(frameApproval.document?.payload);
  if (!payload || payload.version !== 2 || payload.animationContractSha256 !== contract.sha256 || payload.selectionApprovalSha256 !== document.selectionApprovalSha256 || !SHA256.test(payload.snapReceiptSha256 ?? '') || !Array.isArray(payload.frames)) throw new Error('v2 normalization frame approval binding is invalid');
  const definitions = document.clips.flatMap((clip) => clip.frames.map((frame) => ({ ...frame, loopMode: clip.loopMode })));
  if (payload.frames.length !== definitions.length) throw new Error('v2 normalization requires exact semantic frame approval coverage');
  if (typeof outputDir !== 'string' || outputDir.trim() === '') throw new Error('v2 normalization outputDir is required');
  return { contract: { document, sha256: contract.sha256 }, frameApproval: { path: frameApproval.path, sha256: frameApproval.sha256, payload }, definitions, outputDir: path.resolve(outputDir) };
}

function translatedCoordinate(value, delta, canvas, label) {
  const translated = { x: value.x + delta.x, y: value.y + delta.y };
  if (translated.x < 0 || translated.y < 0 || translated.x >= canvas.width || translated.y >= canvas.height) throw new Error(`v2 normalization ${label} leaves the stable canvas`);
  return translated;
}

function translatedPixels(image, delta, canvas, { required, frameId, trackId }) {
  const data = Buffer.alloc(canvas.width * canvas.height * 4);
  let retained = 0;
  let clipped = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const sourceOffset = (y * image.width + x) * 4;
      if (image.data[sourceOffset + 3] === 0) continue;
      const targetX = x + delta.x;
      const targetY = y + delta.y;
      if (targetX < 0 || targetY < 0 || targetX >= canvas.width || targetY >= canvas.height) {
        clipped += 1;
        continue;
      }
      image.data.copy(data, (targetY * canvas.width + targetX) * 4, sourceOffset, sourceOffset + 4);
      retained += 1;
    }
  }
  if (retained === 0) throw new Error(`v2 normalization source frame ${frameId}/${trackId} has no visible pixels`);
  if (required && clipped > 0) throw new Error(`v2 normalization clipped required pixels for ${frameId}/${trackId}`);
  return { data, retained, clipped };
}

export async function normalizeContractFrames(args) {
  const selected = snapshotV2Request(args ?? {});
  const { document } = selected.contract;
  const canvas = document.canvas;
  const trackById = new Map(document.tracks.map((track) => [track.id, track]));
  const allowedColors = new Set(document.palette.rgba.map((color) => color.join(',')));
  const sourceRoot = await fs.realpath(path.dirname(selected.frameApproval.path));
  const plannedFrames = [];

  for (const [frameIndex, definition] of selected.definitions.entries()) {
    const approved = selected.frameApproval.payload.frames[frameIndex];
    if (!approved || approved.index !== frameIndex || approved.id !== definition.id || approved.semantic !== definition.semantic || approved.duration !== definition.duration || !Array.isArray(approved.outputs) || approved.outputs.length !== definition.tracks.length) throw new Error(`v2 normalization approval frame order is invalid at ${frameIndex}`);
    const root = approved.landmarks?.root;
    coordinate(root, 'v2 normalization approved root');
    if (root.x >= canvas.width || root.y >= canvas.height) throw new Error('v2 normalization approved root must be inside the source canvas');
    const delta = { x: canvas.pivot.x - root.x, y: canvas.pivot.y - root.y };
    const sockets = namedCoordinates(approved.landmarks?.sockets, definition.sockets, 'sockets', canvas);
    const contacts = namedCoordinates(approved.landmarks?.contacts, definition.contacts, 'contacts', canvas);
    if (!Number.isInteger(approved.landmarks?.baseline)) throw new Error('v2 normalization approved baseline must be an integer');
    const baseline = approved.landmarks.baseline + delta.y;
    if (baseline !== canvas.baseline) throw new Error(`v2 normalization baseline drift for frame ${definition.id}`);
    exact(approved.landmarks.groundTravel, ['x', 'y'], 'v2 normalization groundTravel');
    if (!same(approved.landmarks.groundTravel, definition.groundTravel)) throw new Error(`v2 normalization groundTravel drift for frame ${definition.id}`);
    const plannedTracks = [];
    for (const [trackIndex, trackId] of definition.tracks.entries()) {
      const track = trackById.get(trackId);
      const output = approved.outputs[trackIndex];
      if (!track || !output || output.index !== plannedFrames.reduce((count, frame) => count + frame.tracks.length, 0) + trackIndex || output.trackId !== trackId || !SHA256.test(output.sha256 ?? '')) throw new Error(`v2 normalization missing ordered track frame ${definition.id}/${trackId}`);
      portableRelativePath(output.path, 'v2 normalization approved output path');
      const source = path.resolve(sourceRoot, ...output.path.split('/'));
      const containment = path.relative(sourceRoot, source);
      if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error('v2 normalization approved output escaped its run directory');
      let current = sourceRoot;
      for (const segment of output.path.split('/')) {
        current = path.join(current, segment);
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('v2 normalization source frame path must not contain a symlink');
      }
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('v2 normalization source frame must be a regular single-link file');
      const physical = await fs.realpath(source);
      const physicalContainment = path.relative(sourceRoot, physical);
      if (physicalContainment === '..' || physicalContainment.startsWith(`..${path.sep}`) || path.isAbsolute(physicalContainment)) throw new Error('v2 normalization source frame escaped its run directory');
      const sourceSha256 = await sha256(source);
      if (sourceSha256 !== output.sha256) throw new Error(`v2 normalization source hash changed for ${definition.id}/${trackId}`);
      const image = await readRgba(source);
      if (image.width !== canvas.width || image.height !== canvas.height) throw new Error(`v2 normalization source canvas is unstable for ${definition.id}/${trackId}`);
      const colors = new Set();
      for (let offset = 0; offset < image.data.length; offset += 4) colors.add([...image.data.subarray(offset, offset + 4)].join(','));
      const drift = [...colors].filter((color) => !allowedColors.has(color));
      if (drift.length > 0) throw new Error(`v2 normalization source palette drift for ${definition.id}/${trackId}`);
      const translated = translatedPixels(image, delta, canvas, { required: track.required, frameId: definition.id, trackId });
      plannedTracks.push({ track, source, sourceSha256, translated });
    }
    const translatedSockets = Object.fromEntries(Object.entries(sockets).map(([id, value]) => [id, translatedCoordinate(value, delta, canvas, `socket ${id}`)]));
    const translatedContacts = Object.fromEntries(Object.entries(contacts).map(([id, value]) => [id, translatedCoordinate(value, delta, canvas, `contact ${id}`)]));
    for (const [id, value] of Object.entries(translatedContacts)) {
      const contact = document.contacts.find((item) => item.id === id);
      if (contact?.kind === 'planted-foot' && value.y !== canvas.baseline) throw new Error(`v2 normalization planted contact ${id} must land on the baseline`);
    }
    plannedFrames.push({ definition, tracks: plannedTracks, delta, sockets: translatedSockets, contacts: translatedContacts, baseline });
  }

  try {
    await fs.lstat(selected.outputDir);
    throw new Error(`v2 normalization output directory already exists: ${selected.outputDir}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(selected.outputDir);
  await fs.mkdir(parent, { recursive: true });
  const stage = await fs.mkdtemp(path.join(parent, '.sprite-normalize-v2-stage-'));
  try {
    const frames = [];
    for (const plan of plannedFrames) {
      const tracks = {};
      const layers = [];
      for (const item of plan.tracks) {
        const name = `${plan.definition.id}--${item.track.id}.png`;
        const file = path.join(stage, name);
        await sharp(item.translated.data, { raw: { width: canvas.width, height: canvas.height, channels: 4 } }).png().toFile(file);
        const normalizedSha256 = await sha256(file);
        tracks[item.track.id] = {
          kind: item.track.kind,
          attachTo: item.track.attachTo,
          sourcePath: item.source,
          sourceSha256: item.sourceSha256,
          path: file,
          normalizedSha256,
          retainedPixelCount: item.translated.retained,
          clippedPixelCount: item.translated.clipped
        };
        layers.push({ input: file });
      }
      const combinedPath = path.join(stage, `${plan.definition.id}.png`);
      await sharp({ create: { width: canvas.width, height: canvas.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toFile(combinedPath);
      frames.push({
        id: plan.definition.id,
        semantic: plan.definition.semantic,
        duration: plan.definition.duration,
        loopMode: plan.definition.loopMode,
        scale: document.scale.integer,
        root: { ...canvas.pivot },
        baseline: plan.baseline,
        sockets: plan.sockets,
        contacts: plan.contacts,
        groundTravel: { ...plan.definition.groundTravel },
        tracks,
        combined: { path: combinedPath, sha256: await sha256(combinedPath) }
      });
    }
    await fs.rename(stage, selected.outputDir);
    const rebase = (file) => path.join(selected.outputDir, path.basename(file));
    for (const frame of frames) {
      frame.combined.path = rebase(frame.combined.path);
      for (const track of Object.values(frame.tracks)) track.path = rebase(track.path);
    }
    return {
      version: 2,
      animationContractSha256: selected.contract.sha256,
      selectionApprovalSha256: document.selectionApprovalSha256,
      frameApprovalSha256: selected.frameApproval.sha256,
      snapReceiptSha256: selected.frameApproval.payload.snapReceiptSha256,
      frames
    };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}
