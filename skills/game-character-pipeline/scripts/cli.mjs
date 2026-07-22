#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadEditRevision,
  loadSourceReport,
  renderReviewRevision,
  requireProductionApproval,
  verifyApproval,
  writeApproval
} from './lib/approval.mjs';
import { auditRun, compareRuns, loadAuditExpected, recordAuditReport, recordProductionValidation } from './lib/audit.mjs';
import { createGenerationHandoff, importGeneratedCandidate, loadGenerationHandoff } from './lib/generated-still.mjs';
import { decodeAnimatedImage } from './lib/animated-image.mjs';
import { createPixelProductionContract, publishExportRevision } from './lib/export-contract.mjs';
import { runPixelProduction } from './lib/pixel-pipeline.mjs';
import { decodePngSequence } from './lib/png-sequence.mjs';
import { createProject, createRun, loadInitializedProject, loadRun } from './lib/run-contract.mjs';
import { decodeMotionSource, registerSourceAdapter } from './lib/source-adapter.mjs';
import { decodeVideo } from './lib/video.mjs';
import { startStudioServer } from './studio/server.mjs';

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

function revisionInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 999999) throw new Error('revision must be an integer from 1 to 999999');
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

program
  .command('render')
  .description('Render a non-destructive edit revision')
  .requiredOption('--project-dir <directory>', 'project directory')
  .requiredOption('--run <id>', 'immutable run ID')
  .requiredOption('--edit <revision>', 'immutable edit revision', revisionInteger)
  .option('--allow-global-transform', 'confirm one integer transform for the entire clip', false)
  .action(async (options) => {
    const projectDir = path.resolve(options.projectDir);
    const project = await loadInitializedProject(projectDir);
    const run = await loadRun({ projectRoot: projectDir, id: options.run });
    const rendered = await renderReviewRevision({
      run,
      project,
      editRevision: options.edit,
      allowGlobalTransform: options.allowGlobalTransform
    });
    print({
      status: 'rendered',
      runId: run.id,
      editRevision: options.edit,
      editSha256: rendered.editSha256,
      renderSha256: rendered.sha256,
      contactSheetSha256: rendered.contactSheet.sha256
    });
  });

program
  .command('approve')
  .description('Approve or reject a rendered revision')
  .requiredOption('--project-dir <directory>', 'project directory')
  .requiredOption('--run <id>', 'immutable run ID')
  .requiredOption('--edit <revision>', 'immutable edit revision', revisionInteger)
  .requiredOption('--approver <id>', 'configured approval identity')
  .requiredOption('--decision <decision>', 'approved or rejected')
  .requiredOption('--notes <text>', 'owner review notes')
  .option('--allow-global-transform', 'confirm one integer transform for the entire clip', false)
  .action(async (options) => {
    const projectDir = path.resolve(options.projectDir);
    const project = await loadInitializedProject(projectDir);
    const run = await loadRun({ projectRoot: projectDir, id: options.run });
    const source = await loadSourceReport(run);
    const revision = await loadEditRevision({ run, sourceSha256: source.sha256, revision: options.edit });
    const approval = await writeApproval({
      run,
      project,
      editRevision: options.edit,
      approver: options.approver,
      decision: options.decision,
      notes: options.notes,
      allowGlobalTransform: options.allowGlobalTransform
    });
    const verified = await verifyApproval({ run, file: approval.path, project, source: source.document, edit: revision.edit });
    print({
      status: verified.document.decision,
      runId: run.id,
      editRevision: options.edit,
      approvalRevision: approval.revision,
      approvalSha256: approval.sha256
    });
    if (verified.document.decision === 'rejected') {
      process.exitCode = 4;
      return;
    }
    requireProductionApproval(verified);
  });

