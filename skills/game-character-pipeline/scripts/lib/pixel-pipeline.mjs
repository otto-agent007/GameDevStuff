import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

import { loadEditRevision, loadSourceReport, requireProductionApproval, verifyApproval } from './approval.mjs';

const HASH = /^[a-f0-9]{64}$/;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const FORWARDED_EXITS = new Set([0, 2, 3, 4]);

async function verifySelection({ run, project, selectionApproval }) {
  const source = await loadSourceReport(run);
  const revision = await loadEditRevision({ run, sourceSha256: source.sha256, revision: selectionApproval.document?.editRevision });
  const verified = await verifyApproval({ run, file: selectionApproval.path, project, source: source.document, edit: revision.edit });
  requireProductionApproval(verified);
  return verified;
}

function spawnCaptured(executable, argv, options) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(executable, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    const capture = (name) => (chunk) => {
      sizes[name] += chunk.length;
      if (sizes[name] + sizes[name === 'stdout' ? 'stderr' : 'stdout'] > OUTPUT_LIMIT) {
        child.kill('SIGKILL');
        reject(new Error('pixel production output exceeded the 8 MiB limit'));
        return;
      }
      chunks[name].push(chunk);
    };
    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({
      exitCode: exitCode ?? 1,
      signal,
      stdout: Buffer.concat(chunks.stdout).toString('utf8'),
      stderr: Buffer.concat(chunks.stderr).toString('utf8')
    }));
  });
}

function parseResponse(result, expected) {
  if (!Number.isInteger(result?.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw new Error('pixel production process result is invalid');
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > OUTPUT_LIMIT) throw new Error('pixel production output exceeded the 8 MiB limit');
  let response;
  try { response = JSON.parse(result.stdout.trim()); }
  catch { throw new Error(`pixel production did not return exactly one JSON object${result.stderr ? `: ${result.stderr.trim()}` : ''}`); }
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('pixel production response must be one JSON object');
  if (!FORWARDED_EXITS.has(result.exitCode)) throw new Error(`pixel production failed with exit ${result.exitCode}${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  if (response.contract?.sha256 !== expected.contractSha256) throw new Error('pixel production contract binding mismatch');
  if (response.inputManifest?.sha256 !== expected.inputManifestSha256) throw new Error('pixel production input manifest binding mismatch');
  if (result.exitCode === 0 && (!response.receipt || !HASH.test(response.receipt.sha256 ?? '') || response.report?.passed !== true)) throw new Error('pixel production success response lacks authenticated passing outputs');
  if (result.exitCode === 4 && response.next?.kind !== 'post-snap-frame-approval') throw new Error('pixel production review response lacks the post-snap owner handoff');
  if ((result.exitCode === 2 || result.exitCode === 4) && (!response.next || !Array.isArray(response.next.argv) || typeof response.next.cwd !== 'string')) throw new Error('pixel production handoff must contain structured next.cwd and next.argv');
  return { ...response, exitCode: result.exitCode };
}

export async function runPixelProduction({
  run,
  project,
  selectionApproval,
  contract,
  pipelineCli,
  node = process.execPath,
  output,
  snapReceipt,
  frameApproval,
  spawn = spawnCaptured,
  verifySelectionApproval = verifySelection
}) {
  if (!run?.id || !run?.root || !project?.sha256 || !selectionApproval?.path || !HASH.test(selectionApproval.sha256 ?? '')) throw new Error('pixel production requires an immutable run, project, and selection approval');
  if (!contract?.path || !HASH.test(contract.sha256 ?? '') || !HASH.test(contract.inputs?.sha256 ?? '') || contract.document?.version !== 2 || contract.document.selectionApprovalSha256 !== selectionApproval.sha256) throw new Error('approval binding mismatch between the v2 contract and selected owner approval');
  if (typeof pipelineCli !== 'string' || pipelineCli === '' || typeof node !== 'string' || node === '' || typeof output !== 'string' || output === '') throw new Error('pixel production executable and output paths are required');
  const verified = await verifySelectionApproval({ run, project, selectionApproval });
  if (verified.sha256 !== selectionApproval.sha256 || verified.document?.runId !== run.id || verified.document?.projectSha256 !== project.sha256 || verified.document?.decision !== 'approved') throw new Error('approval binding mismatch after selection approval verification');
  const argv = [pipelineCli, 'produce-contract', '--contract', contract.path, '--project-dir', run.root, '--output', output];
  if (snapReceipt?.path) argv.push('--snap-receipt', snapReceipt.path);
  if (frameApproval?.path) argv.push('--frame-approval', frameApproval.path);
  const result = await spawn(node, argv, { cwd: path.resolve(run.root), shell: false });
  return parseResponse(result, { contractSha256: contract.sha256, inputManifestSha256: contract.inputs.sha256 });
}
