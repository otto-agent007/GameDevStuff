import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSnapReceipt, writeManualHandoffReceipt, verifySnapReceipt } from '../scripts/lib/snap-receipt.mjs';
import { writeSignedState } from '../scripts/lib/state-auth.mjs';

async function fixture() {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-snap-receipt-'));
  const outputDir = path.join(projectDir, 'run');
  await fs.mkdir(path.join(projectDir, '.pixel-sprite-pipeline'), { recursive: true, mode: 0o700 });
  await fs.mkdir(outputDir);
  const input = path.join(projectDir, 'input.png');
  const output = path.join(outputDir, 'output.png');
  const handoff = path.join(outputDir, 'snapper-handoff.json');
  await Promise.all([
    fs.writeFile(input, 'source'), fs.writeFile(output, 'snapped'), fs.writeFile(handoff, '{"version":1}\n')
  ]);
  const run = { id: 'run-1', outputDir, manifestSha256: 'a'.repeat(64) };
  const contract = { sha256: 'b'.repeat(64) };
  const identity = { origin: 'managed-cache', physicalPath: '/verified/snapper', sha256: 'c'.repeat(64), size: 1, version: '1.2.3', helpSha256: 'd'.repeat(64), fixtureRgbaSha256: 'e'.repeat(64), pinnedReleaseTag: null, upstreamCommit: null };
  return { projectDir, outputDir, input, output, handoff, run, contract, identity };
}

test('verified receipt binds tool, contract, ordered inputs, arguments, and outputs', async () => {
  const value = await fixture();
  const receipt = await writeSnapReceipt({
    projectDir: value.projectDir, run: value.run, contract: value.contract,
    inputs: [value.input], outputs: [value.output], args: ['16', '--palette', 'fixed'], identity: value.identity
  });
  assert.equal(receipt.document.payload.toolProvenanceVerified, true);
  assert.deepEqual(receipt.document.payload.arguments, ['16', '--palette', 'fixed']);
  await verifySnapReceipt({ projectDir: value.projectDir, file: receipt.path, expectedRun: value.run, expectedContract: value.contract });
  await fs.appendFile(value.output, 'tamper');
  await assert.rejects(verifySnapReceipt({ projectDir: value.projectDir, file: receipt.path, expectedRun: value.run, expectedContract: value.contract }), /output hash mismatch/);
});

test('manual handoff is truthful and cannot claim binary identity', async () => {
  const value = await fixture();
  const snapped = path.join(value.outputDir, 'snapped');
  await fs.mkdir(snapped);
  const nestedOutput = path.join(snapped, 'output.png');
  await fs.rename(value.output, nestedOutput);
  const receipt = await writeManualHandoffReceipt({
    projectDir: value.projectDir, run: value.run, handoff: value.handoff, inputs: [value.input], outputs: [nestedOutput]
  });
  assert.equal(receipt.document.payload.origin, 'manual-handoff');
  assert.equal(receipt.document.payload.toolProvenanceVerified, false);
  assert.equal(receipt.document.payload.binary, null);
  assert.equal(receipt.document.payload.arguments, null);
  assert.equal(receipt.document.payload.outputs[0].path, 'snapped/output.png');
});

test('receipt output records are contained while external inputs remain hash-bound', async () => {
  const value = await fixture();
  const external = path.join(value.projectDir, 'external-output.png');
  await fs.writeFile(external, 'external-output');
  await assert.rejects(writeSnapReceipt({
    projectDir: value.projectDir, run: value.run, contract: value.contract, inputs: [value.input], outputs: [external], args: ['16'], identity: value.identity
  }), /output|contained|escape/i);

  const receipt = await writeSnapReceipt({ projectDir: value.projectDir, run: value.run, contract: value.contract, inputs: [value.input], outputs: [value.output], args: ['16'], identity: value.identity });
  const outside = path.join(value.projectDir, 'outside.png');
  await fs.copyFile(value.output, outside);
  const escaped = structuredClone(receipt.document.payload);
  escaped.outputs[0].path = '../outside.png';
  const file = path.join(value.outputDir, 'escaped-receipt.json');
  await writeSignedState({ projectDir: value.projectDir, file, domain: 'pixel-sprite-snap-receipt/v1', payload: escaped });
  await assert.rejects(verifySnapReceipt({ projectDir: value.projectDir, file, expectedRun: value.run, expectedContract: value.contract }), /output|contained|escape/i);
});

