import './frame-canvas.mjs';
import './timeline.mjs';

const shell = document.querySelector('.app-shell');
const timeline = document.querySelector('frame-timeline');
const canvas = document.querySelector('frame-canvas');
const status = document.querySelector('#status');
const playButton = document.querySelector('#play');
let session;
let frames = [];
let selectedIndex = 0;
let playing = false;
let playbackTimer;
let copyNumber = 0;

const titleCase = (value) => value.split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
const frameUrl = (sha256) => `/api/frame/${sha256}`;
const includedFrames = () => frames.filter((frame) => frame.included !== false);

function stopPlayback() {
  playing = false;
  clearTimeout(playbackTimer);
  playButton.textContent = 'Play';
}

function updateCanvas() {
  const frame = frames[selectedIndex];
  if (!frame) return;
  const previous = frames[(selectedIndex - 1 + frames.length) % frames.length];
  const next = frames[(selectedIndex + 1) % frames.length];
  canvas.setAttribute('frame', frame.url);
  canvas.setAttribute('first', frames[0].url);
  canvas.setAttribute('last', frames.at(-1).url);
  if (document.querySelector('#overlay-previous').checked) canvas.setAttribute('previous', previous.url);
  else canvas.removeAttribute('previous');
  if (document.querySelector('#overlay-next').checked) canvas.setAttribute('next', next.url);
  else canvas.removeAttribute('next');
}

function updateReadout() {
  const frame = frames[selectedIndex];
  const total = includedFrames().reduce((sum, item) => sum + item.durationMs, 0);
  document.querySelector('#frame-count').textContent = `${frames.length} frames`;
  document.querySelector('#selected-name').textContent = frame?.id ?? '—';
  document.querySelector('#frame-position').textContent = `Frame ${frames.length ? selectedIndex + 1 : 0} of ${frames.length}`;
  document.querySelector('#total-duration').textContent = `${total} ms total`;
  document.querySelector('#selection-frame').textContent = frame?.id ?? '—';
  document.querySelector('#selection-duration').textContent = frame ? `${frame.durationMs} ms` : '—';
  document.querySelector('#scrub-progress').value = frames.length ? (selectedIndex + 1) / frames.length : 0;
}

function render({ focus = false } = {}) {
  timeline.frames = frames;
  timeline.selectedIndex = selectedIndex;
  updateCanvas();
  updateReadout();
  if (focus) timeline.focusSelected();
}

function selectFrame(index, { manual = false, focus = false } = {}) {
  if (!frames.length) return;
  if (manual) stopPlayback();
  selectedIndex = Math.max(0, Math.min(index, frames.length - 1));
  render({ focus });
}

function scheduleNext() {
  if (!playing) return;
  const current = frames[selectedIndex];
  playbackTimer = setTimeout(() => {
    const nextIndex = (selectedIndex + 1) % frames.length;
    selectFrame(nextIndex);
    scheduleNext();
  }, current.durationMs);
}

function togglePlayback() {
  if (playing) {
    stopPlayback();
    return;
  }
  playing = true;
  playButton.textContent = 'Pause';
  scheduleNext();
}

function setBooleanOverlay(input, attribute) {
  input.addEventListener('change', () => {
    if (attribute === 'previous' || attribute === 'next') updateCanvas();
    else canvas.setAttribute(attribute, String(input.checked));
  });
}

timeline.addEventListener('frame-select', ({ detail }) => selectFrame(detail.index, { manual: true, focus: detail.focus }));
timeline.addEventListener('frame-include', ({ detail }) => {
  frames[detail.index].included = detail.included;
  render();
  status.textContent = `${detail.included ? 'Included' : 'Excluded'} ${frames[detail.index].id}; save to create a revision.`;
});
timeline.addEventListener('frame-duplicate', ({ detail }) => {
  const original = frames[detail.index];
  copyNumber += 1;
  const duplicate = { ...original, id: `${original.id}-copy-${copyNumber}`, label: `${original.label ?? ''}` };
  frames.splice(detail.index + 1, 0, duplicate);
  selectedIndex = detail.index + 1;
  render();
  status.textContent = `Duplicated ${original.id}; save to create a revision.`;
});
timeline.addEventListener('frame-label', ({ detail }) => {
  frames[detail.index].label = detail.label;
});

