import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectArchive, extractInspectedArchive } from '../lib/archive.mjs';
import { validateToolManifest } from '../lib/tool-manifest.mjs';
import {
  FIXTURE_HEIGHT, FIXTURE_INPUT_RGBA_SHA256, FIXTURE_OUTPUT_RGBA_SHA256, FIXTURE_PALETTE_SHA256, FIXTURE_WIDTH,
  RELEASE_TAG, REQUIRED_TARGETS, RUST_TARGETS, atomicDirectory, closed, commitValue,
  hashFile, hashValue, parseCli, portableName, regularUnlinkedFile, safeInteger, stableJson, writeJson
} from './release-common.mjs';

const RECORD_KEYS = ['schemaVersion', 'target', 'rustTarget', 'archive', 'executable', 'upstream', 'build', 'fixture', 'files'];
const FILE_KEYS = ['license', 'notices', 'sbom', 'metadata'];

function identity(value) { return JSON.stringify(value); }

function validateFile(value, expectedName, label) {
  closed(value, ['name', 'sha256', 'size'], label);
  if (value.name !== expectedName) throw new Error(`${label} filename mismatch`);
  hashValue(value.sha256, `${label} hash`); safeInteger(value.size, `${label} size`);
}

export function validateReleaseRecord(record) {
  closed(record, RECORD_KEYS, 'target release record');
  if (record.schemaVersion !== 1) throw new Error('unsupported target release record schema');
  if (!REQUIRED_TARGETS.includes(record.target)) throw new Error(`unexpected release target: ${record.target}`);
  if (record.rustTarget !== RUST_TARGETS[record.target]) throw new Error(`Rust target mismatch: ${record.target}`);
  closed(record.archive, ['name', 'format', 'sha256', 'size'], 'archive record');
  portableName(record.archive.name); hashValue(record.archive.sha256, 'archive hash'); safeInteger(record.archive.size, 'archive size');
  const expectedFormat = record.target === 'windows-x64' ? 'zip' : 'tar.gz';
  const expectedArchive = `pixel-snapper-${record.target}.${expectedFormat === 'zip' ? 'zip' : 'tar.gz'}`;
  if (record.archive.format !== expectedFormat || record.archive.name !== expectedArchive) throw new Error(`archive identity mismatch: ${record.target}`);
  closed(record.executable, ['name', 'sha256', 'size'], 'executable record');
  const expectedExecutable = record.target === 'windows-x64' ? 'spritefusion-pixel-snapper.exe' : 'spritefusion-pixel-snapper';
  if (record.executable.name !== expectedExecutable) throw new Error(`executable name mismatch: ${record.target}`);
  hashValue(record.executable.sha256, 'executable hash'); safeInteger(record.executable.size, 'executable size');
  closed(record.upstream, ['repository', 'tag', 'version', 'commit'], 'upstream identity');
  if (record.upstream.repository !== 'Hugo-Dz/spritefusion-pixel-snapper' || !/^v\d+\.\d+\.\d+$/.test(record.upstream.tag) || record.upstream.version !== record.upstream.tag.slice(1)) throw new Error('invalid upstream identity');
  commitValue(record.upstream.commit, 'upstream commit');
  closed(record.build, ['workflowCommit', 'rustVersion', 'cargoVersion', 'cargoLockSha256', 'cargoSbomVersion', 'cargoAboutVersion', 'binaryVersion', 'helpSha256'], 'build identity');
  commitValue(record.build.workflowCommit, 'workflow commit');
  if (record.build.rustVersion !== '1.88.0' || record.build.cargoSbomVersion !== '0.10.0' || record.build.cargoAboutVersion !== '0.8.4' || !/^cargo 1\.88\.0(?: \([^)]+\))?$/.test(record.build.cargoVersion) || record.build.binaryVersion !== `spritefusion-pixel-snapper ${record.upstream.version}`) throw new Error('invalid locked toolchain identity');
  hashValue(record.build.helpSha256, 'binary help hash');
  hashValue(record.build.cargoLockSha256, 'Cargo.lock hash');
  closed(record.fixture, ['inputRgbaSha256', 'rgbaSha256', 'width', 'height', 'paletteSha256'], 'fixture identity');
  for (const key of ['inputRgbaSha256', 'rgbaSha256', 'paletteSha256']) hashValue(record.fixture[key], `fixture ${key}`);
  safeInteger(record.fixture.width, 'fixture width'); safeInteger(record.fixture.height, 'fixture height');
  if (record.fixture.inputRgbaSha256 !== FIXTURE_INPUT_RGBA_SHA256 || record.fixture.rgbaSha256 !== FIXTURE_OUTPUT_RGBA_SHA256 || record.fixture.paletteSha256 !== FIXTURE_PALETTE_SHA256 || record.fixture.width !== FIXTURE_WIDTH || record.fixture.height !== FIXTURE_HEIGHT) throw new Error(`fixture approved identity mismatch: ${record.target}`);
  closed(record.files, FILE_KEYS, 'packaged files');
  validateFile(record.files.license, 'LICENSE-Pixel-Snapper', 'license');
  validateFile(record.files.notices, 'THIRD-PARTY-NOTICES', 'notices');
  validateFile(record.files.sbom, 'pixel-snapper.spdx.json', 'SBOM');
  validateFile(record.files.metadata, 'target-metadata.json', 'target metadata');
  return record;
}

