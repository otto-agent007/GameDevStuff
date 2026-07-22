import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { copyImmutable } from './artifacts.mjs';
import { decodePngArtifact } from './png-sequence.mjs';
import { sha256File } from './schema.mjs';

const execFile = promisify(execFileCallback);
const MAX_BUFFER = 8 * 1024 * 1024;
const TIMEOUT_MS = 60000;
const MAX_FRAMES = 10000;

export class MediaToolHandoffError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MediaToolHandoffError';
    this.exitCode = 2;
    this.handoff = {
      status: 'awaiting-media-tool',
      expectedName: 'ffmpeg',
      requirements: {
        selectionOrder: ['explicit --ffmpeg path', 'FFMPEG_BIN', 'first executable ffmpeg on PATH'],
        identity: ['absolute path', 'sha256', 'size', 'version'],
        bundledExecutable: false
      },
      ...details
    };
  }
}

async function executableIdentity(file) {
  const selected = path.resolve(file);
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('media tool must be a regular single-link file');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) throw new Error('media tool must be executable');
  return { path: selected, sha256: await sha256File(selected), size: stat.size };
}

async function execute(file, args) {
  try {
    return await execFile(file, args, {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
      windowsHide: true
    });
  } catch (error) {
    if (error.killed || error.signal === 'SIGTERM') throw new Error(`media tool timed out after ${TIMEOUT_MS} ms`);
    const detail = typeof error.stderr === 'string' && error.stderr.trim() ? error.stderr.trim() : error.message;
    throw new Error(`media tool failed: ${detail}`);
  }
}

async function verifyUnchanged(expected) {
  const current = await executableIdentity(expected.path);
  if (current.sha256 !== expected.sha256 || current.size !== expected.size) throw new Error('media tool identity changed during use');
}

export async function inspectMediaTool(file, expectedName) {
  if (typeof expectedName !== 'string' || expectedName === '') throw new Error('expected media tool name is required');
  const before = await executableIdentity(file);
  const result = await execute(before.path, ['-version']);
  await verifyUnchanged(before);
  const version = result.stdout.split(/\r?\n/, 1)[0]?.trim();
  if (!version || !version.toLowerCase().startsWith(`${expectedName.toLowerCase()} version`)) {
    throw new Error(`media tool did not identify as ${expectedName}`);
  }
  return { ...before, version };
}

async function pathCandidate(name) {
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.resolve(entry, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      await executableIdentity(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' && !/must be executable|regular single-link/.test(error.message)) throw error;
    }
  }
  return null;
}

async function selectFfmpeg(explicitPath) {
  const selected = explicitPath || process.env.FFMPEG_BIN || await pathCandidate('ffmpeg');
  if (!selected) throw new MediaToolHandoffError('FFmpeg is required to resume video intake');
  try {
    return await inspectMediaTool(selected, 'ffmpeg');
  } catch (error) {
    if (error.code === 'ENOENT') throw new MediaToolHandoffError('selected FFmpeg executable does not exist', { rejectedPath: path.resolve(selected) });
    throw error;
  }
}

async function runBoundTool(identity, args) {
  await verifyUnchanged(identity);
  const result = await execute(identity.path, args);
  await verifyUnchanged(identity);
  return result;
}

function integerTime(value, timeBase, label) {
  if (!/^-?\d+$/.test(value)) throw new Error(`video ${label} presentation timestamp is missing or invalid`);
  const units = Number(value);
  const milliseconds = units * timeBase.numerator * 1000 / timeBase.denominator;
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`video ${label} cannot be represented in integer milliseconds`);
  return milliseconds;
}

export function parseFramehash(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const timeBaseLine = lines.find((line) => /^#tb\s+0:/.test(line));
  const match = timeBaseLine?.match(/^#tb\s+0:\s*(\d+)\/(\d+)$/);
  if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) throw new Error('video framehash stream time base is missing');
  const timeBase = { numerator: Number(match[1]), denominator: Number(match[2]) };
  const records = [];
  for (const line of lines.filter((candidate) => !candidate.startsWith('#'))) {
    const fields = line.split(',').map((field) => field.trim());
    if (fields.length < 6 || fields[0] !== '0') throw new Error('video framehash record is invalid');
    const timestampMs = integerTime(fields[2], timeBase, 'presentation');
    const durationMs = integerTime(fields[3], timeBase, 'duration');
    if (timestampMs < 0) throw new Error('video presentation timestamps must be nonnegative');
    if (durationMs < 1 || durationMs > 65535) throw new Error('video frame duration is invalid');
    if (records.length > 0 && timestampMs <= records.at(-1).timestampMs) {
      throw new Error('video presentation timestamps must be unique and ordered');
    }
    records.push({ timestampMs, durationMs });
    if (records.length > MAX_FRAMES) throw new Error(`video exceeds ${MAX_FRAMES} frames`);
  }
  if (records.length === 0) throw new Error('video framehash contains no frames');
  if (records[0].timestampMs !== 0) throw new Error('video presentation timestamps must start at zero');
  for (let index = 0; index < records.length - 1; index += 1) {
    if (records[index + 1].timestampMs - records[index].timestampMs !== records[index].durationMs) {
      throw new Error('video frame duration disagrees with presentation timestamps');
    }
  }
  return { timeBase, records };
}

async function extractionDirectory(run) {
  const directory = path.join(run.root, 'work', 'video-extract');
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('video extraction directory must be real');
  return directory;
}

async function validateExtractedFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('extracted video frame must be a regular single-link file');
}

