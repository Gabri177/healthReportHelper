import * as THREE from 'three';
import { TopDrop } from './lens';
import { FRAG, MAXB, MAXBUB, MAXRAIN, NP, RAIN_FRAG, RAIN_VERT, VERT } from './shader';

type Vec3 = [number, number, number];
type Body = { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number };
type Batch = { hit: boolean; cb?: () => void };
type Projectile = Body & { wait: number; wob: number; go: boolean; sink: boolean; batch: Batch };
/** Loose water. `own` drops came out of the main drop and carry its volume. */
type Drop = Body & { age: number; own: boolean; drain: boolean; dead?: boolean; kin?: Kin };
/** A drop held in place (moving from (x0, y0) to (x1, y1) over `dur`, slow-fast-slow), bobbing there until the pull. */
type Kin = { x0: number; y0: number; x1: number; y1: number; t0: number; dur: number; ph: number };
/** Where raindrops drawn back in gather: a drop that grows from nothing to `target` (share of the drop's water). */
type Sink = { x: number; y: number; target: number; vol: number; drop: Drop | null };
/** A raindrop due to set off at `at` (seconds into the gathering) from (x, y) toward sink `to`, carrying `vol`. */
type Spawn = { at: number; x: number; y: number; to: number; vol: number; water: boolean };
/** Share of the drop left in the middle while it gathers: a small seed for the rest to rush into. */
const SEED = 0.015;
/** Evaporating droplets: they leave the surface, drift off and shrink away. */
type Mist = Body & { r0: number; age: number; life: number };
type Bead = { id: string; x: number; y: number; vx: number; vy: number; r: number; el: HTMLElement | null; home: boolean; age: number; dead?: boolean };
/** A vapour bubble inside the boiling drop (coordinates in core radii; z is toward the viewer). */
type Bubble = { x: number; y: number; z: number; r: number; vy: number; ph: number; a: number };
/** A spot that keeps giving off fine bubbles while the drop boils. */
type Site = { x: number; y: number; z: number; clock: number };
/** Water clinging to the pointer. While `tether` is set it is still joined to the drop by a neck. */
type Cling = { x: number; y: number; vx: number; vy: number; r: number; tether: boolean; breakAt: number };
/** A raindrop (a streak) or a splash droplet (a dot). */
type Streak = { x: number; y: number; vx: number; vy: number; w: number; len: number; a: number; age: number; splash: boolean; dead?: boolean };
/** A raindrop being drawn back in, on its way to a sink. */
type Inflow = Streak & { to: number; vol: number };

export type BeadSpec = { id: string; el: HTMLElement | null };
export type Pointer = { x: number; y: number; drag: boolean } | null;
/**
 * `float`: the drop hangs in the middle and its gravity pulls loose water back in.
 * `settle`: the result is in. The drop boils over and bursts, then it rains; the water collects along the
 * bottom of the page, seen from the side like a tank, and its level rises with the rain.
 */
export type Mode = 'float' | 'settle';

// ---- feel. Units: px and seconds.
/** Pull of the centre on loose water while floating (px/s² at the surface, weakening slowly with distance). */
const GRAVITY = 2400;
/** Air drag on loose water, and the extra drag of wetting close to the surface (so drops ease in, never bounce off). */
const DRAG = 1.8;
const WET_DRAG = 7;
/** Downward gravity once the drop has burst. */
const FALL = 2600;
/** How quickly a drop that touches the surface flows into it. */
const DRAIN = 6;
/** How tightly clinging water follows the pointer, and the pointer speed (px/s) that flicks it off. */
const STICK = 240;
const FLICK = 1300;
/** Evaporation while idle (droplets per second). */
const MIST_RATE = 2.2;
/** Boiling: how many seconds the heat takes to build up while the report is written. */
const HEAT_RISE = 14;
/**
 * The tank: the rise (px) the drop alone gives it over a 720 px wide page; wave speed (px/s), damping (1/s) and
 * viscosity (px²/s, it calms the short ripples first).
 * Waves are fast, as in real water a few centimetres deep, so the level evens out within a second and stays flat.
 */
const DROP_DEPTH = 40;
const WAVE = 1100;
const WAVE_DAMP = 1.6;
const WAVE_VISC = 300;
/**
 * Rain: drops per second at full strength, seconds to fill the tank, and its final level (share of the page height).
 * Once the level is reached the rain eases off to a drizzle that never quite stops (DRIZZLE drops per second).
 */
