import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { closed, commitValue, hashValue, parseCli, stableJson } from './release-common.mjs';

const SPDX_KEYS = Object.freeze([
  'SPDXID', 'annotations', 'comment', 'creationInfo', 'dataLicense', 'documentDescribes',
  'documentNamespace', 'externalDocumentRefs', 'files', 'hasExtractedLicensingInfos', 'name',
  'packages', 'relationships', 'revieweds', 'spdxVersion'
]);
const CREATION_KEYS = Object.freeze(['comment', 'created', 'creators', 'licenseListVersion']);

function assertClosedAllowed(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} must use a closed SPDX schema`);
}

function sortByStable(values) {
  if (!Array.isArray(values)) return values;
  return [...values].sort((left, right) => stableJson(left).localeCompare(stableJson(right), 'en'));
}

export function normalizeComplianceSbom(input, { upstreamCommit, cargoLockSha256 }) {
  commitValue(upstreamCommit, 'compliance upstream commit');
  hashValue(cargoLockSha256, 'compliance Cargo.lock hash');
  assertClosedAllowed(input, SPDX_KEYS, ['SPDXID', 'creationInfo', 'dataLicense', 'documentNamespace', 'packages', 'spdxVersion'], 'SPDX document');
  if (input.SPDXID !== 'SPDXRef-DOCUMENT' || input.spdxVersion !== 'SPDX-2.3' || input.dataLicense !== 'CC0-1.0') throw new Error('invalid SPDX document identity');
  assertClosedAllowed(input.creationInfo, CREATION_KEYS, ['created', 'creators'], 'SPDX creationInfo');
  if (!Array.isArray(input.creationInfo.creators) || !input.creationInfo.creators.includes('Tool: cargo-sbom-v0.10.0')) throw new Error('cargo-sbom 0.10.0 creator is required');
  const value = structuredClone(input);
  value.creationInfo.created = '1970-01-01T00:00:00Z';
  value.creationInfo.creators = [...value.creationInfo.creators].sort();
  value.documentNamespace = `https://github.com/Hugo-Dz/spritefusion-pixel-snapper/sbom/${upstreamCommit}/${cargoLockSha256}`;
  for (const key of ['packages', 'files', 'relationships', 'documentDescribes', 'externalDocumentRefs', 'hasExtractedLicensingInfos', 'annotations', 'revieweds']) if (Object.hasOwn(value, key)) value[key] = sortByStable(value[key]);
  return stableJson(value);
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const required = ['input', 'output', 'upstream-commit', 'cargo-lock-sha256'];
  if (Object.keys(args).some((key) => !required.includes(key)) || required.some((key) => !args[key])) throw new Error('usage: normalize-compliance.mjs --input RAW.json --output SPDX.json --upstream-commit SHA --cargo-lock-sha256 SHA256');
  const input = JSON.parse(await fs.readFile(args.input, 'utf8'));
  const output = normalizeComplianceSbom(input, { upstreamCommit: args['upstream-commit'], cargoLockSha256: args['cargo-lock-sha256'] });
  await fs.writeFile(args.output, output, { flag: 'wx', mode: 0o644 });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