export async function decodeVideo({ source, run, ffmpegPath }) {
  if (!source) throw new Error('video intake requires a source file');
  if (!['mp4', 'webm'].includes(run?.document?.sourceRequest?.kind)) throw new Error('video run kind must be mp4 or webm');
  const copied = await copyImmutable({ source: path.resolve(source), root: run.root, relative: 'source/video/original.bin' });
  let tool;
  try {
    tool = await selectFfmpeg(ffmpegPath);
  } catch (error) {
    if (error.exitCode === 2) {
      error.handoff = { ...error.handoff, runId: run.id, sourceSha256: copied.sha256 };
    }
    throw error;
  }
  const framehashArgs = ['-nostdin', '-v', 'error', '-i', copied.path, '-map', '0:v:0', '-f', 'framehash', '-hash', 'sha256', '-'];
  const framehashResult = await runBoundTool(tool, framehashArgs);
  if (framehashResult.stderr.trim()) throw new Error(`video framehash reported corruption: ${framehashResult.stderr.trim()}`);
  const timing = parseFramehash(framehashResult.stdout);

  const staging = await extractionDirectory(run);
  const pattern = path.join(staging, 'frame-%06d.png');
  const extractArgs = ['-nostdin', '-v', 'error', '-n', '-i', copied.path, '-map', '0:v:0', '-vsync', '0', '-pix_fmt', 'rgba', pattern];
  const expectedNames = timing.records.map((_, index) => `frame-${String(index + 1).padStart(6, '0')}.png`);
  const beforeNames = (await fs.readdir(staging)).sort();
  if (beforeNames.length === 0) {
    const extractionResult = await runBoundTool(tool, extractArgs);
    if (extractionResult.stderr.trim()) throw new Error(`video decode corruption: ${extractionResult.stderr.trim()}`);
  } else if (JSON.stringify(beforeNames) !== JSON.stringify(expectedNames)) {
    throw new Error('video extraction staging is partial or contains unknown files');
  }
  const actualNames = (await fs.readdir(staging)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error('video decoded output-count disagreement');

  const decoded = [];
  for (const [index, name] of expectedNames.entries()) {
    const selected = path.join(staging, name);
    await validateExtractedFile(selected);
    decoded.push(await decodePngArtifact({
      run,
      sourceRelative: path.relative(run.root, selected).replaceAll('\\', '/'),
      frameId: `video-frame-${String(index + 1).padStart(6, '0')}`,
      durationMs: timing.records[index].durationMs
    }));
  }
  const first = decoded[0];
  if (decoded.some(({ width, height }) => width !== first.width || height !== first.height)) {
    throw new Error('video frame dimensions changed during decode');
  }
  const diagnostics = [];
  const firstByHash = new Map();
  const frames = decoded.map((frame, index) => {
    const id = `video-frame-${String(index + 1).padStart(6, '0')}`;
    const duplicateOf = firstByHash.get(frame.rgbaSha256) ?? null;
    if (duplicateOf === null) firstByHash.set(frame.rgbaSha256, id);
    else diagnostics.push({ code: 'DUPLICATE_FRAME', frameId: id });
    if (frame.empty) diagnostics.push({ code: 'EMPTY_FRAME', frameId: id });
    return {
      index,
      id,
      path: frame.output.relative,
      sha256: frame.output.sha256,
      width: frame.width,
      height: frame.height,
      timestampMs: timing.records[index].timestampMs,
      durationMs: timing.records[index].durationMs,
      sourceRect: { x: 0, y: 0, width: frame.width, height: frame.height },
      duplicateOf
    };
  });
  const alpha = decoded.some(({ alpha: present }) => present);
  if (alpha) diagnostics.push({ code: 'ALPHA_PRESENT', frameId: null });
  if (new Set(timing.records.map(({ durationMs }) => durationMs)).size > 1) diagnostics.push({ code: 'VARIABLE_FRAME_RATE', frameId: null });
  return {
    kind: run.document.sourceRequest.kind,
    sourceSha256: copied.sha256,
    decoder: {
      name: 'external-ffmpeg-framehash-and-rgba',
      version: tool.version,
      arguments: [
        `tool=${JSON.stringify(tool)}`,
        `framehash=${JSON.stringify([tool.path, ...framehashArgs])}`,
        `extract=${JSON.stringify([tool.path, ...extractArgs])}`
      ]
    },
    canvas: { width: first.width, height: first.height },
    alpha,
    timeBase: timing.timeBase,
    frames,
    diagnostics,
    approval: null
  };
}
