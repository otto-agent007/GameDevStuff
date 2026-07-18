import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import tar from 'tar-stream';
import { gzipSync, zipSync } from 'fflate';
import sharp from 'sharp';
import {
  FIXTURE_HEIGHT, FIXTURE_INPUT_RGBA_SHA256, FIXTURE_OUTPUT_RGBA_SHA256, FIXTURE_PALETTE_SHA256, FIXTURE_WIDTH,
  REQUIRED_TARGETS, RUST_TARGETS, atomicDirectory, closed, commitValue, pixelSnapperFixtureRgba,
  hashFile, hashValue, parseCli, portableName, regularUnlinkedFile, safeInteger, stableJson, writeJson
} from './release-common.mjs';

const COMPONENT_NAMES = Object.freeze({
  licenseFile: 'LICENSE-Pixel-Snapper',
  noticesFile: 'THIRD-PARTY-NOTICES',
  sbomFile: 'pixel-snapper.spdx.json'
});

function validateIdentity({ target, rustTarget, upstream, build, fixture }) {
  if (!REQUIRED_TARGETS.includes(target)) throw new Error(`unsupported release target: ${target}`);
  if (rustTarget !== RUST_TARGETS[target]) throw new Error(`Rust target mismatch: ${target}`);
  closed(upstream, ['repository', 'tag', 'version', 'commit'], 'upstream identity');
  if (upstream.repository !== 'Hugo-Dz/spritefusion-pixel-snapper' || !/^v\d+\.\d+\.\d+$/.test(upstream.tag) || upstream.version !== upstream.tag.slice(1)) throw new Error('invalid upstream identity');
  commitValue(upstream.commit, 'upstream commit');
  closed(build, ['workflowCommit', 'rustVersion', 'cargoVersion', 'cargoLockSha256', 'cargoSbomVersion', 'cargoAboutVersion', 'binaryVersion', 'helpSha256'], 'build identity');
  commitValue(build.workflowCommit, 'workflow commit');
  if (build.rustVersion !== '1.88.0' || build.cargoSbomVersion !== '0.10.0' || build.cargoAboutVersion !== '0.8.4' || !/^cargo 1\.88\.0(?: \([^)]+\))?$/.test(build.cargoVersion) || build.binaryVersion !== `spritefusion-pixel-snapper ${upstream.version}`) throw new Error('locked toolchain identity mismatch');
  hashValue(build.helpSha256, 'binary help hash');
  hashValue(build.cargoLockSha256, 'Cargo.lock hash');
  closed(fixture, ['inputRgbaSha256', 'rgbaSha256', 'expectedRgbaSha256', 'width', 'height', 'paletteSha256'], 'fixture result');
  for (const key of ['inputRgbaSha256', 'rgbaSha256', 'expectedRgbaSha256', 'paletteSha256']) hashValue(fixture[key], `fixture ${key}`);
  safeInteger(fixture.width, 'fixture width'); safeInteger(fixture.height, 'fixture height');
  if (fixture.rgbaSha256 !== fixture.expectedRgbaSha256) throw new Error(`fixture RGBA hash mismatch: ${target}`);
  if (fixture.inputRgbaSha256 !== FIXTURE_INPUT_RGBA_SHA256 || fixture.rgbaSha256 !== FIXTURE_OUTPUT_RGBA_SHA256 || fixture.paletteSha256 !== FIXTURE_PALETTE_SHA256 || fixture.width !== FIXTURE_WIDTH || fixture.height !== FIXTURE_HEIGHT) throw new Error(`fixture approved identity mismatch: ${target}`);
}

const FIXTURE_RGBA = pixelSnapperFixtureRgba();

