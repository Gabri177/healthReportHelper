import { useEffect, useRef } from 'react';

export type Item = {
  id: string;
  name: string;
  size: number;
  preview: string | null;
  status: 'reading' | 'done' | 'failed';
  landed: boolean;
  info?: string;
  error?: string;
};

export function FileTray({ items, onDismiss }: { items: Item[]; onDismiss: (id: string) => void }) {
  const shown = items.filter(i => i.landed);
  const list = useRef<HTMLUListElement>(null);
  // one row that scrolls sideways; the newest file slides into view
  useEffect(() => {
    list.current?.scrollTo({ left: list.current.scrollWidth, behavior: 'smooth' });
  }, [shown.length]);
  if (!shown.length) return null;
  return (
    <ul ref={list} className="tray" aria-label="已丢入的文件">
      {shown.map(i => (
        <li key={i.id} className={`chip glass is-${i.status}`}>
          <span className="chip-thumb" aria-hidden="true">
            {i.preview ? <img src={i.preview} alt="" /> : <span className="mono">PDF</span>}
          </span>
          <span className="chip-text">
            <span className="chip-name" title={i.name}>
              {i.name}
            </span>
            <span className="chip-status" aria-live="polite">
              {i.status === 'reading' && <span className="spin" aria-hidden="true" />}
              <span className="chip-msg" title={i.status === 'failed' ? i.error : undefined}>
                {i.status === 'reading' ? '正在识别' : i.status === 'done' ? i.info || '已识别' : i.error || '识别失败'}
              </span>
            </span>
          </span>
          {i.status === 'failed' && (
            <button type="button" className="chip-x" aria-label={`移除 ${i.name}`} onClick={() => onDismiss(i.id)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
