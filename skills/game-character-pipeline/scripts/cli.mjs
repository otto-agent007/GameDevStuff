#!/usr/bin/env node
import { Command } from 'commander';

const commands = Object.freeze([
  ['init', 'Create a versioned character project from a validated brief'],
  ['intake', 'Import or resume an immutable motion source'],
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

for (const [name, description] of commands) {
  program.command(name).description(description).action(unavailable(name));
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message, exitCode: 1 })}\n`);
  process.exitCode = 1;
}
