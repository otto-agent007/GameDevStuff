import './frame-canvas.mjs';
import './timeline.mjs';
import { installMarkerAuthoring } from './markers.mjs';
import {
  activeIndices,
  cloneFrameState,
  nextPlaybackIndex,
  playbackIndices,
  reviewDelay
} from './review-state.mjs';

const shell = document.querySelector('.app-shell');
const timeline = document.querySelector('frame-timeline');
const canvas = document.querySelector('frame-canvas');
const status = document.querySelector('#status');
const playButton = document.querySelector('#play');
const replayButton = document.querySelector('#replay');
let session;
let action;
let frames = [];
let savedFrames = [];
let selectedIndex = 0;
let reviewSide = 'B';
let reviewSpeed = 1;
let playbackRange = { in: null, out: null };
let playing = false;
let playbackTimer;
let copyNumber = 0;
let markerAuthoring;
let dirty = false;
let renderReceipt = null;

const titleCase = (value) => value.split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
const frameUrl = (sha256) => `/api/frame/${sha256}`;
const displayFrames = () => reviewSide === 'A' && savedFrames.length ? savedFrames : frames;
const includedFrames = () => displayFrames().filter((frame) => frame.included !== false);
const activeFrameIndices = () => activeIndices(displayFrames());
const rangedFrameIndices = () => playbackIndices(displayFrames(), playbackRange);
const hasPlaybackRange = () => Number.isInteger(playbackRange.in) || Number.isInteger(playbackRange.out);
const firstActiveIndex = () => activeFrameIndices()[0] ?? null;
const lastActiveIndex = () => activeFrameIndices().at(-1) ?? null;

function adjacentActiveIndex(index, direction) {
  const active = activeFrameIndices();
  if (!active.length) return null;
  if (direction > 0) return active.find((candidate) => candidate > index) ?? active[0];
  return active.findLast((candidate) => candidate < index) ?? active.at(-1);
}

function setFrameInclusion(index, included) {
  if (reviewSide === 'A') return false;
  const frame = frames[index];
  if (!frame || frame.included === included) return false;
  if (!included && includedFrames().length === 1) {
    status.textContent = 'An action must retain at least one active frame.';
    return false;
  }
  frame.included = included;
  frame.edit.included = included;
  setDirty(true);
  render();
  status.textContent = `${included ? 'Restored' : 'Excluded'} ${frame.id} ${included ? 'to' : 'from'} the action; save to create a revision.`;
  return true;
}

function updateApprovalControls() {
  const hasSavedEdit = Boolean(session?.editRevision);
  document.querySelector('#save-revision').disabled = reviewSide === 'A';
  document.querySelector('#render-review').disabled = dirty || !hasSavedEdit;
  const canDecide = !dirty && Boolean(renderReceipt) && hasSavedEdit;
  document.querySelector('#approve-revision').disabled = !canDecide;
  document.querySelector('#reject-revision').disabled = !canDecide;
}

function updateReviewState() {
  if (!session) return;
  document.querySelector('#review-a').setAttribute('aria-pressed', String(reviewSide === 'A'));
  document.querySelector('#review-b').setAttribute('aria-pressed', String(reviewSide === 'B'));
  const saved = session.editRevision
    ? `Revision ${session.editRevision} · ${session.editSha256.slice(0, 12)}`
    : 'Source defaults · no saved hash';
  document.querySelector('#review-a-state').textContent = saved;
  document.querySelector('#review-b-state').textContent = dirty
    ? 'Unsaved working copy · no immutable hash'
    : `Matches ${saved}`;
}

function updateRangeState() {
  const view = displayFrames();
  const start = Number.isInteger(playbackRange.in) ? view[playbackRange.in]?.id : null;
  const end = Number.isInteger(playbackRange.out) ? view[playbackRange.out]?.id : null;
  document.querySelector('#range-readout').textContent = start || end
    ? `${start ?? 'First active'} → ${end ?? 'Last active'}`
    : 'Full action';
  document.querySelector('#clear-range').disabled = !hasPlaybackRange();
}

function setDirty(value) {
  dirty = value;
  if (value) {
    renderReceipt = null;
    document.querySelector('#approval-render-hash').textContent = 'Not rendered';
  }
  updateReviewState();
  updateApprovalControls();
}

