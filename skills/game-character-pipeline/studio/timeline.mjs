const cloneFrames = (frames) => frames.map((frame) => ({ ...frame }));

export class FrameTimeline extends HTMLElement {
  #frames = [];
  #selected = 0;

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
      this.#emit('frame-include', { index, included: row.dataset.included !== 'true' });
      return;
    }
    if (action === 'duplicate') {
      this.#emit('frame-duplicate', { index });
      return;
    }
    if (event.target.matches('input')) return;
    this.#emit('frame-select', { index });
  }

  #onInput(event) {
    const row = this.#rowFrom(event);
    if (!row || !event.target.matches('[data-label]')) return;
    this.#emit('frame-label', { index: Number(row.dataset.index), label: event.target.value });
  }

  #onKeydown(event) {
    const row = this.#rowFrom(event);
    if (!row || event.target.matches('input')) return;
    const index = Number(row.dataset.index);
    const targets = { ArrowLeft: index - 1, ArrowUp: index - 1, ArrowRight: index + 1, ArrowDown: index + 1, Home: 0, End: this.#frames.length - 1 };
    if (Object.hasOwn(targets, event.key)) {
      event.preventDefault();
      this.#emit('frame-select', { index: Math.max(0, Math.min(targets[event.key], this.#frames.length - 1)), focus: true });
    } else if (event.key === 'Delete') {
      event.preventDefault();
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
      copy.append(ordinal, name, duration, label);

      const actions = document.createElement('div');
      actions.className = 'frame-actions';
      const include = document.createElement('button');
      include.type = 'button';
      include.dataset.action = 'include';
      include.setAttribute('aria-label', `${frame.included === false ? 'Include' : 'Exclude'} ${frame.id}`);
      include.textContent = frame.included === false ? '＋' : '✓';
      const duplicate = document.createElement('button');
      duplicate.type = 'button';
      duplicate.dataset.action = 'duplicate';
      duplicate.setAttribute('aria-label', `Duplicate ${frame.id}`);
      duplicate.textContent = '⧉';
      actions.append(include, duplicate);
      row.append(thumb, copy, actions);
      this.append(row);
    }
  }
}

customElements.define('frame-timeline', FrameTimeline);