const RAIN_RATE = 70;
const DRIZZLE = 14;
const FILL_TIME = 10;
const LEVEL = 0.24;
/** Seconds the drop swells, boiling over, before it bursts (the cards are dealt just after, see .fan-card). */
const FUSE = 0.4;
const SUBSTEPS = 3;
const MAX_DROPS = 40;
const MAX_MIST = 16;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export class LiquidEngine {
  readonly ok: boolean;
  pointer: Pointer = null;
  dragCount = 1;
  /** Pointer and file-drag feedback on the drop is only active while true. */
  interactive = true;
  /** How hard the water should be boiling, 0–1 (it builds up slowly and cools quickly). */
  heatTarget = 0;
  /** Elements raindrops splash on (their top edges). */
  obstacles = '';

  private renderer?: THREE.WebGLRenderer;
  /** Water on the pointer, once it has come away from the drop, is drawn above the page (see lens.ts). */
  private top?: TopDrop;
  private mat?: THREE.ShaderMaterial;
  private rainMat?: THREE.ShaderMaterial;
  private rainGeo?: THREE.InstancedBufferGeometry;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private anchor: HTMLElement | null = null;
  private mode: Mode = 'float';
  /** Seconds left of the swell before the boiling drop bursts. */
  private fuse = 0;
  private heat = 0;
  private raf = 0;
  private last = performance.now();
  private t = 0;
  private sc = 1;
  private scV = 0;
  private sq = 0;
  private sqV = 0;
  private sqAxis: Vec3 = [0, 1, 0];
  /** Floating: offset of the drop from its rest position (springs back). */
  private off = { x: 0, y: 0, vx: 0, vy: 0 };
  /** The tank along the bottom: level heightfield (px above the bottom edge), its vertical velocity, and its area (px²). */
  private tank = { on: false, drain: false, area: 0, h: new Float32Array(NP), v: new Float32Array(NP), tmp: new Float32Array(NP) };
  private rain: Streak[] = [];
  private rainRate = 0;
  private rainClock = 0;
  private rainWait = 0;
  private wind = 0;
  private wasUnder = false;
  /**
   * Back to floating, like a black hole drawing in rain: raindrops are pulled in from all round the page and off the
   * water, slowly at first and then faster, swirling a little and speeding up as they fall in. They gather into drops
   * of all sizes around the middle, which grow from nothing; when all the rain is in, the centre pulls hard for a
   * moment and the drops rush together. `t` is the time since it began (-1: not gathering); `rushAt` when the pull
   * starts; `launched` the share of the water already set off; `swirl` the way it turns.
   */
  private gather = { t: -1, area0: 0, rushAt: Infinity, launched: 0, swirl: 1 };
  private sinks: Sink[] = [];
  private spawns: Spawn[] = [];
  private inflow: Inflow[] = [];
  /** Volume (in drops) not yet gathered into a drop: still in the tank or on its way in. */
  private liftVolume = 0;
  /** Strength of the centre's pull: 1, and briefly much more when the gathered drops are drawn in. */
  private pull = 1;
  private rects: DOMRect[] = [];
  private imps: { dir: Vec3; age: number; k: number }[] = [];
  private proj: Projectile[] = [];
  private drops: Drop[] = [];
  private mist: Mist[] = [];
  private mistClock = 0;
  private cling: Cling | null = null;
  private wasInside = false;
  private insideFor = 0;
  private beads = new Map<string, Bead>();
  private bubs: Bubble[] = [];
  private bubClock = 0;
  private sites: Site[] = [];
  private fe = { ox: 0, oy: 0, r: 0 };
  private cur = { x: 0, y: 0, r: 0, rV: 0, vx: 0, vy: 0 };
  private pv = { x: 0, y: 0, vx: 0, vy: 0, ok: false };
  private R0 = 110;
  private cx = 0;
  private cy = 0;
  private ax = 0;
  private ay = 0;
  private R = 110;
  private W = 1;
  private H = 1;
  private shadow = 1;
  private reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private quality = Math.min(window.devicePixelRatio || 1, 1.5);
  private slow = 0;
  private size = { w: 0, h: 0, q: 0 };
  private buf = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement) {
    let renderer: THREE.WebGLRenderer | undefined;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    } catch {
      renderer = undefined;
    }
    this.ok = !!renderer;
    if (!renderer) return;
    this.renderer = renderer;
    this.top = new TopDrop();
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uRes: { value: new THREE.Vector2() },
        uScale: { value: 1 },
        uTime: { value: 0 },
        uCore: { value: new THREE.Vector4() },
        uSq: { value: new THREE.Vector4(0, 1, 0, 0) },
        uImp: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, 1, -1)) },
        uImpK: { value: new THREE.Vector4() },
        uB: { value: Array.from({ length: MAXB }, () => new THREE.Vector4()) },
        uN: { value: 0 },
        uBub: { value: Array.from({ length: MAXBUB }, () => new THREE.Vector4()) },
        uNB: { value: 0 },
        uZTop: { value: 200 },
        uBoil: { value: 0 },
        uFloor: { value: new THREE.Vector2() },
        uShadow: { value: 1 },
        uGround: { value: -1 },
        uPool: { value: Array.from({ length: NP / 4 }, () => new THREE.Vector4()) },
        uWaterOn: { value: 0 },
        uLevel: { value: 0 },
      },
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    // rain: one instanced quad per streak or splash droplet, blended over the page
    const quad = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('aP', new THREE.InstancedBufferAttribute(new Float32Array(MAXRAIN * 2), 2));
    geo.setAttribute('aD', new THREE.InstancedBufferAttribute(new Float32Array(MAXRAIN * 2), 2));
    geo.setAttribute('aS', new THREE.InstancedBufferAttribute(new Float32Array(MAXRAIN * 2), 2));
    geo.setAttribute('aA', new THREE.InstancedBufferAttribute(new Float32Array(MAXRAIN), 1));
    geo.instanceCount = 0;
    this.rainGeo = geo;
    this.rainMat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
      uniforms: { uView: { value: new THREE.Vector2(1, 1) } },
    });
    const rainMesh = new THREE.Mesh(geo, this.rainMat);
    rainMesh.frustumCulled = false;
    rainMesh.renderOrder = 1;
    this.scene.add(rainMesh);

    this.raf = requestAnimationFrame(this.frame);
  }

  setAnchor(el: HTMLElement | null) {
    this.anchor = el;
  }

  setMode(m: Mode) {
    if (m === 'settle') {
      if (this.mode === 'settle' || this.fuse > 0) return;
      // a boiling drop swells for a moment before it bursts
      this.fuse = this.reduce ? 0.01 : FUSE;
    } else {
      if (this.fuse > 0) this.fuse = 0;
      if (this.mode === 'float') return;
      this.mode = 'float';
      this.gatherUp();
    }
  }

  isHot(x: number, y: number) {
    return Math.hypot(x - this.cx, y - this.cy) < this.R0 * 1.14;
  }

  /** A file becomes a water blob at (x, y) that is pulled into the droplet; `onHit` fires on the first impact. */
  launch(x: number, y: number, n: number, onHit?: () => void, fromCursor = false) {
    const batch: Batch = { hit: false, cb: onHit };
    if (!this.ok) {
      batch.hit = true;
      onHit?.();
      return;
    }
    const k = Math.max(1, Math.min(4, n));
    const r0 = fromCursor && this.cur.r > 1 ? this.cur.r : 0;
    if (fromCursor) this.cur.r = 0;
    for (let i = 0; i < k; i++) {
      this.proj.push({
        x: x + (i ? rnd(-18, 18) : 0),
        y: y + (i ? rnd(-18, 18) : 0),
        z: 0, vx: 0, vy: 0, vz: 0, wob: 0,
        r: i === 0 && r0 ? r0 : this.R0 * (k === 1 ? 0.24 : 0.18),
        wait: i * 0.12, go: false, sink: false, batch,
      });
    }
    if (this.proj.length > 6) this.proj.splice(0, this.proj.length - 6);
    setTimeout(() => {
      if (!batch.hit) {
        batch.hit = true;
        batch.cb?.();
      }
    }, 1800);
  }

  /** Question beads: each one buds off the drop and floats to its element (or waits near it); removed ones fall back in. */
  setBeads(specs: BeadSpec[]) {
    const ids = new Set(specs.map(s => s.id));
    for (const b of this.beads.values()) if (!ids.has(b.id)) b.home = true;
    for (const s of specs) {
      const b = this.beads.get(s.id);
      if (b) {
        b.el = s.el;
        b.home = false;
      } else {
        const a = rnd(-1.2, -0.3);
        this.beads.set(s.id, {
          id: s.id,
          x: this.cx + Math.cos(a) * this.R * 0.55,
          y: this.cy + Math.sin(a) * this.R * 0.55,
          vx: Math.cos(a) * 160,
          vy: Math.sin(a) * 160,
          r: this.R0 * 0.06,
          el: s.el,
          home: false,
          age: Math.random() * 10,
        });
      }
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.top?.dispose();
    this.mat?.dispose();
    this.rainMat?.dispose();
    this.rainGeo?.dispose();
    this.renderer?.dispose();
  }

  // ---------- events on the drop ----------

  private addDrop(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, own: boolean, age = 0) {
    this.drops.push({ x, y, z, vx, vy, vz, r, age, own, drain: false });
    if (this.drops.length > MAX_DROPS) {
      const i = this.drops.findIndex(d => !d.own);
      this.drops.splice(i >= 0 ? i : 0, 1);
    }
  }

  private ripple(dir: Vec3, k: number) {
    this.imps.unshift({ dir, age: 0, k });
    if (this.imps.length > 4) this.imps.length = 4;
  }

  /** Something hit the surface at p with p's velocity: crater, ripples, squash, splash and a rebound jet. */
  private impact(p: Body, sizeK = 1) {
    const { cx, cy, R } = this;
    let dx = p.x - cx;
    let dy = p.y - cy;
    let dz = p.z;
    let L = Math.hypot(dx, dy, dz);
    if (L < 1) {
      dx = 0; dy = 0; dz = 1; L = 1;
    }
    const dir: Vec3 = [dx / L, dy / L, dz / L];
    const vl = Math.hypot(p.vx, p.vy, p.vz);
    const sp = Math.max(900 * sizeK, vl);
    this.ripple(dir, Math.min(1.4, (0.55 + sp / 2400) * (p.r / (0.2 * this.R0))));
    this.sqAxis = vl > 1 ? [p.vx / vl, p.vy / vl, p.vz / vl] : [-dir[0], -dir[1], -dir[2]];
    this.sqV += Math.min(2.4, sp / 750) * sizeK;

    const ref: Vec3 = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    let t1: Vec3 = [dir[1] * ref[2] - dir[2] * ref[1], dir[2] * ref[0] - dir[0] * ref[2], dir[0] * ref[1] - dir[1] * ref[0]];
    const tl = Math.hypot(...t1) || 1;
    t1 = [t1[0] / tl, t1[1] / tl, t1[2] / tl];
    const t2: Vec3 = [dir[1] * t1[2] - dir[2] * t1[1], dir[2] * t1[0] - dir[0] * t1[2], dir[0] * t1[1] - dir[1] * t1[0]];
    const count = Math.round((6 + Math.min(6, sp / 450)) * sizeK * (this.reduce ? 0.5 : 1));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = rnd(380, 820) * (0.7 + sp / 2600);
      const side = rnd(120, 420);
      const tx = t1[0] * Math.cos(a) + t2[0] * Math.sin(a);
      const ty = t1[1] * Math.cos(a) + t2[1] * Math.sin(a);
      const tz = t1[2] * Math.cos(a) + t2[2] * Math.sin(a);
      this.addDrop(
        cx + dir[0] * R + tx * R * 0.1,
        cy + dir[1] * R + ty * R * 0.1,
        dir[2] * R + tz * R * 0.1,
        dir[0] * out + tx * side,
        dir[1] * out + ty * side,
        dir[2] * out + tz * side,
        R * rnd(0.03, 0.085),
        false,
      );
    }
    const js = 260 + sp * 0.08;
    this.addDrop(cx + dir[0] * R * 0.95, cy + dir[1] * R * 0.95, dir[2] * R * 0.95, dir[0] * js, dir[1] * js, dir[2] * js, R * 0.12 * sizeK, false);
  }

  /** The boiling drop bursts into a spray of drops that fall into the tank below; then it rains. */
  private burst() {
    const { cx, cy, R, R0 } = this;
    const total = this.coreVolume();
    this.releaseCling(0.3);
    this.beads.forEach(b => this.addDrop(b.x, b.y, 0, b.vx, b.vy, 0, b.r, true, 0.3));
    this.beads.clear();
    this.drops = this.drops.filter(d => d.own);
    for (const d of this.drops) d.kin = undefined;
    this.gather.t = -1;
    this.sinks = [];
    this.spawns = [];
    this.inflow = [];
    this.liftVolume = 0;
    this.pull = 1;
    this.bubs = [];
    // the skin tears and the water opens outward from the rim: a few heavier drops and a spray of fine ones.
    // (The pieces carry only part of the volume; the rain makes up the rest of the tank.)
    const big = this.reduce ? 3 : 7;
    const n = this.reduce ? 8 : 28;
    const a0 = rnd(0, Math.PI * 2);
    for (let i = 0; i < n; i++) {
      const heavy = i % Math.round(n / big) === 0;
      const r = R0 * (heavy ? rnd(0.15, 0.22) : rnd(0.04, 0.1)) * Math.cbrt(total);
      const a = a0 + (i / n) * Math.PI * 2 + rnd(-0.25, 0.25);
      const sp = (heavy ? rnd(140, 320) : rnd(320, 640)) * (this.reduce ? 0.4 : 1);
      const k = rnd(0.72, 0.95);
      // the steam gives everything a little lift, then it all falls
      this.addDrop(cx + Math.cos(a) * R * k, cy + Math.sin(a) * R * k, rnd(-0.35, 0.35) * R, Math.cos(a) * sp, Math.sin(a) * sp - 160, 0, r, true, -1);
    }
    // a puff of steam
    for (let k = 0; k < 10 && !this.reduce; k++) {
      const a = rnd(0, Math.PI * 2);
      this.mist.push({ x: cx + Math.cos(a) * R * 0.8, y: cy + Math.sin(a) * R * 0.8, z: 0, vx: Math.cos(a) * rnd(60, 160), vy: Math.sin(a) * rnd(60, 160) - 60, vz: 0, r: 0, r0: R0 * rnd(0.02, 0.045), age: 0, life: rnd(0.8, 1.6) });
    }
    const tk = this.tank;
    tk.on = true;
    tk.drain = false;
    tk.area = 0;
    tk.h.fill(0);
    tk.v.fill(0);
    this.rain = [];
    this.rainRate = 0;
    this.rainClock = 0;
    this.rainWait = 0.6; // a beat after the burst before the rain begins
    this.wind = rnd(-80, 80);
    this.heat = 0;
  }

  /** Back to floating: the rain stops, the tank drains away and the drop's own water rises back into the middle. */
  private gatherUp() {
    const tk = this.tank;
    const { W, H, R0 } = this;
    const cx = this.ax || W / 2;
    const cy = this.ay || H * 0.4;
    // the drops the rain gathers into: a few big, more small, around the middle at different distances and heights
    const k = this.reduce ? 5 : 10;
    const ws = Array.from({ length: k }, () => Math.pow(Math.random(), 1.6) + 0.06);
    const sum = ws.reduce((x, y) => x + y, 0);
    const targets = ws.map(w => ((1 - SEED) * w) / sum).sort((x, y) => y - x);
    const reach = Math.min(W, H) * 0.44;
    this.sinks = [];
    for (const target of targets) {
      const r = R0 * Math.cbrt(target);
      let best = { x: cx, y: cy, gap: -Infinity };
      for (let n = 0; n < 30; n++) {
        const a = rnd(0, Math.PI * 2);
        const dist = rnd(R0 * 1.25 + r, reach);
        // the whole drop stays on screen, even on a narrow phone
        const x = clamp(cx + Math.cos(a) * dist * 1.3, Math.max(0.06 * W, r + 12), Math.min(0.94 * W, W - r - 12));
        const y = clamp(cy + Math.sin(a) * dist * 0.85, Math.max(0.1 * H, r + 12), Math.min(0.78 * H, H - r - 12));
        const gap = Math.min(Math.hypot(x - cx, y - cy) - R0 * 0.9 - r, ...this.sinks.map(o => Math.hypot(x - o.x, y - o.y) - (R0 * Math.cbrt(o.target) + r) * 1.4 - 12));
        if (gap > best.gap) best = { x, y, gap };
        if (gap > 0) break;
      }
      this.sinks.push({ x: best.x, y: best.y, target, vol: 0, drop: null });
    }
    // the rain: many raindrops, each carrying a little; more of them come to the bigger drops
    const n = this.reduce ? 70 : 240;
    const spread = this.reduce ? 0.8 : 2.1;
    const picks: number[] = [];
    for (let i = 0; i < k; i++) for (let j = 0; j < 4; j++) picks.push(i);
    while (picks.length < n) {
      let u = Math.random() * (1 - SEED);
      let i = 0;
      while (i < k - 1 && u > targets[i]) u -= targets[i++];
      picks.push(i);
    }
    picks.sort(() => Math.random() - 0.5);
    const count = targets.map((_, i) => picks.filter(p => p === i).length);
    this.spawns = picks.map((to, i) => {
      // from the edge of the page beyond its drop, seen from the middle; rays that end below set off from the water
      const sk = this.sinks[to];
      const a = Math.atan2(sk.y - cy, sk.x - cx) + rnd(-1.1, 1.1);
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const tx = dx > 0 ? (W + 20 - cx) / dx : dx < 0 ? (-20 - cx) / dx : Infinity;
      const tyTop = dy < 0 ? (-20 - cy) / dy : Infinity;
      const tyBottom = dy > 0 ? (H - cy) / dy : Infinity;
      const t = Math.min(tx, tyTop, tyBottom);
      return {
        // slowly at first, then faster and faster
        at: spread * Math.pow((i + Math.random()) / n, 0.6),
        x: cx + dx * t,
        y: cy + dy * t,
        to,
        vol: targets[to] / count[to],
        water: t === tyBottom,
      };
    });
    this.spawns.sort((x, y) => x.at - y.at);
    this.inflow = [];
    this.liftVolume = 1 - SEED;
    this.gather = { t: 0, area0: tk.on ? tk.area : 0, rushAt: Infinity, launched: 0, swirl: Math.random() < 0.5 ? -1 : 1 };
    tk.drain = false;
    this.rain = [];
    this.rainRate = 0;
    this.off = { x: 0, y: 0, vx: 0, vy: 0 };
  }

  /** A raindrop reaches its sink: the drop there grows by what it carried. */
  private absorb(f: Inflow) {
    f.dead = true;
    const sk = this.sinks[f.to];
    sk.vol += f.vol;
    this.liftVolume = Math.max(0, this.liftVolume - f.vol);
    const r = this.R0 * Math.cbrt(sk.vol);
    if (sk.drop) sk.drop.r = r;
    else {
      // held where it gathers, bobbing a little, until the pull
      sk.drop = { x: sk.x, y: sk.y, z: 0, vx: 0, vy: 0, vz: 0, r, age: 0, own: true, drain: false, kin: { x0: sk.x, y0: sk.y, x1: sk.x, y1: sk.y, t0: -10, dur: 1, ph: rnd(0, 6) } };
      this.drops.push(sk.drop);
    }
  }

  /** The gathering, one frame: raindrops set off and fall in, the tank empties with them, then the pull. */
  private stepGather(dt: number) {
    const g = this.gather;
    const tk = this.tank;
    const H = this.H;
    const cx = this.cx;
    const cy = this.cy;
    g.t += dt;
    while (this.spawns.length && this.spawns[0].at <= g.t) {
      const sp = this.spawns.shift()!;
      g.launched += sp.vol;
      let y = sp.y;
      if (sp.water) {
        // peeling off the water: the surface rises with it
        y = Math.min(this.surface(sp.x), H);
        if (tk.on) this.pour(sp.x, 0, 6, -24);
      }
      // it starts off turning round the middle (the swirl), then the pull takes over
      const ox = sp.x - cx;
      const oy = y - cy;
      const ol = Math.hypot(ox, oy) || 1;
      const v0 = rnd(140, 260);
      this.inflow.push({
        x: sp.x,
        y,
        vx: (-oy / ol) * v0 * g.swirl - (ox / ol) * v0 * 0.4,
        vy: (ox / ol) * v0 * g.swirl - (oy / ol) * v0 * 0.4,
        w: rnd(1.9, 2.8),
        len: 10,
        a: rnd(0.8, 1),
        age: 0,
        splash: false,
        to: sp.to,
        vol: sp.vol,
      });
    }
    // falling in: faster and faster the closer it gets, turning in harder at the end
    const steps = 3;
    const h = dt / steps;
    for (const f of this.inflow) {
      const sk = this.sinks[f.to];
      for (let n = 0; n < steps && !f.dead; n++) {
        const dx = sk.x - f.x;
        const dy = sk.y - f.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < (sk.drop?.r ?? 2) + 3) {
          this.absorb(f);
          break;
        }
        const want = 260 + 140000 / (d + 90);
        const k = 1 - Math.exp(-h * (2.5 + 900 / (d + 60)));
        f.vx += ((dx / d) * want - f.vx) * k;
        f.vy += ((dy / d) * want - f.vy) * k;
        f.x += f.vx * h;
        f.y += f.vy * h;
      }
      f.age += dt;
      f.len = clamp(Math.hypot(f.vx, f.vy) * 0.03, 8, 44);
      if (!f.dead && f.age > 3.5) this.absorb(f);
    }
    this.inflow = this.inflow.filter(f => !f.dead);
    // the water level follows what has not set off yet; once all of it has, the rest drains away
    if (tk.on) {
      tk.area = g.area0 * Math.max(0, 1 - g.launched / (1 - SEED));
      if (!this.spawns.length) tk.drain = true;
    }
    // all the rain is in: a breath, then the pull
    if (!this.spawns.length && !this.inflow.length && g.rushAt === Infinity) g.rushAt = g.t + (this.reduce ? 0.05 : 0.3);
    if (g.t >= g.rushAt) {
      for (const d of this.drops) if (d.kin) d.kin = undefined;
      const since = g.t - g.rushAt;
      // the centre's pull jumps and eases back to normal
      this.pull = 1 + 7 * Math.exp(-since * 3.2);
      if (since > 1.6) {
        this.pull = 1;
        g.t = -1;
        this.sinks = [];
      }
    }
  }

  /** Clinging water lets go of the pointer, keeping a share of its motion. */
  private releaseCling(keep: number) {
    const c = this.cling;
    if (!c) return;
    this.addDrop(c.x, c.y, 0, c.vx * keep, c.vy * keep, 0, c.r, true, 0.05);
    this.cling = null;
  }

  /** Fraction of all the water the main drop holds (water that is out loose is missing until it returns). */
  private coreVolume() {
    let lost = this.liftVolume;
    for (const d of this.drops) if (d.own) lost += Math.pow(d.r / this.R0, 3);
    const c = this.cling;
    if (c) {
      const out = c.tether ? clamp((Math.hypot(c.x - this.cx, c.y - this.cy) - this.R * 0.8) / (this.R0 * 0.35), 0, 1) : 1;
      lost += Math.pow(c.r / this.R0, 3) * out;
    }
    return Math.max(this.gather.t >= 0 ? SEED : 0.04, 1 - lost);
  }

  // ---------- the tank ----------

  private dropArea() {
    return DROP_DEPTH * 720 * Math.pow(this.R0 / 110, 2);
  }

  private level(x: number) {
    const tk = this.tank;
    if (!tk.on) return 0;
    const f = clamp(x / this.W, 0, 1) * (NP - 1);
    const i = Math.min(NP - 2, Math.floor(f));
    return tk.h[i] + (tk.h[i + 1] - tk.h[i]) * (f - i);
  }

  /** Screen y of the water surface at x (below the page when there is no water). */
  private surface(x: number) {
    return this.tank.on ? this.H - this.level(x) : this.H + 10;
  }

  /** Adds `area` px² of water around x and pushes the surface down by `kick` px/s. */
  private pour(x: number, area: number, width: number, kick: number) {
    const tk = this.tank;
    tk.on = true;
    const dx = this.W / (NP - 1);
    const sigma = Math.max(width, dx);
    const i0 = Math.max(0, Math.floor((x - sigma * 3) / dx));
    const i1 = Math.min(NP - 1, Math.ceil((x + sigma * 3) / dx));
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += Math.exp(-((i * dx - x) ** 2) / (2 * sigma * sigma));
    if (sum < 1e-6) return;
    tk.area += area;
    for (let i = i0; i <= i1; i++) {
      const w = Math.exp(-((i * dx - x) ** 2) / (2 * sigma * sigma));
      tk.h[i] += (area * w) / (sum * dx);
      tk.v[i] -= kick * w;
    }
  }

  private stepTank(dt: number) {
    const tk = this.tank;
    const dx = this.W / (NP - 1);
    // the wave must not cross more than half a cell per step
    const steps = Math.ceil((WAVE * dt) / (0.5 * dx));
    const h = dt / steps;
    const c2 = (WAVE * WAVE) / (dx * dx);
    const visc = Math.min(0.24, (WAVE_VISC * h) / (dx * dx));
    for (let n = 0; n < steps; n++) {
      for (let i = 0; i < NP; i++) {
        // the page edges let nothing through (zero flux), so waves reflect off them
        const l = tk.h[i === 0 ? 0 : i - 1];
        const r = tk.h[i === NP - 1 ? NP - 1 : i + 1];
        tk.v[i] += (c2 * (l - 2 * tk.h[i] + r) - WAVE_DAMP * tk.v[i]) * h;
      }
      // symmetric smoothing (read from a copy, so it has no direction of its own)
      tk.tmp.set(tk.v);
      for (let i = 1; i < NP - 1; i++) tk.v[i] += visc * (tk.tmp[i - 1] - 2 * tk.tmp[i] + tk.tmp[i + 1]);
      for (let i = 0; i < NP; i++) tk.h[i] = Math.max(0, tk.h[i] + tk.v[i] * h);
    }
    if (tk.drain) tk.area *= Math.exp(-2.2 * dt);
    let sum = 0;
    for (let i = 0; i < NP; i++) sum += tk.h[i];
    // keep exactly the water that has been poured in
    const fix = (tk.area / dx - sum) / NP;
    for (let i = 0; i < NP; i++) tk.h[i] = Math.max(0, tk.h[i] + fix);
    if (tk.drain && tk.area < 40) {
      tk.on = false;
      tk.drain = false;
      tk.area = 0;
      tk.h.fill(0);
      tk.v.fill(0);
    }
  }

  // ---------- rain ----------

  private addStreak(s: Omit<Streak, 'age'>) {
    if (this.rain.length >= MAXRAIN) {
      const i = this.rain.findIndex(r => r.splash);
      this.rain.splice(i >= 0 ? i : 0, 1);
    }
    this.rain.push({ ...s, age: 0 });
  }

  /** Droplets thrown up where something broke on the water (or a panel) at (x, y); they fall back. */
  private crown(x: number, y: number, n: number, up: number, size: number) {
    for (let k = 0; k < n; k++) {
      this.addStreak({ x, y: y - 1, vx: rnd(-100, 100) + this.wind * 0.2, vy: -rnd(up * 0.5, up), w: rnd(1.8, 3) * size, len: 0, a: rnd(0.75, 0.95), splash: true });
    }
  }

  private stepRain(dt: number) {
    const tk = this.tank;
    const W = this.W;
    const H = this.H;
    // the rain gathers and pours until the tank is filled to its level, then eases off to a drizzle that goes on
    const full = H * LEVEL * W;
    const want = this.rainWait > 0 || tk.drain ? 0 : (tk.area < full ? RAIN_RATE : DRIZZLE) * (this.reduce ? 0.3 : 1);
    this.rainWait = Math.max(0, this.rainWait - dt);
    this.rainRate += (want - this.rainRate) * (1 - Math.exp(-dt * (want > this.rainRate ? 1.2 : 0.6)));
    const perDrop = Math.max(0, full - this.dropArea()) / (RAIN_RATE * FILL_TIME);
    // the water a drop brings, up to the level: past it the drizzle only ripples the surface
    const gain = () => Math.min(perDrop, Math.max(0, full - tk.area));
    // drizzle drops are finer and fall slower than the downpour's
    const heavy = clamp((this.rainRate - DRIZZLE) / (RAIN_RATE - DRIZZLE), 0, 1);
    this.rainClock += dt * this.rainRate;
    while (this.rainClock > 1) {
      this.rainClock -= 1;
      this.addStreak({
        x: rnd(-40, W + 40),
        y: rnd(-60, -10),
        vx: this.wind * (0.5 + 0.5 * heavy) + rnd(-20, 20),
        vy: rnd(700, 900) + 400 * heavy,
        w: rnd(1.3, 1.8) + 0.6 * heavy,
        len: rnd(10, 16) + 10 * heavy,
        a: rnd(0.45, 0.62) + 0.13 * heavy,
        splash: false,
      });
    }
    const hand = this.pointer && !this.pointer.drag ? this.pointer : null;
    for (const s of this.rain) {
      if (s.dead) continue;
      s.age += dt;
      const py = s.y;
      if (s.splash) s.vy += 1500 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const surf = this.surface(s.x);
      if (s.splash) {
        // a splash droplet falling back makes its own tiny dimple
        if (s.vy > 0 && s.y >= surf) {
          if (tk.on) this.pour(s.x, 0, 3, 6);
          s.dead = true;
        }
        if (s.age > 2) s.dead = true;
        continue;
      }
      // the pointer is an umbrella
      if (hand && Math.hypot(s.x - hand.x, s.y - hand.y) < 14) {
        this.crown(s.x, s.y, 2, 220, 0.9);
        s.dead = true;
        continue;
      }
      // the top edges of the panels
      for (const r of this.rects) {
        if (py < r.top && s.y >= r.top && s.x > r.left + 6 && s.x < r.right - 6) {
          this.crown(s.x, r.top, Math.random() < 0.5 ? 2 : 3, 200, 0.9);
          tk.area += gain(); // it runs off into the tank
          s.dead = true;
          break;
        }
      }
      if (s.dead) continue;
      // the water: a dimple that runs off as waves and a little crown of spray
      if (s.y >= surf) {
        // a fine drop makes a smaller dimple and a smaller crown
        const big = clamp((s.w - 1.3) / 1.1, 0, 1);
        this.pour(s.x, gain(), Math.max(6, (W / (NP - 1)) * 1.3), 11 + 5 * big);
        this.crown(s.x, surf, 1 + Math.floor(Math.random() * (1.5 + 2 * big)), 180 + 80 * big, 0.75 + 0.25 * big);
        if (Math.random() < 0.15 * big) this.addStreak({ x: s.x, y: surf - 1, vx: 0, vy: -rnd(200, 320), w: 3, len: 0, a: 0.9, splash: true });
        s.dead = true;
      }
    }
    this.rain = this.rain.filter(s => !s.dead && s.y < H + 60);
    // a hand moved through the water pushes waves along and stirs up bubbles
    if (hand && tk.on) {
      const surf = this.surface(hand.x);
      const under = hand.y > surf;
      const pv = this.pv;
      const sp = Math.hypot(pv.vx, pv.vy);
      if (under !== this.wasUnder && sp > 80) {
        this.crown(hand.x, surf, 3, 240, 1);
      }
      if (under) {
        const dx = W / (NP - 1);
        const i = clamp(Math.round(hand.x / dx), 1, NP - 2);
        const push = clamp(pv.vx * 0.04, -40, 40);
        tk.v[i - 1] += push * dt * 30;
        tk.v[i + 1] -= push * dt * 30;
        tk.v[i] += clamp(pv.vy * 0.03, -30, 30) * dt * 30;
      }
      this.wasUnder = under;
    }
  }

  // ---------- the pointer as a wet fingertip ----------

  private touch(px: number, py: number, realDt: number) {
    const { cx, cy, R, R0, pv } = this;
    const d = Math.hypot(px - cx, py - cy);
    const inside = d < R * 0.98;
    const speed = Math.hypot(pv.vx, pv.vy);
    if (inside && !this.wasInside) {
      // touching the surface: it dimples there and the drop is nudged along
      const l = d || 1;
      this.ripple([((px - cx) / l) * 0.9, ((py - cy) / l) * 0.9, 0.42], clamp(speed / 2600, 0.08, 0.5));
      this.off.vx += clamp(pv.vx * 0.05, -70, 70);
      this.off.vy += clamp(pv.vy * 0.05, -70, 70);
      // water already on the fingertip rejoins the drop
      if (this.cling) this.releaseCling(0.2);
      this.insideFor = 0;
    }
    if (inside) {
      this.insideFor += realDt;
      // moving through it drags the water a little (viscosity)
      this.off.vx += pv.vx * 0.5 * realDt;
      this.off.vy += pv.vy * 0.5 * realDt;
    } else if (this.wasInside && !this.cling) {
      // leaving: the water wets the fingertip and is drawn out after it. Slow exits take more water and
      // stretch further before the neck breaks; a fast one just flings off a small drop.
      const r = R0 * clamp(0.2 - speed / 9000, 0.05, 0.2) * clamp(0.4 + this.insideFor * 3, 0.4, 1);
      if (speed > FLICK * 1.4) {
        this.addDrop(px, py, 0, pv.vx * 0.5, pv.vy * 0.5, 0, r * 0.6, true, 0.05);
      } else {
        this.cling = { x: px, y: py, vx: pv.vx, vy: pv.vy, r, tether: true, breakAt: R0 * clamp(1 - speed / 2200, 0.25, 1) };
      }
    }
    this.wasInside = inside;
  }

  /** Moves clinging water; returns the spheres of the neck while it is still joined to the drop. */
  private stepCling(h: number, px: number, py: number, speed: number): [number, number, number][] {
    const c = this.cling!;
    const { cx, cy, R } = this;
    // it hangs from the fingertip, sagging a little toward the pull of the centre
    const gx = cx - px;
    const gy = cy - py;
    const gl = Math.hypot(gx, gy) || 1;
    const tx = px + (gx / gl) * c.r * 0.35;
    const ty = py + (gy / gl) * c.r * 0.35;
    const damp = 2 * Math.sqrt(STICK) * 0.55;
    c.vx += ((tx - c.x) * STICK - c.vx * damp) * h;
    c.vy += ((ty - c.y) * STICK - c.vy * damp) * h;
    c.x += c.vx * h;
    c.y += c.vy * h;
    if (!c.tether) {
      if (speed > FLICK) this.releaseCling(0.9);
      return [];
    }
    const dx = c.x - cx;
    const dy = c.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const out = d - R;
    if (out > c.breakAt) {
      // the neck pinches off: the fingertip keeps its drop, the neck leaves a couple of tiny drops behind
      c.tether = false;
      const sx = cx + ux * R;
      const sy = cy + uy * R;
      for (const f of [0.4, 0.68]) {
        if (Math.random() < 0.8) this.addDrop(sx + (c.x - sx) * f, sy + (c.y - sy) * f, 0, -ux * 50, -uy * 50, 0, this.R0 * rnd(0.022, 0.034), true, 0.05);
      }
      this.sqAxis = [ux, uy, 0];
      this.sqV -= 1.2;
      this.ripple([ux * 0.94, uy * 0.94, 0.34], 0.45);
      return [];
    }
    const t = clamp(out / c.breakAt, 0, 1);
    const nr = c.r * 0.75 * Math.pow(1 - t, 1.2);
    const sx = cx + ux * R * 0.9;
    const sy = cy + uy * R * 0.9;
    const neck: [number, number, number][] = [[cx + ux * R * 0.93, cy + uy * R * 0.93, c.r * (1.15 - 0.5 * t)]];
    for (let i = 1; i <= 3; i++) {
      const f = i / 4;
      const mid = 1 - Math.abs(f - 0.5) * 2;
      neck.push([sx + (c.x - sx) * f, sy + (c.y - sy) * f, nr + (c.r * 0.8 - nr) * (1 - mid) * (1 - mid)]);
    }
    return neck;
  }

  // ---------- simulation ----------

  private stepDrops(h: number, cx: number, cy: number, R: number) {
    const drops = this.drops;
    const settle = this.mode === 'settle';
    // cohesion while floating: drops that touch are drawn together and merge (volume conserved)
    if (!settle) {
      for (let i = 0; i < drops.length; i++) {
        const a = drops[i];
        if (a.dead || a.drain || a.kin || a.age < 0.08) continue;
        for (let j = i + 1; j < drops.length; j++) {
          const b = drops[j];
          if (b.dead || b.drain || b.kin || b.age < 0.08) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dz = b.z - a.z;
          const d = Math.hypot(dx, dy, dz) || 1;
          const reach = (a.r + b.r) * 1.08;
          if (d > reach) continue;
          const va = a.r ** 3;
          const vb = b.r ** 3;
          if (d < (a.r + b.r) * 0.3) {
            const v = va + vb;
            a.x = (a.x * va + b.x * vb) / v;
            a.y = (a.y * va + b.y * vb) / v;
            a.z = (a.z * va + b.z * vb) / v;
            a.vx = (a.vx * va + b.vx * vb) / v;
            a.vy = (a.vy * va + b.vy * vb) / v;
            a.vz = (a.vz * va + b.vz * vb) / v;
            a.r = Math.cbrt(v);
            a.own = a.own || b.own;
            b.dead = true;
            continue;
          }
          const pull = 900 * (1 - d / reach);
          const fa = (pull * vb) / (va + vb);
          const fb = (pull * va) / (va + vb);
          a.vx += (dx / d) * fa * h;
          a.vy += (dy / d) * fa * h;
          a.vz += (dz / d) * fa * h;
          b.vx -= (dx / d) * fb * h;
          b.vy -= (dy / d) * fb * h;
          b.vz -= (dz / d) * fb * h;
        }
      }
    }
    for (const s of drops) {
      if (s.dead) continue;
      s.age += h;
      if (settle) {
        // free fall into the tank: a big dimple and a crown of spray
        s.vy += FALL * h;
        const damp = Math.exp(-0.25 * h);
        s.vx *= damp;
        s.vy *= damp;
        s.x += s.vx * h;
        s.y += s.vy * h;
        s.z *= Math.exp(-2 * h);
        if (s.x < s.r) {
          s.x = s.r;
          s.vx = Math.abs(s.vx) * 0.3;
        } else if (s.x > this.W - s.r) {
          s.x = this.W - s.r;
          s.vx = -Math.abs(s.vx) * 0.3;
        }
        const surf = this.surface(s.x);
        if (s.vy > 0 && s.y + s.r * 0.3 >= surf) {
          const big = s.r / this.R0;
          this.pour(s.x, s.own ? Math.pow(big, 3) * this.dropArea() : 0, Math.max(s.r * 2.5, 24), Math.min(s.vy, 1200) * 0.1);
          this.crown(s.x, Math.min(surf, this.H), Math.round(clamp(big * 30, 3, 9)), 320 + big * 500, 1 + big * 2);
          s.dead = true;
        }
        continue;
      }
      if (s.kin) {
        // rising to its place (slow, fast, slow), then bobbing there until the pull
        const k = s.kin;
        const u = clamp((this.gather.t - k.t0) / k.dur, 0, 1);
        const e = 0.5 - 0.5 * Math.cos(Math.PI * u);
        const de = (0.5 * Math.PI * Math.sin(Math.PI * u)) / k.dur;
        const bob = u >= 1 ? Math.sin(this.t * 2.4 + k.ph) * 3 : 0;
        s.x = k.x0 + (k.x1 - k.x0) * e;
        s.y = k.y0 + (k.y1 - k.y0) * e + bob;
        s.vx = (k.x1 - k.x0) * de;
        s.vy = (k.y1 - k.y0) * de;
        continue;
      }
      const dx = cx - s.x;
      const dy = cy - s.y;
      const dz = -s.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      if (s.drain) {
        // flowing into the surface: sink toward the centre while the volume passes over
        s.r *= Math.exp(-DRAIN * h);
        s.x += dx * Math.min(1, 5 * h);
        s.y += dy * Math.min(1, 5 * h);
        s.z += dz * Math.min(1, 5 * h);
        if (s.r < 0.8) s.dead = true;
        continue;
      }
      // pulled toward the middle like a small world's gravity; air drag thickens near the surface
      const g = GRAVITY * this.pull * Math.min(1.3, Math.pow(Math.max(R, this.R0 * 0.3) / d, 0.7));
      const c = DRAG + WET_DRAG * smooth(R * 1.6, R, d);
      s.vx += ((dx / d) * g - c * s.vx) * h;
      s.vy += ((dy / d) * g - c * s.vy) * h;
      s.vz += ((dz / d) * g - c * s.vz) * h;
      s.x += s.vx * h;
      s.y += s.vy * h;
      s.z += s.vz * h;
      if (s.age > 0.12 && d < R + s.r * 0.55) {
        s.drain = true;
        const k2 = Math.min(0.8, (s.r / this.R0) * (s.own ? 2.4 : 1));
        if (k2 > 0.08 && (this.imps.length < 4 || s.own)) this.ripple([-dx / d, -dy / d, -dz / d], k2);
        if (s.own) {
          this.sqAxis = [dx / d, dy / d, dz / d];
          this.sqV += Math.min(0.9, s.r / this.R0) * 1.2;
          // slamming in under the strong pull, a bigger drop throws a little water back out
          const sp = Math.hypot(s.vx, s.vy, s.vz);
          if (this.pull > 2 && sp > 700 && s.r > 0.14 * this.R0 && !this.reduce) {
            const ux = -dx / d;
            const uy = -dy / d;
            for (let k = Math.round(clamp((s.r / this.R0) * 9, 1, 4)); k > 0; k--) {
              const a = Math.atan2(uy, ux) + rnd(-1.1, 1.1);
              const out = rnd(260, 620);
              this.addDrop(cx - ux * R * 0.95, cy - uy * R * 0.95, 0, Math.cos(a) * out, Math.sin(a) * out, rnd(-60, 60), s.r * rnd(0.14, 0.28), false);
            }
          }
        }
      }
      if (!s.own && s.age > 3.5) s.r *= Math.exp(-3 * h);
    }
    this.drops = drops.filter(s => !s.dead && s.r > 0.7);
  }

  private stepProjectiles(h: number, cx: number, cy: number, R: number) {
    for (const p of this.proj) {
      if (p.wait > 0) {
        p.wait -= h;
        p.wob += h;
        continue;
      }
      if (p.sink) {
        p.x += (cx - p.x) * Math.min(1, 6 * h);
        p.y += (cy - p.y) * Math.min(1, 6 * h);
        p.z += -p.z * Math.min(1, 6 * h);
        p.r *= Math.exp(-12 * h);
        continue;
      }
      if (!p.go) {
        p.go = true;
        const dx = cx - p.x;
        const dy = cy - p.y;
        const d = Math.hypot(dx, dy);
        if (d < R) {
          p.z = Math.sqrt(Math.max(0, R * R - d * d));
        } else {
          const ux = dx / d;
          const uy = dy / d;
          const side = rnd(-1, 1) * 240;
          p.vx = ux * 420 - uy * side;
          p.vy = uy * 420 + ux * side - 160;
          p.vz = 220;
        }
      }
      const dx = cx - p.x;
      const dy = cy - p.y;
      const dz = -p.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      if (d < R + p.r * 0.25) {
        this.impact(p);
        p.sink = true;
        if (!p.batch.hit) {
          p.batch.hit = true;
          p.batch.cb?.();
        }
        continue;
      }
      p.vx += ((dx / d) * 3600 - 0.6 * p.vx) * h;
      p.vy += ((dy / d) * 3600 - 0.6 * p.vy) * h;
      p.vz += ((dz / d) * 3600 - 0.6 * p.vz) * h;
      p.x += p.vx * h;
      p.y += p.vy * h;
      p.z += p.vz * h;
    }
    this.proj = this.proj.filter(p => p.r > 1.2);
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const renderer = this.renderer!;
    const u = this.mat!.uniforms;
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = 1 / 60;
    // adaptive resolution: drop pixel ratio if we keep missing frames
    this.slow = dt > 1 / 40 ? this.slow + 1 : Math.max(0, this.slow - 1);
    if (this.slow > 60 && this.quality > 0.75) {
      this.quality -= 0.25;
      this.slow = 0;
    }
    const realDt = Math.min(dt, 1 / 25);
    dt = realDt * (this.reduce ? 0.35 : 1);
    this.t += dt;
    const t = this.t;

    const W = window.innerWidth;
    const H = window.innerHeight;
    this.W = W;
    this.H = H;
    if (W !== this.size.w || H !== this.size.h || this.quality !== this.size.q) {
      renderer.setPixelRatio(this.quality);
      renderer.setSize(W, H, false);
      this.size = { w: W, h: H, q: this.quality };
    }

    // the swell before the burst
    if (this.fuse > 0) {
      this.fuse -= dt;
      if (this.fuse <= 0) {
        this.fuse = 0;
        this.mode = 'settle';
        this.burst();
      }
    }
    const settle = this.mode === 'settle';
    if (this.anchor && !settle && this.fuse <= 0) {
      const ar = this.anchor.getBoundingClientRect();
      if (ar.width > 2) {
        if (!settle) this.R0 = ar.width / 2;
        this.ax = ar.left + ar.width / 2;
        this.ay = ar.top + ar.height / 2;
      }
    }
    this.rects = this.obstacles && settle ? Array.from(document.querySelectorAll(this.obstacles), el => el.getBoundingClientRect()) : [];
    const R0 = this.R0;

    // ---- heat: builds up slowly while there is work, boils over just before the burst, cools off quickly
    const heatT = settle ? 0 : this.heatTarget;
    if (this.fuse > 0) this.heat += (1 - this.heat) * (1 - Math.exp(-dt * 8));
    else this.heat += (heatT - this.heat) * (heatT > this.heat ? 1 - Math.exp(-dt / (HEAT_RISE * (heatT < 0.5 ? 0.25 : 1))) : 1 - Math.exp(-dt * 1.5));
    const heat = this.heat;
    const boiling = heat > 0.03;

    // ---- pointer velocity
    const pv = this.pv;
    const hand = this.pointer;
    if (hand) {
      if (!pv.ok) Object.assign(pv, { x: hand.x, y: hand.y, vx: 0, vy: 0, ok: true });
      const k = Math.min(1, realDt * 20);
      pv.vx += ((hand.x - pv.x) / realDt - pv.vx) * k;
      pv.vy += ((hand.y - pv.y) / realDt - pv.vy) * k;
      pv.x = hand.x;
      pv.y = hand.y;
    } else {
      pv.ok = false;
      pv.vx = 0;
      pv.vy = 0;
    }
    const speed = Math.hypot(pv.vx, pv.vy);
    const ptr = this.interactive && !settle && this.gather.t < 0 ? hand : null;

    // ---- where the drop is (after it bursts there is none: its water is out as drops and in the tank)
    const off = this.off;
    off.vx += (-off.x * 30 - off.vx * 9) * dt;
    off.vy += (-off.y * 30 - off.vy * 9) * dt;
    off.x += off.vx * dt;
    off.y += off.vy * dt;
    const cx = this.ax + off.x;
    const cy = this.ay + off.y + Math.sin(t * 1.1) * R0 * 0.05; // gentle floating
    const swell = this.fuse > 0 ? 1 + 0.16 * smooth(0, 1, 1 - this.fuse / FUSE) : 1;
    const R = settle ? 0 : R0 * this.sc * swell * Math.cbrt(this.coreVolume());
    this.cx = cx;
    this.cy = cy;
    this.R = R;

    // ---- a dragged file is a blob under the cursor, and the water reaches for it
    let tgt = 1;
    let feX = 0;
    let feY = 0;
    let feR = 0;
    let curR = 0;
    if (ptr?.drag) {
      const dx = ptr.x - cx;
      const dy = ptr.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const du = d / R0;
      const hot = du < 1.14;
      tgt = hot ? 1.16 : 1.06;
      if (!hot) {
        const reach = Math.min(1.5, Math.max(0.95, du * 0.5)) * R0;
        feX = (dx / d) * reach;
        feY = (dy / d) * reach;
        feR = 0.34 * R0;
      }
      curR = 0.2 * R0 * (1 + 0.12 * Math.min(4, this.dragCount));
    }
    // a boiling drop trembles, harder as the heat builds
    if (boiling) tgt *= 1 + heat * (0.012 * Math.sin(t * 11) + 0.008 * Math.sin(t * 17.3));
    this.scV += ((tgt - this.sc) * 150 - this.scV * 15) * dt;
    this.sc += this.scV * dt;
    this.sqV += (-this.sq * 220 - this.sqV * 10) * dt;
    this.sq = Math.max(-0.28, Math.min(0.28, this.sq + this.sqV * dt));

    const fe = this.fe;
    const kf = 1 - Math.exp(-dt * 9);
    fe.ox += (feX - fe.ox) * kf;
    fe.oy += (feY - fe.oy) * kf;
    fe.r += (feR - fe.r) * (1 - Math.exp(-dt * 7));

    const cur = this.cur;
    if (ptr?.drag) {
      const k = cur.r < 1 ? 1 : 1 - Math.exp(-dt * 20);
      const nx = cur.x + (ptr.x - cur.x) * k;
      const ny = cur.y + (ptr.y - cur.y) * k;
      cur.vx = cur.r < 1 ? 0 : (nx - cur.x) / Math.max(dt, 0.001);
      cur.vy = cur.r < 1 ? 0 : (ny - cur.y) / Math.max(dt, 0.001);
      cur.x = nx;
      cur.y = ny;
      cur.rV += ((curR - cur.r) * 200 - cur.rV * 16) * dt;
      cur.r = Math.max(0, cur.r + cur.rV * dt);
    } else {
      cur.r = Math.max(0, cur.r - dt * R0 * 2.5);
      cur.rV = 0;
    }

    // ---- the plain pointer is a wet fingertip on the drop
    if (ptr && !ptr.drag) this.touch(ptr.x, ptr.y, realDt);
    else {
      this.wasInside = false;
      if (this.cling) this.releaseCling(0.4);
    }

    if (this.gather.t >= 0 && !settle) this.stepGather(dt);

    // ---- physics in sub-steps, so fast motion stays smooth
    let neck: [number, number, number][] = [];
    const tk = this.tank;
    const h = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) {
      if (this.cling && ptr) neck = this.stepCling(h, ptr.x, ptr.y, speed);
      this.stepProjectiles(h, cx, cy, R);
      this.stepDrops(h, cx, cy, R);
    }
    if (tk.on) this.stepTank(dt);
    if (settle || this.rain.length) this.stepRain(dt);
    for (const m of this.imps) m.age += dt;
    this.imps = this.imps.filter(m => m.age < 2.6);


    // ---- evaporation: fine droplets bud off the surface, drift away and shrink to nothing
    if (!boiling && !settle && !this.reduce && R > R0 * 0.5) {
      this.mistClock += dt * MIST_RATE;
      while (this.mistClock > 1) {
        this.mistClock -= 1;
        if (this.mist.length >= MAX_MIST) this.mist.shift();
        // all the way round, not just off the top
        const a = rnd(0, Math.PI * 2);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        this.mist.push({ x: cx + ca * R * 0.97, y: cy + sa * R * 0.97, z: rnd(-0.05, 0.3) * R, vx: ca * rnd(16, 40), vy: sa * rnd(16, 40), vz: 0, r: 0, r0: R0 * rnd(0.014, 0.032), age: 0, life: rnd(1.6, 3) });
      }
    }
    for (const m of this.mist) {
      m.age += dt;
      const damp = Math.exp(-0.7 * dt);
      m.vx *= damp;
      m.vy *= damp;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.r = m.r0 * smooth(0, 0.3, m.age) * (1 - smooth(m.life * 0.45, m.life, m.age));
    }
    this.mist = this.mist.filter(m => m.age < m.life);

    // ---- boiling: more and bigger vapour bubbles as the heat builds; they burst at the surface, spitting droplets
    // fine bubbles stream from a few spots in the lower half; bigger ones form here and there as the heat builds
    const inLower = (): Vec3 => {
      for (;;) {
        const q: Vec3 = [rnd(-0.7, 0.7), rnd(0.1, 0.75), rnd(-0.7, 0.7)];
        if (Math.hypot(...q) < 0.78) return q;
      }
    };
    const spawn = (q: Vec3, r: number) => {
      if (this.bubs.length < MAXBUB) this.bubs.push({ x: q[0], y: q[1], z: q[2], r, vy: 0.1, ph: rnd(0, 6), a: 0 });
    };
    if (boiling && !settle) {
      if (!this.sites.length) this.sites = Array.from({ length: 4 }, () => { const [x, y, z] = inLower(); return { x, y, z, clock: Math.random() }; });
      for (const st of this.sites) {
        st.clock += dt * (1.5 + 9 * heat);
        while (st.clock > 1) {
          st.clock -= 1;
          spawn([st.x + rnd(-0.008, 0.008), st.y, st.z], rnd(0.009, 0.015));
        }
        // a spot dries up now and then and another one starts
        if (Math.random() < dt * 0.25) Object.assign(st, (([x, y, z]) => ({ x, y, z }))(inLower()));
      }
      this.bubClock += dt * (0.6 + 7 * heat);
      while (this.bubClock > 1) {
        this.bubClock -= 1;
        spawn(inLower(), rnd(0.018, 0.03 + 0.045 * heat));
      }
    } else this.sites = [];
    for (const b of this.bubs) {
      // buoyancy: bigger bubbles rise faster, and they gather speed as they go
      const vt = (0.2 + 3.6 * Math.sqrt(b.r)) * (1 + 0.4 * heat);
      b.vy += (vt - b.vy) * (1 - Math.exp(-dt * 3));
      b.y -= b.vy * dt;
      // the bigger ones zigzag
      b.x += Math.sin(b.ph + t * 8) * b.r * 5 * dt;
      // and they swell as they rise
      b.r *= 1 + dt * (0.12 + 0.3 * heat);
      b.a = Math.min(1, b.a + dt * 8);
      if (Math.hypot(b.x, b.y, b.z) + b.r * 0.5 > 0.9) {
        b.a = -1;
        if (b.y > -0.2) continue; // it reached the side: it just slips out of view against the curve
        const l = Math.hypot(b.x, b.y) || 1;
        const nx = b.x / l;
        const ny = b.y / l;
        if (b.r > 0.025 && this.imps.length < 4) this.ripple([nx * 0.95, ny * 0.95, 0.3], 0.08 + 0.25 * heat);
        if (b.r > 0.03 && heat > 0.35 && Math.random() < heat && !this.reduce) {
          if (this.mist.length >= MAX_MIST) this.mist.shift();
          this.mist.push({ x: cx + nx * R, y: cy + ny * R, z: 0.2 * R, vx: nx * rnd(60, 160), vy: ny * rnd(60, 160) - 40, vz: 0, r: 0, r0: R0 * rnd(0.015, 0.03), age: 0, life: rnd(0.5, 0.9) });
        }
      }
    }
    this.bubs = this.bubs.filter(b => b.a >= 0 && !settle);

    // ---- question beads
    let idle = 0;
    for (const b of this.beads.values()) {
      let tx: number;
      let ty: number;
      if (b.home) {
        tx = cx;
        ty = cy;
      } else if (b.el && b.el.isConnected) {
        const r = b.el.getBoundingClientRect();
        tx = r.left + r.width / 2;
        ty = r.top + r.height / 2 + Math.sin(t * 2.1 + b.age) * 3;
      } else {
        const a = -1.15 + idle * 0.38;
        tx = cx + Math.cos(a) * R * 1.42;
        ty = cy + Math.sin(a) * R * 1.42 + Math.sin(t * 1.7 + b.age) * 4;
        idle += 1;
      }
      const k = b.home ? 60 : 30;
      const c = 2 * Math.sqrt(k) * 0.85;
      b.vx += ((tx - b.x) * k - b.vx * c) * dt;
      b.vy += ((ty - b.y) * k - b.vy * c) * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.age += dt;
      const target = b.el && !b.home ? 0.19 * R0 : 0.12 * R0;
      b.r += (target - b.r) * (1 - Math.exp(-dt * 5));
      if (b.home && Math.hypot(b.x - cx, b.y - cy) < R * 0.9) {
        b.dead = true;
        this.addDrop(b.x, b.y, 0, b.vx, b.vy, 0, b.r, false, 0.3);
      }
    }
    for (const b of this.beads.values()) if (b.dead) this.beads.delete(b.id);

    // ---- assemble the blob list for the shader (most important first; the list is capped)
    const B = u.uB.value as THREE.Vector4[];
    let n = 0;
    let zTop = R0 * 1.5;
    const add = (x: number, y: number, z: number, r: number) => {
      if (n >= MAXB || r < 0.6) return;
      B[n].set(x, y, z, r);
      n += 1;
      zTop = Math.max(zTop, z + r);
    };
    // while it is still joined to the drop by a neck, water on the pointer is part of the drop; once it has
    // come away it moves to the top layer, over text and panels (below)
    if (this.cling?.tether) {
      add(this.cling.x, this.cling.y, 0, this.cling.r);
      for (const [x, y, r] of neck) add(x, y, 0, r);
    }
    for (const b of this.beads.values()) add(b.x, b.y, 0, b.r);
    for (const s of this.drops) if (s.own) add(s.x, s.y, s.z, s.r);
    if (settle || this.gather.t >= 0) {
      for (const s of this.drops) {
        const v = Math.hypot(s.vx, s.vy);
        if (s.own && v > 260 && s.r > 0.12 * R0) {
          const k = Math.min(1, (v - 260) / 900) * s.r;
          add(s.x - (s.vx / v) * k * 0.7, s.y - (s.vy / v) * k * 0.7, s.z, s.r * 0.78);
          add(s.x - (s.vx / v) * k * 1.4, s.y - (s.vy / v) * k * 1.4, s.z, s.r * 0.5);
        }
      }
    }
    if (cur.r > 1) {
      add(cur.x, cur.y, 0, cur.r);
      if (Math.hypot(cur.vx, cur.vy) > 80) add(cur.x - cur.vx * 0.03, cur.y - cur.vy * 0.03, 0, cur.r * 0.68);
    }
    if (fe.r > 1 && Math.hypot(fe.ox, fe.oy) > 0.5 * R0) add(cx + fe.ox, cy + fe.oy, 0, fe.r);
    for (const p of this.proj) {
      add(p.x, p.y, p.z, p.wait > 0 ? p.r * (1 + 0.06 * Math.sin(p.wob * 22)) : p.r);
      const v = Math.hypot(p.vx, p.vy, p.vz);
      if (!p.sink && v > 150) {
        const ux = p.vx / v;
        const uy = p.vy / v;
        const uz = p.vz / v;
        add(p.x - ux * p.r * 0.95, p.y - uy * p.r * 0.95, p.z - uz * p.r * 0.95, p.r * 0.66);
        add(p.x - ux * p.r * 1.75, p.y - uy * p.r * 1.75, p.z - uz * p.r * 1.75, p.r * 0.4);
      }
    }
    for (const s of this.drops) if (!s.own) add(s.x, s.y, s.z, s.r);
    for (const m of this.mist) add(m.x, m.y, m.z, m.r);

    const imp = u.uImp.value as THREE.Vector4[];
    const kk = [0, 0, 0, 0];
    for (let j = 0; j < 4; j++) {
      const m = this.imps[j];
      if (m) {
        imp[j].set(m.dir[0], m.dir[1], m.dir[2], m.age);
        kk[j] = m.k;
      } else imp[j].set(0, 0, 1, -1);
    }
    const bub = u.uBub.value as THREE.Vector4[];
    this.bubs.forEach((b, i) => bub[i].set(cx + b.x * R, cy + b.y * R, b.r * R, b.a * (0.72 + 0.28 * clamp(b.z + 0.5, 0, 1))));
    const pool = u.uPool.value as THREE.Vector4[];
    for (let i = 0; i < NP / 4; i++) pool[i].set(tk.h[i * 4], tk.h[i * 4 + 1], tk.h[i * 4 + 2], tk.h[i * 4 + 3]);
    this.shadow += ((settle || R < R0 * 0.5 ? 0 : 1) - this.shadow) * (1 - Math.exp(-dt * 5));

    // rain instances
    const g = this.rainGeo!;
    const aP = g.getAttribute('aP') as THREE.InstancedBufferAttribute;
    const aD = g.getAttribute('aD') as THREE.InstancedBufferAttribute;
    const aS = g.getAttribute('aS') as THREE.InstancedBufferAttribute;
    const aA = g.getAttribute('aA') as THREE.InstancedBufferAttribute;
    let m = 0;
    for (const s of this.inflow.length ? [...this.rain, ...this.inflow] : this.rain) {
      if (m >= MAXRAIN) break;
      const v = Math.hypot(s.vx, s.vy) || 1;
      const len = s.splash ? s.w + Math.min(5, v * 0.01) : s.len;
      aP.setXY(m, s.x, s.y);
      aD.setXY(m, s.vx / v, s.vy / v);
      aS.setXY(m, s.w, len);
      aA.setX(m, s.a);
      m += 1;
    }
    g.instanceCount = m;
    aP.needsUpdate = aD.needsUpdate = aS.needsUpdate = aA.needsUpdate = true;
    (this.rainMat!.uniforms.uView.value as THREE.Vector2).set(W, H);

    renderer.getDrawingBufferSize(this.buf);
    (u.uRes.value as THREE.Vector2).copy(this.buf);
    u.uScale.value = this.buf.x / W;
    u.uTime.value = t;
    // a burst drop is parked out of sight
    if (R < 0.5) (u.uCore.value as THREE.Vector4).set(-1e4, -1e4, 0, 0.5);
    else (u.uCore.value as THREE.Vector4).set(cx, cy, 0, R);
    (u.uSq.value as THREE.Vector4).set(this.sqAxis[0], this.sqAxis[1], this.sqAxis[2], this.sq);
    (u.uImpK.value as THREE.Vector4).set(kk[0], kk[1], kk[2], kk[3]);
    (u.uFloor.value as THREE.Vector2).set(this.ax + R0 * 0.06, this.ay + R0 * 1.42);
    u.uShadow.value = this.shadow;
    const cl = this.cling;
    this.top?.set(cl?.x ?? 0, cl?.y ?? 0, cl && !cl.tether ? cl.r : 0);
    u.uGround.value = -1;
    u.uWaterOn.value = tk.on ? 1 : 0;
    u.uLevel.value = tk.area / Math.max(1, W);
    u.uN.value = n;
    u.uNB.value = this.bubs.length;
    u.uZTop.value = zTop + 6;
    u.uBoil.value = boiling && !settle ? (0.6 + 4.5 * heat) * (R0 / 110) : 0;
    renderer.render(this.scene, this.cam);
  };
}
