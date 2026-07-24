import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { resolvePixelSnapper } from './tool-identity.mjs';
import { verifyExistingSnapReceipt, writeAlignedSourceReceipt, writeSnapReceipt } from './snap-receipt.mjs';

function snapperConfig(config) {
  return {
    executable: config?.snapper?.executable ?? 'spritefusion-pixel-snapper',
    args: config?.snapper?.args ?? ['16']
  };
}

function commandArguments(input, output, config, paletteHex, pixelSize) {
  const options = (snapperConfig(config).args ?? []).filter((argument) => String(argument) !== '16');
  if (pixelSize !== undefined) {
    if (!Number.isInteger(pixelSize) || pixelSize < 1) throw new Error('contracted Pixel Snapper pixel size must be a positive integer');
    if (options.includes('--pixel-size')) throw new Error('contracted Pixel Snapper pixel size conflicts with configured arguments');
    options.push('--pixel-size', String(pixelSize));
  }
  if (paletteHex === undefined) return [input, output, '16', ...options];
  if (!Array.isArray(paletteHex) || paletteHex.length === 0 || paletteHex.length > 16 || paletteHex.some((color) => !/^[0-9a-fA-F]{6}$/.test(color))) throw new Error('contract palette must contain 1-16 six-digit hex colors');
  if (options.includes('--palette')) throw new Error('contract palette conflicts with configured Pixel Snapper palette arguments');
  return [input, output, '16', ...options, '--palette', paletteHex.join(',')];
}

function validateOutputCanvas(canvas) {
  if (canvas === undefined) return null;
  if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas) || Object.keys(canvas).sort().join(',') !== 'height,width' ||
    !Number.isInteger(canvas.width) || canvas.width < 1 || !Number.isInteger(canvas.height) || canvas.height < 1) {
    throw new Error('contracted Pixel Snapper output canvas must use positive integer width and height');
  }
  return { width: canvas.width, height: canvas.height };
}

async function canonicalizeOutputCanvas(file, canvas) {
  if (!canvas) return;
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Pixel Snapper output must be a regular single-link file');
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width === canvas.width && info.height === canvas.height) return;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if ((x >= canvas.width || y >= canvas.height) && data[(y * info.width + x) * info.channels + 3] !== 0) {
        throw new Error('Pixel Snapper output has opaque pixels outside the contracted canvas');
      }
    }
  }
  const cropWidth = Math.min(info.width, canvas.width);
  const cropHeight = Math.min(info.height, canvas.height);
  const stage = `${file}.canvas-${crypto.randomUUID()}.tmp.png`;
  try {
    await sharp(data, { raw: info })
      .extract({ left: 0, top: 0, width: cropWidth, height: cropHeight })
      .extend({
        top: 0,
        left: 0,
        right: canvas.width - cropWidth,
        bottom: canvas.height - cropHeight,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toFile(stage);
    await fs.rename(stage, file);
  } finally {
    await fs.rm(stage, { force: true });
  }
}

function outputFor(input, outputDir) {
  return path.join(outputDir, `${path.basename(input, path.extname(input))}-snapped.png`);
}

function alignedSourceContract(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'canvas,paletteRgba,paletteSha256,scale') throw new Error('aligned source contract schema is invalid');
  const canvas = validateOutputCanvas(value.canvas);
  if (!Number.isInteger(value.scale) || value.scale < 1) throw new Error('aligned source scale must be a positive integer');
  if (!Array.isArray(value.paletteRgba) || value.paletteRgba.length === 0 || value.paletteRgba.length > 16) throw new Error('aligned source palette is invalid');
  const paletteRgba = value.paletteRgba.map((color) => {
    if (!Array.isArray(color) || color.length !== 4 || color.some((component) => !Number.isInteger(component) || component < 0 || component > 255)) throw new Error('aligned source palette is invalid');
    return [...color];
  });
  if (new Set(paletteRgba.map((color) => color.join(','))).size !== paletteRgba.length) throw new Error('aligned source palette contains duplicate colors');
  const paletteSha256 = crypto.createHash('sha256').update(JSON.stringify(paletteRgba)).digest('hex');
  if (value.paletteSha256 !== paletteSha256) throw new Error('aligned source palette hash mismatch');
  return { scale: value.scale, canvas, paletteRgba, paletteSha256 };
}

