import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import * as z from 'zod';
import { MOCK, readFile, writeReport } from './claude.ts';
import * as store from './store.ts';
import { AnswerSchema, HOURS, type Answer, type Question } from './schemas.ts';
import { csp, expiredPage, lockedPage, reportPage } from './render.ts';
import { quota, sweepQuotas } from './limits.ts';

// In production (npm start) this server also serves the built app and listens on PORT; in development Vite owns
// 5173 and this API listens on API_PORT.
const PROD = process.env.NODE_ENV === 'production';
const PORT = Number((PROD ? process.env.PORT || process.env.API_PORT : process.env.API_PORT) || 8787);
const MAX_FILES = 20;
// Per-visitor quotas (by IP; 0 = no limit) and a daily cap on reports for the whole site, so that one visitor
// cannot use up the shared API key. See DEPLOY.md.
const sessionQuota = quota(Number(process.env.RATE_SESSIONS_PER_HOUR ?? 10), 3600_000);
const fileQuota = quota(Number(process.env.RATE_FILES_PER_HOUR ?? 60), 3600_000);
const MAX_REPORTS_PER_DAY = Number(process.env.MAX_REPORTS_PER_DAY ?? 0);
const daily = { day: '', count: 0 };

/** Which proxies to believe about the visitor's IP: "loopback" (a proxy on this machine) unless TRUST_PROXY says otherwise. */
function trustProxy(v = process.env.TRUST_PROXY) {
  if (v == null || v === '') return 'loopback';
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}
const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', trustProxy());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
const json = express.json({ limit: '200kb' });

const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });

function friendly(e: unknown, badRequest = '文件太大或无法读取', other = '识别失败，请重试') {
  if (e instanceof Anthropic.AuthenticationError) return '服务端的 API Key 无效，请检查配置';
  if (e instanceof Anthropic.RateLimitError) return '请求太频繁，请稍后再试';
  if (e instanceof Anthropic.BadRequestError) return badRequest;
  if (e instanceof Anthropic.APIError) return `AI 服务暂时不可用（${e.status ?? '网络'}）`;
  return other;
}

function upsertAnswers(s: store.Session, answers: Answer[]) {
  for (const a of answers) {
    if (!s.questions.some(q => q.id === a.questionId)) continue;
    s.answers = s.answers.filter(x => x.questionId !== a.questionId).concat(a);
  }
}

/** Asked once, as soon as the session holds reports from different exam dates. */
function mergeQuestion(s: store.Session): Question | null {
  if (s.mergeAsked) return null;
  const dates = [...new Set(s.files.map(f => f.analysis?.reportDate).filter((d): d is string => !!d))].sort().reverse();
  if (dates.length < 2) return null;
  s.mergeAsked = true;
  return {
    id: 'merge',
    kind: 'multi_report',
    type: 'single',
    tag: '多份报告',
    title: `发现 ${dates.length} 份不同日期的体检报告，要怎么处理？`,
    context: dates.join(' · '),
    placeholder: '比如：只对比血脂和肝功能',
    options: [
      { id: 'compare', label: '合并解读，对比变化', note: '可以看出各项指标的升降趋势', recommended: true, exclusive: false },
      { id: 'latest', label: `只解读最新的 ${dates[0]}`, note: '较早的报告不会写进解读', recommended: false, exclusive: false },
    ],
  };
}

// ---------- upload & analysis API ----------

app.get('/api/config', (_req, res) => {
  res.json({ mock: MOCK, hours: HOURS });
});

app.post('/api/sessions', async (req, res) => {
  if (!sessionQuota.take(req.ip ?? '')) return fail(res, 429, '这一小时里开始的解读太多了，请稍后再试');
  const s = await store.createSession();
  res.json({ sessionId: s.id, mock: MOCK });
});

