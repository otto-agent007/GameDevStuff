#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const validator = path.join(
  codexRoot,
  'skills',
  '.system',
  'skill-creator',
  'scripts',
  'quick_validate.py'
);

if (!fs.existsSync(validator)) {
  process.stderr.write(`official skill validator is not installed: ${validator}\n`);
  process.exitCode = 1;
} else {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, [validator, '.'], {
    cwd: packageRoot,
    stdio: 'inherit',
    shell: false
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