async function alignedSourcePlans(inputs, outputDir, contract) {
  const allowed = new Set(contract.paletteRgba.map((color) => color.join(',')));
  const plans = [];
  for (const input of inputs) {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== contract.canvas.width * contract.scale || info.height !== contract.canvas.height * contract.scale || info.channels !== 4) return null;
    const collapsed = Buffer.alloc(contract.canvas.width * contract.canvas.height * 4);
    for (let y = 0; y < contract.canvas.height; y += 1) {
      for (let x = 0; x < contract.canvas.width; x += 1) {
        const sourceX = x * contract.scale;
        const sourceY = y * contract.scale;
        const sourceOffset = (sourceY * info.width + sourceX) * 4;
        const color = [...data.subarray(sourceOffset, sourceOffset + 4)];
        if (!allowed.has(color.join(','))) return null;
        for (let cellY = 0; cellY < contract.scale; cellY += 1) {
          for (let cellX = 0; cellX < contract.scale; cellX += 1) {
            const offset = ((sourceY + cellY) * info.width + sourceX + cellX) * 4;
            for (let channel = 0; channel < 4; channel += 1) if (data[offset + channel] !== color[channel]) return null;
          }
        }
        collapsed.set(color, (y * contract.canvas.width + x) * 4);
      }
    }
    plans.push({ input, output: outputFor(input, outputDir), data: collapsed });
  }
  return plans;
}

