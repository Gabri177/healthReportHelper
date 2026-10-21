// Full-screen fragment shader: draws the page backdrop (soft light + dot grid) and, on top of it,
// clear, colourless water made of ray-marched metaballs.
//
// Clear water has no colour of its own; it reads as water through optics alone:
//  - a lens: what lies behind is magnified in the middle and squeezed toward the rim
//  - a thin darker rim where light is totally internally reflected (water→air critical angle ≈ 48.6°)
//  - a darker band just under the highlight, and a bright crescent low on the far side
//  - one small, sharp specular highlight and a soft window reflection
//  - a contact shadow: under the floating drop, or along the line where settled drops touch the ground
export const MAXB = 48;
export const MAXBUB = 40;
/** Columns of the water-level heightfield along the bottom of the page (packed four to a vec4). */
export const NP = 160;

export const VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const FRAG = /* glsl */ `
#define MAXB ${MAXB}
#define MAXBUB ${MAXBUB}
#define NP ${NP}
#define LMAX 14
uniform vec2 uRes;
uniform float uScale;
uniform float uTime;
uniform vec4 uCore;
uniform vec4 uSq;
uniform vec4 uImp[4];
uniform vec4 uImpK;
uniform vec4 uB[MAXB];
uniform int uN;
uniform vec4 uBub[MAXBUB];
uniform int uNB;
uniform float uZTop;
uniform float uBoil;
uniform vec2 uFloor;
uniform float uShadow;
uniform float uGround;
uniform vec4 uPool[NP / 4];
uniform float uWaterOn;
uniform float uLevel;

const vec3 LIGHT = vec3(-0.55, -0.72, 0.62);

// Only the blobs that reach this pixel take part in the march: a vertical view ray
// can never come closer to a blob than its distance on screen.
vec4 lb[LMAX];
int ln;

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float smax(float a, float b, float k) { return -smin(-a, -b, k); }

float kOf(float r) { return clamp(r * 0.85, 2.5, max(uCore.w * 0.22, 2.5)); }

float gather(vec2 p) {
  float m = length(p - uCore.xy) - uCore.w * 1.42;
  ln = 0;
  for (int i = 0; i < MAXB; i++) {
    if (i >= uN) break;
    vec4 b = uB[i];
    float d = length(p - b.xy) - b.w;
    if (d < kOf(b.w) + 2.0 && ln < LMAX) {
      lb[ln] = b;
      ln++;
      m = min(m, d - b.w * 0.25 - 10.0);
    }
  }
  // nothing is drawn below the ground once the water has settled on it
  if (uGround > 0.0 && p.y > uGround + 1.5) m = 1.0;
  return m;
}

float sdCore(vec3 p) {
  vec3 q = p - uCore.xyz;
  float s = uSq.w;
  float qa = dot(q, uSq.xyz);
  vec3 qp = q - uSq.xyz * qa;
  vec3 ps = uSq.xyz * (qa / (1.0 - s)) + qp / (1.0 + 0.5 * s);
  float d = (length(ps) - uCore.w) * min(1.0 - s, 1.0 + 0.5 * s);
  vec3 n = q / max(length(q), 0.001);
  // boiling: the surface churns while files are being read; at rest the outline is a perfect circle
  if (uBoil > 0.0) {
    float t = uTime;
    d -= uBoil * (0.55 * sin(5.0 * n.x + t * 6.3) * sin(4.3 * n.y - t * 5.1) + 0.45 * sin(7.0 * n.z + 3.0 * n.x + t * 8.7) * sin(6.1 * n.y + t * 4.4));
  }
  for (int j = 0; j < 4; j++) {
    float age = uImp[j].w;
    if (age >= 0.0 && age < 2.6) {
      float ang = acos(clamp(dot(n, uImp[j].xyz), -1.0, 1.0));
      float k = uImpK[j];
      float front = age * 2.4;
      float env = exp(-age * 2.6) * smoothstep(front + 0.3, front - 0.15, ang) * exp(-ang * 0.5);
      d -= uCore.w * 0.035 * k * env * sin(ang * 10.0 - age * 20.0);
      d += uCore.w * 0.14 * k * (age * 10.0) * exp(1.0 - age * 10.0) * exp(-ang * ang * 14.0);
    }
  }
  return d;
}

float scene(vec3 p) {
  float d = sdCore(p);
  for (int i = 0; i < LMAX; i++) {
    if (i >= ln) break;
    vec4 b = lb[i];
    d = smin(d, length(p - b.xyz) - b.w, kOf(b.w));
  }
  // settled water sits on an invisible ground: flat where it touches
  if (uGround > 0.0) d = smax(d, p.y - uGround, 1.5);
  return d;
}

// The page. Mirrored in CSS for the no-WebGL fallback.
vec3 backdrop(vec2 q) {
  vec2 vp = uRes / uScale;
  float m = max(vp.x, vp.y);
  vec3 c = vec3(0.945, 0.947, 0.95);
  vec2 a = vec2(0.10, -0.05) * vp + vec2(sin(uTime * 0.05), cos(uTime * 0.04)) * 50.0;
  vec2 b = vec2(1.05, 0.35) * vp + vec2(cos(uTime * 0.035), sin(uTime * 0.045)) * 60.0;
  vec2 e = vec2(0.40, 1.10) * vp + vec2(sin(uTime * 0.03), cos(uTime * 0.05)) * 60.0;
  c = mix(c, vec3(0.985, 0.99, 0.995), 0.8 * exp(-dot(q - a, q - a) / (0.16 * m * m)));
  c = mix(c, vec3(0.88, 0.895, 0.92), 0.55 * exp(-dot(q - b, q - b) / (0.12 * m * m)));
  c = mix(c, vec3(0.97, 0.94, 0.915), 0.55 * exp(-dot(q - e, q - e) / (0.14 * m * m)));
  vec2 g = mod(q + 12.0, 24.0) - 12.0;
  c = mix(c, vec3(0.08, 0.09, 0.1), 0.2 * smoothstep(1.7, 0.9, length(g)));
  // floating: a small, dense shadow below with light focused through the drop inside it
  if (uShadow > 0.0) {
    vec2 fc = uFloor;
    vec2 fr = vec2(uCore.w * 0.78, uCore.w * 0.11);
    vec2 f = (q - fc) / fr;
    c *= 1.0 - 0.34 * uShadow * exp(-dot(f, f) * 2.2);
    vec2 f1 = (q - fc) / (fr * 1.9);
    c *= 1.0 - 0.10 * uShadow * exp(-dot(f1, f1) * 1.5);
    vec2 f2 = (q - fc - vec2(fr.x * 0.16, -fr.y * 0.15)) / (fr * vec2(0.28, 0.45));
    c += vec3(0.42) * uShadow * exp(-dot(f2, f2) * 2.2);
  }
  return c;
}

// ---- the water that collects along the bottom of the page, seen straight from the side, like a tank.
// Its level is a heightfield (px above the bottom edge) that rises with the rain and carries the waves.

float ph(int i) {
  int j = clamp(i, 0, NP - 1);
  return uPool[j / 4][j - (j / 4) * 4];
}

// Catmull-Rom through the heightfield, so the line is smooth between samples: height, slope and curvature at x.
vec3 surf(float x) {
  float w = uRes.x / uScale;
  float cell = w / float(NP - 1);
  float fx = clamp(x / w, 0.0, 1.0) * float(NP - 1);
  int i = int(floor(fx));
  float t = fract(fx);
  float p0 = ph(i - 1);
  float p1 = ph(i);
  float p2 = ph(i + 1);
  float p3 = ph(i + 2);
  float a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  float b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
  float c = 0.5 * (p2 - p0);
  float h = ((a * t + b) * t + c) * t + p1;
  float dh = ((3.0 * a * t + 2.0 * b) * t + c) / cell;
  float d2h = (6.0 * a * t + 2.0 * b) / (cell * cell);
  // the surface is never perfectly still: a fine shiver runs along it
  float k = smoothstep(1.0, 12.0, h);
  float t1 = x * 0.043 + uTime * 2.3;
  float t2 = x * 0.097 - uTime * 3.1;
  h += k * (0.3 * sin(t1) + 0.15 * sin(t2));
  dh += k * (0.3 * 0.043 * cos(t1) + 0.15 * 0.097 * cos(t2));
  return vec3(h, dh, d2h);
}

// Light focused by the moving surface onto the wall behind the water: soft, drifting bright bands.
float caustic(vec2 q, float t) {
  vec2 a = q * vec2(0.016, 0.022);
  float c = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    a += 0.6 * vec2(sin(a.y * 1.7 + t * (0.5 + 0.2 * fi) + fi * 1.3), cos(a.x * 1.4 - t * (0.45 + 0.15 * fi) + fi * 2.1));
    float r = abs(sin(a.x * 2.1 + a.y * 0.8)) * abs(sin(a.y * 1.9 - a.x * 0.6));
    c += 0.09 / (r + 0.09);
  }
  return smoothstep(0.3, 0.9, c / 3.0);
}

// The water along the bottom of the page, seen exactly side-on: the level is a horizontal line that rises with the rain.
vec3 water(vec2 p, vec3 bg) {
  if (uWaterOn < 0.5) return bg;
  vec2 vp = uRes / uScale;
  vec3 S = surf(p.x);
  float h = S.x;
  if (h < 0.3) return bg;
  float s = vp.y - h;
  float d = p.y - s;
  if (d < -4.0) return bg;
  float slope = S.y;
  float curv = S.z;

  // the top of the water, edge-on: a hair-thin pale sliver that glints as the ripples tilt it
  float glint = clamp(0.55 + slope * 3.0 + 0.2 * sin(p.x * 0.29 + uTime * 4.0), 0.0, 1.0);
  vec3 above = mix(bg, vec3(0.995), smoothstep(-2.4, -0.6, d) * (0.35 + 0.45 * glint));

  // below: the wall behind is seen through the water, a little magnified, so the dots break at the line.
  // Only right under the surface do the waves bend the view.
  float yl = vp.y - uLevel;
  vec2 q = vec2(vp.x * 0.5 + (p.x - vp.x * 0.5) * 0.975, yl + (p.y - yl) * 0.975 - 2.0);
  q += vec2(slope * 10.0, -curv * 40.0) * exp(-max(d, 0.0) / 9.0);
  vec3 c = backdrop(q);
  // the water itself: a faint grey veil, deeper toward the bottom, and a slightly darker layer under the surface
  c = mix(c, vec3(0.80, 0.81, 0.815), 0.12 + 0.2 * smoothstep(0.0, 320.0, d) + 0.08 * exp(-max(d, 0.0) / 14.0));
  // light focused by the waves, faint bands on the wall just under the surface
  c += vec3(0.05) * caustic(vec2(p.x + slope * 24.0, d), uTime) * smoothstep(2.0, 16.0, d) * exp(-d / 70.0);
  // just under the line the underside of the surface is a mirror (total internal reflection):
  // a silver band, thicker under the crests and broken up by the ripples
  float tirH = clamp(4.0 - curv * 60.0, 1.5, 9.0);
  float streak = 0.7 + 0.3 * sin(p.x * 0.21 + slope * 30.0 - uTime * 2.6);
  c = mix(c, vec3(0.99), smoothstep(tirH + 1.2, tirH * 0.3, d) * 0.75 * streak);
  // the meniscus at the front: a fine dark line exactly on the waterline
  c = mix(c, vec3(0.38, 0.4, 0.42), 0.55 * exp(-d * d / 0.45));
  return mix(above, c, smoothstep(-0.5, 0.5, d));
}

// Neutral studio surroundings for reflections: bright sky, soft window up-left, darker ground.
vec3 env(vec3 d) {
  float up = -d.y;
  vec3 c = mix(vec3(0.40, 0.41, 0.42), vec3(0.85, 0.86, 0.86), smoothstep(-0.5, 0.0, up));
  c = mix(c, vec3(0.99), smoothstep(0.0, 0.8, up));
  float fz = step(0.0, d.z);
  vec2 s1 = vec2(d.x + 0.42, up - 0.52);
  c += vec3(1.0) * fz * smoothstep(0.26, 0.18, abs(s1.x)) * smoothstep(0.14, 0.07, abs(s1.y)) * 4.0;
  return c;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale;
  vec3 bg = backdrop(p);
  bg = water(p, bg);
  if (gather(p) > 0.0) { gl_FragColor = vec4(bg, 1.0); return; }

  float z = uZTop;
  float minD = 100000.0;
  float zMin = z;
  bool hit = false;
  for (int i = 0; i < 80; i++) {
    float d = scene(vec3(p, z));
    if (d < minD) { minD = d; zMin = z; }
    if (d < 0.1) { hit = true; break; }
    z -= max(d * 0.85, 0.3);
    if (z < -uZTop) break;
  }
  // coverage from the closest approach gives a clean, smooth silhouette
  float px = 1.0 / uScale;
  float alpha = hit ? 1.0 : smoothstep(1.4 * px, 0.0, minD);
  if (alpha <= 0.001) { gl_FragColor = vec4(bg, 1.0); return; }

  vec3 pos = vec3(p, hit ? z : zMin);
  vec2 e = vec2(0.6, -0.6);
  vec3 N = normalize(e.xyy * scene(pos + e.xyy) + e.yyx * scene(pos + e.yyx) + e.yxy * scene(pos + e.yxy) + e.xxx * scene(pos + e.xxx));

  // the water sits around the z = 0 plane, so a front-surface height h means 2h of water along the ray
  float thick = 2.0 * max(pos.z, 0.0);

  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(LIGHT);
  float cosI = clamp(dot(N, V), 0.0, 1.0);
  float edge = 1.0 - cosI;
  float fres = 0.02 + 0.98 * pow(edge, 5.0);
  vec3 refl = env(reflect(-V, N));

  // lens: for a sphere, (p - centre) = N.xy · r and r = h / Nz
  vec2 off = N.xy * (max(pos.z, 0.0) / max(N.z, 0.12));
  float squeeze = 0.40 * (1.0 + 1.6 * edge * edge);
  vec3 tr;
  tr.r = backdrop(p - off * (squeeze - 0.004)).r;
  tr.g = backdrop(p - off * squeeze).g;
  tr.b = backdrop(p - off * (squeeze + 0.004)).b;

  // darker band under the highlight, on the lit side
  float upper = smoothstep(-0.1, -0.75, N.y) * smoothstep(0.98, 0.55, cosI);
  tr *= 1.0 - 0.2 * upper;

  // bright crescent low on the far side: light focused through the drop
  vec3 Lout = normalize(vec3(-L.x, -L.y, 0.35));
  float crescent = pow(max(dot(N, Lout), 0.0), 5.0) * smoothstep(0.12, 0.55, edge) * smoothstep(6.0, 40.0, thick);
  tr += vec3(1.0) * crescent * 0.55;

  // vapour bubbles, seen through the front of the drop: its lens moves them like the page behind, a little less.
  // A gas bubble in water is a small diverging lens, clear in the middle. Its outer quarter reflects totally,
  // a ring that mirrors the bright room above and the darker floor below; a glint faces the light and a
  // little light gathers on the far edge.
  vec2 pb = p - off * squeeze * 0.3;
  vec2 ld = normalize(L.xy);
  // toward the outline the water is thick and steeply curved: bubbles there are lost from view
  float clear = smoothstep(0.97, 0.72, length(p - uCore.xy) / max(uCore.w, 1.0));
  for (int i = 0; i < MAXBUB; i++) {
    if (i >= uNB) break;
    vec4 bb = uBub[i];
    float rr = max(bb.z, 0.6);
    // bigger bubbles flatten as they rise
    float ob = 1.0 + clamp(rr / uCore.w * 2.5, 0.0, 0.22);
    vec2 dv = (pb - bb.xy) * vec2(1.0 / ob, ob);
    float d = length(dv);
    if (d > rr + 1.5) continue;
    float rho = d / rr;
    vec2 nd = dv / max(d, 1e-3);
    float aa = 1.0 / rr;
    float inside = smoothstep(rr + 0.7, rr - 0.7, d);
    vec3 ringC = mix(vec3(0.36, 0.37, 0.38), vec3(0.93, 0.94, 0.95), (0.5 - 0.5 * nd.y) * 0.85);
    vec3 b = tr * 1.04 + 0.015;
    b = mix(b, ringC, smoothstep(0.58 - aa, 0.8, rho) * 0.8);
    b = mix(b, vec3(0.26, 0.27, 0.28), smoothstep(1.0 - max(0.14, 1.2 * aa), 1.0, rho) * 0.6);
    float glint = smoothstep(0.34 + aa, 0.0, length(dv / rr - ld * 0.42));
    float gather = smoothstep(0.2 + aa, 0.0, abs(rho - 0.72)) * smoothstep(0.3, 0.9, dot(nd, -ld));
    b += vec3(1.0) * (glint * 0.85 + gather * 0.4);
    tr = mix(tr, b, inside * bb.w * clear);
  }

  vec3 col = mix(tr, refl, fres);

  // total internal reflection: a thin, soft dark rim, heavier away from the light
  float away = 0.5 - 0.5 * dot(normalize(N.xy + 1e-4), normalize(L.xy));
  float tir = smoothstep(0.5, 0.82, edge) * (1.0 - smoothstep(0.93, 1.0, edge));
  col = mix(col, vec3(0.28, 0.29, 0.3), tir * (0.32 + 0.38 * away));

  // highlights: one sharp sun glint, a soft sheen, a faint second light on the right
  vec3 H = normalize(L + V);
  float h1 = max(dot(N, H), 0.0);
  float h2 = max(dot(N, normalize(normalize(vec3(0.85, -0.15, 0.5)) + V)), 0.0);
  float spec = pow(h1, 420.0) * 3.0 + pow(h1, 60.0) * 0.12 + pow(h2, 200.0) * 0.45;
  col += vec3(spec);

  gl_FragColor = vec4(mix(bg, min(col, vec3(1.0)), alpha), 1.0);
}
`;

