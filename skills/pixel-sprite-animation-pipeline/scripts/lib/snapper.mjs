import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

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

export function detectPixelSnapper(config) {
  const executable = process.env.PIXEL_SNAPPER_BIN || snapperConfig(config).executable;
  const probe = spawnSync(executable, ['--help'], { encoding: 'utf8', shell: false });
  return {
    available: !probe.error && probe.status === 0,
    executable,
    probeStatus: probe.status,
    error: probe.error?.message ?? null
  };
}

export async function writeSnapperHandoff({ inputs, outputDir, config }) {
  const executable = process.env.PIXEL_SNAPPER_BIN || snapperConfig(config).executable;
  await fs.mkdir(outputDir, { recursive: true });
  const expectedOutputs = inputs.map((input) => path.basename(outputFor(input, outputDir)));
  const handoffPath = path.join(outputDir, 'pixel-snapper-handoff.json');
  const resumeCommand = `pixel-sprite-pipeline normalize --frames ${outputDir}`;
  await fs.writeFile(handoffPath, JSON.stringify({
    version: 1,
    executable,
    sourceInputs: inputs,
    inputs,
    expectedOutputs,
    commandTemplate: [executable, '<INPUT>', '<OUTPUT>', '16', ...commandArguments('<INPUT>', '<OUTPUT>', config).slice(3)],
    resumeCommand
  }, null, 2));
  return { status: 'manual-handoff', executable, outputs: [], handoffPath };
}

export async function runPixelSnapper({ inputs, outputDir, config }) {
  const detection = detectPixelSnapper(config);
  if (!detection.available) return writeSnapperHandoff({ inputs, outputDir, config });

  await fs.mkdir(outputDir, { recursive: true });
  const outputs = [];
  for (const input of inputs) {
    const output = outputFor(input, outputDir);
    const result = spawnSync(detection.executable, commandArguments(input, output, config), {
      encoding: 'utf8',
      shell: false
    });
    if (result.status !== 0) {
      throw new Error(`Pixel Snapper failed for ${input}: ${result.stderr || result.error?.message || `exit status ${result.status}`}`);
    }
    outputs.push(output);
  }
  return { status: 'complete', executable: detection.executable, outputs, handoffPath: null };
}
