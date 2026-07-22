import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderReviewRevision, verifyApproval, writeApproval } from '../lib/approval.mjs';
import { writeRevision } from '../lib/artifacts.mjs';
import { loadInitializedProject, loadRun } from '../lib/run-contract.mjs';
import {
  exactObject,
  portableId,
  portableRelativePath,
  sha256File,
  sha256Value,
  uniqueList
} from '../lib/schema.mjs';

const HASH = /^[a-f0-9]{64}$/;
const BODY_LIMIT = 1024 * 1024;
const CSP = "default-src 'self'; img-src 'self' blob:; connect-src 'self'";
const STUDIO_ROOT = fileURLToPath(new URL('../../studio/', import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/studio/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/studio/frame-canvas.mjs', ['frame-canvas.mjs', 'text/javascript; charset=utf-8']],
  ['/studio/markers.mjs', ['markers.mjs', 'text/javascript; charset=utf-8']],
  ['/studio/timeline.mjs', ['timeline.mjs', 'text/javascript; charset=utf-8']],
  ['/studio/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function responseHeaders(contentType) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(contentType ? { 'Content-Type': contentType } : {})
  };
}

function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    ...responseHeaders('application/json; charset=utf-8'),
    'Content-Length': body.length,
    ...headers
  });
  response.end(body);
}

async function sendStatic(response, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const [relative, contentType] = entry;
  const bytes = await fs.readFile(path.join(STUDIO_ROOT, relative));
  response.writeHead(200, {
    ...responseHeaders(contentType),
    'Content-Length': bytes.length
  });
  response.end(bytes);
  return true;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new HttpError(400, `${label} must be a JSON object`);
  }
  return value;
}

async function readJson(request) {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'mutation content type must be application/json');
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) {
    request.resume();
    throw new HttpError(413, 'request body exceeds 1 MiB');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'request body exceeds 1 MiB');
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }
  return plainObject(value, 'request body');
}

function contained(root, target, label) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the run root`);
  }
}

async function readCanonicalJson(file, root, label) {
  const runRoot = await fs.realpath(root);
  const selected = path.resolve(file);
  contained(runRoot, selected, label);
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a regular single-link file`);
  const physical = await fs.realpath(selected);
  contained(runRoot, physical, label);
  const document = JSON.parse(await fs.readFile(physical, 'utf8'));
  if (await sha256File(physical) !== sha256Value(document)) throw new Error(`${label} must use canonical immutable JSON`);
  return document;
}

function validateReviewManifest(document) {
  const manifest = structuredClone(document);
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.frames)) throw new Error('review manifest must contain frames');
  uniqueList(manifest.frames, 'review manifest frames', { key: ({ id }) => id });
  for (const frame of manifest.frames) {
    portableId(frame.id, 'review frame ID');
    portableRelativePath(frame.path, 'review frame path');
    if (typeof frame.sha256 !== 'string' || !HASH.test(frame.sha256)) throw new Error('review frame sha256 is invalid');
  }
  return manifest;
}

async function loadReviewManifest(run, stage, supplied) {
  if (stage === 'post-snap' && supplied === undefined) throw new Error('post-snap studio stage requires a review manifest');
  if (supplied && typeof supplied === 'object') return validateReviewManifest(supplied);
  const file = supplied === undefined
    ? path.join(run.root, 'reports', 'source.json')
    : path.resolve(supplied);
  return validateReviewManifest(await readCanonicalJson(file, run.root, 'review manifest'));
}

async function verifyFrame(runRoot, frame) {
  const root = await fs.realpath(runRoot);
  const selected = path.join(root, ...frame.path.split('/'));
  contained(root, selected, 'review frame');
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new HttpError(409, 'review frame is not an immutable file');
  const physical = await fs.realpath(selected);
  contained(root, physical, 'review frame');
  if (await sha256File(physical) !== frame.sha256) throw new HttpError(409, 'frame hash mismatch');
  return physical;
}