export async function inspectReleaseArchive({ record: inputRecord, archiveBytes }) {
  const record = validateReleaseRecord(structuredClone(inputRecord));
  const extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-snapper-release-inspect-'));
  try {
    await fs.chmod(extractionRoot, 0o700);
    const expectedFiles = [record.executable.name, record.files.license.name, record.files.notices.name, record.files.sbom.name, record.files.metadata.name];
    const inspection = inspectArchive({ bytes: archiveBytes, format: record.archive.format, expectedFiles });
    const extracted = path.join(extractionRoot, 'contents');
    await extractInspectedArchive({ inspection, outputDir: extracted });
    for (const [name, descriptor] of [
      [record.executable.name, record.executable], [record.files.license.name, record.files.license],
      [record.files.notices.name, record.files.notices], [record.files.sbom.name, record.files.sbom], [record.files.metadata.name, record.files.metadata]
    ]) {
      const file = path.join(extracted, name);
      const stat = await regularUnlinkedFile(file, `archived ${name}`);
      if (stat.size !== descriptor.size || await hashFile(file) !== descriptor.sha256) throw new Error(`archived file hash or size mismatch: ${record.target}/${name}`);
    }
    const expectedMetadata = { schemaVersion: 1, target: record.target, rustTarget: record.rustTarget, executable: record.executable, upstream: record.upstream, build: record.build, fixture: record.fixture, files: { license: record.files.license, notices: record.files.notices, sbom: record.files.sbom } };
    const embedded = JSON.parse(await fs.readFile(path.join(extracted, record.files.metadata.name), 'utf8'));
    if (stableJson(embedded) !== stableJson(expectedMetadata)) throw new Error(`embedded target metadata mismatch: ${record.target}`);
    return { record, embeddedMetadata: embedded };
  } finally { await fs.rm(extractionRoot, { recursive: true, force: true }); }
}

async function loadArtifactDirectory(directory) {
  const recordFile = path.join(directory, 'target-release-record.json');
  await regularUnlinkedFile(recordFile, 'target release record');
  const record = validateReleaseRecord(JSON.parse(await fs.readFile(recordFile, 'utf8')));
  const expected = [record.archive.name, record.executable.name, record.files.license.name, record.files.notices.name, record.files.sbom.name, record.files.metadata.name, 'target-release-record.json'].sort();
  const actual = (await fs.readdir(directory)).sort();
  if (identity(actual) !== identity(expected)) throw new Error(`unexpected build artifact file set: ${record.target}`);
  for (const [name, descriptor] of [
    [record.archive.name, record.archive], [record.executable.name, record.executable],
    [record.files.license.name, record.files.license], [record.files.notices.name, record.files.notices],
    [record.files.sbom.name, record.files.sbom], [record.files.metadata.name, record.files.metadata]
  ]) {
    const file = path.join(directory, name);
    const stat = await regularUnlinkedFile(file, name);
    if (stat.size !== descriptor.size || await hashFile(file) !== descriptor.sha256) throw new Error(`build artifact hash or size mismatch: ${record.target}/${name}`);
  }
  await inspectReleaseArchive({ record, archiveBytes: await fs.readFile(path.join(directory, record.archive.name)) });
  return { record, directory };
}

