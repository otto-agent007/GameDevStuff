import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  approvePoseSelection,
  loadApprovedPoseSelection,
  writePoseSelection
} from '../lib/pose-selection.mjs';
import { loadInitializedProject, loadRun } from '../lib/run-contract.mjs';
import {
  exactObject,
  portableRelativePath,
  sha256File,
  sha256Value
} from '../lib/schema.mjs';

const BODY_LIMIT = 1024 * 1024;
const CSP = "default-src 'self'; img-src 'self' blob:; connect-src 'self'";
const STUDIO_ROOT = fileURLToPath(new URL('../../studio/', import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['recovery.html', 'text/html; charset=utf-8']],
  ['/studio/recovery-app.mjs', ['recovery-app.mjs', 'text/javascript; charset=utf-8']],
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

function methodError(allow) {
  return new HttpError(405, 'method is not allowed', { Allow: allow });
}

function plainObject(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new HttpError(400, `${label} must be a JSON object`);
  }
  return value;
}

async function readJson(request) {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'mutation content type must be application/json');
  }
  const declared = request.headers['content-length'];
  if (
    declared !== undefined &&
    (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)
  ) {
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
  try {
    return plainObject(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
      'request body'
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'request body must be valid JSON');
  }
}

function contained(root, target, label) {
  const relative = path.relative(root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escaped the run root`);
  }
}

async function readCanonicalJson(file, runRoot, label) {
  const root = await fs.realpath(runRoot);
  const selected = path.resolve(file);
  contained(root, selected, label);
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a regular single-link file`);
  }
  const physical = await fs.realpath(selected);
  contained(root, physical, label);
  const document = JSON.parse(await fs.readFile(physical, 'utf8'));
  const sha256 = await sha256File(physical);
  if (sha256 !== sha256Value(document)) {
    throw new Error(`${label} must use canonical immutable JSON`);
  }
  return { document, path: physical, sha256 };
}

async function loadRecovery(run, project) {
  const loaded = await readCanonicalJson(
    path.join(run.root, 'reports', 'pose-board-recovery.json'),
    run.root,
    'pose-board recovery report'
  );
  const document = loaded.document;
  exactObject(
    document,
    [
      'schemaVersion',
      'kind',
      'projectSha256',
      'runSha256',
      'runId',
      'actionId',
      'actionSha256',
      'source',
      'contract',
      'canvas',
      'background',
      'mask',
      'components',
      'ignoredNoise',
      'candidates',
      'proposedOrder',
      'overlay'
    ],
    'pose-board recovery report'
  );
  if (
    document.schemaVersion !== 1 ||
    document.kind !== 'pose-board-recovery' ||
    document.projectSha256 !== project.sha256 ||
    document.runSha256 !== run.sha256 ||
    document.runId !== run.id ||
    document.actionId !== run.document.sourceRequest.actionId
  ) {
    throw new Error('pose-board recovery report ancestry mismatch');
  }
  return loaded;
}

async function verifyArtifact(runRoot, record, label) {
  portableRelativePath(record.path, `${label} path`);
  const root = await fs.realpath(runRoot);
  const selected = path.join(root, ...record.path.split('/'));
  contained(root, selected, label);
  const stat = await fs.lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new HttpError(409, `${label} is not an immutable file`);
  }
  const physical = await fs.realpath(selected);
  contained(root, physical, label);
  if (await sha256File(physical) !== record.sha256) {
    throw new HttpError(409, `${label} hash mismatch`);
  }
  return physical;
}

async function loadSelectionState(run, recovery, project) {
  const rootDocument = {
    schemaVersion: 1,
    kind: 'pose-selection-root',
    runId: run.id,
    recoverySha256: recovery.sha256
  };
  let state = {
    selectionRevision: 0,
    selectionSha256: sha256Value(rootDocument),
    selection: null,
    selectionPath: null
  };
  const names = (await fs.readdir(path.join(run.root, 'edits')))
    .filter((name) => /^pose-selection-\d{4}\.json$/.test(name))
    .sort();
  for (const [index, name] of names.entries()) {
    if (name !== `pose-selection-${String(index + 1).padStart(4, '0')}.json`) {
      throw new Error('pose selection revisions are not contiguous');
    }
    const loaded = await readCanonicalJson(
      path.join(run.root, 'edits', name),
      run.root,
      'pose selection revision'
    );
    if (
      loaded.document.kind !== 'pose-board-selection' ||
      loaded.document.projectSha256 !== project.sha256 ||
      loaded.document.runId !== run.id ||
      loaded.document.recoverySha256 !== recovery.sha256
    ) {
      throw new Error('pose selection revision ancestry mismatch');
    }
    state = {
      selectionRevision: index + 1,
      selectionSha256: loaded.sha256,
      selection: loaded.document,
      selectionPath: loaded.path
    };
  }
  return state;
}

function requireMutationHeaders(request, origin, currentSha256) {
  if (request.headers.origin !== origin) {
    throw new HttpError(403, 'mutation origin is not the studio origin');
  }
  if (request.headers['if-match'] !== currentSha256) {
    throw new HttpError(409, 'stale pose selection If-Match value');
  }
}

function serialQueue() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
}

