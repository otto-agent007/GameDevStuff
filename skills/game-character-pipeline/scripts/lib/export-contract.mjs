import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { copyImmutable, writeImmutableJson } from './artifacts.mjs';
import { canonicalJson, exactObject, portableRelativePath, sha256File, sha256Value } from './schema.mjs';

const HASH = /^[a-f0-9]{64}$/;

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} must be a sha256`);
}

function opaquePaletteHex(rgba) {
  return rgba.slice(1).map((color) => color.slice(0, 3).map((component) => component.toString(16).padStart(2, '0')).join(''));
}

async function verifiedContainedFile(root, relative, expectedSha256, label) {
  portableRelativePath(relative, `${label} path`);
  hash(expectedSha256, `${label} hash`);
  const physicalRoot = await fs.realpath(root);
  let selected = physicalRoot;
  for (const component of relative.split('/')) {
    selected = path.join(selected, component);
    if ((await fs.lstat(selected)).isSymbolicLink()) throw new Error(`${label} path must not contain a symlink`);
  }
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a regular single-link file`);
  const physical = await fs.realpath(selected);
  const containment = path.relative(physicalRoot, physical);
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error(`${label} escaped its root`);
  if (await sha256File(physical) !== expectedSha256) throw new Error(`${label} hash mismatch`);
  return physical;
}

export async function createPixelProductionContract({ run, project, selectionApproval, edit }) {
  if (!run?.id || !run?.root || !run.document?.sourceRequest?.actionId || !HASH.test(run.sha256 ?? '')) throw new Error('pixel contract requires an immutable run');
  if (!project?.root || !project?.document || !HASH.test(project.sha256 ?? '')) throw new Error('pixel contract requires an initialized project');
  if (selectionApproval?.verified !== true || selectionApproval.document?.decision !== 'approved' || !HASH.test(selectionApproval.sha256 ?? '')) throw new Error('pixel contract requires a verified owner selection approval');
  if (!edit || edit.actionId !== run.document.sourceRequest.actionId || !Array.isArray(edit.frames)) throw new Error('pixel contract edit does not match the immutable run action');
  const action = project.document.actions.find(({ id }) => id === edit.actionId);
  if (!action) throw new Error('pixel contract action is not present in the project');
  if (action.tracks.length !== 1 || action.tracks[0] !== 'actor') throw new Error('separate approved track derivatives are required before multi-track pixel production');
  const selectedFrames = edit.frames.filter(({ included }) => included);
  if (selectedFrames.length === 0) throw new Error('pixel contract requires approved selected frames');
  if (selectedFrames.length !== selectionApproval.document.derivatives?.length || selectedFrames.length !== selectionApproval.document.selectedFrames?.length) throw new Error('pixel contract approval membership mismatch');

  const canonicalAnchor = project.document.character.anchors.find(({ role }) => role === 'canonical');
  if (!canonicalAnchor) throw new Error('pixel contract requires one canonical character anchor');
  const anchorSource = await verifiedContainedFile(project.root, canonicalAnchor.path, canonicalAnchor.sha256, 'canonical character anchor');
  const base = `work/pixel-contracts/${selectionApproval.sha256}`;
  const copiedAnchor = await copyImmutable({ source: anchorSource, root: run.root, relative: `${base}/canonical-anchor.png` });
  const frames = [];
  const inputFrames = [];
  for (const [index, frame] of selectedFrames.entries()) {
    if (frame.tracks.length !== 1 || frame.tracks[0] !== 'actor') throw new Error('separate approved track derivatives are required before multi-track pixel production');
    const selected = selectionApproval.document.selectedFrames[index];
    const derivative = selectionApproval.document.derivatives[index];
    if (selected.frameId !== frame.frameId || derivative.frameId !== frame.frameId || selected.derivativeSha256 !== derivative.sha256) throw new Error('pixel contract approval membership mismatch');
    await verifiedContainedFile(run.root, derivative.path, derivative.sha256, 'approved frame derivative');
    frames.push({
      id: frame.frameId,
      semantic: frame.label.trim() || action.semantic,
      duration: frame.durationMs,
      tracks: ['actor'],
      sockets: frame.markers?.filter(({ kind }) => kind === 'socket').map(({ id }) => id) ?? [],
      contacts: structuredClone(frame.contacts),
      groundTravel: structuredClone(frame.groundTravel)
    });
    inputFrames.push({ frameId: frame.frameId, trackId: 'actor', path: derivative.path, sha256: derivative.sha256 });
  }
  const contractDocument = {
    version: 2,
    selectionApprovalSha256: selectionApproval.sha256,
    character: { id: project.document.id, anchorSha256: copiedAnchor.sha256 },
    canvas: structuredClone(project.document.canvas),
    scale: structuredClone(project.document.scale),
    palette: { ...structuredClone(project.document.palette), snapperPaletteHex: opaquePaletteHex(project.document.palette.rgba) },
    tracks: [structuredClone(project.document.tracks.find(({ id }) => id === 'actor'))],
    sockets: project.document.sockets.filter(({ id }) => action.sockets.includes(id)).map((socket) => structuredClone(socket)),
    contacts: project.document.contacts.filter(({ id }) => action.contacts.includes(id)).map((contact) => structuredClone(contact)),
    clips: [{ id: action.id, loopMode: action.loopMode, frames }],
    review: { checkpoints: structuredClone(project.document.approvals.requiredGates), approvers: structuredClone(project.document.approvals.identities) }
  };
  const relative = `${base}/animation-contract-v2.json`;
  const contract = await writeImmutableJson({ root: run.root, relative, value: contractDocument, reuse: true });
  const inputsDocument = {
    version: 1,
    selectionApprovalSha256: selectionApproval.sha256,
    anchor: { path: copiedAnchor.relative, sha256: copiedAnchor.sha256 },
    frames: inputFrames
  };
  const inputs = await writeImmutableJson({ root: run.root, relative: `${relative}.inputs.json`, value: inputsDocument, reuse: true });
  return { path: contract.path, relative: contract.relative, sha256: contract.sha256, document: contractDocument, inputs };
}