async function loadInputDirectory(inputDir) {
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink() || !entry.isDirectory())) throw new Error('release input must contain only target artifact directories');
  return Promise.all(entries.map((entry) => loadArtifactDirectory(path.join(inputDir, entry.name))));
}

function compareRecords(records) {
  const first = records[0];
  for (const record of records.slice(1)) {
    if (identity(record.upstream) !== identity(first.upstream)) throw new Error(`upstream identity mismatch: ${record.target}`);
    if (record.build.workflowCommit !== first.build.workflowCommit) throw new Error(`workflow identity mismatch: ${record.target}`);
    if (record.build.cargoLockSha256 !== first.build.cargoLockSha256) throw new Error(`lockfile identity mismatch: ${record.target}`);
    const tools = ({ rustVersion, cargoVersion, cargoSbomVersion, cargoAboutVersion, binaryVersion }) => ({ rustVersion, cargoVersion, cargoSbomVersion, cargoAboutVersion, binaryVersion });
    if (identity(tools(record.build)) !== identity(tools(first.build))) throw new Error(`toolchain identity mismatch: ${record.target}`);
    if (record.fixture.inputRgbaSha256 !== first.fixture.inputRgbaSha256) throw new Error(`fixture input hash mismatch: ${record.target}`);
    if (record.fixture.rgbaSha256 !== first.fixture.rgbaSha256) throw new Error(`fixture RGBA hash mismatch: ${record.target}`);
    if (identity(record.fixture) !== identity(first.fixture)) throw new Error(`fixture identity mismatch: ${record.target}`);
    if (record.files.license.sha256 !== first.files.license.sha256 || record.files.license.size !== first.files.license.size) throw new Error(`upstream license mismatch: ${record.target}`);
    if (record.files.notices.sha256 !== first.files.notices.sha256 || record.files.notices.size !== first.files.notices.size) throw new Error(`third-party notices mismatch: ${record.target}`);
    if (record.files.sbom.sha256 !== first.files.sbom.sha256 || record.files.sbom.size !== first.files.sbom.size) throw new Error(`SBOM mismatch: ${record.target}`);
  }
}

function validateReleaseTag(releaseTag, upstream) {
  const match = RELEASE_TAG.exec(releaseTag ?? '');
  if (!match) throw new Error('invalid release tag');
  if (match[1] !== upstream.version || match[2] !== upstream.commit.slice(0, 7)) throw new Error('release tag commit suffix or version mismatch');
}

function createResult(records, releaseTag) {
  const first = records[0];
  validateReleaseTag(releaseTag, first.upstream);
  const releaseUrl = `https://github.com/otto-agent007/GameDevStuff/releases/tag/${releaseTag}`;
  const manifest = validateToolManifest({
    schemaVersion: 1,
    release: { tag: releaseTag, url: releaseUrl },
    upstream: { repository: first.upstream.repository, version: first.upstream.version, commit: first.upstream.commit },
    build: { rustVersion: first.build.rustVersion, cargoLockSha256: first.build.cargoLockSha256, workflowCommit: first.build.workflowCommit },
    fixture: { inputRgbaSha256: first.fixture.inputRgbaSha256, rgbaSha256: first.fixture.rgbaSha256 },
    assets: Object.fromEntries(records.map((record) => [record.target, {
      url: `https://github.com/otto-agent007/GameDevStuff/releases/download/${releaseTag}/${record.archive.name}`,
      archiveName: record.archive.name, archiveFormat: record.archive.format, archiveSize: record.archive.size, archiveSha256: record.archive.sha256,
      executable: record.executable.name, executableSize: record.executable.size, executableSha256: record.executable.sha256
    }]))
  });
  const metadata = { schemaVersion: 1, releaseTag, releaseUrl, targets: records };
  return { manifest, metadata };
}