async function runAlignedSource({ inputs, outputDir, contract, receipt }) {
  if (!contract) return null;
  if (!receipt) throw new Error('aligned source production requires a signed receipt target');
  const derivation = { kind: 'integer-grid-collapse', scale: contract.scale, canvas: contract.canvas, paletteSha256: contract.paletteSha256 };
  const receiptFile = receipt.durableReceiptFile ?? path.join(outputDir, 'snap-receipt.json');
  const existing = await verifyExistingSnapReceipt({
    projectDir: receipt.projectDir,
    file: receiptFile,
    expectedRun: receipt.run,
    expectedContract: receipt.contract,
    expectedInputs: inputs,
    expectedDerivation: derivation
  });
  if (existing) return {
    status: 'complete',
    origin: 'verified-aligned-source',
    executable: null,
    identity: null,
    outputs: existing.document.payload.outputs.map((item) => path.resolve(path.dirname(receiptFile), item.path)),
    handoffPath: null,
    receipt: { path: receiptFile, sha256: existing.sha256, signature: existing.document.signature },
    recoveredExistingReceipt: true
  };
  const plans = await alignedSourcePlans(inputs, outputDir, contract);
  if (!plans) return null;
  try {
    await fs.mkdir(outputDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('aligned source output directory already exists without its signed receipt');
  }
  for (const plan of plans) {
    await sharp(plan.data, { raw: { width: contract.canvas.width, height: contract.canvas.height, channels: 4 } }).png().toFile(plan.output);
  }
  const published = await writeAlignedSourceReceipt({
    projectDir: receipt.projectDir,
    run: receipt.run,
    contract: receipt.contract,
    inputs,
    outputs: plans.map(({ output }) => output),
    derivation
  });
  return {
    status: 'complete',
    origin: 'verified-aligned-source',
    executable: null,
    identity: null,
    outputs: plans.map(({ output }) => output),
    handoffPath: null,
    receipt: { path: published.path, sha256: published.sha256, signature: published.document.signature }
  };
}

export async function detectPixelSnapper(config, options = {}) {
  const env = options.env ?? process.env;
  if (!options.manifest) return { available: false, executable: env.PIXEL_SNAPPER_BIN || snapperConfig(config).executable, probeStatus: null, error: 'pinned Pixel Snapper manifest is required', identity: null };
  const identity = await resolvePixelSnapper({
    projectDir: options.projectDir ?? process.cwd(),
    config,
    configProvenance: options.configProvenance,
    manifest: options.manifest,
    env,
    pathValue: options.pathValue
  });
  const pinned = identity !== null &&
    identity.pinnedReleaseTag === options.manifest.release.tag &&
    identity.upstreamCommit === options.manifest.upstream.commit;
  return {
    available: pinned,
    executable: identity?.physicalPath ?? (env.PIXEL_SNAPPER_BIN || snapperConfig(config).executable),
    probeStatus: identity ? 0 : null,
    error: identity && !pinned ? 'resolved Pixel Snapper binary is not pinned by the release manifest' : null,
    identity
  };
}

export async function writeSnapperHandoff({ inputs, outputDir, config, paletteHex, pixelSize, env = process.env }) {
  const executable = env.PIXEL_SNAPPER_BIN || snapperConfig(config).executable;
  await fs.mkdir(outputDir, { recursive: true });
  const expectedOutputs = inputs.map((input) => path.basename(outputFor(input, outputDir)));
  const handoffPath = path.join(outputDir, 'pixel-snapper-handoff.json');
  const resumeCommand = `pixel-sprite-pipeline normalize --frames ${outputDir}`;
  await fs.writeFile(handoffPath, JSON.stringify({
    version: 1,
    origin: 'manual-handoff',
    toolProvenanceVerified: false,
    binary: null,
    arguments: null,
    executable,
    sourceInputs: inputs,
    inputs,
    expectedOutputs,
    commandTemplate: [executable, '<INPUT>', '<OUTPUT>', ...commandArguments('<INPUT>', '<OUTPUT>', config, paletteHex, pixelSize).slice(2)],
    resumeCommand
  }, null, 2));
  return { status: 'manual-handoff', executable, outputs: [], handoffPath };
}

export async function runPixelSnapper({ inputs, outputDir, config, paletteHex, pixelSize, outputCanvas, alignedSource, identity = null, resolverOptions = {}, receipt = null }) {
  const contractedCanvas = validateOutputCanvas(outputCanvas);
  const aligned = await runAlignedSource({ inputs, outputDir, contract: alignedSourceContract(alignedSource), receipt });
  if (aligned) return aligned;
  const detection = identity ? { available: true, executable: identity.physicalPath, identity } : await detectPixelSnapper(config, resolverOptions);
  if (!detection.available) return writeSnapperHandoff({ inputs, outputDir, config, paletteHex, pixelSize, env: resolverOptions.env ?? process.env });

  const argumentsForReceipt = commandArguments('<INPUT>', '<OUTPUT>', config, paletteHex, pixelSize).slice(2);
  if (receipt) {
    const receiptOutputDir = receipt.run?.outputDir ?? receipt.run?.runDir;
    const receiptFile = receipt.durableReceiptFile ?? path.join(outputDir, 'snap-receipt.json');
    if (!receipt.durableReceiptFile && path.resolve(receiptOutputDir) !== path.resolve(outputDir)) throw new Error('snap receipt output directory must match Pixel Snapper output directory');
    const existing = await verifyExistingSnapReceipt({
      projectDir: receipt.projectDir, file: receiptFile, expectedRun: receipt.run,
      expectedContract: receipt.contract, expectedInputs: inputs, expectedArgs: argumentsForReceipt, expectedIdentity: detection.identity
    });
    if (existing) return { status: 'complete', executable: detection.identity.path, identity: detection.identity, outputs: existing.document.payload.outputs.map((item) => path.resolve(path.dirname(receiptFile), item.path)), handoffPath: null, receipt: { path: receiptFile, sha256: existing.sha256, signature: existing.document.signature }, recoveredExistingReceipt: true };
  }

  await fs.mkdir(outputDir, { recursive: true });
  const outputs = [];
  for (const input of inputs) {
    const output = outputFor(input, outputDir);
    const result = spawnSync(detection.identity.physicalPath, commandArguments(input, output, config, paletteHex, pixelSize), {
      encoding: 'utf8',
      shell: false
    });
    if (result.status !== 0) {
      throw new Error(`Pixel Snapper failed for ${input}: ${result.stderr || result.error?.message || `exit status ${result.status}`}`);
    }
    await canonicalizeOutputCanvas(output, contractedCanvas);
    outputs.push(output);
  }
  const published = receipt ? await writeSnapReceipt({
    projectDir: receipt.projectDir, run: receipt.run, contract: receipt.contract, inputs, outputs,
    args: argumentsForReceipt, identity: detection.identity
  }) : null;
  return { status: 'complete', executable: detection.identity.path, identity: detection.identity, outputs, handoffPath: null, ...(published ? { receipt: { path: published.path, sha256: published.sha256, signature: published.document.signature } } : {}) };
}
