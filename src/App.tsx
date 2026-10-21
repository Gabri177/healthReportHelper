import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api';
import { LiquidEngine } from './liquid/engine';
import { isAccepted, prepare, sampleFiles } from './prepare';
import { QuestionMenu } from './components/QuestionMenu';
import { FileTray, type Item } from './components/FileTray';
import { CardFan } from './components/Cards';
import { DonePanel } from './components/DonePanel';

type Stage = 'idle' | 'collecting' | 'writing' | 'pick' | 'publishing' | 'done';
type Point = { x: number; y: number };

const MAX_PARALLEL = 3;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLSpanElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickOrigin = useRef<Point | null>(null);
  const engine = useRef<LiquidEngine | null>(null);
  const session = useRef<Promise<string> | null>(null);
  const queue = useRef<(() => Promise<void>)[]>([]);
  const running = useRef(0);

  const [glOk, setGlOk] = useState(true);
  const [mock, setMock] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [items, setItems] = useState<Item[]>([]);
  const [questions, setQuestions] = useState<api.Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, api.Answer>>({});
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hot, setHot] = useState(false);
  const [dragN, setDragN] = useState(0);
  const [report, setReport] = useState<api.ReportData | null>(null);
  const [requireCode, setRequireCode] = useState(true);
  const [pub, setPub] = useState<(api.Published & { hours: number }) | null>(null);
  const [error, setError] = useState('');

  const pending = useMemo(() => questions.filter(q => !answers[q.id]), [questions, answers]);
  const reading = items.filter(i => i.status === 'reading').length;
  const doneCount = items.filter(i => i.status === 'done').length;
  const canDrop = (stage === 'idle' || stage === 'collecting') && !closing;
  // the report can be written once nothing is being read, no question is waiting and at least one file was read
  const ready = reading === 0 && pending.length === 0 && doneCount > 0;

  // ---------- liquid engine ----------
  useEffect(() => {
    const e = new LiquidEngine(canvasRef.current!);
    e.setAnchor(anchorRef.current);
    // raindrops splash on the top edges of these
    e.obstacles = '.fan-card, .done-card, .done-panel, .code-toggle';
    engine.current = e;
    if (import.meta.env.DEV) (window as unknown as { __liquid: LiquidEngine }).__liquid = e;
    setGlOk(e.ok);
    fetch('/api/config')
      .then(r => r.json())
      .then(c => setMock(!!c.mock))
      .catch(() => {});
    return () => e.dispose();
  }, []);

  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.interactive = canDrop;
    // once the result is in, the drop bursts and it starts to rain
    e.setMode(stage === 'pick' || stage === 'publishing' || stage === 'done' ? 'settle' : 'float');
    e.dragCount = Math.max(1, dragN);
    // a simmer while files are read; a boil that builds up while the report is written
    e.heatTarget = stage === 'writing' ? 1 : reading > 0 ? 0.35 : 0;
    e.setBeads(stage === 'collecting' ? pending.map((q, i) => ({ id: q.id, el: i === 0 ? slotRef.current : null })) : []);
  });

  // ---------- uploads ----------
  const getSession = () => (session.current ??= api.createSession().then(r => r.sessionId));

  const update = (id: string, patch: Partial<Item>) => setItems(prev => prev.map(i => (i.id === id ? { ...i, ...patch } : i)));

  const pump = () => {
    while (running.current < MAX_PARALLEL && queue.current.length) {
      const job = queue.current.shift()!;
      running.current += 1;
      job().finally(() => {
        running.current -= 1;
        pump();
      });
    }
  };

  const upload = (id: string, file: File) => {
    queue.current.push(async () => {
      const prep = await prepare(file);
      if ('error' in prep) return update(id, { status: 'failed', error: prep.error });
      update(id, { preview: prep.preview, name: prep.name });
      try {
        const sid = await getSession();
        const r = await api.uploadFile(sid, prep.blob, prep.name);
        if (!r.ok) return update(id, { status: 'failed', error: r.error });
        const info = [`${r.indicatorCount ?? 0} 项指标`, r.attentionCount ? `${r.attentionCount} 项需关注` : ''].filter(Boolean).join(' · ');
        update(id, { status: 'done', info });
        if (r.questions.length) setQuestions(prev => [...prev, ...r.questions.filter(q => !prev.some(p => p.id === q.id))]);
      } catch (e) {
        update(id, { status: 'failed', error: (e as Error).message });
      }
    });
    pump();
  };

  const addFiles = (files: File[], from: Point, fromCursor: boolean) => {
    const ok = files.filter(isAccepted);
    if (ok.length < files.length) setError(ok.length ? `已跳过 ${files.length - ok.length} 个不支持的文件` : '只支持 PDF 和图片');
    else setError('');
    if (!ok.length) return;
    const fresh: Item[] = ok.map(f => ({ id: crypto.randomUUID(), name: f.name, size: f.size, preview: null, status: 'reading', landed: false }));
    setItems(prev => [...prev, ...fresh]);
    const ids = new Set(fresh.map(f => f.id));
    engine.current?.launch(
      from.x,
      from.y,
      ok.length,
      () => {
        setItems(prev => prev.map(i => (ids.has(i.id) ? { ...i, landed: true } : i)));
        setStage(s => (s === 'idle' ? 'collecting' : s));
      },
      fromCursor,
    );
    ok.forEach((f, i) => upload(fresh[i].id, f));
  };

  // window-level drag & drop: a file can be released anywhere on the page
  const live = useRef({ canDrop, addFiles });
  live.current = { canDrop, addFiles };
  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth += 1;
      if (!live.current.canDrop) return;
      setDragging(true);
      setDragN(e.dataTransfer!.items.length);
    };
    const over = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      if (!live.current.canDrop) {
        e.dataTransfer!.dropEffect = 'none';
        return;
      }
      e.dataTransfer!.dropEffect = 'copy';
      const eng = engine.current;
      if (eng) {
        eng.pointer = { x: e.clientX, y: e.clientY, drag: true };
        setHot(eng.isHot(e.clientX, e.clientY));
      }
      setDragging(true);
    };
    const reset = () => {
      depth = 0;
      setDragging(false);
      setHot(false);
      if (engine.current) engine.current.pointer = null;
    };
    const leave = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) reset();
    };
    const drop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      reset();
      if (!live.current.canDrop) return;
      live.current.addFiles(Array.from(e.dataTransfer!.files), { x: e.clientX, y: e.clientY }, true);
    };
    // The pointer is a blade: just moving it through the water cuts it (a finger works the same way).
    const move = (e: PointerEvent) => {
      const eng = engine.current;
      if (!eng || eng.pointer?.drag) return;
      if (e.pointerType === 'mouse' || e.buttons) eng.pointer = { x: e.clientX, y: e.clientY, drag: false };
    };
    const lift = (e: PointerEvent) => {
      const eng = engine.current;
      if (eng && e.pointerType !== 'mouse' && !eng.pointer?.drag) eng.pointer = null;
    };
    const out = (e: MouseEvent) => {
      if (!e.relatedTarget && engine.current && !engine.current.pointer?.drag) engine.current.pointer = null;
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', lift);
    window.addEventListener('pointercancel', lift);
    document.addEventListener('mouseout', out);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', lift);
      window.removeEventListener('pointercancel', lift);
      document.removeEventListener('mouseout', out);
    };
  }, []);

  const centerOf = (el: Element | null): Point => {
    if (!el) return { x: innerWidth / 2, y: -30 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  const openPicker = (from: Element | null) => {
    pickOrigin.current = from ? centerOf(from) : null;
    fileInput.current?.click();
  };

  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    const a = anchorRef.current?.getBoundingClientRect();
    addFiles(files, pickOrigin.current ?? { x: a ? a.left + a.width / 2 : innerWidth / 2, y: -30 }, false);
  };

  const trySample = async (btn: Element) => {
    addFiles(await sampleFiles(), centerOf(btn), false);
  };

  // ---------- questions ----------
  const answer = (q: api.Question, optionIds: string[], note: string) => {
    const a: api.Answer = { questionId: q.id, optionIds, note };
    setAnswers(prev => ({ ...prev, [q.id]: a }));
    getSession()
      .then(sid => api.sendAnswers(sid, [a]))
      .catch(() => {});
  };

  // ---------- finish → write → pick → publish ----------
  useEffect(() => {
    if (!closing || stage !== 'collecting' || reading > 0 || pending.length > 0) return;
    if (doneCount === 0) {
      setClosing(false);
      setError('还没有识别成功的报告，换个文件试试');
      return;
    }
    setStage('writing');
    setError('');
    (async () => {
      try {
        const sid = await getSession();
        const r = await api.finish(sid, Object.values(answers));
        setReport(r.report);
        setStage('pick');
      } catch (e) {
        setError((e as Error).message);
        setClosing(false);
        setStage('collecting');
      }
    })();
  }, [closing, stage, reading, pending.length, doneCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (hours: number) => {
    setStage('publishing');
    setError('');
    try {
      const sid = await getSession();
      const p = await api.publish(sid, hours, requireCode);
      setPub({ ...p, hours });
      setStage('done');
    } catch (e) {
      setError((e as Error).message);
      setStage('pick');
    }
  };

  const restart = () => {
    items.forEach(i => i.preview && URL.revokeObjectURL(i.preview));
    session.current = null;
    queue.current = [];
    setItems([]);
    setQuestions([]);
    setAnswers({});
    setClosing(false);
    setReport(null);
    setPub(null);
    setError('');
    setStage('idle');
  };

  // ---------- copy ----------
  let title = '把体检报告，丢进水滴里';
  let sub = '照片或 PDF，拖到页面任意位置松手就好';
  if (dragging) {
    title = hot ? '松手，交给水滴' : '在哪儿松手都行';
    sub = dragN ? `感应到 ${dragN} 个文件 · 松手后它们会自己落进水滴` : '松手后文件会自己落进水滴';
  } else if (stage === 'collecting') {
    title = reading ? `水滴正在读 ${reading} 份文件` : `读完了 ${doneCount} 份文件`;
    if (reading) sub = '可以继续往里丢。等全部识别完、问题都确认后，就能生成报告。';
    else if (pending.length) sub = `还有 ${pending.length} 个问题需要你确认，确认完就能生成报告。`;
    else if (!doneCount) sub = '还没有识别成功的文件，换一份试试。';
    else sub = '可以继续往里丢。全部丢完以后，点「上传结束，生成报告」。';
  } else if (stage === 'writing') {
    title = '水滴正在写你的报告';
    sub = `汇总 ${doneCount} 份文件里的指标，查阅相关医学文献，再结合你的回答写成报告，通常需要一分钟左右。`;
  } else if (stage === 'pick' || stage === 'publishing') {
    title = '抽一张，决定报告保留多久';
    sub = '链接从现在开始生效。到期后，报告页面和原始文件会被一起清除。';
  }

  const compact = stage === 'pick' || stage === 'publishing' || stage === 'done';
  const showQuestion = stage === 'collecting' && pending.length > 0;

  return (
    <div className={`app${compact ? ' is-compact' : ''}${showQuestion ? ' has-question' : ''}${glOk ? '' : ' no-gl'}`} data-stage={stage}>
      <canvas ref={canvasRef} className="liquid" aria-hidden="true" />
      <input ref={fileInput} type="file" multiple accept="image/*,application/pdf,.pdf,.heic,.heif" hidden onChange={onPicked} />

      <header className="topbar">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.6c3.7 4.4 6.6 8.1 6.6 11.6a6.6 6.6 0 0 1-13.2 0c0-3.5 2.9-7.2 6.6-11.6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M9 14.4a3.1 3.1 0 0 0 3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <b className="serif">滴析</b>
          <span className="muted small">体检报告 AI 解读</span>
        </div>
        <span className="muted small privacy">链接最长保留 24 小时，到期自动清除</span>
      </header>

      <main className="main">
        <div className="drop-zone">
          <div className="stage">
            <div ref={anchorRef} className="anchor" aria-hidden="true" />
            {!glOk && <div className="anchor fallback-drop" aria-hidden="true" />}
            {canDrop && <button type="button" className="hit" aria-label="选择体检报告文件，也可以把文件拖到页面任意位置" onClick={() => openPicker(null)} />}
          </div>
          {showQuestion && (
            <QuestionMenu key={pending[0].id} q={pending[0]} remaining={pending.length} slotRef={slotRef} onAnswer={(ids, note) => answer(pending[0], ids, note)} />
          )}
        </div>

        {stage !== 'done' && (
          <div className="hero">
            <h1 className="serif">{title}</h1>
            <p>{sub}</p>
          </div>
        )}

        {stage === 'idle' && !dragging && (
          <div className="row center">
            <button type="button" className="btn btn-pri" onClick={e => openPicker(e.currentTarget)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 16V4" />
                <path d="M7 9l5-5 5 5" />
                <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
              </svg>
              选择文件
            </button>
            {mock && (
              <button type="button" className="btn btn-glass" onClick={e => trySample(e.currentTarget)}>
                用示例报告试试
              </button>
            )}
          </div>
        )}

        {stage === 'collecting' && (
          <>
            <FileTray items={items} onDismiss={id => setItems(prev => prev.filter(i => i.id !== id))} />
            {!closing && (
              <div className="row center">
                {/* kept mounted so it can open and close smoothly; out of reach (inert) until it is ready */}
                <span className={`go-slot${ready ? ' is-on' : ''}`} inert={!ready}>
                  <button type="button" className="btn btn-pri" onClick={() => setClosing(true)}>
                    上传结束，生成报告
                  </button>
                </span>
                <button type="button" className="btn btn-glass" onClick={e => openPicker(e.currentTarget)}>
                  继续添加
                </button>
              </div>
            )}
          </>
        )}

        {stage === 'writing' && <div className="writing" aria-hidden="true" />}

        {(stage === 'pick' || stage === 'publishing') && report && (
          <>
            <CardFan report={report} disabled={stage === 'publishing'} onPick={pick} />
            <label className="code-toggle glass">
              <input type="checkbox" checked={requireCode} onChange={e => setRequireCode(e.target.checked)} />
              <span className="switch" aria-hidden="true" />
              打开链接需要 6 位提取码
            </label>
          </>
        )}

        {stage === 'done' && pub && report && <DonePanel pub={pub} report={report} onRestart={restart} />}

        {error && (
          <p className="toast glass" role="status">
            {error}
          </p>
        )}
      </main>

      <footer className="foot muted small">
        <span>解读仅供参考，不能替代医生的诊断</span>
        <span>原始文件只用于本次解读，链接到期即清除</span>
      </footer>
    </div>
  );
}
