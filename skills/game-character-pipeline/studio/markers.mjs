const TOOL_DEFINITIONS = [
  ['Root pivot', 'root', 'root-pivot'],
  ['Baseline', 'baseline', 'baseline'],
  ['Left foot', 'left-foot', 'planted-foot'],
  ['Right foot', 'right-foot', 'planted-foot'],
  ['Hand', 'hand', 'socket'],
  ['Prop grip', 'prop-grip', 'prop-grip'],
  ['Effect origin', 'effect-origin', 'socket']
];

function element(name, properties = {}, children = []) {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'className') node.className = value;
    else if (key === 'textContent') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function labeledInput(labelText, input) {
  return element('label', { className: 'author-field' }, [element('span', { textContent: labelText }), input]);
}

function titleForTrack(kind) {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} track`;
}

export function installMarkerAuthoring({ root, canvas, project, actionId, getFrame, getFrames, onChange }) {
  let activeTool = null;
  const history = [];
  const controls = {};

  const tools = element('div', { className: 'marker-tools', role: 'toolbar', 'aria-label': 'Landmark tools' });
  for (const [label, id, kind] of TOOL_DEFINITIONS) {
    const button = element('button', {
      type: 'button',
      textContent: label,
      dataset: { markerTool: `${kind}:${id}` },
      'aria-pressed': 'false'
    });
    button.addEventListener('click', () => {
      activeTool = { id, kind };
      for (const candidate of tools.querySelectorAll('[data-marker-tool]')) candidate.setAttribute('aria-pressed', String(candidate === button));
      onChange(`${label} tool selected. Click the frame to place it.`, { render: false });
    });
    tools.append(button);
  }
  for (const socket of project.sockets.filter(({ id }) => id !== 'hand' && id !== 'effect-origin')) {
    const button = element('button', { type: 'button', textContent: `Socket ${socket.id}`, 'aria-pressed': 'false' });
    button.addEventListener('click', () => {
      activeTool = { id: socket.id, kind: 'socket' };
      for (const candidate of tools.querySelectorAll('button')) candidate.setAttribute('aria-pressed', String(candidate === button));
      onChange(`Socket ${socket.id} tool selected. Click the frame to place it.`, { render: false });
    });
    tools.append(button);
  }

  const timing = element('fieldset', { className: 'author-group' }, [element('legend', { textContent: 'Frame timing & alignment' })]);
  controls.duration = element('input', { type: 'number', min: '1', max: '65535', step: '1' });
  controls.translationX = element('input', { type: 'number', min: '-16384', max: '16384', step: '1', 'aria-label': 'Translation X' });
  controls.translationY = element('input', { type: 'number', min: '-16384', max: '16384', step: '1', 'aria-label': 'Translation Y' });
  timing.append(
    labeledInput('Duration', controls.duration),
    labeledInput('Translation X', controls.translationX),
    labeledInput('Translation Y', controls.translationY)
  );

  const contactGroup = element('fieldset', { className: 'author-group' }, [element('legend', { textContent: 'Contact interval & travel' })]);
  controls.contacts = new Map();
  for (const contact of project.contacts) {
    const input = element('input', { type: 'checkbox' });
    const human = contact.id.replace(/-/g, ' ');
    const label = contact.id === 'left-foot' ? 'Planted left foot' : contact.id === 'right-foot' ? 'Planted right foot' : `Planted ${human}`;
    controls.contacts.set(contact.id, input);
    contactGroup.append(element('label', { className: 'check-field' }, [input, element('span', { textContent: label })]));
  }
  controls.travelX = element('input', { type: 'number', min: '-16384', max: '16384', step: '1', 'aria-label': 'Ground travel X' });
  controls.travelY = element('input', { type: 'number', min: '-16384', max: '16384', step: '1', 'aria-label': 'Ground travel Y' });
  contactGroup.append(labeledInput('Ground travel X', controls.travelX), labeledInput('Ground travel Y', controls.travelY));

  const trackGroup = element('fieldset', { className: 'author-group track-group' }, [element('legend', { textContent: 'Tracks' })]);
  controls.tracks = new Map();
  const allowedTracks = new Set(project.actions.find(({ id }) => id === actionId)?.tracks ?? []);
  for (const track of project.tracks) {
    const input = element('input', { type: 'checkbox' });
    input.disabled = !allowedTracks.has(track.id);
    controls.tracks.set(track.id, input);
    trackGroup.append(element('label', { className: 'track-field' }, [
      input,
      element('span', { textContent: titleForTrack(track.kind) }),
      element('code', { textContent: track.id })
    ]));
  }

  const transformGroup = element('fieldset', { className: 'author-group repair-group' }, [element('legend', { textContent: 'Global repair' })]);
  controls.transformOptIn = element('input', { type: 'checkbox' });
  controls.scale = element('input', { type: 'number', min: '1', max: '8', step: '1', value: '1', 'aria-label': 'Global integer scale' });
  controls.rotation = element('select', { 'aria-label': 'Global quarter turns' });
  for (const value of [-3, -2, -1, 0, 1, 2, 3]) controls.rotation.append(element('option', { value: String(value), textContent: String(value) }));
  controls.rotation.value = '0';
  transformGroup.append(
    element('label', { className: 'check-field' }, [controls.transformOptIn, element('span', { textContent: 'Confirm global transform repair' })]),
    labeledInput('Integer scale', controls.scale),
    labeledInput('Quarter turns', controls.rotation)
  );

  root.replaceChildren(tools, timing, contactGroup, trackGroup, transformGroup);

  function snapshot() {
    history.push(getFrames().map(({ id, edit }) => ({ id, edit: structuredClone(edit) })));
    document.querySelector('#undo-edit').disabled = false;
  }

  function mutate(message, operation) {
    snapshot();
    operation(getFrame().edit);
    onChange(message, { render: true });
  }

  function mutateAll(message, operation) {
    snapshot();
    for (const frame of getFrames()) operation(frame.edit);
    onChange(message, { render: true });
  }

  controls.duration.addEventListener('change', () => mutate('Updated authored frame duration.', (edit) => { edit.durationMs = Number(controls.duration.value); }));
  controls.translationX.addEventListener('change', () => mutate('Updated non-destructive X translation.', (edit) => { edit.translation.x = Number(controls.translationX.value); }));
  controls.translationY.addEventListener('change', () => mutate('Updated non-destructive Y translation.', (edit) => { edit.translation.y = Number(controls.translationY.value); }));
  controls.travelX.addEventListener('change', () => mutate('Updated authored ground travel.', (edit) => { edit.groundTravel.x = Number(controls.travelX.value); }));
  controls.travelY.addEventListener('change', () => mutate('Updated authored ground travel.', (edit) => { edit.groundTravel.y = Number(controls.travelY.value); }));
  for (const [id, input] of controls.contacts) {
    input.addEventListener('change', () => mutate('Updated planted-foot contact interval.', (edit) => {
      edit.contacts = input.checked ? [...new Set([...edit.contacts, id])] : edit.contacts.filter((contact) => contact !== id);
    }));
  }
  for (const [id, input] of controls.tracks) {
    input.addEventListener('change', () => mutate('Updated explicit frame tracks.', (edit) => {
      edit.tracks = input.checked ? [...new Set([...edit.tracks, id])] : edit.tracks.filter((track) => track !== id);
    }));
  }
  controls.transformOptIn.addEventListener('change', () => {
    if (controls.transformOptIn.checked && !window.confirm('Apply one integer scale and quarter-turn rotation to every frame in this clip?')) {
      controls.transformOptIn.checked = false;
      return;
    }
    mutateAll('Updated explicit global transform repair.', (edit) => {
      edit.transform = controls.transformOptIn.checked ? { scale: Number(controls.scale.value), rotationQuarterTurns: Number(controls.rotation.value) } : null;
    });
  });
  for (const input of [controls.scale, controls.rotation]) {
    input.addEventListener('change', () => {
      if (!controls.transformOptIn.checked) return;
      mutateAll('Updated explicit global transform repair.', (edit) => {
        edit.transform = { scale: Number(controls.scale.value), rotationQuarterTurns: Number(controls.rotation.value) };
      });
    });
  }

  canvas.addEventListener('click', (event) => {
    if (!activeTool) return;
    const rect = event.target.getBoundingClientRect();
    const x = Math.max(0, Math.min(project.canvas.width - 1, Math.floor(((event.clientX - rect.left) / rect.width) * project.canvas.width)));
    const y = Math.max(0, Math.min(project.canvas.height - 1, Math.floor(((event.clientY - rect.top) / rect.height) * project.canvas.height)));
    mutate(`Placed ${activeTool.id} at ${x}, ${y}.`, (edit) => {
      edit.markers = edit.markers.filter(({ id, kind }) => id !== activeTool.id || kind !== activeTool.kind);
      edit.markers.push({ ...activeTool, x, y });
    });
  });

  document.querySelector('#undo-edit').addEventListener('click', () => {
    const previous = history.pop();
    if (!previous) return;
    for (const saved of previous) {
      const frame = getFrames().find(({ id }) => id === saved.id);
      if (frame) frame.edit = saved.edit;
    }
    document.querySelector('#undo-edit').disabled = history.length === 0;
    onChange('Restored the previous non-destructive edit state.', { render: true });
  });

  function refresh() {
    const frame = getFrame();
    if (!frame) return;
    const edit = frame.edit;
    controls.duration.value = String(edit.durationMs);
    controls.duration.setAttribute('aria-label', `Duration ${frame.id}`);
    controls.translationX.value = String(edit.translation.x);
    controls.translationY.value = String(edit.translation.y);
    controls.travelX.value = String(edit.groundTravel.x);
    controls.travelY.value = String(edit.groundTravel.y);
    for (const [id, input] of controls.contacts) input.checked = edit.contacts.includes(id);
    for (const [id, input] of controls.tracks) input.checked = edit.tracks.includes(id);
    controls.transformOptIn.checked = edit.transform !== null;
    controls.scale.value = String(edit.transform?.scale ?? 1);
    controls.rotation.value = String(edit.transform?.rotationQuarterTurns ?? 0);
  }

  return { refresh };
}