function nativeProbe(binaryFile, args) {
  const result = spawnSync(binaryFile, args, { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`native Pixel Snapper probe failed (${args.join(' ')}): ${result.stderr || result.error?.message || `exit status ${result.status}`}`);
  return result.stdout.trim();
}

export async function probeNativePixelSnapper({ binaryFile, upstreamVersion, expectedInputRgbaSha256, expectedRgbaSha256 }) {
  hashValue(expectedInputRgbaSha256, 'expected fixture input hash');
  if (expectedInputRgbaSha256 !== FIXTURE_INPUT_RGBA_SHA256 || expectedInputRgbaSha256 !== crypto.createHash('sha256').update(FIXTURE_RGBA).digest('hex')) throw new Error('fixture input hash mismatch');
  if (expectedRgbaSha256 !== FIXTURE_OUTPUT_RGBA_SHA256) throw new Error('fixture expected RGBA hash mismatch');
  hashValue(expectedRgbaSha256, 'expected fixture RGBA hash');
  await regularUnlinkedFile(binaryFile, 'native Pixel Snapper binary');
  const binaryVersion = nativeProbe(binaryFile, ['--version']);
  if (binaryVersion !== `spritefusion-pixel-snapper ${upstreamVersion}`) throw new Error('native Pixel Snapper version mismatch');
  const help = nativeProbe(binaryFile, ['--help']);
  if (!help.includes('USAGE:')) throw new Error('native Pixel Snapper help probe mismatch');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-snapper-release-probe-'));
  try {
    const input = path.join(directory, 'input.png');
    const output = path.join(directory, 'output.png');
    await sharp(FIXTURE_RGBA, { raw: { width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT, channels: 4 } }).png().toFile(input);
    nativeProbe(binaryFile, [input, output, '16']);
    const image = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const rgbaSha256 = crypto.createHash('sha256').update(image.data).digest('hex');
    if (rgbaSha256 !== expectedRgbaSha256) throw new Error('native fixture RGBA hash mismatch');
    const colors = new Set();
    for (let index = 0; index < image.data.length; index += 4) colors.add(image.data.subarray(index, index + 4).toString('hex'));
    const paletteBytes = Buffer.concat([...colors].sort().map((color) => Buffer.from(color, 'hex')));
    return { binaryVersion, helpSha256: crypto.createHash('sha256').update(help).digest('hex'), fixture: { inputRgbaSha256: expectedInputRgbaSha256, rgbaSha256, expectedRgbaSha256, width: image.info.width, height: image.info.height, paletteSha256: crypto.createHash('sha256').update(paletteBytes).digest('hex') } };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function tarBytes(entries) {
  const pack = tar.pack();
  const chunks = [];
  const complete = new Promise((resolve, reject) => { pack.on('data', (chunk) => chunks.push(chunk)); pack.on('end', resolve); pack.on('error', reject); });
  for (const entry of entries) {
    await new Promise((resolve, reject) => pack.entry({ name: entry.name, size: entry.bytes.length, mode: entry.mode, uid: 0, gid: 0, mtime: new Date(0), type: 'file' }, entry.bytes, (error) => error ? reject(error) : resolve()));
  }
  pack.finalize(); await complete;
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function zipBytes(entries) {
  const source = {};
  for (const entry of entries) source[entry.name] = [entry.bytes, { level: 9, mtime: new Date('1980-01-02T00:00:00Z'), attrs: entry.mode << 16 }];
  return zipSync(source, { level: 9 });
}

export async function packagePixelSnapper(options) {
  closed(options, ['target', 'rustTarget', 'outputDir', 'binaryFile', 'licenseFile', 'noticesFile', 'sbomFile', 'upstream', 'build', 'fixture'], 'package request');
  const { target, rustTarget, outputDir, binaryFile, licenseFile, noticesFile, sbomFile, upstream, build, fixture } = options;
  validateIdentity({ target, rustTarget, upstream, build, fixture });
  const sourceFiles = { binaryFile, licenseFile, noticesFile, sbomFile };
  for (const [key, file] of Object.entries(sourceFiles)) await regularUnlinkedFile(file, key);
  JSON.parse(await fs.readFile(sbomFile, 'utf8'));
  const executableName = target === 'windows-x64' ? 'spritefusion-pixel-snapper.exe' : 'spritefusion-pixel-snapper';
  if (path.basename(binaryFile).toLowerCase() !== executableName.toLowerCase()) throw new Error(`binary filename mismatch: ${target}`);
  const archiveFormat = target === 'windows-x64' ? 'zip' : 'tar.gz';
  const archiveName = `pixel-snapper-${target}.${archiveFormat === 'zip' ? 'zip' : 'tar.gz'}`;

  return atomicDirectory(outputDir, async (stage) => {
    const files = {};
    for (const [key, outputName] of Object.entries(COMPONENT_NAMES)) {
      const destination = path.join(stage, outputName);
      await fs.copyFile(sourceFiles[key], destination, fs.constants.COPYFILE_EXCL);
      files[key.replace('File', '')] = { name: outputName, sha256: await hashFile(destination), size: (await fs.stat(destination)).size };
    }
    const executableDestination = path.join(stage, executableName);
    await fs.copyFile(binaryFile, executableDestination, fs.constants.COPYFILE_EXCL);
    if (target !== 'windows-x64') await fs.chmod(executableDestination, 0o755);
    const executable = { name: executableName, sha256: await hashFile(executableDestination), size: (await fs.stat(executableDestination)).size };
    const embeddedMetadata = { schemaVersion: 1, target, rustTarget, executable, upstream, build, fixture: { inputRgbaSha256: fixture.inputRgbaSha256, rgbaSha256: fixture.rgbaSha256, width: fixture.width, height: fixture.height, paletteSha256: fixture.paletteSha256 }, files };
    const metadataName = 'target-metadata.json';
    const metadataFile = path.join(stage, metadataName);
    await writeJson(metadataFile, embeddedMetadata);
    files.metadata = { name: metadataName, sha256: await hashFile(metadataFile), size: (await fs.stat(metadataFile)).size };
    const orderedNames = [executableName, COMPONENT_NAMES.licenseFile, COMPONENT_NAMES.noticesFile, COMPONENT_NAMES.sbomFile, metadataName];
    const entries = await Promise.all(orderedNames.map(async (name) => ({ name, bytes: await fs.readFile(path.join(stage, name)), mode: name === executableName && target !== 'windows-x64' ? 0o755 : 0o644 })));
    const bytes = archiveFormat === 'zip' ? zipBytes(entries) : await tarBytes(entries);
    await fs.writeFile(path.join(stage, archiveName), bytes, { flag: 'wx', mode: 0o644 });
    const record = { schemaVersion: 1, target, rustTarget, archive: { name: archiveName, format: archiveFormat, sha256: await hashFile(path.join(stage, archiveName)), size: bytes.length }, executable, upstream, build, fixture: embeddedMetadata.fixture, files };
    await writeJson(path.join(stage, 'target-release-record.json'), record);
    return { record, archiveEntries: orderedNames };
  });
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const required = ['request', 'output-dir'];
  if (Object.keys(args).some((key) => !required.includes(key)) || required.some((key) => !args[key])) throw new Error('usage: package-pixel-snapper.mjs --request REQUEST.json --output-dir DIR');
  const request = JSON.parse(await fs.readFile(args.request, 'utf8'));
  closed(request, ['nativeProbe', 'target', 'rustTarget', 'binaryFile', 'licenseFile', 'noticesFile', 'sbomFile', 'upstream', 'build', 'fixture'], 'native package request');
  if (request.nativeProbe !== true) throw new Error('native package request must execute native probes');
  if (request.nativeProbe === true) {
    const probe = await probeNativePixelSnapper({ binaryFile: request.binaryFile, upstreamVersion: request.upstream?.version, expectedInputRgbaSha256: request.fixture?.inputRgbaSha256, expectedRgbaSha256: request.fixture?.expectedRgbaSha256 });
    request.build = { ...request.build, binaryVersion: probe.binaryVersion, helpSha256: probe.helpSha256 };
    request.fixture = probe.fixture;
    delete request.nativeProbe;
  }
  const result = await packagePixelSnapper({ ...request, outputDir: args['output-dir'] });
  process.stdout.write(stableJson(result.record));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