// ---- rain: streaks and splash droplets drawn as instanced quads over the page and the water
export const MAXRAIN = 320;

export const RAIN_VERT = /* glsl */ `
attribute vec2 aP;
attribute vec2 aD;
attribute vec2 aS;
attribute float aA;
uniform vec2 uView;
varying vec2 vL;
varying vec2 vS;
varying float vA;
void main() {
  vec2 n = vec2(-aD.y, aD.x);
  vec2 ext = vec2(aS.x * 0.5 + 1.0, aS.y * 0.5 + 1.0);
  vec2 px = aP + n * position.x * ext.x + aD * position.y * ext.y;
  vL = position.xy * ext;
  vS = aS;
  vA = aA;
  gl_Position = vec4(px.x / uView.x * 2.0 - 1.0, 1.0 - px.y / uView.y * 2.0, 0.0, 1.0);
}
`;

export const RAIN_FRAG = /* glsl */ `
varying vec2 vL;
varying vec2 vS;
varying float vA;
void main() {
  float r = vS.x * 0.5;
  float hl = max(vS.y * 0.5 - r, 0.0);
  vec2 q = vec2(vL.x, max(abs(vL.y) - hl, 0.0));
  float d = length(q) - r;
  float a = smoothstep(0.7, -0.5, d) * vA * 0.6;
  // a clear drop: bright on the lit side, a faint dark edge on the other
  float side = clamp(-vL.x / max(r, 0.6), -1.0, 1.0);
  vec3 c = mix(vec3(0.36, 0.38, 0.4), vec3(1.0), 0.5 + 0.5 * side);
  gl_FragColor = vec4(c * a, a);
}
`;