async function loadEditState(run, stage, sourceSha256) {
  const root = {
    schemaVersion: 1,
    kind: 'studio-edit-root',
    runId: run.id,
    stage,
    sourceSha256
  };
  let state = { editRevision: 0, editSha256: sha256Value(root), edit: null };
  const names = (await fs.readdir(path.join(run.root, 'edits')))
    .filter((name) => /^studio-edit-\d{4}\.json$/.test(name))
    .sort();
  for (const [index, name] of names.entries()) {
    if (name !== `studio-edit-${String(index + 1).padStart(4, '0')}.json`) throw new Error('studio edit revisions are not contiguous');
    const file = path.join(run.root, 'edits', name);
    const document = await readCanonicalJson(file, run.root, 'studio edit revision');
    exactObject(document, ['schemaVersion', 'kind', 'runId', 'stage', 'sourceSha256', 'previousSha256', 'edit'], 'studio edit revision');
    if (
      document.schemaVersion !== 1 ||
      document.kind !== 'studio-edit' ||
      document.runId !== run.id ||
      document.stage !== stage ||
      document.sourceSha256 !== sourceSha256 ||
      document.previousSha256 !== state.editSha256
    ) throw new Error('studio edit revision chain is invalid');
    state = {
      editRevision: index + 1,
      editSha256: await sha256File(file),
      edit: document.edit
    };
  }
  return state;
}

function methodError(allow) {
  return new HttpError(405, 'method is not allowed', { Allow: allow });
}

function requireMutationHeaders(request, origin, currentSha256) {
  if (request.headers.origin !== origin) throw new HttpError(403, 'mutation origin is not the studio origin');
  if (request.headers['if-match'] !== currentSha256) throw new HttpError(409, 'stale edit If-Match value');
}

function serialQueue() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
}