function compatibleEdit(edit) {
  return edit?.kind === 'frame-studio-edit' &&
    Array.isArray(edit.frames) &&
    edit.frames.length === session.source.frames.length &&
    edit.frames.every((frame, index) => frame.frameId === session.source.frames[index].id);
}

function applyEdit(edit) {
  if (!compatibleEdit(edit)) return false;
  for (const [index, frameEdit] of edit.frames.entries()) {
    frames[index].edit = structuredClone(frameEdit);
    frames[index].included = frameEdit.included;
    frames[index].label = frameEdit.label;
    frames[index].durationMs = frameEdit.durationMs;
  }
  selectedIndex = Math.min(selectedIndex, frames.length - 1);
  render();
  return true;
}

function stopPlayback() {
  playing = false;
  clearTimeout(playbackTimer);
  playButton.textContent = 'Play';
}

function updateCanvas() {
  const view = displayFrames();
  const frame = view[selectedIndex];
  if (!frame) return;
  const previousIndex = adjacentActiveIndex(selectedIndex, -1);
  const nextIndex = adjacentActiveIndex(selectedIndex, 1);
  const firstIndex = firstActiveIndex();
  const lastIndex = lastActiveIndex();
  const previous = view[previousIndex] ?? frame;
  const next = view[nextIndex] ?? frame;
  const first = view[firstIndex] ?? frame;
  const last = view[lastIndex] ?? frame;
  canvas.setAttribute('frame', frame.url);
  canvas.setAttribute('first', first.url);
  canvas.setAttribute('last', last.url);
  canvas.markerState = { markers: frame.edit.markers, canvas: session.project.canvas };
  if (document.querySelector('#overlay-previous').checked) canvas.setAttribute('previous', previous.url);
  else canvas.removeAttribute('previous');
  if (document.querySelector('#overlay-next').checked) canvas.setAttribute('next', next.url);
  else canvas.removeAttribute('next');
}

function updateReadout() {
  const view = displayFrames();
  const frame = view[selectedIndex];
  const active = includedFrames();
  const total = active.reduce((sum, item) => sum + item.edit.durationMs, 0);
  document.querySelector('#frame-count').textContent = `${active.length} active / ${view.length} source`;
  document.querySelector('#selected-name').textContent = frame?.id ?? '—';
  document.querySelector('#frame-position').textContent = `Frame ${view.length ? selectedIndex + 1 : 0} of ${view.length}`;
  document.querySelector('#total-duration').textContent = `${total} ms total`;
  document.querySelector('#selection-frame').textContent = frame?.id ?? '—';
  document.querySelector('#selection-duration').textContent = frame ? `${frame.edit.durationMs} ms` : '—';
  const inclusionButton = document.querySelector('#toggle-frame-inclusion');
  const isIncluded = frame?.included !== false;
  inclusionButton.textContent = isIncluded ? 'Exclude from action' : 'Restore to action';
  inclusionButton.dataset.included = String(isIncluded);
  inclusionButton.disabled = reviewSide === 'A';
  document.querySelector('#scrub-progress').value = view.length ? (selectedIndex + 1) / view.length : 0;
}

function render({ focus = false } = {}) {
  timeline.frames = displayFrames();
  timeline.readOnly = reviewSide === 'A';
  timeline.rangeIn = playbackRange.in;
  timeline.rangeOut = playbackRange.out;
  timeline.selectedIndex = selectedIndex;
  updateCanvas();
  updateReadout();
  markerAuthoring?.refresh();
  markerAuthoring?.setDisabled(reviewSide === 'A');
  updateReviewState();
  updateRangeState();
  updateApprovalControls();
  if (focus) timeline.focusSelected();
}

function selectFrame(index, { manual = false, focus = false } = {}) {
  const view = displayFrames();
  if (!view.length) return;
  if (manual) stopPlayback();
  selectedIndex = Math.max(0, Math.min(index, view.length - 1));
  render({ focus });
}

