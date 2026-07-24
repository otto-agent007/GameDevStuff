import assert from 'node:assert/strict';
import test from 'node:test';

import { runPixelProduction } from '../scripts/lib/pixel-pipeline.mjs';

const HASH = (letter) => letter.repeat(64);

function fixture(overrides = {}) {
  const calls = [];
  const spawn = async (executable, argv, options) => {
    calls.push({ executable, argv, options });
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ status: 'complete', contract: { sha256: HASH('5') }, inputManifest: { sha256: HASH('6') }, receipt: { path: '/run/snap-receipt.json', sha256: HASH('8') }, exports: { metadata: '/out/animation-contract-export.json' }, report: { passed: true, failures: [] } })}\n`,
      stderr: ''
    };
  };
  const selectionApproval = {
    path: '/project/run/approved/selection-approval-0001.json', sha256: HASH('3'),
    document: { runId: 'run-1', projectSha256: HASH('2'), decision: 'approved', selectedFrames: [{ frameId: 'walk-1', derivativeSha256: HASH('4') }] }
  };
  return {
    run: { id: 'run-1', root: '/project/run', sha256: HASH('1') },
    project: { root: '/project', sha256: HASH('2') },
    selectionApproval,
    pipelineCli: '/repo/pixel/scripts/cli.mjs',
    node: '/usr/bin/node',
    contract: { path: '/project/run/work/animation-contract-v2.json', sha256: HASH('5'), inputs: { sha256: HASH('6') }, document: { version: 2, selectionApprovalSha256: selectionApproval.sha256 } },
    output: '/project/run/work/pixel-production',
    spawn,
    verifySelectionApproval: async () => selectionApproval,
    calls,
    ...overrides
  };
}

test('production uses argv without a shell and returns authenticated outputs', async () => {
  const value = fixture();
  const result = await runPixelProduction(value);
  assert.equal(value.calls.length, 1);
  assert.equal(value.calls[0].options.shell, false);
  assert.deepEqual(value.calls[0].argv.slice(0, 2), [value.pipelineCli, 'produce-contract']);
  const snapperProjectDir = value.calls[0].argv.indexOf('--snapper-project-dir');
  assert.notEqual(snapperProjectDir, -1);
  assert.equal(value.calls[0].argv[snapperProjectDir + 1], value.project.root);
  assert.equal(value.calls[0].executable, value.node);
  assert.match(result.receipt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.exitCode, 0);
});

test('first production pass stops for post-snap owner approval', async () => {
  const value = fixture({
    spawn: async (executable, argv, options) => {
      value.calls.push({ executable, argv, options });
      return {
        exitCode: 4,
        stdout: `${JSON.stringify({ status: 'awaiting-frame-approval', contract: { sha256: HASH('5') }, inputManifest: { sha256: HASH('6') }, receipt: { path: '/run/snap-receipt.json', sha256: HASH('8') }, next: { kind: 'post-snap-frame-approval', cwd: '/project/run', argv: ['/usr/bin/node', '/repo/studio.mjs', 'studio', '--stage', 'post-snap'] } })}\n`,
        stderr: ''
      };
    }
  });
  const result = await runPixelProduction(value);
  assert.equal(result.exitCode, 4);
  assert.equal(result.next.kind, 'post-snap-frame-approval');
});

test('production rejects approval or membership changes before spawning', async () => {
  const value = fixture({ verifySelectionApproval: async () => { throw new Error('approval binding mismatch: selected frame membership changed'); } });
  await assert.rejects(runPixelProduction(value), /approval binding mismatch/);
  assert.equal(value.calls.length, 0);
});

test('production rejects a child response built from changed contract inputs', async () => {
  const value = fixture({
    spawn: async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({ status: 'complete', contract: { sha256: HASH('5') }, inputManifest: { sha256: HASH('9') }, receipt: { sha256: HASH('8') }, exports: {}, report: { passed: true } })}\n`,
      stderr: ''
    })
  });
  await assert.rejects(runPixelProduction(value), /input manifest binding mismatch/);
});
