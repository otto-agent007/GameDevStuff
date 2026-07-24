function pointFor(marker, edit, fallback) {
  return {
    x: (marker?.x ?? fallback.x) + (edit.translation?.x ?? 0) - (edit.groundTravel?.x ?? 0),
    y: (marker?.y ?? fallback.y) + (edit.translation?.y ?? 0) - (edit.groundTravel?.y ?? 0)
  };
}

function markerFor(edit, predicate) {
  return (edit.markers ?? []).find(predicate);
}

function issue(type, frameIndex, frameId, message, contactId = null) {
  return {
    id: `${type}:${frameIndex}:${contactId ?? 'root'}`,
    type,
    frameIndex,
    frameId,
    contactId,
    message
  };
}

export function analyzeMotion(frames, canvas) {
  const rootPath = [];
  const footPaths = {};
  const issues = [];
  const priorContacts = new Map();
  const pivot = canvas?.pivot ?? { x: 0, y: 0 };

  for (const [frameIndex, frame] of (frames ?? []).entries()) {
    if (frame.included === false) continue;
    const edit = frame.edit ?? {};
    const root = markerFor(edit, ({ id, kind }) => id === 'root' && kind === 'root-pivot');
    if (!root) {
      issues.push(issue('missing-root', frameIndex, frame.id, `${frame.id} uses the project pivot because no root marker is authored.`));
    }
    rootPath.push({ frameIndex, frameId: frame.id, ...pointFor(root, edit, pivot) });

    const contacts = new Set(edit.contacts ?? []);
    for (const contactId of contacts) {
      const marker = markerFor(edit, ({ id, kind }) => id === contactId && kind === 'planted-foot');
      if (!marker) {
        issues.push(issue(
          'missing-contact-marker',
          frameIndex,
          frame.id,
          `${frame.id} marks ${contactId} planted without a matching foot marker.`,
          contactId
        ));
        priorContacts.delete(contactId);
        continue;
      }
      const point = { frameIndex, frameId: frame.id, ...pointFor(marker, edit, pivot) };
      (footPaths[contactId] ??= []).push(point);
      const prior = priorContacts.get(contactId);
      if (prior && (prior.x !== point.x || prior.y !== point.y)) {
        issues.push(issue(
          'foot-slide',
          frameIndex,
          frame.id,
          `${contactId} moves from ${prior.x},${prior.y} to ${point.x},${point.y} while planted.`,
          contactId
        ));
      }
      priorContacts.set(contactId, point);
    }
    for (const contactId of [...priorContacts.keys()]) {
      if (!contacts.has(contactId)) priorContacts.delete(contactId);
    }
  }

  return {
    canvas: {
      width: Math.max(1, canvas?.width ?? 1),
      height: Math.max(1, canvas?.height ?? 1)
    },
    rootPath,
    footPaths,
    issues
  };
}

const SVG = 'http://www.w3.org/2000/svg';
const PATH_COLORS = {
  root: '#63d5e8',
  'left-foot': '#f59e0b',
  'right-foot': '#ff5c7a'
};

function svgElement(name, attributes = {}) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function pointsAttribute(points, canvas) {
  return points.map(({ x, y }) => {
    const plotX = Math.max(0, Math.min(100, (x / canvas.width) * 100));
    const plotY = Math.max(0, Math.min(100, (y / canvas.height) * 100));
    return `${plotX},${plotY}`;
  }).join(' ');
}

function appendPath(plot, id, points, canvas) {
  if (!points.length) return;
  plot.append(svgElement('polyline', {
    points: pointsAttribute(points, canvas),
    fill: 'none',
    stroke: PATH_COLORS[id] ?? '#c4ccd0',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'data-path': id
  }));
  for (const point of points) {
    plot.append(svgElement('circle', {
      cx: Math.max(0, Math.min(100, (point.x / canvas.width) * 100)),
      cy: Math.max(0, Math.min(100, (point.y / canvas.height) * 100)),
      r: 2.2,
      fill: PATH_COLORS[id] ?? '#c4ccd0',
      'data-frame-index': point.frameIndex
    }));
  }
}

export function renderMotionDiagnostics(root, analysis, onSelect) {
  const plot = root.querySelector('#motion-path-plot');
  const summary = root.querySelector('#motion-summary');
  const issues = root.querySelector('#motion-issues');
  plot.replaceChildren();
  issues.replaceChildren();
  appendPath(plot, 'root', analysis.rootPath, analysis.canvas);
  for (const [contactId, points] of Object.entries(analysis.footPaths)) {
    appendPath(plot, contactId, points, analysis.canvas);
  }
  summary.textContent = `${analysis.rootPath.length} active frames · ${analysis.issues.length} ${analysis.issues.length === 1 ? 'warning' : 'warnings'}`;
  if (!analysis.issues.length) {
    const empty = document.createElement('p');
    empty.className = 'motion-empty';
    empty.textContent = 'No authored motion warnings.';
    issues.append(empty);
    return;
  }
  for (const item of analysis.issues) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'motion-issue';
    button.setAttribute('aria-label', `Go to ${item.frameId}: ${item.type}`);
    button.textContent = item.message;
    button.addEventListener('click', () => onSelect(item.frameIndex));
    issues.append(button);
  }
}
