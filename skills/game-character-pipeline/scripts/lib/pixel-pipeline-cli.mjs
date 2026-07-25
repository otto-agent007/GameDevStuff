import fs from 'node:fs/promises';
import path from 'node:path';

const CONFIGURATION_DESCRIPTION = 'Configure a readable Pixel Sprite Pipeline CLI with --pipeline-cli <file> or PIXEL_SPRITE_PIPELINE_CLI.';

function handoff(description) {
  return {
    status: 'awaiting-pixel-pipeline-cli',
    description
  };
}

export async function resolvePixelPipelineCli({ pipelineCli, env = process.env, cwd = process.cwd() } = {}) {
  const configured = pipelineCli === undefined ? env.PIXEL_SPRITE_PIPELINE_CLI : pipelineCli;
  if (typeof configured !== 'string' || configured.trim() === '') return { handoff: handoff(CONFIGURATION_DESCRIPTION) };

  const file = path.resolve(cwd, configured);
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return { handoff: handoff(`The configured Pixel Sprite Pipeline CLI is not a regular file: ${file}. ${CONFIGURATION_DESCRIPTION}`) };
    await fs.access(file, fs.constants.R_OK);
    return { pipelineCli: file };
  } catch {
    return { handoff: handoff(`The configured Pixel Sprite Pipeline CLI is missing or unreadable: ${file}. ${CONFIGURATION_DESCRIPTION}`) };
  }
}