export async function assembleRelease({ inputs, inputDir, outputDir, releaseTag, expectedUpstreamCommit, expectedWorkflowCommit }) {
  if ((inputs === undefined) === (inputDir === undefined)) throw new Error('provide exactly one release input source');
  const loaded = inputDir ? await loadInputDirectory(inputDir) : inputs.map((record) => ({ record: validateReleaseRecord(structuredClone(record)), directory: null }));
  const byTarget = new Map();
  for (const item of loaded) {
    if (byTarget.has(item.record.target)) throw new Error(`duplicate release target: ${item.record.target}`);
    byTarget.set(item.record.target, item);
  }
  for (const target of REQUIRED_TARGETS) if (!byTarget.has(target)) throw new Error(`missing release target: ${target}`);
  if (byTarget.size !== REQUIRED_TARGETS.length) throw new Error('unexpected release target');
  const ordered = REQUIRED_TARGETS.map((target) => byTarget.get(target));
  const records = ordered.map(({ record }) => record);
  compareRecords(records);
  if (expectedUpstreamCommit !== undefined) {
    commitValue(expectedUpstreamCommit, 'expected upstream commit');
    if (records[0].upstream.commit !== expectedUpstreamCommit) throw new Error('upstream commit does not match workflow input');
  }
  if (expectedWorkflowCommit !== undefined) {
    commitValue(expectedWorkflowCommit, 'expected workflow commit');
    if (records[0].build.workflowCommit !== expectedWorkflowCommit) throw new Error('workflow commit does not match running workflow');
  }
  const seenNames = new Set();
  for (const record of records) {
    const folded = portableName(record.archive.name).normalize('NFC').toLowerCase();
    if (seenNames.has(folded)) throw new Error(`portable asset name collision: ${record.archive.name}`);
    seenNames.add(folded);
  }
  const effectiveReleaseTag = releaseTag ?? `pixel-snapper-v${records[0].upstream.version}-commit.${records[0].upstream.commit.slice(0, 7)}`;
  const result = createResult(records, effectiveReleaseTag);
  if (!outputDir) return result;
  if (!inputDir) throw new Error('release output requires filesystem input artifacts');
  return atomicDirectory(outputDir, async (stage) => {
    for (const item of ordered) await fs.copyFile(path.join(item.directory, item.record.archive.name), path.join(stage, item.record.archive.name), fs.constants.COPYFILE_EXCL);
    const first = ordered[0];
    for (const descriptor of [first.record.files.license, first.record.files.notices, first.record.files.sbom]) await fs.copyFile(path.join(first.directory, descriptor.name), path.join(stage, descriptor.name), fs.constants.COPYFILE_EXCL);
    const metadataName = 'build-metadata.json';
    const manifestName = 'pixel-snapper-tool-manifest.json';
    await writeJson(path.join(stage, metadataName), result.metadata);
    await writeJson(path.join(stage, manifestName), result.manifest);
    const releaseAssets = [...records.map((record) => record.archive.name), 'LICENSE-Pixel-Snapper', 'THIRD-PARTY-NOTICES', 'pixel-snapper.spdx.json', metadataName, manifestName];
    const checksums = { schemaVersion: 1, releaseTag: effectiveReleaseTag, assets: [] };
    for (const name of releaseAssets) {
      const file = path.join(stage, name);
      checksums.assets.push({ name, sha256: await hashFile(file), size: (await fs.stat(file)).size });
    }
    await writeJson(path.join(stage, 'checksums.json'), checksums);
    return { ...result, checksums };
  });
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const allowed = ['input-dir', 'output-dir', 'release-tag', 'upstream-commit', 'workflow-commit'];
  if (Object.keys(args).some((key) => !allowed.includes(key)) || allowed.some((key) => !args[key])) throw new Error('usage: assemble-release.mjs --input-dir DIR --output-dir DIR --release-tag TAG');
  const result = await assembleRelease({ inputDir: args['input-dir'], outputDir: args['output-dir'], releaseTag: args['release-tag'], expectedUpstreamCommit: args['upstream-commit'], expectedWorkflowCommit: args['workflow-commit'] });
  process.stdout.write(stableJson({ releaseTag: result.manifest.release.tag, assets: result.checksums.assets.length }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
