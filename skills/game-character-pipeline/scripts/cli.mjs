#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGenerationHandoff, importGeneratedCandidate, loadGenerationHandoff } from './lib/generated-still.mjs';
import { decodeAnimatedImage } from './lib/animated-image.mjs';
import { decodePngSequence } from './lib/png-sequence.mjs';
import { createProject, createRun, loadInitializedProject, loadRun } from './lib/run-contract.mjs';
import { decodeMotionSource, registerSourceAdapter } from './lib/source-adapter.mjs';
import { decodeVideo } from './lib/video.mjs';
import { startStudioServer } from './studio/server.mjs';

const commands = Object.freeze([
  ['render', 'Render a non-destructive edit revision'],
  ['approve', 'Approve or reject a rendered revision'],
  ['produce', 'Delegate approved frames to deterministic pixel production'],
  ['validate', 'Validate one complete character animation run'],
  ['audit', 'Compare reproducible run evidence']
]);

function unavailable(name) {
  return () => {
    throw new Error(`${name} command is not available in this package revision`);
  };
}

const program = new Command()
  .name('game-character-pipeline')
  .description('Auditable character animation workflow orchestration')
  .version('0.1.0')
  .showHelpAfterError();

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('duration must be an integer from 1 to 65535');
  return parsed;
}

registerSourceAdapter('png-sequence', ({ source, run }) => decodePngSequence({ manifest: source, run }));
registerSourceAdapter('generated-still', ({ source, run, options }) => importGeneratedCandidate({
  handoff: options.handoff,
  source,
  run,
  durationMs: options.durationMs
}));
for (const kind of ['gif', 'apng', 'webp']) {
  registerSourceAdapter(kind, ({ source, run }) => decodeAnimatedImage({ source, run }));
}
for (const kind of ['mp4', 'webm']) {
  registerSourceAdapter(kind, ({ source, run, options }) => decodeVideo({ source, run, ffmpegPath: options.ffmpegPath }));
}

program
  .command('studio')
  .description('Open the local Frame Studio authoring surface')
  .requiredOption('--project-dir <directory>', 'project directory')
  .requiredOption('--run <id>', 'immutable run ID')
  .action(async (options) => {
    const studio = await startStudioServer({
      projectDir: path.resolve(options.projectDir),
      runId: options.run,
      stage: 'selection'
    });
    print({ status: 'ready', origin: studio.origin, runId: options.run });
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await studio.close();
  });

program
  .command('init')
  .description('Create a versioned character project from a validated brief')
  .requiredOption('--contract <file>', 'validated project contract')
  .requiredOption('--project-dir <directory>', 'project directory')
  .action(async (options) => {
    const result = await createProject({
      root: path.resolve(options.projectDir),
      contractFile: path.resolve(options.contract)
    });
    print({
      status: result.reused ? 'reused' : 'created',
      projectDir: result.root,
      projectSha256: result.sha256
    });
  });

program
  .command('intake')
  .description('Import or resume an immutable motion source')
  .requiredOption('--project-dir <directory>', 'project directory')
  .requiredOption('--action <id>', 'contracted action ID')
  .requiredOption('--kind <kind>', 'motion source kind')
  .option('--resume <run-id>', 'resume an immutable run')
  .option('--pose <id>', 'generated still pose ID')
  .option('--handoff <file>', 'canonical generation handoff')
  .option('--generated-image <file>', 'generated PNG returned by the environment')
  .option('--duration-ms <milliseconds>', 'explicit candidate duration', positiveInteger)
  .option('--source-manifest <file>', 'explicit PNG sequence manifest')
  .option('--source <file>', 'animated image or video source file')
  .option('--ffmpeg <file>', 'explicit FFmpeg executable')
  .action(async (options) => {
    const projectDir = path.resolve(options.projectDir);
    const project = await loadInitializedProject(projectDir);
    const run = options.resume
      ? await loadRun({ projectRoot: projectDir, id: options.resume })
      : await createRun({
        projectRoot: projectDir,
        project,
        sourceRequest: { actionId: options.action, kind: options.kind }
      });

    if (run.document.sourceRequest.actionId !== options.action || run.document.sourceRequest.kind !== options.kind) {
      throw new Error('resume arguments do not match the immutable run request');
    }

    if (options.kind === 'generated-still') {
      if (!options.pose) throw new Error('generated-still intake requires --pose');
      if (!options.generatedImage) {
        const handoff = await createGenerationHandoff({
          project,
          run,
          actionId: options.action,
          poseId: options.pose,
          cliPath: fileURLToPath(import.meta.url)
        });
        print({
          status: 'awaiting-generated-image',
          runId: run.id,
          handoff: { path: handoff.path, sha256: handoff.sha256 },
          next: handoff.next
        });
        process.exitCode = 2;
        return;
      }
      if (!options.handoff || !options.durationMs) throw new Error('generated-still resume requires handoff and explicit duration');
      const handoff = await loadGenerationHandoff({ file: options.handoff, run });
      const result = await decodeMotionSource({
        kind: 'generated-still',
        source: path.resolve(options.generatedImage),
        run,
        options: { handoff, durationMs: options.durationMs }
      });
      print({ status: 'intake-complete', runId: run.id, sourceSha256: result.sourceSha256, approval: result.approval });
      return;
    }

    if (options.kind === 'png-sequence' && options.sourceManifest) {
      const result = await decodeMotionSource({
        kind: 'png-sequence',
        source: path.resolve(options.sourceManifest),
        run,
        options: {}
      });
      print({ status: 'intake-complete', runId: run.id, sourceSha256: result.sourceSha256, approval: result.approval });
      return;
    }

    if (['gif', 'apng', 'webp'].includes(options.kind) && options.source) {
      const result = await decodeMotionSource({
        kind: options.kind,
        source: path.resolve(options.source),
        run,
        options: {}
      });
      print({ status: 'intake-complete', runId: run.id, sourceSha256: result.sourceSha256, approval: result.approval });
      return;
    }

    if (['mp4', 'webm'].includes(options.kind) && options.source) {
      const result = await decodeMotionSource({
        kind: options.kind,
        source: path.resolve(options.source),
        run,
        options: { ffmpegPath: options.ffmpeg ? path.resolve(options.ffmpeg) : undefined }
      });
      print({ status: 'intake-complete', runId: run.id, sourceSha256: result.sourceSha256, approval: result.approval });
      return;
    }

    print({ status: options.resume ? 'resumed' : 'created', runId: run.id, state: run.document.state });
  });

for (const [name, description] of commands) {
  program.command(name).description(description).action(unavailable(name));
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error.exitCode === 2 && error.handoff) {
    print(error.handoff);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${JSON.stringify({ error: error.message, exitCode: 1 })}\n`);
    process.exitCode = 1;
  }
}
