/**
 * A drop of water above everything on the page. The engine's canvas sits behind the page, so a drop that
 * should pass over text and panels is drawn here instead: a round element on the top layer whose
 * backdrop is bent through an SVG displacement map (Chromium; elsewhere it is a clear drop without the
 * bending), with the drop's rim, glints and focused light in CSS on top.
 */

const NS = 'http://www.w3.org/2000/svg';
/** Magnification at the centre is 1 / (1 - SQUEEZE); toward the rim the view is squeezed much harder. */
const SQUEEZE = 0.26;
/** Map value per unit of offset (offsets are in drop radii and stay within ±0.68). */
const K = 0.7;
const MAP = 128;

let ids = 0;

/** Where each point of the drop looks instead, as R/G around 0.5: the same lens as the shader's drops. */
function lensMap() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = MAP;
  const ctx = cv.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(MAP, MAP);
  for (let j = 0; j < MAP; j++) {
    for (let i = 0; i < MAP; i++) {
      const u = ((i + 0.5) / MAP) * 2 - 1;
      const v = ((j + 0.5) / MAP) * 2 - 1;
      const rho = Math.hypot(u, v);
      let ox = 0;
      let oy = 0;
      if (rho < 1) {
        const edge = 1 - Math.sqrt(1 - rho * rho);
        const sq = SQUEEZE * (1 + 1.6 * edge * edge);
        ox = -u * sq;
        oy = -v * sq;
      }
      const k = (j * MAP + i) * 4;
      img.data[k] = Math.round(255 * (0.5 + ox * K));
      img.data[k + 1] = Math.round(255 * (0.5 + oy * K));
      img.data[k + 2] = 128;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL();
}

export class TopDrop {
  private el: HTMLDivElement;
  private svg: SVGSVGElement;
  private filter: SVGFilterElement;
  private image: SVGFEImageElement;
  private disp: SVGFEDisplacementMapElement;
  private r = 0;
  private shown = false;

  constructor() {
    const id = `top-drop-lens-${++ids}`;
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('width', '0');
    this.svg.setAttribute('height', '0');
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.style.position = 'absolute';
    this.filter = document.createElementNS(NS, 'filter');
    this.filter.id = id;
    this.filter.setAttribute('filterUnits', 'userSpaceOnUse');
    this.filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
    this.filter.setAttribute('color-interpolation-filters', 'sRGB');
    this.image = document.createElementNS(NS, 'feImage');
    this.image.setAttribute('href', lensMap());
    this.image.setAttribute('preserveAspectRatio', 'none');
    this.image.setAttribute('result', 'map');
    this.disp = document.createElementNS(NS, 'feDisplacementMap');
    this.disp.setAttribute('in', 'SourceGraphic');
    this.disp.setAttribute('in2', 'map');
    this.disp.setAttribute('xChannelSelector', 'R');
    this.disp.setAttribute('yChannelSelector', 'G');
    this.filter.append(this.image, this.disp);
    this.svg.append(this.filter);
    document.body.append(this.svg);

    this.el = document.createElement('div');
    this.el.className = 'top-drop';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.setProperty('--lens', `url(#${id})`);
    document.body.append(this.el);
  }

  /** Puts the drop at (x, y) with radius r (px), or hides it when r is 0. */
  set(x: number, y: number, r: number) {
    if (r < 1) {
      if (this.shown) {
        this.el.style.opacity = '0';
        this.shown = false;
      }
      return;
    }
    // the filter is sized in px, so it is only rebuilt when the drop changes size
    const rr = Math.round(r * 2) / 2;
    if (rr !== this.r) {
      this.r = rr;
      const d = String(rr * 2);
      for (const a of ['x', 'y']) {
        this.filter.setAttribute(a, '0');
        this.image.setAttribute(a, '0');
      }
      for (const a of ['width', 'height']) {
        this.filter.setAttribute(a, d);
        this.image.setAttribute(a, d);
      }
      this.disp.setAttribute('scale', String(rr / K));
      this.el.style.width = this.el.style.height = `${rr * 2}px`;
      this.el.style.fontSize = `${rr}px`;
    }
    this.el.style.transform = `translate3d(${x - rr}px, ${y - rr}px, 0)`;
    if (!this.shown) {
      this.el.style.opacity = '1';
      this.shown = true;
    }
  }

  dispose() {
    this.el.remove();
    this.svg.remove();
  }
}