playButton.addEventListener('click', togglePlayback);
document.querySelector('#previous-frame').addEventListener('click', () => selectFrame((selectedIndex - 1 + frames.length) % frames.length, { manual: true }));
document.querySelector('#next-frame').addEventListener('click', () => selectFrame((selectedIndex + 1) % frames.length, { manual: true }));
document.querySelector('#zoom').addEventListener('input', (event) => {
  const zoom = Math.max(1, Math.min(12, Math.trunc(Number(event.target.value) || 1)));
  event.target.value = String(zoom);
  canvas.setAttribute('zoom', String(zoom));
});
document.querySelector('#onion-opacity').addEventListener('input', (event) => canvas.setAttribute('onion-opacity', event.target.value));
setBooleanOverlay(document.querySelector('#overlay-previous'), 'previous');
setBooleanOverlay(document.querySelector('#overlay-next'), 'next');
setBooleanOverlay(document.querySelector('#overlay-seam'), 'seam');
setBooleanOverlay(document.querySelector('#overlay-clipping'), 'clipping');
setBooleanOverlay(document.querySelector('#overlay-duplicates'), 'duplicates');
setBooleanOverlay(document.querySelector('#overlay-palette'), 'palette');
setBooleanOverlay(document.querySelector('#overlay-drift'), 'drift');

document.querySelector('#save-revision').addEventListener('click', async () => {
  stopPlayback();
  status.textContent = 'Saving immutable edit revision…';
  const edit = {
    schemaVersion: 1,
    selectedFrameId: frames[selectedIndex]?.id ?? null,
    frames: frames.map(({ id, sha256, included, label, durationMs }) => ({ id, sha256, included, label, durationMs })),
    overlays: {
      previous: document.querySelector('#overlay-previous').checked,
      next: document.querySelector('#overlay-next').checked,
      seam: document.querySelector('#overlay-seam').checked
    }
  };
  try {
    const response = await fetch('/api/edits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': session.editSha256 },
      body: JSON.stringify(edit)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'revision save failed');
    session.editSha256 = result.sha256;
    session.editRevision = result.revision;
    status.textContent = `Saved edit revision ${result.revision}.`;
  } catch (error) {
    status.textContent = `Could not save revision: ${error.message}`;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea, select')) return;
  const keyActions = {
    ArrowLeft: () => selectFrame(selectedIndex - 1, { manual: true, focus: true }),
    ArrowRight: () => selectFrame(selectedIndex + 1, { manual: true, focus: true }),
    Home: () => selectFrame(0, { manual: true, focus: true }),
    End: () => selectFrame(frames.length - 1, { manual: true, focus: true })
  };
  if (Object.hasOwn(keyActions, event.key)) {
    event.preventDefault();
    keyActions[event.key]();
  } else if (event.code === 'Space') {
    event.preventDefault();
    togglePlayback();
  } else if (event.key === 'Delete' && frames[selectedIndex]) {
    event.preventDefault();
    frames[selectedIndex].included = false;
    render();
  }
});

async function initialize() {
  try {
    const response = await fetch('/api/session');
    if (!response.ok) throw new Error(`session returned ${response.status}`);
    session = await response.json();
    const action = session.project.actions.find(({ id }) => id === session.actionId);
    frames = session.source.frames.map((frame) => ({ ...frame, included: true, label: '', url: frameUrl(frame.sha256) }));
    document.querySelector('#project-title').textContent = `${session.project.character.name} / ${titleCase(action?.id ?? session.actionId)}`;
    document.querySelector('#source-hash').textContent = session.sourceSha256.slice(0, 12);
    status.textContent = `Immutable ${session.stage} source loaded.`;
    render();
    shell.dataset.loading = 'false';
  } catch (error) {
    status.textContent = `Frame Studio could not load: ${error.message}`;
    shell.dataset.loading = 'error';
  }
}

initialize();
