import { useEffect, useState } from 'react';
import * as api from '../api';
import { Card, fmtExpire } from './Cards';

type Props = {
  pub: api.Published & { hours: number };
  report: api.ReportData;
  onRestart: () => void;
};

const pad = (n: number) => String(n).padStart(2, '0');

export function DonePanel({ pub, report, onRestart }: Props) {
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [gone, setGone] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const left = Math.max(0, pub.expiresAt - now);
  const countdown = `${Math.floor(left / 3600_000)} 小时 ${pad(Math.floor((left % 3600_000) / 60_000))}:${pad(Math.floor((left % 60_000) / 1000))}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pub.code ? `${pub.url}\n提取码：${pub.code}` : pub.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setErr('浏览器不允许自动复制，请手动选中链接复制');
    }
  };

  // The owner skips the code prompt: the server sets the unlock cookie for this report first.
  const open = async (print: boolean) => {
    setErr('');
    const w = window.open('about:blank', '_blank');
    try {
      if (pub.code) await api.ownerUnlock(pub.reportId, pub.ownerToken);
      const href = `/r/${pub.reportId}${print ? '?print=1' : ''}`;
      if (w) w.location.href = href;
      else location.href = href;
    } catch (e) {
      w?.close();
      setErr((e as Error).message);
    }
  };

  const destroy = async () => {
    setErr('');
    try {
      await api.destroy(pub.reportId, pub.ownerToken);
      setGone(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (gone || left === 0) {
    return (
      <section className="glass done-panel done-gone">
        {/* the drop, emptied */}
        <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2.6c3.7 4.4 6.6 8.1 6.6 11.6a6.6 6.6 0 0 1-13.2 0c0-3.5 2.9-7.2 6.6-11.6z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 2.2" strokeLinejoin="round" />
        </svg>
        <h2 className="serif">{gone ? '报告已销毁' : '报告已到期'}</h2>
        <p className="muted">链接已经失效，报告页面和原始文件都已从服务器删除。</p>
        <button type="button" className="btn btn-pri" onClick={onRestart}>
          再解读一份
        </button>
      </section>
    );
  }

  return (
    <div className="done">
      <div className="done-card">
        <Card report={report} hours={pub.hours} expiresAt={pub.expiresAt} />
      </div>
      <section className="glass done-panel" aria-labelledby="done-title">
        <div className="done-head">
          <span className="ok-dot" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>
          <h2 id="done-title" className="serif">
            报告已生成，复制链接就能分享
          </h2>
        </div>
        <div className="linkbox">
          <span className="mono link">{pub.url}</span>
          <button type="button" className="btn btn-pri btn-sm" onClick={copy} aria-live="polite">
            {copied ? '已复制' : '复制链接'}
          </button>
        </div>
        {pub.code && (
          <p className="code-line">
            提取码 <b className="mono">{pub.code}</b> · 复制链接时会一起带上
          </p>
        )}
        <div className="done-grid">
          <div className="tile">
            <span className="muted small">距离自动清除</span>
            <b className="mono big">{countdown}</b>
            <span className="muted small">{fmtExpire(pub.expiresAt)} 失效</span>
          </div>
          <div className="tile">
            <span className="muted small">到期后一并清除</span>
            <ul>
              <li>报告页面</li>
              <li>上传的原始文件</li>
              <li>识别数据与你的回答</li>
            </ul>
          </div>
        </div>
        {/* the destroy confirmation takes the place of the actions, so the panel never grows */}
        {!confirm ? (
          <div className="row wrap done-actions">
            <button type="button" className="btn btn-glass" onClick={() => open(false)}>
              打开报告
            </button>
            <button type="button" className="btn btn-glass" onClick={() => open(true)}>
              保存为 PDF
            </button>
            <button type="button" className="btn btn-text" onClick={onRestart}>
              再解读一份
            </button>
            <span className="grow" />
            <button type="button" className="btn-danger" onClick={() => setConfirm(true)}>
              立即销毁
            </button>
          </div>
        ) : (
          <div className="confirm" role="alert">
            <span>销毁后链接立即失效，报告和原始文件都无法恢复。</span>
            <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirm(false)}>
              取消
            </button>
            <button type="button" className="btn btn-warn btn-sm" onClick={destroy}>
              确认销毁
            </button>
          </div>
        )}
        {err && (
          <p className="err" role="status">
            {err}
          </p>
        )}
      </section>
    </div>
  );
}