app.post('/api/sessions/:id/files', upload.single('file'), async (req, res) => {
  const s = store.getSession(String(req.params.id));
  if (!s) return fail(res, 404, '会话已过期，请刷新页面重新开始');
  if (s.writing || s.report) return fail(res, 409, '已经结束上传了');
  if (s.files.length >= MAX_FILES) return fail(res, 400, `一次最多 ${MAX_FILES} 个文件`);
  if (!fileQuota.take(req.ip ?? '')) return fail(res, 429, '这一小时上传的文件太多了，请稍后再试');
  const f = req.file;
  if (!f) return fail(res, 400, '没有收到文件');
  if (!SUPPORTED.has(f.mimetype)) return fail(res, 415, '只支持 JPG、PNG、WebP 图片和 PDF');
  const name = String(req.body?.name || f.originalname).slice(0, 200);

  const stored = await store.addFile(s, { name, mime: f.mimetype, data: f.buffer });
  try {
    const analysis = await readFile({ name, mime: f.mimetype, data: f.buffer });
    stored.analysis = analysis;
    if (!analysis.isHealthReport) {
      stored.status = 'failed';
      stored.error = '这个文件看起来不是体检报告';
      return res.json({ fileId: stored.id, ok: false, error: stored.error, questions: [] });
    }
    stored.status = 'done';
    const questions = analysis.questions.map(q => ({ ...q, id: `${stored.id}.${q.id}` }));
    s.questions.push(...questions);
    const merge = mergeQuestion(s);
    if (merge) {
      s.questions.push(merge);
      questions.push(merge);
    }
    res.json({
      fileId: stored.id,
      ok: true,
      reportDate: analysis.reportDate,
      indicatorCount: analysis.indicators.length + analysis.imaging.length,
      attentionCount: analysis.indicators.filter(i => i.status !== 'normal' && i.status !== 'unknown').length,
      questions,
    });
  } catch (e) {
    console.error('[read]', e);
    stored.status = 'failed';
    stored.error = friendly(e);
    res.status(502).json({ fileId: stored.id, ok: false, error: stored.error, questions: [] });
  }
});

app.post('/api/sessions/:id/answers', json, (req, res) => {
  const s = store.getSession(String(req.params.id));
  if (!s) return fail(res, 404, '会话已过期');
  const parsed = z.object({ answers: z.array(AnswerSchema).max(50) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, '参数不正确');
  upsertAnswers(s, parsed.data.answers);
  res.status(204).end();
});

app.post('/api/sessions/:id/finish', json, async (req, res) => {
  const s = store.getSession(String(req.params.id));
  if (!s) return fail(res, 404, '会话已过期');
  const parsed = z.object({ answers: z.array(AnswerSchema).max(50) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, '参数不正确');
  upsertAnswers(s, parsed.data.answers);
  if (s.files.some(f => f.status === 'reading')) return fail(res, 409, '还有文件在识别中');
  let files = s.files.filter(f => f.status === 'done' && f.analysis);
  if (!files.length) return fail(res, 400, '还没有识别成功的报告');

  const merge = s.answers.find(a => a.questionId === 'merge');
  if (merge?.optionIds.includes('latest')) {
    const latest = files.map(f => f.analysis!.reportDate).filter(Boolean).sort().reverse()[0];
    files = files.filter(f => !f.analysis!.reportDate || f.analysis!.reportDate === latest);
  }

  if (!s.report) {
    if (!s.writing && MAX_REPORTS_PER_DAY) {
      const today = new Date().toISOString().slice(0, 10);
      if (daily.day !== today) Object.assign(daily, { day: today, count: 0 });
      if (daily.count >= MAX_REPORTS_PER_DAY) return fail(res, 429, '今天的解读名额已经用完了，明天再来吧');
      daily.count += 1;
    }
    s.writing ??= writeReport({
      files: files.map(f => ({ name: f.name, analysis: f.analysis! })),
      questions: s.questions,
      answers: s.answers,
      today: new Date().toISOString().slice(0, 10),
    });
    try {
      s.report = await s.writing;
    } catch (e) {
      console.error('[write]', e);
      s.writing = undefined;
      // a report that failed does not use up the day's allowance
      if (MAX_REPORTS_PER_DAY) daily.count = Math.max(0, daily.count - 1);
      return fail(res, 502, friendly(e, '生成报告失败，请重试', '生成报告失败，请重试'));
    }
  }
  res.json({ report: s.report });
});

app.post('/api/sessions/:id/publish', json, async (req, res) => {
  const s = store.getSession(String(req.params.id));
  if (!s) return fail(res, 404, '会话已过期');
  const parsed = z
    .object({ hours: z.number().refine(h => (HOURS as readonly number[]).includes(h)), requireCode: z.boolean() })
    .safeParse(req.body);
  if (!parsed.success) return fail(res, 400, '有效期只能是 3、6、12 或 24 小时');
  if (!s.report) return fail(res, 409, '报告还没写好');
  const { meta, code, ownerToken } = await store.publish(s, parsed.data.hours, parsed.data.requireCode);
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ reportId: meta.id, url: `${base.replace(/\/$/, '')}/r/${meta.id}`, code, ownerToken, expiresAt: meta.expiresAt });
});