export async function startStudioServer({
  projectDir,
  runId,
  stage,
  reviewManifest,
  host = '127.0.0.1',
  port = 0
}) {
  if (host !== '127.0.0.1') throw new Error('Frame Studio must bind to the IPv4 loopback host');
  if (stage !== 'selection' && stage !== 'post-snap') throw new Error('studio stage must be selection or post-snap');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('studio port is invalid');
  const resolvedProjectDir = path.resolve(projectDir);
  const project = await loadInitializedProject(resolvedProjectDir);
  const run = await loadRun({ projectRoot: resolvedProjectDir, id: runId });
  const source = await loadReviewManifest(run, stage, reviewManifest);
  const sourceSha256 = sha256Value(source);
  const frameByHash = new Map(source.frames.map((frame) => [frame.sha256, frame]));
  let editState = await loadEditState(run, stage, sourceSha256);
  const serialize = serialQueue();
  let origin;

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== origin.slice('http://'.length)) throw new HttpError(403, 'request Host is not the studio origin');
      const url = new URL(request.url, origin);
      const pathname = url.pathname;

      if (STATIC_FILES.has(pathname)) {
        if (request.method !== 'GET' && request.method !== 'HEAD') throw methodError('GET, HEAD');
        if (request.method === 'HEAD') {
          const [, contentType] = STATIC_FILES.get(pathname);
          response.writeHead(200, responseHeaders(contentType));
          response.end();
          return;
        }
        await sendStatic(response, pathname);
        return;
      }

      if (pathname === '/api/session') {
        if (request.method !== 'GET') throw methodError('GET');
        sendJson(response, 200, {
          schemaVersion: 1,
          runId: run.id,
          stage,
          sourceSha256,
          projectSha256: project.sha256,
          project: project.document,
          actionId: run.document.sourceRequest.actionId,
          source,
          ...editState
        });
        return;
      }

      if (pathname.startsWith('/api/frame/')) {
        if (request.method !== 'GET') throw methodError('GET');
        const match = pathname.match(/^\/api\/frame\/([a-f0-9]{64})$/);
        const frame = match ? frameByHash.get(match[1]) : null;
        if (!frame) throw new HttpError(404, 'frame is not present in the review manifest');
        const file = await verifyFrame(run.root, frame);
        const bytes = await fs.readFile(file);
        response.writeHead(200, {
          ...responseHeaders('image/png'),
          'Content-Length': bytes.length
        });
        response.end(bytes);
        return;
      }

      if (pathname === '/api/edits') {
        if (request.method !== 'PUT') throw methodError('PUT');
        const edit = await readJson(request);
        const result = await serialize(async () => {
          requireMutationHeaders(request, origin, editState.editSha256);
          const document = {
            schemaVersion: 1,
            kind: 'studio-edit',
            runId: run.id,
            stage,
            sourceSha256,
            previousSha256: editState.editSha256,
            edit
          };
          const written = await writeRevision({ root: run.root, area: 'edits', stem: 'studio-edit', value: document });
          editState = { editRevision: written.revision, editSha256: written.sha256, edit };
          return written;
        });
        sendJson(response, 200, { revision: result.revision, sha256: result.sha256, editSha256: sha256Value(edit) });
        return;
      }

      const editRevisionMatch = pathname.match(/^\/api\/edits\/(\d{1,6})$/);
      if (editRevisionMatch) {
        if (request.method !== 'GET') throw methodError('GET');
        const revision = Number(editRevisionMatch[1]);
        if (revision < 1 || revision > editState.editRevision) throw new HttpError(404, 'studio edit revision does not exist');
        const file = path.join(run.root, 'edits', `studio-edit-${String(revision).padStart(4, '0')}.json`);
        const document = await readCanonicalJson(file, run.root, 'studio edit revision');
        sendJson(response, 200, { revision, sha256: await sha256File(file), edit: document.edit });
        return;
      }

      if (pathname === '/api/approval') {
        if (request.method !== 'POST') throw methodError('POST');
        const approval = await readJson(request);
        exactObject(approval, ['approver', 'decision', 'notes'], 'studio approval request');
        const result = await serialize(async () => {
          requireMutationHeaders(request, origin, editState.editSha256);
          if (editState.editRevision < 1) throw new HttpError(409, 'approval requires a saved edit revision');
          try {
            const written = await writeApproval({ run, project, editRevision: editState.editRevision, ...approval });
            await verifyApproval({ run, file: written.path, project, source, edit: editState.edit });
            return written;
          } catch (error) {
            throw new HttpError(400, error.message);
          }
        });
        sendJson(response, 200, {
          revision: result.revision,
          sha256: result.sha256,
          decision: result.document.decision,
          editSha256: result.document.editSha256,
          renderSha256: result.document.renderedReview.sha256
        });
        return;
      }

      if (pathname === '/api/render') {
        if (request.method !== 'POST') throw methodError('POST');
        const body = await readJson(request);
        exactObject(body, [], 'studio render request');
        const result = await serialize(async () => {
          requireMutationHeaders(request, origin, editState.editSha256);
          if (editState.editRevision < 1) throw new HttpError(409, 'render requires a saved edit revision');
          try {
            return await renderReviewRevision({ run, project, editRevision: editState.editRevision });
          } catch (error) {
            throw new HttpError(400, error.message);
          }
        });
        sendJson(response, 200, {
          editRevision: result.editRevision,
          editSha256: result.editSha256,
          renderSha256: result.sha256,
          renderedManifestSha256: result.renderedManifest.sha256,
          contactSheetSha256: result.contactSheet.sha256
        });
        return;
      }

      throw new HttpError(404, 'route not found');
    } catch (error) {
      const status = error.status ?? 500;
      sendJson(response, status, { error: status === 500 ? 'internal studio error' : error.message }, error.headers);
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  const address = server.address();
  origin = `http://${host}:${address.port}`;
  let closed = false;
  return {
    origin,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections?.();
      });
    }
  };
}
