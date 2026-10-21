import type { ReportMeta } from './store.ts';
import type { ReportData } from './schemas.ts';

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const FONTS =
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;700&family=Noto+Serif+SC:wght@600;700&display=swap';

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{--ink:#141619;--ink2:#3A3E43;--muted:#5B6066;--line:rgba(20,22,25,.1);--accent:#17191C;--accent-d:#000;--hi:#A3480D;--hi-bg:rgba(251,235,221,.85);--lo:#36589A;--lo-bg:rgba(228,234,245,.85)}
html{-webkit-text-size-adjust:100%}
body{margin:0;color:var(--ink);font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',system-ui,sans-serif;line-height:1.6;
background-color:#F1F2F3;
background-image:radial-gradient(circle at 1px 1px,rgba(20,22,25,.14) 1px,transparent 1.5px),radial-gradient(60vmax 45vmax at 10% -5%,rgba(255,255,255,.85),transparent 62%),radial-gradient(50vmax 40vmax at 105% 35%,rgba(205,212,226,.55),transparent 60%),radial-gradient(60vmax 45vmax at 40% 110%,rgba(240,228,216,.55),transparent 60%);
background-size:24px 24px,auto,auto,auto;background-attachment:fixed}
.glass{background:rgba(255,255,255,.58);-webkit-backdrop-filter:blur(22px) saturate(170%);backdrop-filter:blur(22px) saturate(170%);border:1px solid rgba(255,255,255,.8);box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 12px 32px rgba(20,60,70,.08);border-radius:22px}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.glass{background:rgba(255,255,255,.9)}}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.serif{font-family:'Noto Serif SC',serif}
a{color:var(--accent)}a:hover{color:var(--accent-d)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 20px;border-radius:999px;border:1px solid rgba(255,255,255,.85);background:rgba(255,255,255,.6);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);color:var(--ink);font:inherit;font-size:14px;font-weight:500;cursor:pointer;text-decoration:none}
.btn:hover{background:rgba(255,255,255,.85)}
.btn-pri{background:var(--accent);border-color:var(--accent);color:#fff}
.btn-pri:hover{background:var(--accent-d);color:#fff}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
`;

function page(opts: { title: string; nonce: string; body: string; css?: string; script?: string }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(opts.title)}</title>
<link rel="stylesheet" href="${FONTS}">
<style>${BASE_CSS}${opts.css ?? ''}</style>
</head>
<body>
${opts.body}
${opts.script ? `<script nonce="${opts.nonce}">${opts.script}</script>` : ''}
</body>
</html>`;
}

export function csp(nonce: string) {
  return [
    "default-src 'none'",
    "img-src 'self'",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `script-src 'nonce-${nonce}'`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

const LOGO = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6c3.7 4.4 6.6 8.1 6.6 11.6a6.6 6.6 0 0 1-13.2 0c0-3.5 2.9-7.2 6.6-11.6z" fill="none" stroke="#141619" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 14.4a3.1 3.1 0 0 0 3 3" fill="none" stroke="#141619" stroke-width="1.6" stroke-linecap="round"/></svg>`;

function fmtDate(ms: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: process.env.TZ_DISPLAY || 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ms);
}

function fmtTime(ms: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: process.env.TZ_DISPLAY || 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ms);
}

const STATUS: Record<string, { label: string; color: string; bg: string }> = {
  high: { label: '偏高', color: 'var(--hi)', bg: 'var(--hi-bg)' },
  low: { label: '偏低', color: 'var(--lo)', bg: 'var(--lo-bg)' },
  borderline: { label: '临界', color: 'var(--hi)', bg: 'rgba(255,255,255,.7)' },
  abnormal: { label: '异常', color: 'var(--hi)', bg: 'var(--hi-bg)' },
};

const fmtNum = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toString() : Number(n.toFixed(2)).toString());

