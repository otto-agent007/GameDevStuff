const cloneFrames = (frames) => frames.map((frame) => ({ ...frame }));

export class FrameTimeline extends HTMLElement {
  #frames = [];
  #selected = 0;
  #readOnly = false;

  connectedCallback() {
    this.addEventListener('click', (event) => this.#onClick(event));
    this.addEventListener('input', (event) => this.#onInput(event));
    this.addEventListener('keydown', (event) => this.#onKeydown(event));
    this.#render();
  }

  set frames(value) {
    this.#frames = cloneFrames(value ?? []);
    this.#selected = Math.min(this.#selected, Math.max(0, this.#frames.length - 1));
    this.#render();
  }

  get frames() {
    return cloneFrames(this.#frames);
  }

  set selectedIndex(value) {
    this.#selected = Math.max(0, Math.min(Number(value) || 0, Math.max(0, this.#frames.length - 1)));
    this.#render();
  }

  get selectedIndex() {
    return this.#selected;
  }

  set readOnly(value) {
    this.#readOnly = Boolean(value);
    this.#render();
  }

  get readOnly() {
    return this.#readOnly;
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
  }

  #rowFrom(event) {
    return event.target.closest?.('[data-frame-id]');
  }

  #onClick(event) {
    const row = this.#rowFrom(event);
    if (!row) return;
    const index = Number(row.dataset.index);
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'include') {
      if (this.#readOnly) return;
      this.#emit('frame-include', { index, included: row.dataset.included !== 'true' });
      return;
    }
    if (action === 'duplicate') {
      if (this.#readOnly) return;
      this.#emit('frame-duplicate', { index });
      return;
    }
    if (event.target.matches('input')) return;
    this.#emit('frame-select', { index });
  }

  #onInput(event) {
    const row = this.#rowFrom(event);
    if (this.#readOnly || !row || !event.target.matches('[data-label]')) return;
    this.#emit('frame-label', { index: Number(row.dataset.index), label: event.target.value });
  }

  #onKeydown(event) {
    const row = this.#rowFrom(event);
    if (!row || event.target.matches('input')) return;
    const index = Number(row.dataset.index);
    const transport = {
      ArrowLeft: 'previous',
      ArrowUp: 'previous',
      ArrowRight: 'next',
      ArrowDown: 'next',
      Home: 'first',
      End: 'last'
    };
    if (Object.hasOwn(transport, event.key)) {
      event.preventDefault();
      event.stopPropagation();
      this.#emit('frame-transport', { command: transport[event.key] });
    } else if (event.key === 'Delete') {
      event.preventDefault();
      event.stopPropagation();
      this.#emit('frame-include', { index, included: false });
    }
  }

  focusSelected() {
    this.querySelector('[aria-current="true"]')?.focus();
  }

  #render() {
    if (!this.isConnected) return;
    this.replaceChildren();
    for (const [index, frame] of this.#frames.entries()) {
      const row = document.createElement('article');
      row.className = 'frame-row';
      row.dataset.frameId = frame.id;
      row.dataset.index = String(index);
      row.dataset.included = String(frame.included !== false);
      row.dataset.readOnly = String(this.#readOnly);
      row.setAttribute('aria-current', String(index === this.#selected));
      row.tabIndex = index === this.#selected ? 0 : -1;

      const thumb = document.createElement('div');
      thumb.className = 'frame-thumb';
      const image = document.createElement('img');
      image.src = frame.url;
      image.alt = '';
      image.draggable = false;
      thumb.append(image);

      const copy = document.createElement('div');
      copy.className = 'frame-copy';
      const ordinal = document.createElement('span');
      ordinal.className = 'frame-ordinal';
      ordinal.textContent = String(index + 1).padStart(2, '0');
      const name = document.createElement('strong');
      name.textContent = frame.id;
      const duration = document.createElement('span');
      duration.className = 'frame-duration';
      duration.textContent = `${frame.durationMs} ms`;
      const label = document.createElement('input');
      label.dataset.label = '';
      label.value = frame.label ?? '';
      label.placeholder = 'Add label';
      label.setAttribute('aria-label', `Label ${frame.id}`);
      label.disabled = this.#readOnly;
      copy.append(ordinal, name, duration, label);
      if (frame.edit?.contacts?.length) {
        const contacts = document.createElement('span');
        contacts.className = 'contact-span';
        contacts.textContent = frame.edit.contacts.join(' · ');
        copy.append(contacts);
      }
      if (frame.included === false) {
        const state = document.createElement('span');
        state.className = 'frame-state';
        state.textContent = 'Excluded';
        copy.append(state);
      }

      const actions = document.createElement('div');
      actions.className = 'frame-actions';
      const include = document.createElement('button');
      include.type = 'button';
      include.dataset.action = 'include';
      include.setAttribute('aria-label', `${frame.included === false ? 'Include' : 'Exclude'} ${frame.id}`);
      include.textContent = frame.included === false ? '＋' : '✓';
      include.disabled = this.#readOnly;
      const duplicate = document.createElement('button');
      duplicate.type = 'button';
      duplicate.dataset.action = 'duplicate';
      duplicate.setAttribute('aria-label', `Duplicate ${frame.id}`);
      duplicate.textContent = '⧉';
      duplicate.disabled = this.#readOnly;
      actions.append(include, duplicate);
      row.append(thumb, copy, actions);
      this.append(row);
    }
  }
}

customElements.define('frame-timeline', FrameTimeline);
