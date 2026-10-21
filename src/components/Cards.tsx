import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ReportData } from '../api';
import { CardWater } from './CardWater';

export const HOURS = [3, 6, 12, 24] as const;

export function fmtExpire(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === today.toDateString()) return `今天 ${hm}`;
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function markerPct(a: ReportData['attention'][number]) {
  const { numeric: v, refLow: lo, refHigh: hi } = a;
  if (v == null || (lo == null && hi == null)) return null;
  const min = lo != null ? lo - Math.abs((hi ?? lo * 2) - lo) * 0.5 : 0;
  const max = hi != null ? hi + Math.abs(hi - (lo ?? 0)) * 0.5 : (lo ?? v) * 2;
  return Math.max(4, Math.min(96, ((v - min) / (max - min || 1)) * 100));
}

/** A miniature of the generated report, used as the face of each card. */
export function ReportThumb({ report }: { report: ReportData }) {
  return (
    <div className="thumb" aria-hidden="true">
      <div className="thumb-top">
        <svg width="10" height="10" viewBox="0 0 24 24">
          <path d="M12 2.6c3.7 4.4 6.6 8.1 6.6 11.6a6.6 6.6 0 0 1-13.2 0c0-3.5 2.9-7.2 6.6-11.6z" fill="none" stroke="currentColor" strokeWidth="2.2" />
        </svg>
        滴析 · 体检报告解读
      </div>
      <div className="thumb-title">{report.title}</div>
      <p className="thumb-head">{report.headline}</p>
      <div className="thumb-tiles">
        <span>
          <b>{report.counts.total}</b>项目
        </span>
        <span>
          <b>{report.counts.normal}</b>正常
        </span>
        <span>
          <b style={{ color: 'var(--hi)' }}>{report.counts.attention}</b>关注
        </span>
      </div>
      {report.attention.slice(0, 3).map(a => {
        const p = markerPct(a);
        return (
          <div className="thumb-row" key={a.name}>
            <span>{a.name}</span>
            <i>{p != null && <em style={{ left: `${p}%`, background: a.status === 'low' ? 'var(--lo)' : 'var(--hi)' }} />}</i>
          </div>
        );
      })}
    </div>
  );
}

/** How full a card is: the longer the link lives, the more water it holds. */
const fillOf = (hours: number) => 0.12 + 0.6 * Math.pow(hours / 24, 0.8);

export function Card({ report, hours, expiresAt }: { report: ReportData; hours: number; expiresAt: number }) {
  return (
    <div className="card-face">
      <ReportThumb report={report} />
      <CardWater level={fillOf(hours)} />
      <div className="card-foot">
        <span className="dur">
          <b className="mono">{hours}</b> 小时
        </span>
        <span className="exp">{fmtExpire(expiresAt)} 失效</span>
      </div>
    </div>
  );
}

/**
 * Four validity options held like a hand of cards: overlapping at the bottom, fanned at the top.
 * Clicking a card draws it out of the hand; a click anywhere else (or Esc) puts it back.
 */
export function CardFan({ report, disabled, onPick }: { report: ReportData; disabled: boolean; onPick: (hours: number) => void }) {
  const now = Date.now();
  const [open, setOpen] = useState<number | null>(null);
  const fan = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open == null || disabled) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      // the code switch belongs with the choice, so using it keeps the card out
      if (!t.closest?.('.fan-card.is-open, .code-toggle')) setOpen(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(null);
      fan.current?.querySelector<HTMLElement>('.fan-card.is-open .card-btn')?.focus();
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open, disabled]);

  return (
    <div ref={fan} className={`fan${open != null ? ' has-open' : ''}`} role="group" aria-label="选择报告有效期">
      {HOURS.map((h, i) => {
        const at = now + h * 3600_000;
        const isOpen = open === i;
        return (
          <div key={h} className={`fan-card${isOpen ? ' is-open' : ''}`} style={{ '--i': i, '--rot': `${(i - 1.5) * 12}deg` } as CSSProperties}>
            <button
              type="button"
              className="card-btn"
              disabled={disabled}
              aria-expanded={isOpen}
              aria-label={`有效期 ${h} 小时，${fmtExpire(at)} 失效`}
              onClick={() => setOpen(i)}
            >
              <Card report={report} hours={h} expiresAt={at} />
            </button>
            {isOpen && (
              <button type="button" className="btn btn-pri card-go" disabled={disabled} onClick={() => onPick(h)}>
                {disabled ? '正在生成链接…' : `就这张，生成 ${h} 小时链接`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