function rangeBar(a: ReportData['attention'][number]) {
  const v = a.numeric;
  const lo = a.refLow;
  const hi = a.refHigh;
  if (v == null || (lo == null && hi == null)) return '';
  let min: number;
  let max: number;
  if (lo != null && hi != null) {
    const span = Math.max(hi - lo, Math.abs(hi) * 0.1, 0.1);
    min = Math.min(lo - span * 0.5, v - span * 0.15);
    max = Math.max(hi + span * 0.5, v + span * 0.15);
    if (min < 0 && lo >= 0 && v >= 0) min = 0;
  } else if (hi != null) {
    min = 0;
    max = Math.max(hi * 1.5, v * 1.15);
  } else {
    min = 0;
    max = Math.max(lo! * 2, v * 1.2);
  }
  const pct = (x: number) => Math.max(0, Math.min(100, ((x - min) / (max - min || 1)) * 100));
  const zl = lo != null ? pct(lo) : 0;
  const zr = hi != null ? pct(hi) : 100;
  const mk = Math.max(1.5, Math.min(98.5, pct(v)));
  const color = a.status === 'low' ? 'var(--lo)' : 'var(--hi)';
  const hollow = a.status === 'borderline';
  return `<div class="bar" aria-hidden="true">
  <div class="track"></div>
  <div class="zone" style="left:${zl.toFixed(1)}%;width:${(zr - zl).toFixed(1)}%"></div>
  <div class="dot" style="left:${mk.toFixed(1)}%;${hollow ? `background:#fff;border:4px solid ${color}` : `background:${color};border:3px solid #fff;box-shadow:0 0 0 1px ${color}`}"></div>
</div>
<div class="bar-l mono"><span>${fmtNum(min)}</span><span>参考 ${esc(a.refText)}</span><span>${fmtNum(max)}</span></div>`;
}

const ADVICE_ICON: Record<string, string> = {
  alcohol: '<path d="M7 3h10l-1.5 7a3.5 3.5 0 0 1-7 0z"/><path d="M12 13.5V20M8.5 20h7"/>',
  sleep: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  stress: '<path d="M4 12c2.5-4 5.5-4 8 0s5.5 4 8 0"/>',
  weight: '<path d="M5 20h14l-2-11H7z"/><circle cx="12" cy="6" r="2.2"/>',
  medical: '<path d="M12 5v14M5 12h14"/>',
  other: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16h.01"/>',
};

const URGENCY: Record<string, { label: string; color: string; bg: string }> = {
  routine: { label: '择期就诊', color: 'var(--ink)', bg: 'rgba(20,22,25,.07)' },
  soon: { label: '两周内', color: 'var(--hi)', bg: 'var(--hi-bg)' },
  urgent: { label: '尽快就医', color: '#fff', bg: 'var(--hi)' },
};

const RISK: Record<string, string> = { low: '低风险', medium: '需留意', high: '尽快就医', unknown: '待评估' };

/** The health score as a half-circle gauge with its range lit up. */
function gauge(lo: number, hi: number, good: boolean) {
  const cx = 120;
  const cy = 116;
  const r = 96;
  const pt = (v: number) => {
    const a = Math.PI * (1 - v / 100);
    return `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy - r * Math.sin(a)).toFixed(2)}`;
  };
  const arc = (a: number, b: number) => `M ${pt(a)} A ${r} ${r} 0 0 1 ${pt(Math.max(b, a + 0.4))}`;
  const ticks = [0, 60, 70, 80, 90, 100]
    .map(v => {
      const a = Math.PI * (1 - v / 100);
      const x1 = cx + (r + 14) * Math.cos(a);
      const y1 = cy - (r + 14) * Math.sin(a);
      const x2 = cx + (r + 19) * Math.cos(a);
      const y2 = cy - (r + 19) * Math.sin(a);
      const lx = cx + (r + 31) * Math.cos(a);
      const ly = cy - (r + 31) * Math.sin(a) + 4;
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(20,22,25,.28)" stroke-width="1.2"/><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${v}</text>`;
    })
    .join('');
  return `<svg class="gauge" viewBox="-16 -22 272 150" role="img" aria-label="健康综合评分 ${lo} 到 ${hi} 分">
<path d="${arc(0, 100)}" fill="none" stroke="rgba(20,22,25,.08)" stroke-width="16" stroke-linecap="round"/>
<path d="${arc(lo, hi)}" fill="none" stroke="${good ? 'var(--ink)' : 'var(--hi)'}" stroke-width="16" stroke-linecap="round"/>
<g class="ticks">${ticks}</g>
<text x="${cx}" y="${cy - 26}" text-anchor="middle" class="g-num">${lo}–${hi}</text>
<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="g-sub">满分 100</text>
</svg>`;
}

/** Actual age as a line, the estimated biological age as a band, on one scale. */
function ageScale(b: ReportData['bioAge'][number]) {
  const chrono = b.chronological > 0 ? b.chronological : null;
  const min = Math.floor((Math.min(b.low, chrono ?? b.low) - 6) / 5) * 5;
  const max = Math.ceil((Math.max(b.high, chrono ?? b.high) + 6) / 5) * 5;
  const pct = (v: number) => ((v - min) / (max - min || 1)) * 100;
  const ticks: string[] = [];
  for (let v = min; v <= max; v += 5) ticks.push(`<span style="left:${pct(v).toFixed(2)}%">${v}</span>`);
  return `<div class="age" aria-hidden="true">
<div class="age-track"></div>
<div class="age-band" style="left:${pct(b.low).toFixed(2)}%;width:${(pct(b.high) - pct(b.low)).toFixed(2)}%"><span>生理 ${b.low}–${b.high} 岁</span></div>
${chrono ? `<div class="age-now" style="left:${pct(chrono).toFixed(2)}%"><span>实际 ${chrono} 岁</span></div>` : ''}
<div class="age-ticks mono">${ticks.join('')}</div>
</div>`;
}

