/**
 * A reference for the biological age estimate: Levine's phenotypic age (PhenoAge, 2018), computed from nine
 * routine blood markers and the person's age. The model gives the final range and the reasons; this keeps the
 * number anchored to a published formula instead of a guess. CRP is often not part of a check-up: when it is
 * missing, a typical value is used and the estimate is marked as less certain.
 */
import type { FileAnalysis } from './schemas.ts';

type Indicator = FileAnalysis['indicators'][number];

/** How to find each marker in a Chinese check-up report, and the plausible range in the formula's units. */
const MARKERS = {
  albumin: { codes: ['alb'], names: ['白蛋白'], not: ['前白蛋白', '白球', '尿', '微量'], range: [15, 70] },
  creatinine: { codes: ['crea', 'cr', 'cre', 'scr'], names: ['肌酐'], not: ['尿', '清除', '比'], range: [15, 1500] },
  glucose: { codes: ['glu', 'fpg', 'fbg'], names: ['空腹血糖', '血糖', '葡萄糖'], not: ['尿', '餐后', '糖化'], range: [1.5, 35] },
  crp: { codes: ['crp', 'hs-crp', 'hscrp'], names: ['c反应蛋白', 'c-反应蛋白'], not: [], range: [0, 300] },
  lymph: { codes: ['lym%', 'ly%', 'lymph%', 'lym'], names: ['淋巴细胞百分比', '淋巴细胞比率', '淋巴细胞比例', '淋巴细胞%'], not: ['绝对值', '计数', '#'], range: [3, 80] },
  mcv: { codes: ['mcv'], names: ['平均红细胞体积'], not: [], range: [55, 130] },
  rdw: { codes: ['rdw-cv', 'rdw', 'rdwcv'], names: ['红细胞分布宽度'], not: ['sd'], range: [8, 30] },
  alp: { codes: ['alp', 'akp'], names: ['碱性磷酸酶'], not: [], range: [10, 1000] },
  wbc: { codes: ['wbc'], names: ['白细胞计数', '白细胞'], not: ['尿', '镜检', '粪'], range: [0.5, 50] },
} as const;
type Marker = keyof typeof MARKERS;

const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/\s/g, '');

/** The marker's value converted to the formula's units, or null. */
function valueOf(m: Marker, inds: Indicator[]): number | null {
  const spec = MARKERS[m];
  const hit = inds.find(i => {
    if (i.numeric == null) return false;
    const name = norm(i.name);
    const code = norm(i.code);
    if (spec.not.some(n => name.includes(n) || code.includes(n))) return false;
    return (spec.codes as readonly string[]).includes(code) || spec.names.some(n => name.includes(n));
  });
  if (!hit || hit.numeric == null) return null;
  let v = hit.numeric;
  const unit = norm(hit.unit);
  // the usual Chinese units are the formula's; convert the common others
  if (m === 'albumin' && unit.includes('g/dl')) v *= 10;
  if (m === 'creatinine' && unit.includes('mg/dl')) v *= 88.4;
  if (m === 'glucose' && unit.includes('mg/dl')) v /= 18;
  if (m === 'crp') v = unit.includes('mg/dl') ? v * 10 : v; // kept in mg/L here
  if (m === 'rdw' && unit.includes('fl')) return null; // RDW-SD, not the percentage the formula wants
  const [lo, hi] = spec.range;
  return v >= lo && v <= hi ? v : null;
}

export type PhenoAge = { value: number; crpImputed: boolean; markers: Record<string, number> };

/** Levine 2018 phenotypic age, or null when a marker other than CRP (or the age) is missing. */
export function phenoAge(inds: Indicator[], age: number | null): PhenoAge | null {
  if (!age || age < 18 || age > 100) return null;
  const v = {} as Record<Marker, number | null>;
  for (const m of Object.keys(MARKERS) as Marker[]) v[m] = valueOf(m, inds);
  const missing = (Object.keys(v) as Marker[]).filter(m => m !== 'crp' && v[m] == null);
  if (missing.length) return null;
  const crpImputed = v.crp == null;
  // CRP below the detection limit is reported as 0; the formula needs its logarithm
  const crpMgDl = Math.max(crpImputed ? 1 : v.crp!, 0.1) / 10;
  const xb =
    -19.907 -
    0.0336 * v.albumin! +
    0.0095 * v.creatinine! +
    0.1953 * v.glucose! +
    0.0954 * Math.log(crpMgDl) -
    0.012 * v.lymph! +
    0.0268 * v.mcv! +
    0.3306 * v.rdw! +
    0.00188 * v.alp! +
    0.0554 * v.wbc! +
    0.0804 * age;
  const g = 0.0076927;
  const mort = 1 - Math.exp((-Math.exp(xb) * (Math.exp(120 * g) - 1)) / g);
  const value = 141.50225 + Math.log(-0.00553 * Math.log(1 - mort)) / 0.090165;
  if (!Number.isFinite(value)) return null;
  const markers: Record<string, number> = {};
  for (const m of Object.keys(v) as Marker[]) if (v[m] != null) markers[m] = Math.round(v[m]! * 100) / 100;
  return { value: Math.round(value * 10) / 10, crpImputed, markers };
}
