import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePixelSnapper } from './tool-identity.mjs';
import { verifyExistingSnapReceipt, writeSnapReceipt } from './snap-receipt.mjs';

function snapperConfig(config) {
  return {
    executable: config?.snapper?.executable ?? 'spritefusion-pixel-snapper',
    args: config?.snapper?.args ?? ['16']
  };
}

function commandArguments(input, output, config) {
  const options = (snapperConfig(config).args ?? []).filter((argument) => String(argument) !== '16');
  return [input, output, '16', ...options];
}

function outputFor(input, outputDir) {
  return path.join(outputDir, `${path.basename(input, path.extname(input))}-snapped.png`);
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

export async function writeSnapperHandoff({ inputs, outputDir, config, env = process.env }) {
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
    commandTemplate: [executable, '<INPUT>', '<OUTPUT>', '16', ...commandArguments('<INPUT>', '<OUTPUT>', config).slice(3)],
    resumeCommand
  }, null, 2));
  return { status: 'manual-handoff', executable, outputs: [], handoffPath };
}

export async function runPixelSnapper({ inputs, outputDir, config, identity = null, resolverOptions = {}, receipt = null }) {
  const detection = identity ? { available: true, executable: identity.physicalPath, identity } : await detectPixelSnapper(config, resolverOptions);
  if (!detection.available) return writeSnapperHandoff({ inputs, outputDir, config, env: resolverOptions.env ?? process.env });

  const argumentsForReceipt = commandArguments('<INPUT>', '<OUTPUT>', config).slice(2);
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
    const result = spawnSync(detection.identity.physicalPath, commandArguments(input, output, config), {
      encoding: 'utf8',
      shell: false
    });
    if (result.status !== 0) {
      throw new Error(`Pixel Snapper failed for ${input}: ${result.stderr || result.error?.message || `exit status ${result.status}`}`);
    }
    outputs.push(output);
  }
  const published = receipt ? await writeSnapReceipt({
    projectDir: receipt.projectDir, run: receipt.run, contract: receipt.contract, inputs, outputs,
    args: argumentsForReceipt, identity: detection.identity
  }) : null;
  return { status: 'complete', executable: detection.identity.path, identity: detection.identity, outputs, handoffPath: null, ...(published ? { receipt: { path: published.path, sha256: published.sha256, signature: published.document.signature } } : {}) };
}