const REPORT_CSS = `
.banner{position:sticky;top:0;z-index:5;background:rgba(20,22,25,.86);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:#E3E6E9;font-size:13px}
.banner>div{max-width:1040px;margin:0 auto;padding:10px 20px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px}
.banner strong{color:#fff;font-weight:500}
.wrap{max-width:1040px;margin:0 auto;padding:32px 20px 64px;display:flex;flex-direction:column;gap:44px}
h1{margin:6px 0 0;font-size:clamp(30px,5vw,44px);line-height:1.25}
h3{margin:0;font-size:17px;line-height:1.5}
p{margin:0}
.muted{color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{font-size:13px;padding:5px 12px;border-radius:999px;background:rgba(255,255,255,.6);border:1px solid rgba(255,255,255,.85);color:var(--ink2)}
.sec{display:flex;flex-direction:column;gap:16px}
.sec-h{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.sec-h .idx{font:600 13px/1 'JetBrains Mono',monospace;color:var(--muted);letter-spacing:.06em}
.sec-h h2{margin:0;font:700 24px/1.3 'Noto Serif SC',serif}
.sec-h .sub{font-size:13px;color:var(--muted)}
.card{padding:22px 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
.txt{font-size:14.5px;line-height:1.85;color:var(--ink2);max-width:40em}
.pill{display:inline-block;flex:none;font-size:12.5px;font-weight:700;padding:4px 11px;border-radius:999px;line-height:1.5}
.cite{font:600 10.5px/1 'JetBrains Mono',monospace;vertical-align:super;margin-left:2px;white-space:nowrap}
.cite a{text-decoration:none;color:var(--muted);padding:0 1px}
.cite a:hover{color:var(--ink)}
.urgent{padding:16px 20px;border-radius:18px;background:var(--hi);color:#fff;font-weight:500;line-height:1.7}
/* top: score above the conclusion */
.hero{padding:clamp(22px,4vw,34px);display:flex;flex-direction:column;gap:26px}
.hero-top{display:flex;flex-wrap:wrap;align-items:center;gap:18px 34px}
.gauge{width:min(272px,100%);height:auto;flex:none;overflow:visible}
.gauge .ticks text{font:500 11px 'JetBrains Mono',monospace;fill:var(--muted)}
.gauge .g-num{font:600 38px 'JetBrains Mono',monospace;fill:var(--ink);letter-spacing:-.02em}
.gauge .g-sub{font:400 12px 'Noto Sans SC',sans-serif;fill:var(--muted)}
.score-txt{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:10px}
.score-txt .k{font-size:13px;color:var(--muted)}
.score-txt .lb{font:700 26px/1.2 'Noto Serif SC',serif}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:-6px}
.stat{padding:10px 12px;border-radius:14px;background:rgba(255,255,255,.55)}
.stat span{display:block;font-size:12px;color:var(--muted)}
.stat b{font:600 22px/1.2 'JetBrains Mono',monospace}
.concl{padding-top:24px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:14px}
.concl .k{font-size:13px;font-weight:500;color:var(--muted);letter-spacing:.04em}
.lead{font:700 clamp(21px,2.6vw,26px)/1.6 'Noto Serif SC',serif}
.points{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}
.points li{position:relative;padding-left:22px;font-size:15.5px;line-height:1.8;color:var(--ink2);max-width:42em}
.points li::before{content:'';position:absolute;left:4px;top:.72em;width:7px;height:7px;border-radius:50%;background:var(--ink)}
/* biological age */
.bio{padding:24px;display:flex;flex-direction:column;gap:22px}
.bio-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px}
.bio-verdict{font:700 clamp(19px,2.3vw,22px)/1.6 'Noto Serif SC',serif;max-width:32em}
.age{position:relative;height:114px;margin:0 6px}
.age-track{position:absolute;left:0;right:0;top:44px;height:8px;border-radius:99px;background:rgba(20,22,25,.08)}
.age-band{position:absolute;top:36px;height:24px;border-radius:99px;background:linear-gradient(90deg,rgba(20,22,25,.72),rgba(20,22,25,.88));min-width:10px}
.age-band span{position:absolute;left:50%;top:-30px;transform:translateX(-50%);white-space:nowrap;font-size:13px;font-weight:700}
.age-now{position:absolute;top:28px;width:2px;height:40px;margin-left:-1px;background:var(--hi)}
.age-now span{position:absolute;left:50%;top:44px;transform:translateX(-50%);white-space:nowrap;font-size:12.5px;font-weight:600;color:var(--hi)}
.age-ticks span{position:absolute;bottom:0;transform:translateX(-50%);font-size:11px;color:var(--muted)}
.drivers{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.drv{padding:14px 16px;border-radius:16px;background:rgba(255,255,255,.55);display:flex;flex-direction:column;gap:10px}
.drv h4{margin:0;font-size:13px;font-weight:600}
.drv ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.drv li{font-size:14px;line-height:1.7;color:var(--ink2)}
.drv li b{color:var(--ink);font-weight:600}
.bio-note{font-size:12.5px;line-height:1.7;color:var(--muted)}
.bio-past{display:flex;flex-direction:column;gap:6px;padding-top:16px;border-top:1px solid var(--line);font-size:14px;color:var(--ink2)}
/* indicators */
.row{padding:20px 22px;display:flex;flex-wrap:wrap;align-items:center;gap:14px 28px}
.row .nm{flex:1 1 200px;min-width:0}
.row .vl{flex:0 0 150px}
.row .br{flex:1 1 240px;min-width:200px}
.row .txt{flex:1 1 100%;padding-top:14px;border-top:1px solid var(--line);max-width:none}
.bar{position:relative;height:26px}
.bar .track{position:absolute;left:0;right:0;top:10px;height:6px;border-radius:99px;background:rgba(20,22,25,.08)}
.bar .zone{position:absolute;top:10px;height:6px;border-radius:99px;background:rgba(20,22,25,.18)}
.bar .dot{position:absolute;top:5px;width:16px;height:16px;margin-left:-8px;border-radius:50%}
.bar-l{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted)}
/* visits, questions, food, exercise */
.visit{display:flex;flex-direction:column;gap:10px}
.visit .dep{font:700 20px/1.3 'Noto Serif SC',serif}
.kv{display:flex;gap:10px;font-size:14px;line-height:1.75;color:var(--ink2)}
.kv dt{flex:none;width:4.5em;color:var(--muted)}
.kv dd{margin:0;min-width:0}
.qs{counter-reset:q;list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.qs li{counter-increment:q;padding:18px 20px 18px 58px;position:relative}
.qs li::before{content:counter(q);position:absolute;left:18px;top:17px;width:26px;height:26px;border-radius:50%;background:var(--ink);color:#fff;display:grid;place-items:center;font:600 13px 'JetBrains Mono',monospace}
.qs .q{font-weight:600;font-size:15.5px;line-height:1.65}
.qs .why{margin-top:6px;font-size:13.5px;line-height:1.75;color:var(--muted)}
.food{display:flex;flex-direction:column;gap:12px}
.tag{font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.04em}
.foods{display:flex;flex-direction:column;gap:8px}
.foods div{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.foods .k{flex:none;width:2.6em;font-size:12.5px;font-weight:700}
.fd{font-size:13px;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.7);border:1px solid rgba(20,22,25,.08)}
.fd.less{color:var(--muted);text-decoration:line-through;text-decoration-color:rgba(20,22,25,.35)}
.dose{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.6);font-size:14px;line-height:1.7}
.caution{font-size:13px;line-height:1.75;color:var(--hi)}
/* follow-ups, trends, references */
table{width:100%;min-width:480px;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:12px;font-weight:500;color:var(--muted);padding:14px 20px}
td{padding:13px 20px;border-top:1px solid var(--line)}
.files{display:flex;flex-wrap:wrap;gap:12px;list-style:none;margin:12px 0 0;padding:0}
.files li{width:96px;font-size:11px;color:var(--ink2)}
.files .th{height:116px;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.7);border:1px solid rgba(255,255,255,.9);display:grid;place-items:center;font:600 12px 'JetBrains Mono',monospace;color:var(--muted)}
.files img{width:100%;height:100%;object-fit:cover;display:block}
.files .fn{margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.refs{counter-reset:r;list-style:none;margin:0;padding:6px 0}
.refs li{display:grid;grid-template-columns:44px 1fr;gap:4px 0;padding:16px 24px 16px 14px;border-top:1px solid var(--line);scroll-margin-top:60px}
.refs li:first-child{border-top:0}
.refs li:target{background:rgba(255,255,255,.7)}
.refs .n{font:600 13px/1.9 'JetBrains Mono',monospace;color:var(--muted);text-align:right;padding-right:14px}
.refs .pt{font-size:14.5px;line-height:1.8;color:var(--ink)}
.refs .src{grid-column:2;font-size:13px;line-height:1.7;color:var(--muted)}
.refs .src i{font-style:normal;color:var(--ink2)}
.foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--muted)}
@media (max-width:640px){
  .wrap{gap:36px}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .hero-top{justify-content:center}
  .score-txt{align-items:center;text-align:center}
  .qs li{padding-left:54px}
}
@media print{
  @page{size:A4;margin:14mm}
  body{background:#fff !important}
  .glass,.stat,.drv,.chip,.dose,.fd{background:#fff !important;-webkit-backdrop-filter:none !important;backdrop-filter:none !important;box-shadow:none !important;border:1px solid #dde1e4 !important}
  .banner{position:static;background:#fff;color:var(--ink);border-bottom:1px solid #dde1e4}
  .banner strong{color:var(--ink)}
  .no-print{display:none !important}
  .wrap{padding-top:12px;gap:30px}
  .row,.card,.bio,.drv,.qs li,.refs li,.hero-top,.concl,.age{break-inside:avoid}
  .foot{display:none}
  .sec-h{break-after:avoid}
  .cite a{color:var(--ink)}
}
`;