function scheduleNext() {
  if (!playing) return;
  const indices = rangedFrameIndices();
  if (!indices.length) {
    stopPlayback();
    return;
  }
  const current = displayFrames()[selectedIndex];
  playbackTimer = setTimeout(() => {
    const atEnd = selectedIndex === indices.at(-1);
    if (atEnd && !hasPlaybackRange() && action?.loopMode !== 'loop') {
      stopPlayback();
      return;
    }
    selectFrame(nextPlaybackIndex(indices, selectedIndex));
    scheduleNext();
  }, reviewDelay(current.edit.durationMs, reviewSpeed));
}

function startPlayback({ fromStart = false } = {}) {
  const indices = rangedFrameIndices();
  if (!indices.length) return;
  stopPlayback();
  if (fromStart) selectFrame(indices[0]);
  else if (!indices.includes(selectedIndex)) selectFrame(nextPlaybackIndex(indices, selectedIndex));
  playing = true;
  playButton.textContent = 'Pause';
  scheduleNext();
}

function togglePlayback() {
  if (playing) {
    stopPlayback();
    return;
  }
  startPlayback();
}

function setBooleanOverlay(input, attribute) {
  input.addEventListener('change', () => {
    if (attribute === 'previous' || attribute === 'next') updateCanvas();
    else canvas.setAttribute(attribute, String(input.checked));
  });
}

timeline.addEventListener('frame-select', ({ detail }) => selectFrame(detail.index, { manual: true, focus: detail.focus }));
timeline.addEventListener('frame-include', ({ detail }) => {
  setFrameInclusion(detail.index, detail.included);
});
timeline.addEventListener('frame-transport', ({ detail }) => {
  const targets = {
    previous: adjacentActiveIndex(selectedIndex, -1),
    next: adjacentActiveIndex(selectedIndex, 1),
    first: firstActiveIndex(),
    last: lastActiveIndex()
  };
  selectFrame(targets[detail.command], { manual: true, focus: true });
});
timeline.addEventListener('frame-duplicate', ({ detail }) => {
  if (reviewSide === 'A') return;
  const original = frames[detail.index];
  copyNumber += 1;
  const duplicate = { ...original, id: `${original.id}-copy-${copyNumber}`, edit: structuredClone(original.edit) };
  duplicate.edit.frameId = duplicate.id;
  frames.splice(detail.index + 1, 0, duplicate);
  selectedIndex = detail.index + 1;
  setDirty(true);
  render();
  status.textContent = `Duplicated ${original.id}; save to create a revision.`;
});
timeline.addEventListener('frame-label', ({ detail }) => {
  if (reviewSide === 'A') return;
  frames[detail.index].label = detail.label;
  frames[detail.index].edit.label = detail.label;
  setDirty(true);
});
timeline.addEventListener('frame-duration', ({ detail }) => {
  if (reviewSide === 'A') return;
  const frame = frames[detail.index];
  frame.durationMs = detail.durationMs;
  frame.edit.durationMs = detail.durationMs;
  setDirty(true);
  render();
  status.textContent = `Updated ${frame.id} to ${detail.durationMs} authored milliseconds; save to create a revision.`;
});
timeline.addEventListener('frame-duration-invalid', () => {
  render();
  status.textContent = 'Frame timing must use whole milliseconds from 1 to 65535.';
});

playButton.addEventListener('click', togglePlayback);
replayButton.addEventListener('click', () => startPlayback({ fromStart: true }));
document.querySelector('#toggle-frame-inclusion').addEventListener('click', () => {
  const frame = displayFrames()[selectedIndex];
  if (frame) setFrameInclusion(selectedIndex, frame.included === false);
});

function switchReviewSide(side) {
  if (!['A', 'B'].includes(side) || side === reviewSide) return;
  const resume = playing;
  stopPlayback();
  reviewSide = side;
  selectedIndex = Math.min(selectedIndex, Math.max(0, displayFrames().length - 1));
  render();
  if (resume) startPlayback();
  status.textContent = `Reviewing ${side === 'A' ? 'saved revision A' : 'working copy B'}; audition controls do not change edit state.`;
}

document.querySelector('#review-a').addEventListener('click', () => switchReviewSide('A'));
document.querySelector('#review-b').addEventListener('click', () => switchReviewSide('B'));