program
  .command('produce')
  .description('Delegate approved frames to deterministic pixel production')
  .requiredOption('--project-dir <directory>', 'project directory')
  .requiredOption('--run <id>', 'immutable run ID')
  .requiredOption('--approval <file>', 'verified selection approval')
  .option('--snap-receipt <file>', 'signed Pixel Snapper receipt')
  .option('--frame-approval <file>', 'signed post-snap frame approval')
  .option('--output <directory>', 'new or resumable pixel-production directory')
  .action(async (options) => {
    const projectDir = path.resolve(options.projectDir);
    const project = await loadInitializedProject(projectDir);
    const run = await loadRun({ projectRoot: projectDir, id: options.run });
    const source = await loadSourceReport(run);
    const approvalFile = path.resolve(options.approval);
    const approvalEnvelope = JSON.parse(await fs.readFile(approvalFile, 'utf8'));
    if (!Number.isInteger(approvalEnvelope.editRevision) || approvalEnvelope.editRevision < 1 || approvalEnvelope.editRevision > 999999) throw new Error('selection approval edit revision is invalid');
    const revision = await loadEditRevision({ run, sourceSha256: source.sha256, revision: approvalEnvelope.editRevision });
    const selectionApproval = await verifyApproval({ run, file: approvalFile, project, source: source.document, edit: revision.edit });
    requireProductionApproval(selectionApproval);
    const contract = await createPixelProductionContract({ run, project, selectionApproval, edit: revision.edit });
    const output = options.output ? path.resolve(options.output) : path.join(run.root, 'work', 'pixel-production');
    const delegated = await runPixelProduction({
      run,
      project,
      selectionApproval,
      contract,
      pipelineCli: fileURLToPath(new URL('../../pixel-sprite-animation-pipeline/scripts/cli.mjs', import.meta.url)),
      output,
      ...(options.snapReceipt ? { snapReceipt: { path: path.resolve(options.snapReceipt) } } : {}),
      ...(options.frameApproval ? { frameApproval: { path: path.resolve(options.frameApproval) } } : {})
    });
    if (delegated.exitCode !== 0) {
      print(delegated);
      process.exitCode = delegated.exitCode;
      return;
    }
    const published = await publishExportRevision({
      run,
      bindings: {
        projectSha256: project.sha256,
        sourceSha256: source.sha256,
        editSha256: selectionApproval.document.editSha256,
        selectionApprovalSha256: selectionApproval.sha256,
        snapReceiptSha256: delegated.receipt.sha256,
        frameApprovalSha256: delegated.frameApproval.sha256
      },
      pixelExport: delegated.exports,
      validationReport: delegated.report
    });
    const validation = await recordProductionValidation({
      run,
      exportRevision: published.revision,
      exportManifestSha256: published.sha256,
      validationReport: delegated.report
    });
    print({
      status: 'complete',
      runId: run.id,
      contract: { path: contract.path, sha256: contract.sha256 },
      receipt: delegated.receipt,
      frameApproval: delegated.frameApproval,
      export: { path: published.path, sha256: published.sha256, revision: published.revision },
      validation: { path: validation.path, sha256: validation.sha256 },
      report: delegated.report
    });
  });

program
  .command('validate')
  .description('Validate one complete character animation run')
  .requiredOption('--project-dir <directory>', 'project directory')
  .requiredOption('--run <id>', 'immutable run ID')
  .option('--revision <number>', 'published export revision', revisionInteger)
  .action(async (options) => {
    const projectDir = path.resolve(options.projectDir);
    const project = await loadInitializedProject(projectDir);
    const run = await loadRun({ projectRoot: projectDir, id: options.run });
    const expected = await loadAuditExpected({ run, revision: options.revision });
    const report = await auditRun({ run, project, expected });
    const written = await recordAuditReport({ run, kind: 'validation-audit', value: { report } });
    const status = report.failures.length > 0 ? 'objective-failure' : report.reviews.length > 0 ? 'review-required' : 'complete';
    print({ status, runId: run.id, audit: { path: written.path, sha256: written.sha256, revision: written.revision }, report });
    if (report.failures.length > 0) process.exitCode = 3;
    else if (report.reviews.length > 0) process.exitCode = 4;
  });

program
  .command('audit')
  .description('Compare reproducible run evidence')
  .requiredOption('--project-dir <directory>', 'project directory')
  .requiredOption('--run <id>', 'first immutable run ID')
  .requiredOption('--repeat <id>', 'equivalent repeat run ID')
  .action(async (options) => {
    const projectDir = path.resolve(options.projectDir);
    const project = await loadInitializedProject(projectDir);
    const [leftRun, rightRun] = await Promise.all([
      loadRun({ projectRoot: projectDir, id: options.run }),
      loadRun({ projectRoot: projectDir, id: options.repeat })
    ]);
    const [leftExpected, rightExpected] = await Promise.all([
      loadAuditExpected({ run: leftRun }),
      loadAuditExpected({ run: rightRun })
    ]);
    const [left, right] = await Promise.all([
      auditRun({ run: leftRun, project, expected: leftExpected }),
      auditRun({ run: rightRun, project, expected: rightExpected })
    ]);
    const comparison = compareRuns(left, right);
    const written = await recordAuditReport({ run: leftRun, kind: 'reproducibility-audit', value: { repeatRunId: rightRun.id, left, right, comparison } });
    const reviews = [...left.reviews, ...right.reviews];
    const objectiveFailure = left.failures.length > 0 || right.failures.length > 0 || comparison.changedDeterministicArtifacts.length > 0;
    const status = objectiveFailure ? 'objective-failure' : reviews.length > 0 ? 'review-required' : 'complete';
    print({ status, runId: leftRun.id, repeatRunId: rightRun.id, audit: { path: written.path, sha256: written.sha256, revision: written.revision }, comparison });
    if (objectiveFailure) process.exitCode = 3;
    else if (reviews.length > 0) process.exitCode = 4;
  });

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