export function reportPage(meta: ReportMeta, nonce: string) {
  const r = meta.report;
  // citations: numbered in the order of the reference list at the end
  const refNo = new Map(r.evidence.map((e, i) => [e.pmid, i + 1]));
  const cites = (ids: string[]) => {
    const ns = [...new Set(ids.map(id => refNo.get(id)).filter((n): n is number => !!n))].sort((a, b) => a - b);
    return ns.length ? `<sup class="cite">[${ns.map(n => `<a href="#ref-${n}" aria-label="文献 ${n}">${n}</a>`).join(',')}]</sup>` : '';
  };
  const statusPill = (s: string) => {
    const st = STATUS[s] ?? STATUS.abnormal;
    return `<span class="pill" style="color:${st.color};background:${st.bg};${s === 'borderline' ? `border:1.5px solid ${st.color}` : ''}">${st.label}</span>`;
  };

  // sections are numbered in the order they appear
  let idx = 0;
  const section = (id: string, title: string, inner: string, sub = '') =>
    `<section class="sec" aria-labelledby="${id}"><div class="sec-h"><span class="idx">${String(++idx).padStart(2, '0')}</span><h2 id="${id}">${esc(title)}</h2>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>${inner}</section>`;

  const good = r.score.label === '很好' || r.score.label === '良好';
  const hero = `<section class="glass hero" aria-label="健康综合评分与结论">
<div class="hero-top">${gauge(r.score.low, r.score.high, good)}
<div class="score-txt"><span class="k">健康综合评分</span><span class="lb" style="color:${good ? 'var(--ink)' : 'var(--hi)'}">${esc(r.score.label)}</span><p class="txt">${esc(r.score.note)}</p></div></div>
<div class="stats"><div class="stat"><span>检查项目</span><b>${r.counts.total}</b></div><div class="stat"><span>正常</span><b>${r.counts.normal}</b></div><div class="stat"><span>需要关注</span><b style="color:var(--hi)">${r.counts.attention}</b></div><div class="stat"><span>影像发现</span><b>${r.counts.imaging}</b></div></div>
<div class="concl"><h2 class="k" style="margin:0">结论</h2><p class="lead">${esc(r.headline)}</p>
${r.keyPoints.length ? `<ul class="points">${r.keyPoints.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}</div>
</section>`;

  const [bio, ...pastBio] = r.bioAge;
  const conf = { low: '粗略估计', medium: '中等把握', high: '把握较大' } as const;
  const bioSec = bio
    ? section(
        't-bio',
        '生理年龄',
        `<div class="glass bio">
<div class="bio-head"><p class="bio-verdict">${esc(bio.verdict)}</p><span class="pill" style="background:rgba(20,22,25,.07)">${conf[bio.confidence]}${bio.examDate ? ` · ${esc(bio.examDate)}` : ''}</span></div>
${ageScale(bio)}
${bio.drivers.length ? `<div class="drivers">${(['older', 'younger'] as const)
          .map(e => {
            const ds = bio.drivers.filter(d => d.effect === e);
            if (!ds.length) return '';
            return `<div class="drv"><h4 style="color:${e === 'older' ? 'var(--hi)' : 'var(--lo)'}">${e === 'older' ? '↑ 让生理年龄偏大' : '↓ 让生理年龄偏小'}</h4><ul>${ds.map(d => `<li><b>${esc(d.name)}</b>　${esc(d.note)}</li>`).join('')}</ul></div>`;
          })
          .join('')}</div>` : ''}
<p class="bio-note">${
          bio.phenoAge != null
            ? `参考 Levine 等 2018 年提出的表型年龄（PhenoAge）公式，依据 9 项血液指标和年龄算出 ${bio.phenoAge} 岁${bio.crpImputed ? '；这份报告没有 C 反应蛋白，按常见值代入，区间相应放宽' : ''}。`
            : '这份报告缺少计算表型年龄所需的部分血液指标，区间是依据现有指标的粗略估计。'
        }生理年龄只是对身体状态的一个直观比喻，不是诊断。</p>
${pastBio.length ? `<div class="bio-past">${pastBio.map(b => `<div><span class="mono muted">${esc(b.examDate || '更早')}</span>　实际 ${b.chronological || '—'} 岁 · 生理 <b>${b.low}–${b.high}</b> 岁　<span class="muted">${esc(b.verdict)}</span></div>`).join('')}</div>` : ''}
</div>`,
        '依据体检指标估计的身体状态年龄',
      )
    : '';

  const visitsSec = section(
    't-vis',
    '就医建议',
    r.visits.length
      ? `<div class="grid">${r.visits
          .map(v => {
            const u = URGENCY[v.urgency] ?? URGENCY.routine;
            return `<div class="glass card visit"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><span class="dep">${esc(v.department)}</span><span class="pill" style="color:${u.color};background:${u.bg}">${u.label} · ${esc(v.when)}</span></div>
<dl style="margin:0;display:flex;flex-direction:column;gap:6px"><div class="kv"><dt>为什么</dt><dd>${esc(v.reason)}${cites(v.refs)}</dd></div>${v.prepare ? `<div class="kv"><dt>去之前</dt><dd>${esc(v.prepare)}</dd></div>` : ''}</dl></div>`;
          })
          .join('')}</div>`
      : `<div class="glass card"><p class="txt">目前没有需要专门去看医生的情况，按下面的复查计划按时复查即可。</p></div>`,
  );

  const attention = r.attention
    .map(
      a => `<li class="glass row">
  <div class="nm"><div><b style="font-size:17px">${esc(a.name)}</b> <span class="mono muted" style="font-size:12px">${esc(a.code)}</span></div>
  <div class="muted" style="font-size:13px;margin-top:4px">${esc(a.category)}${a.confirmedByUser ? ' · <span style="color:var(--accent-d)">数值已由你确认</span>' : ''}</div></div>
  <div class="vl"><div><span class="mono" style="font-weight:600;font-size:28px;line-height:1.1">${esc(a.value)}</span> <span class="muted" style="font-size:13px">${esc(a.unit)}</span></div>
  ${a.previous ? `<div class="muted" style="font-size:12px;margin-top:4px">上次 ${esc(a.previous)}${a.change ? ` · <span style="color:var(--hi)">${esc(a.change)}</span>` : ''}</div>` : ''}</div>
  <div class="br">${rangeBar(a)}</div>
  ${statusPill(a.status)}
  <p class="txt">${esc(a.explanation)}${cites(a.refs)}</p>
</li>`,
    )
    .join('');

  const imaging = r.imaging
    .map(
      m => `<div class="glass card" style="display:flex;flex-direction:column;gap:8px"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:baseline"><h3>${esc(m.title)}</h3><span class="muted" style="font-size:12px">${esc(m.exam)}</span></div>
<p class="txt">${esc(m.finding)}</p>
<p class="txt"><span class="pill" style="font-size:12px;color:var(--ink);background:rgba(20,22,25,.07);margin-right:6px">${RISK[m.risk]}</span>${esc(m.advice)}</p></div>`,
    )
    .join('');

  const questions = r.doctorQuestions
    .map(q => `<li class="glass"><p class="q">${esc(q.question)}</p><p class="why">为什么问：${esc(q.purpose)}</p></li>`)
    .join('');

  const food = r.nutrition
    .map(
      n => `<div class="glass card food"><span class="tag">针对 · ${esc(n.target)}</span><p class="txt" style="color:var(--ink)">${esc(n.advice)}${cites(n.refs)}</p>
<div class="foods">${n.eatMore.length ? `<div><span class="k" style="color:var(--ink)">多吃</span>${n.eatMore.map(f => `<span class="fd">${esc(f)}</span>`).join('')}</div>` : ''}${n.eatLess.length ? `<div><span class="k muted">少吃</span>${n.eatLess.map(f => `<span class="fd less">${esc(f)}</span>`).join('')}</div>` : ''}</div></div>`,
    )
    .join('');

  const rehab = r.rehab
    .map(
      x => `<div class="glass card food"><h3>${esc(x.title)}</h3><p class="txt">${esc(x.body)}${cites(x.refs)}</p>
<div class="dose"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#141619" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" style="flex:none;margin-top:3px"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg><span>${esc(x.dose)}</span></div>
${x.caution ? `<p class="caution">注意：${esc(x.caution)}</p>` : ''}</div>`,
    )
    .join('');

  const habits = r.advice
    .map(
      a => `<div class="glass card" style="display:flex;flex-direction:column;gap:8px"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#141619" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ADVICE_ICON[a.topic] ?? ADVICE_ICON.other}</svg>
<h3>${esc(a.title)}</h3><p class="txt">${esc(a.body)}</p></div>`,
    )
    .join('');

  const follow = r.followUps
    .map(
      f => `<li class="glass card"><b class="mono" style="font-size:18px">${esc(f.when)}</b>
<ul style="margin:10px 0 0;padding-left:20px;font-size:14px;line-height:1.9">${f.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
${f.note ? `<p class="muted" style="margin-top:8px;font-size:13px;line-height:1.75">${esc(f.note)}</p>` : ''}</li>`,
    )
    .join('');

  const trends = r.trends.length
    ? `<div class="glass" style="overflow-x:auto"><table><thead><tr><th scope="col">指标</th><th scope="col">上次</th><th scope="col">这次</th><th scope="col">变化</th></tr></thead><tbody>
${r.trends
  .map(
    t => `<tr><td>${esc(t.name)}</td><td class="mono muted">${esc(t.before)}</td><td class="mono" style="font-weight:600">${esc(t.after)}</td><td class="mono" style="color:${/^[-−↓]/.test(t.change) ? 'var(--lo)' : 'var(--hi)'}">${esc(t.change || '—')}</td></tr>`,
  )
  .join('')}
</tbody></table></div>`
    : '';

  const refs = r.evidence
    .map(
      (e, i) => `<li id="ref-${i + 1}"><span class="n">[${i + 1}]</span><div>${e.point ? `<p class="pt">${esc(e.point)}${e.relates ? ` <span class="muted" style="font-size:12.5px">· ${esc(e.relates)}</span>` : ''}</p>` : ''}</div>
<p class="src"><i>${esc(e.title)}</i> ${esc(e.journal)}${e.year ? `, ${esc(e.year)}` : ''}. ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">PMID ${esc(e.pmid)}</a>` : ''}</p></li>`,
    )
    .join('');

  const files = meta.files
    .map(
      (f, i) =>
        `<li><div class="th">${f.mime.startsWith('image/') ? `<img src="/r/${meta.id}/f/${i}" alt="">` : 'PDF'}</div><div class="fn" title="${esc(f.name)}">${esc(f.name)}</div></li>`,
    )
    .join('');

  const body = `
<div class="banner" role="note"><div>
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C9CED3" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
<span>限时报告：<strong id="exp">${esc(fmtTime(meta.expiresAt))}</strong> 自动清除</span>
<span class="mono no-print" style="color:#E6E9EC">剩余 <span id="cd">--</span></span>
<span style="flex:1"></span>
<button type="button" class="btn no-print" id="pdf" style="min-height:34px;padding:0 14px;color:var(--ink)">保存为 PDF</button>
</div></div>
<main class="wrap">
<header style="display:flex;flex-direction:column;gap:12px">
<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
<div style="display:flex;align-items:center;gap:8px">${LOGO}<b class="serif" style="font-size:17px;letter-spacing:.06em">滴析</b><span class="muted" style="font-size:13px">体检报告解读</span></div>
<span class="mono muted" style="font-size:12px">报告 ${esc(meta.id)}</span></div>
<h1 class="serif">${esc(r.title)}</h1>
<div class="chips"><span class="chip">${esc(r.patientLabel)}</span><span class="chip">体检日期 ${r.examDate ? esc(r.examDate) : '报告上未注明'}</span>${r.compareDate ? `<span class="chip">对比 ${esc(r.compareDate)}</span>` : ''}<span class="chip">报告生成于 <span id="made">${esc(fmtDate(meta.createdAt))}</span></span></div>
</header>
${r.urgent ? `<div class="urgent" role="alert">${esc(r.urgent)}</div>` : ''}
${hero}
${bioSec}
${visitsSec}
${r.attention.length ? section('t-att', `需要关注的 ${r.attention.length} 项指标`, `<ol class="list">${attention}</ol>`) : ''}
${r.imaging.length ? section('t-img', '影像发现', `<div class="grid">${imaging}</div>`) : ''}
${r.doctorQuestions.length ? section('t-q', '看医生时可以问', `<ol class="qs">${questions}</ol>`, '把这些问题带给医生，问清楚再做决定') : ''}
${r.nutrition.length ? section('t-food', '营养建议', `<div class="grid">${food}</div>`) : ''}
${r.rehab.length ? section('t-rehab', '康复与运动', `<div class="grid">${rehab}</div>`) : ''}
${r.advice.length ? section('t-hab', '生活习惯', `<div class="grid">${habits}</div>`) : ''}
${r.followUps.length ? section('t-fu', '复查计划', `<ol class="grid" style="list-style:none;margin:0;padding:0">${follow}</ol>`) : ''}
${trends ? section('t-tr', '和上次相比', trends) : ''}
<section class="grid">
${r.confirmations.length ? `<div class="glass card"><h3>你确认过的信息</h3><dl style="margin:12px 0 0;display:flex;flex-direction:column;gap:12px;font-size:14px">${r.confirmations.map(c => `<div><dt class="muted" style="font-size:12px">${esc(c.label)}</dt><dd style="margin:2px 0 0">${esc(c.value)}</dd></div>`).join('')}</dl></div>` : ''}
<div class="glass card"><h3>原始文件</h3><p class="muted" style="margin-top:4px;font-size:13px">${meta.files.length} 份 · 到期后与本页一同删除</p><ul class="files">${files}</ul></div>
</section>
${r.evidence.length ? section('t-ref', '文献依据', `<ol class="glass refs">${refs}</ol>`, '来自 PubMed，正文中的 [数字] 对应这里的编号') : ''}
<section class="glass card txt" style="font-size:13px;max-width:none"><b style="color:var(--ink)">请注意：</b>本报告由 AI 根据上传的体检报告生成，用来帮助理解检查结果，不能替代医生的诊断和治疗建议。生理年龄与健康评分是估计值，仅供参考。如有不适，或指标明显异常，请及时就医。</section>
<footer class="foot"><span>滴析 · 报告 ${esc(meta.id)}</span><span>到期后，此链接将显示「报告已清除」</span></footer>
</main>`;

  const script = `(function(){
var end=${meta.expiresAt};var el=document.getElementById('cd');
try{document.getElementById('exp').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(end);
document.getElementById('made').textContent=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(${meta.createdAt})}catch(e){}
function p(n){return n<10?'0'+n:''+n}
function tick(){var r=end-Date.now();if(r<=0){location.reload();return}
var h=Math.floor(r/3600000),m=Math.floor(r%3600000/60000),s=Math.floor(r%60000/1000);el.textContent=h+' 小时 '+p(m)+':'+p(s)}
tick();setInterval(tick,1000);
document.getElementById('pdf').addEventListener('click',function(){window.print()});
if(/[?&]print=1/.test(location.search)){window.addEventListener('load',function(){setTimeout(function(){window.print()},400)})}
})();`;

  return page({ title: `${r.title} · 滴析`, nonce, body, css: REPORT_CSS, script });
}