async function ownerReport(req: Request, res: Response) {
  const meta = await store.getReport(String(req.params.id));
  if (!meta) {
    fail(res, 404, '报告不存在或已清除');
    return null;
  }
  if (!store.checkOwner(meta, req.get('x-owner-token'))) {
    fail(res, 403, '没有权限');
    return null;
  }
  return meta;
}

app.delete('/api/reports/:id', async (req, res) => {
  const meta = await ownerReport(req, res);
  if (!meta) return;
  await store.destroyReport(meta.id);
  res.status(204).end();
});

// Lets the owner open their own code-protected report (e.g. to print it) without typing the code.
app.post('/api/reports/:id/owner-unlock', async (req, res) => {
  const meta = await ownerReport(req, res);
  if (!meta) return;
  setUnlockCookie(req, res, meta);
  res.status(204).end();
});

// ---------- shared report pages ----------

const cookieName = (id: string) => `dx_${id}`;

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setUnlockCookie(req: Request, res: Response, meta: store.ReportMeta) {
  res.cookie(cookieName(meta.id), store.unlockToken(meta.id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: `/r/${meta.id}`,
    maxAge: Math.max(0, meta.expiresAt - Date.now()),
  });
}

const isUnlocked = (req: Request, meta: store.ReportMeta) =>
  !meta.codeHash || readCookie(req, cookieName(meta.id)) === store.unlockToken(meta.id);

function sendPage(res: Response, status: number, render: (nonce: string) => string) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp(nonce),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    })
    .send(render(nonce));
}

app.get('/r/:id', async (req, res) => {
  const meta = await store.getReport(String(req.params.id));
  if (!meta) return sendPage(res, 410, expiredPage);
  if (!isUnlocked(req, meta)) return sendPage(res, 401, n => lockedPage(meta.id, n));
  sendPage(res, 200, n => reportPage(meta, n));
});

// Code attempts per report and visitor: 8 wrong tries lock the form for that visitor for 10 minutes
// (per visitor, so someone guessing at a link cannot lock its rightful reader out).
const attempts = new Map<string, { n: number; until: number; last: number }>();

app.post('/r/:id/unlock', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  const meta = await store.getReport(String(req.params.id));
  if (!meta) return sendPage(res, 410, expiredPage);
  const key = `${meta.id}:${req.ip ?? ''}`;
  const a = attempts.get(key) ?? { n: 0, until: 0, last: 0 };
  if (a.until > Date.now()) return sendPage(res, 429, n => lockedPage(meta.id, n, '尝试次数太多，请 10 分钟后再试'));
  if (store.checkCode(meta, String(req.body?.code ?? ''))) {
    attempts.delete(key);
    setUnlockCookie(req, res, meta);
    return res.redirect(303, `/r/${meta.id}`);
  }
  a.n += 1;
  a.last = Date.now();
  if (a.n >= 8) Object.assign(a, { n: 0, until: Date.now() + 10 * 60_000 });
  attempts.set(key, a);
  sendPage(res, 401, n => lockedPage(meta.id, n, '提取码不对，再试一次'));
});

app.get('/r/:id/f/:n', async (req, res) => {
  const meta = await store.getReport(String(req.params.id));
  if (!meta || !isUnlocked(req, meta)) return res.status(404).end();
  const f = meta.files[Number(req.params.n)];
  if (!f || !f.mime.startsWith('image/')) return res.status(404).end();
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).type(f.mime).sendFile(f.disk);
});

// ---------- built frontend (production) ----------

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve('dist');
  app.use(express.static(dist));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) return fail(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? '单个文件不能超过 30 MB' : '上传失败');
  console.error(err);
  fail(res, 500, '服务器出错了');
});

await store.init();
setInterval(() => {
  store.cleanup().catch(console.error);
  sweepQuotas();
  const now = Date.now();
  for (const [k, a] of attempts) if (a.until < now && now - a.last > 3600_000) attempts.delete(k);
}, 60_000);
// HOST=127.0.0.1 behind a reverse proxy, so the service is not reachable around it; all interfaces otherwise
const HOST = process.env.HOST || undefined;
app.listen(PORT, HOST as string, () => {
  console.log(`滴析 API  http://${HOST ?? 'localhost'}:${PORT}${MOCK ? '  (MOCK_AI=1，不调用 Claude)' : ''}`);
  if (!MOCK && !process.env.ANTHROPIC_API_KEY) console.warn('⚠ 未设置 ANTHROPIC_API_KEY，识别会失败。请在 .env 中填写。');
});