test('receipt schemas reject signed extra and malformed identity fields', async () => {
  const value = await fixture();
  const receipt = await writeSnapReceipt({ projectDir: value.projectDir, run: value.run, contract: value.contract, inputs: [value.input], outputs: [value.output], args: ['16'], identity: value.identity });
  const malformed = structuredClone(receipt.document.payload);
  malformed.binary.unexpected = true;
  const file = path.join(value.outputDir, 'malformed-receipt.json');
  await writeSignedState({ projectDir: value.projectDir, file, domain: 'pixel-sprite-snap-receipt/v1', payload: malformed });
  await assert.rejects(verifySnapReceipt({ projectDir: value.projectDir, file, expectedRun: value.run, expectedContract: value.contract }), /schema|identity|binary/i);

  const manual = await writeManualHandoffReceipt({ projectDir: value.projectDir, run: value.run, handoff: value.handoff, inputs: [value.input], outputs: [value.output] });
  const manualMalformed = structuredClone(manual.document.payload);
  manualMalformed.createdAt = 'not-a-date';
  const manualFile = path.join(value.outputDir, 'malformed-manual-receipt.json');
  await writeSignedState({ projectDir: value.projectDir, file: manualFile, domain: 'pixel-sprite-manual-handoff-receipt/v1', payload: manualMalformed });
  await assert.rejects(verifySnapReceipt({ projectDir: value.projectDir, file: manualFile, expectedRun: value.run }), /schema|date/i);
});

test('receipt pins use the manifest tag grammar and bind the abbreviated commit', async () => {
  const valid = await fixture();
  const upstreamCommit = 'abcdef0123456789abcdef0123456789abcdef01';
  const receipt = await writeSnapReceipt({
    projectDir: valid.projectDir, run: valid.run, contract: valid.contract, inputs: [valid.input], outputs: [valid.output], args: ['16'],
    identity: { ...valid.identity, pinnedReleaseTag: 'pixel-snapper-v1.2.3-rc.1-commit.abcdef0', upstreamCommit }
  });
  assert.equal(receipt.document.payload.binary.pinnedReleaseTag, 'pixel-snapper-v1.2.3-rc.1-commit.abcdef0');
  assert.equal(receipt.document.payload.binary.upstreamCommit, upstreamCommit);

  const build = await fixture();
  await writeSnapReceipt({ projectDir: build.projectDir, run: build.run, contract: build.contract, inputs: [build.input], outputs: [build.output], args: ['16'], identity: { ...build.identity, pinnedReleaseTag: 'pixel-snapper-v1.2.3+build.7-commit.abcdef0', upstreamCommit } });

  for (const [tag, commit] of [
    ['pixel-snapper-v1.2.3-commit.abcdef0', '1234567123456789abcdef0123456789abcdef01'],
    ['pixel-snapper-v1.2-commit.abcdef0', upstreamCommit],
    ['pixel-snapper-v1.2.3-commit.ABCDEF0', upstreamCommit],
    ['pixel-snapper-v1.2.3-commit.abcdef0', 'abcdef0']
  ]) {
    const value = await fixture();
    await assert.rejects(writeSnapReceipt({ projectDir: value.projectDir, run: value.run, contract: value.contract, inputs: [value.input], outputs: [value.output], args: ['16'], identity: { ...value.identity, pinnedReleaseTag: tag, upstreamCommit: commit } }), /pin|identity/i);
  }

  const unpinned = await fixture();
  const unpinnedReceipt = await writeSnapReceipt({ projectDir: unpinned.projectDir, run: unpinned.run, contract: unpinned.contract, inputs: [unpinned.input], outputs: [unpinned.output], args: ['16'], identity: unpinned.identity });
  assert.deepEqual([unpinnedReceipt.document.payload.binary.pinnedReleaseTag, unpinnedReceipt.document.payload.binary.upstreamCommit], [null, null]);
});
