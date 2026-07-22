const observed = ['frame', 'previous', 'next', 'first', 'last', 'zoom', 'onion-opacity', 'seam', 'clipping', 'duplicates', 'palette', 'drift'];

function loadImage(source) {
  if (!source) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = source;
  });
}

export class FrameCanvas extends HTMLElement {
  static get observedAttributes() { return observed; }

  #canvas;
  #renderToken = 0;
  #markerState = { markers: [], canvas: null };

  constructor() {
    super();
    this.#canvas = document.createElement('canvas');
    this.#canvas.setAttribute('aria-label', 'Selected animation frame');
    this.append(this.#canvas);
  }

  connectedCallback() { this.#render(); }
  attributeChangedCallback() { if (this.isConnected) this.#render(); }

  set markerState(value) {
    this.#markerState = structuredClone(value ?? { markers: [], canvas: null });
    if (this.isConnected) this.#render();
  }

  async #render() {
    const token = ++this.#renderToken;
    const [frame, previous, next, first, last] = await Promise.all(
      ['frame', 'previous', 'next', 'first', 'last'].map((name) => loadImage(this.getAttribute(name)).catch(() => null))
    );
    if (token !== this.#renderToken || !frame) return;
    const width = frame.naturalWidth;
    const height = frame.naturalHeight;
    const zoom = Math.max(1, Math.trunc(Number(this.getAttribute('zoom')) || 1));
    const source = new OffscreenCanvas(width, height);
    const sourceContext = source.getContext('2d');
    sourceContext.imageSmoothingEnabled = false;
    sourceContext.clearRect(0, 0, width, height);
    const alpha = Math.max(0, Math.min(0.8, Number(this.getAttribute('onion-opacity')) || 0.28));
    const layer = (image, opacity, operation = 'source-over') => {
      if (!image) return;
      sourceContext.save();
      sourceContext.globalAlpha = opacity;
      sourceContext.globalCompositeOperation = operation;
      sourceContext.drawImage(image, 0, 0, width, height);
      sourceContext.restore();
    };
    if (this.hasAttribute('previous')) layer(previous, alpha);
    if (this.hasAttribute('next')) layer(next, alpha);
    if (this.getAttribute('seam') === 'true') {
      layer(first, alpha * 0.7);
      layer(last, alpha * 0.7, 'screen');
    }
    layer(frame, 1);
    if (this.getAttribute('clipping') === 'true') {
      sourceContext.strokeStyle = '#ff5c7a';
      sourceContext.lineWidth = 1;
      sourceContext.strokeRect(0.5, 0.5, width - 1, height - 1);
    }
    if (this.getAttribute('duplicates') === 'true') {
      sourceContext.fillStyle = '#f59e0b';
      sourceContext.fillRect(width - 3, 1, 2, 2);
    }
    if (this.getAttribute('palette') === 'true') {
      sourceContext.fillStyle = '#63d5e8';
      sourceContext.fillRect(1, height - 2, Math.max(1, width - 2), 1);
    }
    if (this.getAttribute('drift') === 'true') {
      sourceContext.strokeStyle = '#63d5e8';
      sourceContext.beginPath();
      sourceContext.moveTo(width / 2, 0);
      sourceContext.lineTo(width / 2, height);
      sourceContext.moveTo(0, height / 2);
      sourceContext.lineTo(width, height / 2);
      sourceContext.stroke();
    }
    const logical = this.#markerState.canvas;
    if (logical) {
      for (const marker of this.#markerState.markers ?? []) {
        const x = ((marker.x + 0.5) / logical.width) * width;
        const y = ((marker.y + 0.5) / logical.height) * height;
        sourceContext.save();
        sourceContext.strokeStyle = marker.kind === 'planted-foot' ? '#f59e0b' : '#63d5e8';
        sourceContext.fillStyle = sourceContext.strokeStyle;
        sourceContext.lineWidth = 1;
        if (marker.kind === 'baseline') {
          sourceContext.beginPath();
          sourceContext.moveTo(0, y);
          sourceContext.lineTo(width, y);
          sourceContext.stroke();
        } else {
          sourceContext.beginPath();
          sourceContext.arc(x, y, Math.max(1, width / 64), 0, Math.PI * 2);
          sourceContext.fill();
          sourceContext.beginPath();
          sourceContext.moveTo(x - 2, y);
          sourceContext.lineTo(x + 2, y);
          sourceContext.moveTo(x, y - 2);
          sourceContext.lineTo(x, y + 2);
          sourceContext.stroke();
        }
        sourceContext.restore();
      }
    }
    this.#canvas.width = width * zoom;
    this.#canvas.height = height * zoom;
    const context = this.#canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    context.drawImage(source, 0, 0, this.#canvas.width, this.#canvas.height);
  }
}

customElements.define('frame-canvas', FrameCanvas);