export async function startRecoveryStudioServer({
  projectDir,
  runId,
  host = '127.0.0.1',
  port = 0
}) {
  if (host !== '127.0.0.1') {
    throw new Error('recovery Studio must bind to the IPv4 loopback host');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('recovery Studio port is invalid');
  }
  const resolvedProjectDir = path.resolve(projectDir);
  const project = await loadInitializedProject(resolvedProjectDir);
  const run = await loadRun({ projectRoot: resolvedProjectDir, id: runId });
  if (run.document.sourceRequest.kind !== 'pose-board') {
    throw new Error('recovery Studio requires a pose-board run');
  }
  const recovery = await loadRecovery(run, project);
  const candidateByHash = new Map(
    recovery.document.candidates.map((candidate) => [candidate.sha256, candidate])
  );
  const overlayByHash = new Map([
    [recovery.document.overlay.sha256, recovery.document.overlay]
  ]);
  let selectionState = await loadSelectionState(run, recovery, project);
  const serialize = serialQueue();
  let origin;

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== origin.slice('http://'.length)) {
        throw new HttpError(403, 'request Host is not the studio origin');
      }
      const url = new URL(request.url, origin);
      const pathname = url.pathname;

      if (STATIC_FILES.has(pathname)) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          throw methodError('GET, HEAD');
        }
        if (request.method === 'HEAD') {
          const [, contentType] = STATIC_FILES.get(pathname);
          response.writeHead(200, responseHeaders(contentType));
          response.end();
          return;
        }
        await sendStatic(response, pathname);
        return;
      }

      if (pathname === '/api/recovery-session') {
        if (request.method !== 'GET') throw methodError('GET');
        sendJson(response, 200, {
          schemaVersion: 1,
          stage: 'recovery',
          runId: run.id,
          actionId: run.document.sourceRequest.actionId,
          projectSha256: project.sha256,
          project: project.document,
          recoverySha256: recovery.sha256,
          recovery: recovery.document,
          ...selectionState
        });
        return;
      }

      const candidateMatch = pathname.match(/^\/api\/candidate\/([a-f0-9]{64})$/);
      if (candidateMatch) {
        if (request.method !== 'GET') throw methodError('GET');
        const candidate = candidateByHash.get(candidateMatch[1]);
        if (!candidate) throw new HttpError(404, 'candidate is not present in the recovery report');
        const file = await verifyArtifact(run.root, candidate, 'recovered candidate');
        const bytes = await fs.readFile(file);
        response.writeHead(200, {
          ...responseHeaders('image/png'),
          'Content-Length': bytes.length
        });
        response.end(bytes);
        return;
      }

      const overlayMatch = pathname.match(/^\/api\/overlay\/([a-f0-9]{64})$/);
      if (overlayMatch) {
        if (request.method !== 'GET') throw methodError('GET');
        const overlay = overlayByHash.get(overlayMatch[1]);
        if (!overlay) throw new HttpError(404, 'overlay is not present in the recovery report');
        const file = await verifyArtifact(run.root, overlay, 'pose-board overlay');
        const bytes = await fs.readFile(file);
        response.writeHead(200, {
          ...responseHeaders('image/png'),
          'Content-Length': bytes.length
        });
        response.end(bytes);
        return;
      }

      if (pathname === '/api/pose-selections') {
        if (request.method !== 'PUT') throw methodError('PUT');
        const value = await readJson(request);
        const written = await serialize(async () => {
          requireMutationHeaders(request, origin, selectionState.selectionSha256);
          try {
            const next = await writePoseSelection({
              run,
              project,
              recovery,
              value
            });
            selectionState = {
              selectionRevision: next.revision,
              selectionSha256: next.sha256,
              selection: next.document,
              selectionPath: next.path
            };
            return next;
          } catch (error) {
            throw new HttpError(400, error.message);
          }
        });
        sendJson(response, 200, {
          revision: written.revision,
          sha256: written.sha256,
          selectionSha256: written.sha256
        });
        return;
      }

      if (pathname === '/api/pose-selection-approval') {
        if (request.method !== 'POST') throw methodError('POST');
        const body = await readJson(request);
        exactObject(
          body,
          ['approver', 'decision', 'notes'],
          'pose selection approval request'
        );
        const written = await serialize(async () => {
          requireMutationHeaders(request, origin, selectionState.selectionSha256);
          if (!selectionState.selectionPath || selectionState.selectionRevision < 1) {
            throw new HttpError(409, 'approval requires a saved pose selection');
          }
          try {
            const selection = {
              path: selectionState.selectionPath,
              sha256: selectionState.selectionSha256,
              revision: selectionState.selectionRevision,
              document: selectionState.selection
            };
            const approval = await approvePoseSelection({
              run,
              project,
              recovery,
              selection,
              ...body
            });
            await loadApprovedPoseSelection({
              run,
              project,
              recovery,
              file: approval.path
            });
            return approval;
          } catch (error) {
            throw new HttpError(400, error.message);
          }
        });
        sendJson(response, 200, {
          revision: written.revision,
          sha256: written.sha256,
          decision: written.document.decision,
          selectionSha256: written.document.selectionSha256
        });
        return;
      }

      throw new HttpError(404, 'route not found');
    } catch (error) {
      const status = error.status ?? 500;
      sendJson(
        response,
        status,
        { error: status === 500 ? 'internal recovery studio error' : error.message },
        error.headers
      );
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