async function nextRevision(exportsRoot) {
  const names = await fs.readdir(exportsRoot);
  for (const name of names) if (!/^revision-\d{4}$/.test(name)) throw new Error(`unexpected export revision entry: ${name}`);
  const revisions = names.map((name) => Number(name.slice('revision-'.length)));
  const revision = (revisions.length === 0 ? 0 : Math.max(...revisions)) + 1;
  if (revision > 9999) throw new Error('export revision limit exceeded');
  return revision;
}

async function verifiedArtifacts(pixelExport) {
  if (!pixelExport?.root || !Array.isArray(pixelExport.artifacts) || pixelExport.artifacts.length === 0) throw new Error('pixel export requires a declared artifact set');
  const root = await fs.realpath(pixelExport.root);
  const seen = new Set();
  const artifacts = [];
  for (const record of pixelExport.artifacts) {
    exactObject(record, ['path', 'sha256'], 'pixel export artifact');
    portableRelativePath(record.path, 'pixel export artifact path');
    hash(record.sha256, 'pixel export artifact hash');
    if (seen.has(record.path)) throw new Error('pixel export artifact paths must be unique');
    seen.add(record.path);
    let current = root;
    for (const segment of record.path.split('/')) {
      current = path.join(current, segment);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('pixel export artifact path must not contain a symlink');
    }
    const stat = await fs.lstat(current);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('pixel export artifact must be a regular single-link file');
    const physical = await fs.realpath(current);
    const containment = path.relative(root, physical);
    if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error('pixel export artifact escaped its root');
    const actual = await sha256File(physical);
    if (actual !== record.sha256) throw new Error(`artifact hash mismatch: ${record.path}`);
    artifacts.push({ path: record.path, sha256: actual, source: physical });
  }
  return artifacts;
}

export async function publishExportRevision({ run, bindings, pixelExport }) {
  if (!run?.id || !run?.root || !HASH.test(run.sha256 ?? '')) throw new Error('export publication requires an immutable run');
  exactObject(bindings, ['projectSha256', 'sourceSha256', 'editSha256', 'selectionApprovalSha256', 'snapReceiptSha256', 'frameApprovalSha256'], 'export bindings');
  for (const [name, value] of Object.entries(bindings)) hash(value, `export ${name}`);
  const artifacts = await verifiedArtifacts(pixelExport);
  const exportsRoot = path.join(await fs.realpath(run.root), 'exports');
  const stat = await fs.lstat(exportsRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('run exports path must be a real directory');
  const revision = await nextRevision(exportsRoot);
  const name = `revision-${String(revision).padStart(4, '0')}`;
  const target = path.join(exportsRoot, name);
  const stage = path.join(exportsRoot, `.${name}-${crypto.randomUUID()}.stage`);
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    const published = [];
    for (const artifact of artifacts) {
      const output = path.join(stage, ...artifact.path.split('/'));
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(artifact.source, output, fs.constants.COPYFILE_EXCL);
      const copiedHash = await sha256File(output);
      if (copiedHash !== artifact.sha256) throw new Error(`artifact changed during export publication: ${artifact.path}`);
      published.push({ path: artifact.path, sha256: copiedHash });
    }
    const document = {
      schemaVersion: 1,
      kind: 'pixel-production-export',
      revision,
      runId: run.id,
      runSha256: run.sha256,
      ...structuredClone(bindings),
      artifacts: published
    };
    const manifest = path.join(stage, 'manifest.json');
    await fs.writeFile(manifest, canonicalJson(document), { flag: 'wx' });
    if (await sha256File(manifest) !== sha256Value(document)) throw new Error('export manifest canonical hash mismatch');
    await fs.rename(stage, target);
    return { path: path.join(target, 'manifest.json'), sha256: sha256Value(document), revision, document };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}
