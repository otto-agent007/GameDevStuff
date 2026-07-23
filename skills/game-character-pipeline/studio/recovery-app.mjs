const shell = document.querySelector('.recovery-shell');
const status = document.querySelector('#status');
const candidateList = document.querySelector('#candidate-list');
const sequenceList = document.querySelector('#sequence-list');
const saveButton = document.querySelector('#save-recovery');
const approveButton = document.querySelector('#approve-recovery');
const rejectButton = document.querySelector('#reject-recovery');

let session;
let candidates = [];
let dirty = false;

const portableIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const candidateUrl = (sha256) => `/api/candidate/${sha256}`;

function selectedCandidates() {
  return candidates.filter(({ selected }) => selected);
}

function omissionCount() {
  const selectedComponents = new Set(
    selectedCandidates().flatMap(({ componentIds }) => componentIds)
  );
  return session.recovery.components.filter(({ id }) => !selectedComponents.has(id)).length;
}

function frameId(candidate) {
  const selected = selectedCandidates();
  const index = selected.indexOf(candidate);
  return candidate.frameId || `stride-${String(index + 1).padStart(2, '0')}`;
}

function stateErrors() {
  const selected = selectedCandidates();
  const errors = [];
  if (selected.length === 0) errors.push('Select at least one recovered candidate.');
  const frameIds = selected.map(frameId);
  if (frameIds.some((id) => !portableIdPattern.test(id))) {
    errors.push('Every frame name must be a portable ID.');
  }
  if (new Set(frameIds).size !== frameIds.length) {
    errors.push('Frame names must be unique.');
  }
  if (selected.some(({ durationMs }) => (
    !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 65535
  ))) {
    errors.push('Durations must be integers from 1 to 65535 ms.');
  }
  if (selected.some(({ componentRoles }) => (
    Object.values(componentRoles).some((role) => !['actor', 'prop', 'effect'].includes(role))
  ))) {
    errors.push('Every selected component needs a configured track role.');
  }
  const omitted = omissionCount();
  if (omitted > 0 && !session.recovery.contract.document.allowUnassigned) {
    errors.push(`${omitted} eligible components still need disposition.`);
  }
  return errors;
}

function selectionDocument() {
  return {
    schemaVersion: 1,
    kind: 'pose-board-selection',
    projectSha256: session.projectSha256,
    runId: session.runId,
    actionId: session.actionId,
    recoverySha256: session.recoverySha256,
    frames: selectedCandidates().map((candidate) => {
      const roles = new Map();
      for (const componentId of candidate.componentIds) {
        const role = candidate.componentRoles[componentId];
        if (!roles.has(role)) roles.set(role, []);
        roles.get(role).push(componentId);
      }
      return {
        id: frameId(candidate),
        candidateId: candidate.id,
        durationMs: candidate.durationMs,
        tracks: [...roles].map(([role, componentIds]) => ({ role, componentIds }))
      };
    })
  };
}

function setStatusForState(prefix = '') {
  const errors = stateErrors();
  const omitted = omissionCount();
  const suffix = errors.length > 0
    ? errors[0]
    : omitted > 0
      ? `${omitted} eligible components omitted by the recovery contract.`
      : 'All eligible foreground is dispositioned.';
  status.textContent = `${prefix}${suffix}`;
}

function updateControls() {
  const valid = stateErrors().length === 0;
  saveButton.disabled = !valid;
  const canDecide = valid && !dirty && session.selectionRevision > 0;
  approveButton.disabled = !canDecide;
  rejectButton.disabled = !canDecide;
  document.querySelector('#selected-count').textContent =
    `${selectedCandidates().length} selected`;
  document.querySelector('#validation-summary').textContent =
    valid ? 'Selection is structurally valid.' : stateErrors().join(' ');
}

function markDirty(message) {
  dirty = true;
  document.querySelector('#selection-hash').textContent = 'Unsaved changes';
  updateControls();
  setStatusForState(`${message} `);
}

function moveCandidate(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= candidates.length) return;
  [candidates[index], candidates[target]] = [candidates[target], candidates[index]];
  markDirty('Candidate order changed.');
  render();
  document.querySelector(`[data-candidate-id="${candidates[target].id}"]`)?.focus();
}

