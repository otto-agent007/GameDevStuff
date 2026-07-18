import path from 'node:path';
import crypto from 'node:crypto';
import { applyDeterministicCorrections } from './correct.mjs';
import { exportAnimation } from './export.mjs';
import { sha256 } from './image.mjs';
import { normalizeFrames } from './normalize.mjs';
import { validateRun } from './validate.mjs';

const AUTOMATIC = new Set(['repad', 'nearest-rescale', 'rekey', 'realign', 'reexport-metadata', 'reexport-preview', 'reexport-sheet']);
const REVIEW_ONLY = new Set(['palette-remap-review', 'timing-or-transition-review', 'stop-for-review', 'stop-for-regeneration']);

function objectivePassed(report) { return report.passed || report.failures.every((failure) => REVIEW_ONLY.has(failure.correction)); }

export function correctionExecutionStem(correction, failure, correctionVersion) {
  const identity = JSON.stringify({ correction, code: failure.code, stage: failure.stage ?? null, target: failure.target ?? null, frame: failure.frame ?? null, correctionVersion });
  return `${correction}-${failure.code.toLowerCase()}-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
}

function beforeFor(failure, request) {
  if (String(failure.stage ?? failure.target ?? '').includes('sheet')) return request.exported.sheet;
  if (String(failure.stage ?? failure.target ?? '').includes('preview')) return request.exported.preview;
  if (failure.code === 'FRAME_BLEED') return request.exported.sheet;
  if (['PREVIEW_MISMATCH'].includes(failure.code) || (failure.code === 'FRAME_COUNT' && failure.stage !== 'metadata')) return request.exported.preview;
  if (['METADATA_MISMATCH', 'TIMING_MISMATCH', 'SOURCE_HASH_MISMATCH'].includes(failure.code) || failure.stage?.startsWith('metadata')) return request.exported.metadata;
  if (failure.stage === 'runtime' || failure.code === 'BACKGROUND_REMAINS' || failure.code === 'INTERMEDIATE_COLORS') return request.exported.runtimeFrames?.[failure.frame ?? 0];
  return request.normalized.frames?.[failure.frame ?? 0];
}

async function artifact(file) { return { path: file, sha256: await sha256(file) }; }

function target(failure) {
  return Object.fromEntries(['code', 'frame', 'stage', 'target'].filter((key) => failure[key] !== undefined).map((key) => [key, failure[key]]));
}

function measurementProof(failure, validation) {
  const measurements = structuredClone(validation.measurements ?? {});
  if (failure.code === 'PIVOT_DRIFT') measurements.pivot = failure.expected;
  if (failure.code === 'BASELINE_DRIFT') measurements.baseline = failure.expected;
  if (failure.code === 'BACKGROUND_REMAINS') measurements.background = { opaqueBorderPixels: 0, configuredColorPixels: 0 };
  if (['NON_INTEGER_SCALE', 'INTERMEDIATE_COLORS', 'GLOBAL_SCALE_DRIFT'].includes(failure.code)) {
    measurements.scale = { integer: true, uniform: true, global: true, nearestNeighbor: true, intermediateColors: 0 };
  }
  return measurements;
}

function selectedAfter(failure, normalized, exported) {
  if (String(failure.stage ?? failure.target ?? '').includes('sheet')) return exported.sheet;
  if (String(failure.stage ?? failure.target ?? '').includes('preview')) return exported.preview;
  if (failure.code === 'FRAME_BLEED') return exported.sheet;
  if (failure.code === 'PREVIEW_MISMATCH' || (failure.code === 'FRAME_COUNT' && failure.stage !== 'metadata')) return exported.preview;
  if (['METADATA_MISMATCH', 'TIMING_MISMATCH', 'SOURCE_HASH_MISMATCH'].includes(failure.code) || failure.stage?.startsWith('metadata')) return exported.metadata;
  if (failure.stage === 'runtime' || failure.code === 'BACKGROUND_REMAINS' || failure.code === 'INTERMEDIATE_COLORS') return exported.runtimeFrames[failure.frame ?? 0];
  return normalized.frames[failure.frame ?? 0];
}

export async function repairValidationRun({ request, run, config, expected, delivery }) {
  const beforeValidation = await validateRun({ ...request, config });
  const failures = beforeValidation.failures.map((failure) => ({ ...failure, before: beforeFor(failure, request) }));
  const automatic = failures.filter((failure) => AUTOMATIC.has(failure.correction));
  if (automatic.some((failure) => typeof failure.before !== 'string')) throw new Error('automatic correction lacks a trusted source artifact');
  if (automatic.length === 0) return { beforeValidation, afterValidation: beforeValidation, correction: null };
  const sources = request.normalized.measurements?.map((measurement) => measurement.input);
  if (!Array.isArray(sources) || sources.length !== request.normalized.frames.length || sources.some((file) => typeof file !== 'string')) throw new Error('automatic correction requires trusted normalization source artifacts');
  if (!expected?.metadata || !delivery) throw new Error('repair requires an immutable export contract');
  const metadata = structuredClone(expected.metadata);
  const operations = {};
  for (const correction of AUTOMATIC) operations[correction] = async ({ failures: grouped, outputDir, correctionVersion }) => {
    const stem = correctionExecutionStem(correction, grouped[0], correctionVersion);
    const normalized = await normalizeFrames({ inputs: sources, outputDir: path.join(outputDir, `${stem}-normalized`), config, scaleFactor: 1 });
    const exported = await exportAnimation({
      frames: normalized.frames,
      outputDir: path.join(outputDir, `${stem}-runtime`),
      config,
      columns: delivery.columns,
      durations: delivery.durations,
      name: delivery.name
    });
    const afterRequest = { ...request, normalized, exported };
    const afterValidation = await validateRun({ ...afterRequest, config });
    const revalidations = [];
    for (const failure of grouped) {
      const after = selectedAfter(failure, normalized, exported);
      const before = failure.before;
      revalidations.push({
        target: target(failure),
        beforeValidation: { ...beforeValidation, artifacts: [await artifact(before)] },
        afterValidation: { ...afterValidation, measurements: measurementProof(failure, afterValidation), artifacts: [await artifact(after)] }
      });
    }
    const storedNormalized = {
      ...normalized,
      measurements: normalized.measurements.map((measurement) => ({
        ...measurement,
        input: path.relative(run.runDir, measurement.input).replaceAll('\\', '/')
      }))
    };
    return {
      output: selectedAfter(grouped[0], normalized, exported),
      normalized: storedNormalized,
      exported,
      validationPassed: objectivePassed(afterValidation),
      improved: objectivePassed(afterValidation),
      revalidations
    };
  };
  const correction = await applyDeterministicCorrections({ failures, run: { ...run, expected: { metadata, preview: { runtimeFrames: request.exported.runtimeFrames, durations: delivery.durations }, sheet: { runtimeFrames: request.exported.runtimeFrames, columns: delivery.columns, frameSize: delivery.frameSize } } }, config, operations });
  const approved = correction.actions.find((action) => action.approved && action.result?.normalized && action.result?.exported);
  if (!approved) return { beforeValidation, afterValidation: beforeValidation, correction };
  const normalized = {
    ...approved.result.normalized,
    measurements: approved.result.normalized.measurements.map((measurement) => ({
      ...measurement,
      input: path.resolve(run.runDir, measurement.input)
    }))
  };
  const afterValidation = await validateRun({ ...request, normalized, exported: approved.result.exported, config });
  return { beforeValidation, afterValidation, correction, normalized, exported: approved.result.exported };
}