document.querySelector('#review-speed').addEventListener('change', (event) => {
  reviewSpeed = Number(event.target.value);
  if (playing) {
    clearTimeout(playbackTimer);
    scheduleNext();
  }
  status.textContent = `Review speed set to ${event.target.selectedOptions[0].textContent}; authored durations are unchanged.`;
});

function setRangeBoundary(boundary) {
  if (displayFrames()[selectedIndex]?.included === false) {
    status.textContent = 'Restore the selected frame before using it as a playback boundary.';
    return;
  }
  const resume = playing;
  stopPlayback();
  playbackRange = { ...playbackRange, [boundary]: selectedIndex };
  if (Number.isInteger(playbackRange.in) && Number.isInteger(playbackRange.out) && playbackRange.in > playbackRange.out) {
    playbackRange = { in: playbackRange.out, out: playbackRange.in };
  }
  render();
  if (resume) startPlayback();
  status.textContent = `Set temporary range ${boundary} at ${displayFrames()[selectedIndex].id}; authored loop mode is unchanged.`;
}

document.querySelector('#set-range-in').addEventListener('click', () => setRangeBoundary('in'));
document.querySelector('#set-range-out').addEventListener('click', () => setRangeBoundary('out'));
document.querySelector('#clear-range').addEventListener('click', () => {
  const resume = playing;
  stopPlayback();
  playbackRange = { in: null, out: null };
  render();
  if (resume) startPlayback();
  status.textContent = 'Cleared the temporary playback range.';
});

document.querySelector('#previous-frame').addEventListener('click', () => selectFrame(adjacentActiveIndex(selectedIndex, -1), { manual: true }));
document.querySelector('#next-frame').addEventListener('click', () => selectFrame(adjacentActiveIndex(selectedIndex, 1), { manual: true }));
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
    kind: 'frame-studio-edit',
    projectSha256: session.projectSha256,
    sourceSha256: session.sourceSha256,
    actionId: session.actionId,
    frames: frames.map(({ edit }) => structuredClone(edit))
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
    savedFrames = cloneFrameState(frames);
    reviewSide = 'B';
    document.querySelector('#restore-revision').disabled = result.revision < 2;
    renderReceipt = null;
    document.querySelector('#approval-edit-hash').textContent = result.editSha256;
    document.querySelector('#approval-render-hash').textContent = 'Not rendered';
    setDirty(false);
    status.textContent = `Saved edit revision ${result.revision}.`;
  } catch (error) {
    status.textContent = `Could not save revision: ${error.message}`;
  }
});