function roleOptions(selected) {
  const action = session.project.actions.find(({ id }) => id === session.actionId);
  const trackById = new Map(session.project.tracks.map((track) => [track.id, track]));
  const roles = [...new Set(action.tracks.map((trackId) => trackById.get(trackId).kind))];
  return roles.map((role) => {
    const option = document.createElement('option');
    option.value = role;
    option.textContent = `${role[0].toUpperCase()}${role.slice(1)}`;
    option.selected = role === selected;
    return option;
  });
}

function renderCandidates() {
  candidateList.replaceChildren();
  for (const [index, candidate] of candidates.entries()) {
    const card = document.createElement('article');
    card.className = 'candidate-card';
    card.dataset.candidateId = candidate.id;
    card.tabIndex = -1;

    const selectionLabel = document.createElement('label');
    selectionLabel.className = 'candidate-select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = candidate.selected;
    checkbox.setAttribute('aria-label', `Select ${candidate.id}`);
    checkbox.addEventListener('change', () => {
      candidate.selected = checkbox.checked;
      if (candidate.selected && !candidate.frameId) {
        candidate.frameId = `stride-${String(selectedCandidates().length).padStart(2, '0')}`;
      }
      markDirty(`${candidate.id} ${candidate.selected ? 'selected.' : 'omitted.'}`);
      render();
      document.querySelector(
        `input[aria-label="Select ${candidate.id}"]`
      )?.focus();
    });
    const title = document.createElement('strong');
    title.textContent = candidate.id;
    selectionLabel.append(checkbox, title);

    const image = document.createElement('img');
    image.src = candidateUrl(candidate.sha256);
    image.alt = `${candidate.id} recovered pose`;

    const evidence = document.createElement('p');
    evidence.textContent =
      `${candidate.componentIds.length} component${candidate.componentIds.length === 1 ? '' : 's'} · ` +
      `${candidate.width}×${candidate.height}`;

    const actions = document.createElement('div');
    actions.className = 'candidate-order-actions';
    const earlier = document.createElement('button');
    earlier.type = 'button';
    earlier.textContent = 'Earlier';
    earlier.setAttribute('aria-label', `Move ${candidate.id} earlier`);
    earlier.disabled = index === 0;
    earlier.addEventListener('click', () => moveCandidate(index, -1));
    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = 'Later';
    later.setAttribute('aria-label', `Move ${candidate.id} later`);
    later.disabled = index === candidates.length - 1;
    later.addEventListener('click', () => moveCandidate(index, 1));
    actions.append(earlier, later);
    card.append(selectionLabel, image, evidence, actions);
    candidateList.append(card);
  }
}

function renderSequence() {
  sequenceList.replaceChildren();
  for (const candidate of selectedCandidates()) {
    const item = document.createElement('article');
    item.className = 'sequence-item';
    const name = frameId(candidate);

    const heading = document.createElement('h3');
    heading.textContent = `${name} · ${candidate.id}`;
    item.append(heading);

    const nameLabel = document.createElement('label');
    nameLabel.className = 'field';
    const nameText = document.createElement('span');
    nameText.textContent = 'Portable frame name';
    const nameInput = document.createElement('input');
    nameInput.value = name;
    nameInput.setAttribute('aria-label', `${name} name`);
    nameInput.addEventListener('input', () => {
      candidate.frameId = nameInput.value;
      markDirty('Frame name changed.');
      updateControls();
    });
    nameLabel.append(nameText, nameInput);

    const durationLabel = document.createElement('label');
    durationLabel.className = 'field';
    const durationText = document.createElement('span');
    durationText.textContent = 'Duration (ms)';
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '1';
    durationInput.max = '65535';
    durationInput.step = '1';
    durationInput.value = String(candidate.durationMs);
    durationInput.setAttribute('aria-label', `${name} duration`);
    durationInput.addEventListener('input', () => {
      candidate.durationMs = Number(durationInput.value);
      markDirty('Frame timing changed.');
      updateControls();
    });
    durationLabel.append(durationText, durationInput);
    item.append(nameLabel, durationLabel);

    const componentGroup = document.createElement('fieldset');
    componentGroup.className = 'component-role-group';
    const legend = document.createElement('legend');
    legend.textContent = 'Whole-component roles';
    componentGroup.append(legend);
    for (const componentId of candidate.componentIds) {
      const roleLabel = document.createElement('label');
      roleLabel.className = 'field';
      const roleText = document.createElement('span');
      roleText.textContent = componentId;
      const select = document.createElement('select');
      select.setAttribute('aria-label', `${name} ${componentId} role`);
      select.append(...roleOptions(candidate.componentRoles[componentId]));
      select.addEventListener('change', () => {
        candidate.componentRoles[componentId] = select.value;
        markDirty('Component role changed.');
      });
      roleLabel.append(roleText, select);
      componentGroup.append(roleLabel);
    }
    item.append(componentGroup);
    sequenceList.append(item);
  }
  if (selectedCandidates().length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Select a recovered candidate to author the sequence.';
    sequenceList.append(empty);
  }
}

