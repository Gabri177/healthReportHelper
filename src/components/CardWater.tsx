import { useEffect, useRef } from 'react';

// ---- feel. Units: px and seconds.
/** Columns across the card. */
const N = 40;
/** Wave speed, damping (1/s, about half of critical for a card: it overshoots once and settles) and viscosity (px²/s). */
const WAVE = 520;
const DAMP = 8;
const VISC = 140;
/** Gravity against which the card's own motion tilts the water (px/s²), and how much of that tilt it follows. */
const G = 2200;
const INERTIA = 0.35;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** The rotation (radians, clockwise) of an element's current transform, mid-animation included. */
function rotationOf(el: Element) {
  const m = getComputedStyle(el).transform;
  const k = m && m !== 'none' ? m.match(/matrix\(([^)]+)\)/) : null;
  if (!k) return 0;
  const [a, b] = k[1].split(',').map(Number);
  return Math.atan2(b, a);
}

/**
 * Water filled to `level` (share of the card's height), seen side-on like the tank along the page.
 * It stays level as the card tilts and sloshes when the card is dealt, picked up or put back.
 */
export function CardWater({ level }: { level: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const host = cv.closest('.fan-card, .done-card') ?? cv.parentElement!;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const h = new Float32Array(N);
    const v = new Float32Array(N);
    const tmp = new Float32Array(N);
    const move = { x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, ok: false };
    let W = 0;
    let H = 0;
    let area = 0;
    let last = performance.now();
    let t = 0;
    let raf = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = clamp((now - last) / 1000, 0.001, 1 / 30);
      last = now;
      t += dt;
      const w = cv.clientWidth;
      const hh = cv.clientHeight;
      if (!w || !hh) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (w !== W || hh !== H) {
        W = w;
        H = hh;
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
        area = level * H * W;
        h.fill(level * H);
        v.fill(0);
      }
      const dx = W / (N - 1);

      // which way is down, seen from inside the card: its tilt, plus the pull of its own acceleration
      const r = host.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (move.ok) {
        const k = 1 - Math.exp(-dt * 25);
        const vx = (cx - move.x) / dt;
        const vy = (cy - move.y) / dt;
        move.ax += ((vx - move.vx) / dt - move.ax) * k * 0.5;
        move.ay += ((vy - move.vy) / dt - move.ay) * k * 0.5;
        move.vx += (vx - move.vx) * k;
        move.vy += (vy - move.vy) * k;
      }
      Object.assign(move, { x: cx, y: cy, ok: true });
      const along = clamp(Math.atan2(move.ax, G - move.ay) * INERTIA, -0.15, 0.15);
      // the slope (height gained per px to the right) the water settles to inside the card
      const slope = Math.tan(clamp(rotationOf(host) - (still ? 0 : along), -1.1, 1.1));

      if (still) {
        for (let i = 0; i < N; i++) h[i] = level * H + slope * (i * dx - W / 2);
      } else {
        // shallow water on the tilted floor: waves even out the height above the level line
        const steps = Math.ceil((WAVE * dt) / (0.5 * dx));
        const s = dt / steps;
        const c2 = (WAVE * WAVE) / (dx * dx);
        const visc = Math.min(0.24, (VISC * s) / (dx * dx));
        const eta = (i: number) => h[clamp(i, 0, N - 1)] - slope * clamp(i, 0, N - 1) * dx;
        for (let n = 0; n < steps; n++) {
          for (let i = 0; i < N; i++) v[i] += (c2 * (eta(i - 1) - 2 * eta(i) + eta(i + 1)) - DAMP * v[i]) * s;
          tmp.set(v);
          for (let i = 1; i < N - 1; i++) v[i] += visc * (tmp[i - 1] - 2 * tmp[i] + tmp[i + 1]);
          for (let i = 0; i < N; i++) h[i] = clamp(h[i] + v[i] * s, 0, H);
        }
      }
      // keep exactly the water it was filled with
      let sum = 0;
      for (let i = 0; i < N; i++) sum += h[i];
      const fix = (area / dx - sum) / N;
      for (let i = 0; i < N; i++) h[i] = clamp(h[i] + fix, 0, H);

      // the surface, with a fine shiver on top
      const surf = (x: number) => {
        const f = clamp(x / dx, 0, N - 1);
        const i = Math.min(N - 2, Math.floor(f));
        const y = h[i] + (h[i + 1] - h[i]) * (f - i);
        return H - y - (still ? 0 : 0.35 * Math.sin(x * 0.09 + t * 2.6) + 0.2 * Math.sin(x * 0.21 - t * 3.7));
      };

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const step = 3;
      const line = () => {
        ctx.moveTo(0, surf(0));
        for (let x = step; x < W + step; x += step) ctx.lineTo(Math.min(x, W), surf(Math.min(x, W)));
      };
      let top = H;
      for (let i = 0; i < N; i++) top = Math.min(top, H - h[i]);

      // the water: a faint grey veil, a touch darker under the surface and toward the bottom
      ctx.beginPath();
      line();
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, top, 0, H);
      g.addColorStop(0, 'rgba(128, 134, 140, 0.2)');
      g.addColorStop(Math.min(0.99, 14 / Math.max(H - top, 15)), 'rgba(128, 134, 140, 0.13)');
      g.addColorStop(1, 'rgba(118, 124, 130, 0.3)');
      ctx.fillStyle = g;
      ctx.fill();

      // the underside of the surface is a mirror: a silver band just under the line
      ctx.save();
      ctx.translate(0, 2.4);
      ctx.beginPath();
      line();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 3.2;
      ctx.stroke();
      ctx.restore();
      // the meniscus: a fine dark line on the waterline, and a pale sliver of the top surface over it
      ctx.beginPath();
      line();
      ctx.strokeStyle = 'rgba(64, 68, 72, 0.55)';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.save();
      ctx.translate(0, -1.1);
      ctx.beginPath();
      line();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [level]);

  return <canvas ref={ref} className="card-water" aria-hidden="true" />;
}