document.querySelector('#restore-revision').addEventListener('click', async () => {
  stopPlayback();
  reviewSide = 'B';
  const target = session.editRevision - 1;
  if (target < 1) return;
  status.textContent = `Loading immutable edit revision ${target}…`;
  try {
    const response = await fetch(`/api/edits/${target}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'revision load failed');
    if (!applyEdit(result.edit)) throw new Error('prior revision is not compatible with this source frame set');
    setDirty(true);
    status.textContent = `Restored edit revision ${target}; save to create a new revision.`;
  } catch (error) {
    status.textContent = `Could not restore revision: ${error.message}`;
  }
});

document.querySelector('#render-review').addEventListener('click', async () => {
  status.textContent = 'Rendering hash-bound review derivatives…';
  try {
    const response = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': session.editSha256 },
      body: '{}'
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'review render failed');
    renderReceipt = result;
    document.querySelector('#approval-edit-hash').textContent = result.editSha256;
    document.querySelector('#approval-render-hash').textContent = result.renderSha256;
    updateApprovalControls();
    status.textContent = `Rendered edit revision ${result.editRevision} for owner review.`;
  } catch (error) {
    renderReceipt = null;
    updateApprovalControls();
    status.textContent = `Could not render review: ${error.message}`;
  }
});

async function submitDecision(decision) {
  const notes = document.querySelector('#approval-notes').value;
  if (decision === 'rejected' && notes.trim() === '') {
    status.textContent = 'Rejection notes are required.';
    return;
  }
  status.textContent = `${decision === 'approved' ? 'Approving' : 'Rejecting'} hash-bound selection…`;
  try {
    const response = await fetch('/api/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': session.editSha256 },
      body: JSON.stringify({
        approver: document.querySelector('#approval-identity').value,
        decision,
        notes
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'approval write failed');
    status.textContent = `${decision === 'approved' ? 'Approved' : 'Rejected'} selection revision ${result.revision}.`;
  } catch (error) {
    status.textContent = `Could not record owner decision: ${error.message}`;
  }
}

document.querySelector('#approve-revision').addEventListener('click', () => submitDecision('approved'));
document.querySelector('#reject-revision').addEventListener('click', () => submitDecision('rejected'));

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea, select')) return;
  const keyActions = {
    ArrowLeft: () => selectFrame(adjacentActiveIndex(selectedIndex, -1), { manual: true, focus: true }),
    ArrowRight: () => selectFrame(adjacentActiveIndex(selectedIndex, 1), { manual: true, focus: true }),
    Home: () => selectFrame(firstActiveIndex(), { manual: true, focus: true }),
    End: () => selectFrame(lastActiveIndex(), { manual: true, focus: true })
  };
  if (Object.hasOwn(keyActions, event.key)) {
    event.preventDefault();
    keyActions[event.key]();
  } else if (event.code === 'Space') {
    event.preventDefault();
    togglePlayback();
  } else if (event.key === 'Delete' && displayFrames()[selectedIndex]) {
    event.preventDefault();
    setFrameInclusion(selectedIndex, false);
  }
});

async function initialize() {
  try {
    const response = await fetch('/api/session');
    if (!response.ok) throw new Error(`session returned ${response.status}`);
    session = await response.json();
    action = session.project.actions.find(({ id }) => id === session.actionId);
    const actionTracks = action?.tracks ?? ['actor'];
    frames = session.source.frames.map((frame) => ({
      ...frame,
      included: true,
      label: '',
      url: frameUrl(frame.sha256),
      edit: {
        frameId: frame.id,
        included: true,
        label: '',
        durationMs: frame.durationMs,
        translation: { x: 0, y: 0 },
        transform: null,
        markers: [],
        contacts: [],
        groundTravel: { x: 0, y: 0 },
        tracks: [...actionTracks]
      }
    }));
    if (compatibleEdit(session.edit)) {
      for (const [index, frameEdit] of session.edit.frames.entries()) {
        frames[index].edit = structuredClone(frameEdit);
        frames[index].included = frameEdit.included;
        frames[index].label = frameEdit.label;
        frames[index].durationMs = frameEdit.durationMs;
      }
    } else if (session.edit) {
      dirty = true;
    }
    savedFrames = cloneFrameState(frames);
    document.querySelector('#project-title').textContent = `${session.project.character.name} / ${titleCase(action?.id ?? session.actionId)}`;
    document.querySelector('#source-hash').textContent = session.sourceSha256.slice(0, 12);
    document.querySelector('#approval-source-hash').textContent = session.sourceSha256;
    document.querySelector('#approval-edit-hash').textContent = session.editSha256;
    const approver = document.querySelector('#approval-identity');
    for (const identity of session.project.approvals.identities) {
      const option = document.createElement('option');
      option.value = identity;
      option.textContent = identity;
      approver.append(option);
    }
    status.textContent = `Immutable ${session.stage} source loaded.`;
    document.querySelector('#restore-revision').disabled = session.editRevision < 2;
    markerAuthoring = installMarkerAuthoring({
      root: document.querySelector('#authoring-tools'),
      canvas,
      project: session.project,
      actionId: session.actionId,
      getFrame: () => displayFrames()[selectedIndex],
      getFrames: () => displayFrames(),
      onChange: (message, { render: shouldRender }) => {
        const frame = frames[selectedIndex];
        frame.durationMs = frame.edit.durationMs;
        frame.included = frame.edit.included;
        frame.label = frame.edit.label;
        if (shouldRender) setDirty(true);
        status.textContent = `${message} Save to create a revision.`;
        if (shouldRender) render();
      }
    });
    render();
    updateApprovalControls();
    shell.dataset.loading = 'false';
  } catch (error) {
    status.textContent = `Frame Studio could not load: ${error.message}`;
    shell.dataset.loading = 'error';
  }
}

initialize();
