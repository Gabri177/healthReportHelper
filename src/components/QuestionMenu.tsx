import { useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { Question } from '../api';

type Props = {
  q: Question;
  remaining: number;
  slotRef: Ref<HTMLSpanElement>;
  onAnswer: (optionIds: string[], note: string) => void;
};

/** The menu that sits next to a question bead. Re-mounted per question (keyed by id), which replays its entrance. */
export function QuestionMenu({ q, remaining, slotRef, onAnswer }: Props) {
  const [sel, setSel] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [writing, setWriting] = useState(false);
  const box = useRef<HTMLElement>(null);

  // the page lays itself out around the menu's height (on narrow screens the drop shrinks to make room)
  useLayoutEffect(() => {
    const el = box.current;
    const app = el?.closest<HTMLElement>('.app');
    if (!el || !app) return;
    const ro = new ResizeObserver(() => app.style.setProperty('--qh', `${Math.ceil(el.offsetHeight)}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      app.style.removeProperty('--qh');
    };
  }, []);

  const toggle = (id: string, exclusive: boolean) => {
    if (q.type === 'single') return setSel([id]);
    if (exclusive) return setSel(s => (s.includes(id) ? [] : [id]));
    setSel(s => {
      const base = s.filter(x => !q.options.find(o => o.id === x)?.exclusive);
      return base.includes(id) ? base.filter(x => x !== id) : [...base, id];
    });
  };

  const titleId = `q-${q.id}`;
  return (
    <section ref={box} className="qmenu glass" aria-labelledby={titleId}>
      <span className="bead-slot" ref={slotRef} aria-hidden="true" />
      <div className="qmenu-head">
        <span className="tag">{q.tag}</span>
        <span className="muted small">{remaining > 1 ? `还有 ${remaining - 1} 个问题在排队` : '最后一个问题'}</span>
      </div>
      <h2 id={titleId}>{q.title}</h2>
      <p className="muted small">{q.context}</p>
      <div className="opts" role="group" aria-labelledby={titleId}>
        {q.options.map(o => {
          const on = sel.includes(o.id);
          return (
            <button key={o.id} type="button" className={`opt${on ? ' is-sel' : ''}`} aria-pressed={on} onClick={() => toggle(o.id, o.exclusive)}>
              <span className={`mark${q.type === 'multi' ? ' is-box' : ''}`} aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              </span>
              <span className="opt-text">
                <span className="opt-label">
                  {o.label}
                  {o.recommended && <span className="rec">AI 推荐</span>}
                </span>
                {o.note && <span className="muted small">{o.note}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {writing && (
        <label className="note">
          都不对？用一句话告诉水滴
          <input className="input" type="text" value={note} maxLength={200} placeholder={q.placeholder} autoFocus onChange={e => setNote(e.target.value)} />
        </label>
      )}
      <div className="row">
        {!writing && (
          <button type="button" className="note-open" onClick={() => setWriting(true)}>
            都不对？自己写一句
          </button>
        )}
        <span className="grow" />
        <button type="button" className="btn btn-text" onClick={() => onAnswer([], '')}>
          跳过
        </button>
        <button type="button" className="btn btn-pri" disabled={!sel.length && !note.trim()} onClick={() => onAnswer(sel, note.trim())}>
          确认
        </button>
      </div>
    </section>
  );
}
