#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';

import { createProject, createRun, loadInitializedProject } from './lib/run-contract.mjs';

const commands = Object.freeze([
  ['studio', 'Open the local Frame Studio authoring surface'],
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
  .action(async (options) => {
    const projectDir = path.resolve(options.projectDir);
    const project = await loadInitializedProject(projectDir);
    const result = await createRun({
      projectRoot: projectDir,
      project,
      sourceRequest: { actionId: options.action, kind: options.kind }
    });
    print({ status: 'created', runId: result.id, state: result.document.state });
  });

for (const [name, description] of commands) {
  program.command(name).description(description).action(unavailable(name));
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message, exitCode: 1 })}\n`);
  process.exitCode = 1;
}