const CENTER_CSS = `
.center{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:32px 16px;text-align:center}
.center h1{margin:0;font-size:clamp(24px,3.4vw,34px);line-height:1.35}
.center p{margin:0;max-width:520px;font-size:15px;line-height:1.85;color:var(--ink2)}
.ghost{width:150px;height:150px;border-radius:50%;border:2px dashed rgba(20,22,25,.25)}
input.code{width:220px;min-height:52px;border-radius:14px;border:1px solid rgba(20,22,25,.18);background:rgba(255,255,255,.8);text-align:center;font:600 22px 'JetBrains Mono',monospace;letter-spacing:.3em}
`;

export function lockedPage(id: string, nonce: string, error?: string) {
  const body = `<main class="center">
<div style="display:flex;align-items:center;gap:8px">${LOGO}<b class="serif" style="letter-spacing:.06em">滴析</b></div>
<form class="glass" method="post" action="/r/${esc(id)}/unlock" style="padding:28px 26px;display:flex;flex-direction:column;align-items:center;gap:16px;max-width:380px;width:100%">
<h1 class="serif" style="font-size:24px">这份报告需要提取码</h1>
<p>请向分享人索取 6 位提取码。</p>
<label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--ink2)">提取码
<input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus></label>
${error ? `<p role="alert" style="color:var(--hi);font-size:14px">${esc(error)}</p>` : ''}
<button class="btn btn-pri" type="submit" style="width:100%">查看报告</button>
</form></main>`;
  return page({ title: '需要提取码 · 滴析', nonce, body, css: CENTER_CSS });
}

export function expiredPage(nonce: string) {
  const body = `<main class="center">
<div class="ghost" aria-hidden="true"></div>
<span class="chip">已到期 · 已清除</span>
<h1 class="serif">这份报告已到期，内容已被清除</h1>
<p>报告页面、原始文件和全部解析数据都已从服务器删除，无法恢复。如需再次查看，请联系分享人重新生成链接。</p>
<a class="btn btn-pri" href="/">我也来解读一份体检报告</a>
</main>`;
  return page({ title: '报告已清除 · 滴析', nonce, body, css: CENTER_CSS + '.chip{font-size:13px;padding:5px 12px;border-radius:999px;background:rgba(255,255,255,.6)}' });
}