function render() {
  renderCandidates();
  renderSequence();
  updateControls();
}

saveButton.addEventListener('click', async () => {
  const errors = stateErrors();
  if (errors.length > 0) {
    setStatusForState();
    return;
  }
  status.textContent = 'Saving immutable recovery revision…';
  try {
    const response = await fetch('/api/pose-selections', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': session.selectionSha256
      },
      body: JSON.stringify(selectionDocument())
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'recovery revision save failed');
    session.selectionRevision = result.revision;
    session.selectionSha256 = result.sha256;
    dirty = false;
    document.querySelector('#selection-hash').textContent = result.sha256;
    updateControls();
    status.textContent = `Saved recovery revision ${result.revision}.`;
  } catch (error) {
    status.textContent = `Could not save recovery revision: ${error.message}`;
  }
});

async function submitDecision(decision) {
  status.textContent = `${decision === 'approved' ? 'Approving' : 'Rejecting'} recovered sequence…`;
  try {
    const response = await fetch('/api/pose-selection-approval', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': session.selectionSha256
      },
      body: JSON.stringify({
        approver: document.querySelector('#approval-identity').value,
        decision,
        notes: document.querySelector('#approval-notes').value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'owner decision failed');
    status.textContent =
      `${decision === 'approved' ? 'Approved' : 'Rejected'} recovered sequence revision ${result.revision}.`;
  } catch (error) {
    status.textContent = `Could not record owner decision: ${error.message}`;
  }
}

approveButton.addEventListener('click', () => submitDecision('approved'));
rejectButton.addEventListener('click', () => submitDecision('rejected'));

async function initialize() {
  try {
    const response = await fetch('/api/recovery-session');
    if (!response.ok) throw new Error(`recovery session returned ${response.status}`);
    session = await response.json();
    const selectedByCandidate = new Map(
      (session.selection?.frames ?? []).map((frame) => [frame.candidateId, frame])
    );
    candidates = session.recovery.proposedOrder.map((candidateId) => {
      const source = session.recovery.candidates.find(({ id }) => id === candidateId);
      const selected = selectedByCandidate.get(candidateId);
      const componentRoles = Object.fromEntries(
        source.componentIds.map((componentId) => {
          const track = selected?.tracks.find((item) => item.componentIds.includes(componentId));
          return [componentId, track?.role ?? 'actor'];
        })
      );
      return {
        ...source,
        selected: Boolean(selected),
        frameId: selected?.id ?? '',
        durationMs: selected?.durationMs ?? 100,
        componentRoles
      };
    });
    document.querySelector('#project-title').textContent =
      `${session.project.character.name} / Recovery`;
    document.querySelector('#component-count').textContent =
      `${session.recovery.components.length} components`;
    document.querySelector('#recovery-overlay').src =
      `/api/overlay/${session.recovery.overlay.sha256}`;
    document.querySelector('#recovery-hash').textContent = session.recoverySha256;
    document.querySelector('#selection-hash').textContent =
      session.selectionRevision > 0 ? session.selectionSha256 : 'Not saved';
    const approver = document.querySelector('#approval-identity');
    for (const identity of session.project.approvals.identities) {
      const option = document.createElement('option');
      option.value = identity;
      option.textContent = identity;
      approver.append(option);
    }
    dirty = false;
    render();
    setStatusForState('Immutable recovery loaded. ');
    shell.dataset.loading = 'false';
  } catch (error) {
    status.textContent = `Could not load recovery Studio: ${error.message}`;
  }
}

initialize();
