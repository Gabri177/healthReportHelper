import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { readFile as readText } from 'node:fs/promises';
import * as z from 'zod';
import { phenoAge, type PhenoAge } from './bioage.ts';
import { claude } from './limits.ts';
import { findLiterature, pubmedUrl, type Paper } from './pubmed.ts';
import {
  FileAnalysisSchema,
  FindingsSchema,
  GuidanceSchema,
  OverviewSchema,
  type Answer,
  type FileAnalysis,
  type Question,
  type ReportData,
  type ReportDraft,
} from './schemas.ts';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
export const MOCK = process.env.MOCK_AI === '1';

let client: Anthropic | null = null;
function api() {
  // Reads ANTHROPIC_API_KEY from the environment. Never ship the key to the browser.
  if (!client) client = new Anthropic();
  return client;
}

const READ_SYSTEM = `你是「滴析」的体检报告识别助手。用户会一次上传一个文件（照片或 PDF），可能是体检报告、化验单、影像检查报告中的一页或多页。

任务：
1. 判断文件是否为体检/化验/检查报告。如果不是（与健康无关），isHealthReport 为 false，其余字段留空数组或 null。
2. 全量读取，逐项提取所有检验指标：中文名、英文缩写、原始结果文本、数值、单位、参考范围原文与上下限、所属分组。
   - 体格检查（身高、体重、BMI、腰围、血压、心率等）也作为指标提取，分组为「一般检查」。
   - status 按报告上的参考范围判断：在范围内为 normal；高于上限为 high；低于下限为 low；恰好落在上限或下限、或仅轻微越界为 borderline；阴阳性等定性结果异常为 abnormal；无法判断为 unknown。
   - 看不清、被遮挡、可能误读的数字，uncertain 设为 true，并给出你最可能的读数。
   - 不要编造报告里没有的指标或数值。
3. 提取影像检查（超声、CT、X 线、心电图等）的发现，并给出风险等级。报告上医生的总检结论和建议，提取要点放进 summaryNotes。
4. 只有在确实需要时才向用户提问，每个文件最多 3 个问题，宁少勿多：
   - illegible：数值看不清时，问用户实际数值，选项给出 2-3 个最可能的读数，最可能的一项 recommended 为 true。
   - context：某项明显异常、而且体检前的状态（是否空腹、饮酒、剧烈运动、用药、生理期等）会显著影响解读时，问用户当时的情况；多选题要有一个 exclusive 为 true 的「都没有」。
   - 每个选项的 label 简短，note 用一句话说明影响；问题 id 用简短英文。
   - 不要问用户无法回答的专业问题，不要问报告上已有答案的问题。
5. 所有面向用户的文字使用简体中文，口语化、友好、不吓人。你不做诊断。`;

const WRITE_SYSTEM = `你是「滴析」的体检报告解读助手，读者是没有医学背景的普通人。你会收到：从用户上传的文件中提取出的结构化数据（与健康无关的文件已被排除）、用户对若干问题的回答、按体检日期计算的表型年龄参考值，以及从 PubMed 检索到的相关文献（含摘要）。请据此写一份解读报告。

总体要求
- 全面阅读所有数据：每一项指标、影像发现、报告上医生的总检意见都要考虑到；与健康无关的内容忽略。
- 结论放在最前面：headline 一句话说清整体情况，keyPoints 2-4 条要点，最重要的在前。
- 用普通人能听懂的话。必须用到的医学名词，第一次出现时在括号里用一句白话解释。不夸大，也不轻描淡写。你不做诊断，不开药。
- 排版：每个文字字段只写一小段，读起来不超过 3 行（约 60 个汉字以内）；要说的多就拆成多条，不写长段落。

健康综合评分 score
- 满分 100，从 100 开始按发现扣分：临界值每项 1-2 分；轻度偏离（超出参考范围 20% 以内）每项 2-4 分；明显偏离每项 4-8 分；危急值 10-20 分；影像发现低风险 0-2 分、需留意 4-8 分、高风险 10-20 分；同一类问题多项同时异常（如血糖、血脂、尿酸、血压、体重）再扣 2-5 分。
- 给出区间而不是一个数，通常宽 4-8 分；读数存疑、缺少关键信息时放宽。
- label 按区间中点：90 以上「很好」，80-89「良好」，70-79「一般」，60-69「需要留意」，60 以下「需要重视」。note 一句话说明分数主要被什么拉低。

生理年龄 bioAge
- 每个体检日期给一项，最近的在前。
- 提供了这一日期的表型年龄参考值（Levine 2018 PhenoAge，依据白蛋白、肌酐、血糖、C 反应蛋白、淋巴细胞百分比、平均红细胞体积、红细胞分布宽度、碱性磷酸酶、白细胞计数和年龄计算）时，区间以它为中心，再结合血压、体重、血脂、尿酸、影像等其他发现适当调整；区间通常宽 4-6 岁，C 反应蛋白是估算值时再放宽 2 岁。
- 没有参考值时，依据现有指标粗略估计，区间宽 8-10 岁，confidence 为 low。实际年龄未知时 chronological 为 0。
- drivers 列出 2-5 个主要影响因素，并说明它让生理年龄偏大还是偏小；verdict 一句话说清和实际年龄相比的结果。

各部分
- attention：只列需要关注的指标（偏高、偏低、临界、定性异常），按重要程度排序。用户确认过的数值 confirmedByUser 为 true。
- visits（就医建议）：需要看医生时，写清挂哪个科、多久内去、为什么、去之前要准备什么（如空腹、带上既往报告）。不需要就医时为空数组。
- doctorQuestions：3-6 个看病时可以直接问医生的问题，每个写明问这个是为了弄清什么。
- nutrition：针对具体发现给出营养建议，写出具体的食物（多吃什么、少吃什么），不泛泛而谈。
- rehab：针对具体发现给出康复与运动建议，写明频率、强度、时长，以及需要避免的情况。
- advice：饮食和运动以外的生活习惯（饮酒、睡眠、压力、体重等），0-3 条。
- followUps：具体的复查时间和项目。
- 有不同日期的报告并且用户同意对比时，填写 previous、change 和 trends；否则 trends 为空数组。
- confirmations：一句话复述用户确认过的信息，以及它们如何影响了解读。
- urgent：存在危急值或需要尽快就医的情况时写明提醒，否则为空字符串。
- counts.total 为所有检验指标数加影像项数；normal + attention + imaging 应等于 total。

文献依据
- 只能引用提供的文献列表里的文章，用它们的 PMID；绝不编造文献或 PMID。
- evidence 列出你引用的每一篇，用一句普通人能懂的话说明它支持了什么。
- attention、visits、nutrition、rehab 中有文献支持的条目，在 refs 里填对应的 PMID；refs 里的 PMID 都要出现在 evidence 中。
- 与本人情况不相关的文献不要引用；没有合适的文献时 evidence 为空数组。
- 只依据提供的数据，不要编造。`;

const PLAN_SYSTEM = `你在为一份体检报告解读查找医学文献。根据给出的异常发现，写 2-5 条英文 PubMed 检索式，用来找与这些发现相关的系统综述、荟萃分析或指南，侧重：这些异常的健康意义、饮食营养干预、运动康复干预、何时需要就医。每条检索式简洁（2-6 个英文关键词，可用 MeSH 词和 AND/OR），不要加年份、语言或文献类型限制（程序会自动加上）。topic 用中文短语说明这条检索针对哪项发现。`;

const PlanSchema = z.object({ queries: z.array(z.object({ topic: z.string(), query: z.string() })) });

type Media = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export async function readFile(file: { name: string; mime: string; data: Buffer }): Promise<FileAnalysis> {
  if (MOCK) return mockRead(file.name);
  const b64 = file.data.toString('base64');
  const block: Anthropic.ContentBlockParam =
    file.mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: file.mime as Media, data: b64 } };

  const msg = await claude(() =>
    api()
      .messages.stream({
        model: MODEL,
        max_tokens: 64000,
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: READ_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [block, { type: 'text', text: `文件名：${file.name}\n请提取这个文件中的内容。` }],
          },
        ],
        output_config: { format: zodOutputFormat(FileAnalysisSchema) },
      })
      .finalMessage(),
  );
  if (!msg.parsed_output) throw new Error(`识别失败（${msg.stop_reason ?? 'unknown'}）`);
  return msg.parsed_output;
}

type WriteInput = {
  files: { name: string; analysis: FileAnalysis }[];
  questions: Question[];
  answers: Answer[];
  today: string;
};

/** Phenotypic age per exam date, from that date's indicators and the age on that report. */
function phenoAges(files: WriteInput['files']) {
  const byDate = new Map<string, { inds: FileAnalysis['indicators']; age: number | null }>();
  for (const f of files) {
    const d = f.analysis.reportDate ?? '';
    const cur = byDate.get(d) ?? { inds: [], age: null };
    cur.inds.push(...f.analysis.indicators);
    cur.age ??= f.analysis.patient.age;
    byDate.set(d, cur);
  }
  return [...byDate].map(([examDate, { inds, age }]) => ({ examDate, age, phenoAge: phenoAge(inds, age) }));
}

/** The answers in words, for the prompts. */
function answered(input: WriteInput) {
  return input.answers
    .map(a => {
      const q = input.questions.find(x => x.id === a.questionId);
      if (!q) return null;
      const picked = q.options.filter(o => a.optionIds.includes(o.id)).map(o => o.label);
      return { question: q.title, picked: picked.length ? picked : ['（跳过）'], note: a.note || null };
    })
    .filter(Boolean);
}

/** PubMed queries for what is abnormal, then the papers they find. Never throws. */
async function literature(input: WriteInput): Promise<Paper[]> {
  const findings = input.files.flatMap(f => [
    ...f.analysis.indicators
      .filter(i => i.status !== 'normal' && i.status !== 'unknown')
      .map(i => `${i.name}${i.code ? ` (${i.code})` : ''} ${i.value}${i.unit ?? ''} ${i.status}`),
    ...f.analysis.imaging.filter(m => m.risk !== 'low').map(m => `${m.exam}：${m.title}（${m.risk}）`),
  ]);
  if (!findings.length) return [];
  try {
    const patient = input.files[0]?.analysis.patient;
    const msg = await claude(() =>
      api().messages.parse({
        model: MODEL,
        max_tokens: 2000,
        system: PLAN_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify({ patient, findings: [...new Set(findings)].slice(0, 40), answers: answered(input) }) }],
        output_config: { format: zodOutputFormat(PlanSchema) },
      }),
    );
    const queries = (msg.parsed_output?.queries ?? []).slice(0, 5).map(q => q.query);
    return queries.length ? await findLiterature(queries) : [];
  } catch (e) {
    console.warn('[literature]', (e as Error).message);
    return [];
  }
}

export async function writeReport(input: WriteInput): Promise<ReportData> {
  const ages = phenoAges(input.files);
  if (MOCK) {
    // demo mode can show a saved, real report instead of the built-in sample (MOCK_REPORT_FILE=path to its JSON)
    if (process.env.MOCK_REPORT_FILE) {
      await wait(2500);
      return JSON.parse(await readText(process.env.MOCK_REPORT_FILE, 'utf8')) as ReportData;
    }
    return enrich(await mockReport(), input.files, MOCK_PAPERS, ages);
  }
  const papers = await literature(input);
  const payload = {
    today: input.today,
    files: input.files.map(f => ({ name: f.name, ...f.analysis, questions: undefined })),
    answers: answered(input),
    phenoAge: ages.map(a => ({
      examDate: a.examDate,
      chronological: a.age,
      phenoAge: a.phenoAge?.value ?? null,
      crpEstimated: a.phenoAge?.crpImputed ?? null,
    })),
    literature: papers.map(p => ({ pmid: p.pmid, title: p.title, journal: p.journal, year: p.year, types: p.types, abstract: p.abstract })),
  };

  // the report is written as three parts at once: as one schema it compiles to too large a grammar
  const data = JSON.stringify(payload);
  const [overview, findings, guidance] = await Promise.all([
    writePart(data, OverviewSchema, PART_OVERVIEW),
    writePart(data, FindingsSchema, PART_FINDINGS),
    writePart(data, GuidanceSchema, PART_GUIDANCE),
  ]);
  const evidence = [...findings.evidence];
  for (const e of guidance.evidence) if (!evidence.some(x => x.pmid === e.pmid)) evidence.push(e);
  return enrich({ ...overview, ...findings, ...guidance, evidence }, input.files, papers, ages);
}

const PART_OVERVIEW = `这一次只写报告的「总览」部分：title、score、结论（headline、keyPoints）、基本信息、counts、bioAge、trends、confirmations、urgent。逐项指标的解释和各类建议由另外两部分负责；结论要点里可以提到最重要的一两条建议。`;
const PART_FINDINGS = `这一次只写报告的「指标」部分：attention、imaging。evidence 只列出你在 attention 里引用的文献。`;
const PART_GUIDANCE = `这一次只写报告的「建议」部分：visits、doctorQuestions、nutrition、rehab、advice、followUps。评分、生理年龄和逐项指标的解释由另外两部分负责，这里不必重复。evidence 只列出你在这些建议里引用的文献。`;

async function writePart<T extends z.ZodType>(data: string, schema: T, part: string): Promise<z.infer<T>> {
  const msg = await claude(() =>
    api()
      .messages.stream({
        model: MODEL,
        max_tokens: 64000,
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: WRITE_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: data }, { type: 'text', text: part }] }],
        output_config: { format: zodOutputFormat(schema) },
      })
      .finalMessage(),
  );
  if (!msg.parsed_output) throw new Error(`生成报告失败（${msg.stop_reason ?? 'unknown'}）`);
  return msg.parsed_output as z.infer<T>;
}

const num = (s: string) => {
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

function range(text: string): [number | null, number | null] {
  const s = text.replace(/\s/g, '').replace(/[～~—–]/g, '-');
  let m = s.match(/^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)/);
  if (m) return [Number(m[1]), Number(m[2])];
  m = s.match(/^[<≤]=?(-?\d+(?:\.\d+)?)/);
  if (m) return [null, Number(m[1])];
  m = s.match(/^[>≥]=?(-?\d+(?:\.\d+)?)/);
  if (m) return [Number(m[1]), null];
  return [null, null];
}

/**
 * Makes the draft safe to render: numbers for the range bars from the extracted indicators, citations reduced to
 * papers PubMed actually returned (with PubMed's own details), the PhenoAge reference beside each age estimate, and
 * the score kept in range.
 */
function enrich(
  draft: ReportDraft,
  files: { analysis: FileAnalysis }[],
  papers: Paper[],
  ages: { examDate: string; phenoAge: PhenoAge | null }[],
): ReportData {
  const all = files.flatMap(f => f.analysis.indicators);
  const key = (s: string | null) => (s ?? '').replace(/\s/g, '').toLowerCase();
  const known = new Map(papers.map(p => [p.pmid, p]));
  const cited = (refs: string[]) => refs.filter(id => known.has(id));
  // every PMID cited anywhere is listed once at the end, in the order the model gave, then in order of first use
  const evidence = draft.evidence.filter(e => known.has(e.pmid));
  const listed = new Set(evidence.map(e => e.pmid));
  const used = [...draft.attention, ...draft.visits, ...draft.nutrition, ...draft.rehab].flatMap(x => cited(x.refs));
  for (const id of used) {
    if (!listed.has(id)) {
      listed.add(id);
      evidence.push({ pmid: id, relates: '', point: '' });
    }
  }
  const lo = Math.max(0, Math.min(100, Math.round(Math.min(draft.score.low, draft.score.high))));
  const hi = Math.max(lo, Math.min(100, Math.round(Math.max(draft.score.low, draft.score.high))));
  return {
    ...draft,
    score: { ...draft.score, low: lo, high: hi },
    attention: draft.attention.map(a => {
      const same = (i: (typeof all)[number]) => (a.code && key(i.code) === key(a.code)) || key(i.name) === key(a.name);
      const hit = all.find(i => same(i) && i.value === a.value) ?? all.find(same);
      const refs = cited(a.refs);
      if (hit && hit.numeric != null) return { ...a, refs, numeric: hit.numeric, refLow: hit.refLow, refHigh: hit.refHigh };
      const [l, h] = range(a.refText);
      return { ...a, refs, numeric: num(a.value), refLow: l, refHigh: h };
    }),
    visits: draft.visits.map(v => ({ ...v, refs: cited(v.refs) })),
    nutrition: draft.nutrition.map(n => ({ ...n, refs: cited(n.refs) })),
    rehab: draft.rehab.map(r => ({ ...r, refs: cited(r.refs) })),
    evidence: evidence.map(e => {
      const p = known.get(e.pmid)!;
      return { ...e, title: p.title, journal: p.journal, year: p.year, url: /^\d+$/.test(p.pmid) ? pubmedUrl(p.pmid) : '' };
    }),
    bioAge: draft.bioAge.map((b, i) => {
      const ref = ages.find(a => a.examDate && a.examDate === b.examDate) ?? (i === 0 ? ages[0] : undefined);
      return { ...b, low: Math.min(b.low, b.high), high: Math.max(b.low, b.high), phenoAge: ref?.phenoAge?.value ?? null, crpImputed: !!ref?.phenoAge?.crpImputed };
    }),
  };
}

// ---------- mock data for UI work without spending tokens ----------

let mockCount = 0;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function mockRead(name: string): Promise<FileAnalysis> {
  await wait(2200 + Math.random() * 2500);
  const n = mockCount++ % 3;
  const base: FileAnalysis = {
    isHealthReport: true,
    reportDate: n === 2 ? '2025-09-12' : '2026-09-18',
    institution: '示例体检中心',
    patient: { sex: '男', age: 36 },
    indicators: [
      { name: '空腹血糖', code: 'GLU', value: '6.1', numeric: 6.1, unit: 'mmol/L', refText: '3.9-6.1', refLow: 3.9, refHigh: 6.1, status: 'borderline', category: '血糖', uncertain: n === 0 },
      { name: '尿酸', code: 'UA', value: '458', numeric: 458, unit: 'μmol/L', refText: '208-428', refLow: 208, refHigh: 428, status: 'high', category: '肾功能', uncertain: false },
      { name: '甘油三酯', code: 'TG', value: '1.65', numeric: 1.65, unit: 'mmol/L', refText: '<1.70', refLow: null, refHigh: 1.7, status: 'normal', category: '血脂', uncertain: false },
      ...(
        [
          ['白蛋白', 'ALB', 46.2, 'g/L', '40-55', '肝功能'],
          ['碱性磷酸酶', 'ALP', 72, 'U/L', '45-125', '肝功能'],
          ['肌酐', 'CREA', 82, 'μmol/L', '57-111', '肾功能'],
          ['白细胞计数', 'WBC', 6.1, '10^9/L', '3.5-9.5', '血常规'],
          ['淋巴细胞百分比', 'LYM%', 31.4, '%', '20-50', '血常规'],
          ['平均红细胞体积', 'MCV', 89.5, 'fL', '82-100', '血常规'],
          ['红细胞分布宽度', 'RDW-CV', 12.8, '%', '11.5-14.5', '血常规'],
        ] as const
      ).map(([name, code, v, unit, ref, category]) => {
        const [lo, hi] = ref.split('-').map(Number);
        return { name, code, value: String(v), numeric: v, unit, refText: ref, refLow: lo, refHigh: hi, status: 'normal' as const, category, uncertain: false };
      }),
    ],
    imaging: [],
    summaryNotes: [],
    questions: [],
  };
  if (n === 0) {
    base.questions.push({
      id: 'glu',
      kind: 'illegible',
      type: 'single',
      tag: '识别存疑',
      title: `「${name}」里空腹血糖的数字有点模糊，你看是哪一个？`,
      context: '生化检验 · 第 2 行',
      placeholder: '比如：纸质报告上写的是 5.8',
      options: [
        { id: 'a', label: '6.1 mmol/L', note: '识别把握最大，恰好在参考上限', recommended: true, exclusive: false },
        { id: 'b', label: '5.1 mmol/L', note: '如果是这个值，就在正常范围内', recommended: false, exclusive: false },
        { id: 'c', label: '8.1 mmol/L', note: '如果是这个值，会标记为明显偏高', recommended: false, exclusive: false },
      ],
    });
  }
  if (n === 1) {
    base.questions.push({
      id: 'ua',
      kind: 'context',
      type: 'multi',
      tag: '补充信息',
      title: '尿酸 458 μmol/L，略高于参考范围。体检前几天，你有下面这些情况吗？',
      context: '用来判断是暂时升高，还是需要复查',
      placeholder: '比如：最近在吃降压药',
      options: [
        { id: 'a', label: '前一晚喝过酒', note: null, recommended: false, exclusive: false },
        { id: 'b', label: '吃过海鲜、火锅或浓汤', note: null, recommended: false, exclusive: false },
        { id: 'c', label: '剧烈运动，或者熬夜', note: null, recommended: false, exclusive: false },
        { id: 'd', label: '都没有', note: null, recommended: false, exclusive: true },
      ],
    });
  }
  return base;
}

const MOCK_PAPERS: Paper[] = [
  { pmid: 'demo-1', title: '（示例文献）Lifestyle interventions for people with impaired fasting glucose: a systematic review', journal: '示例期刊', year: '2021', types: [], abstract: '' },
  { pmid: 'demo-2', title: '（示例文献）Dietary factors and serum uric acid: a meta-analysis', journal: '示例期刊', year: '2020', types: [], abstract: '' },
  { pmid: 'demo-3', title: '（示例文献）Aerobic and resistance exercise for insulin sensitivity: a meta-analysis', journal: '示例期刊', year: '2019', types: [], abstract: '' },
];

async function mockReport(): Promise<ReportDraft> {
  await wait(2500);
  return {
    title: '2026 年度体检报告解读',
    score: { low: 78, high: 84, label: '良好', note: '分数主要被尿酸偏高、空腹血糖临界和维生素 D 不足拉低。' },
    headline: '整体不错，尿酸和血糖有上升苗头，现在从饮食和运动入手正是时候。',
    keyPoints: [
      '尿酸偏高，体检前一晚喝过酒，可能被暂时抬高，3 个月后复查。',
      '空腹血糖 6.1，刚到上限，比去年高了 0.7，建议加测糖化血红蛋白。',
      '维生素 D 不足，多晒太阳，必要时在医生指导下补充。',
    ],
    patientLabel: '男 · 36 岁',
    examDate: '2026-09-18',
    compareDate: '2025-09-12',
    counts: { total: 86, normal: 82, attention: 3, imaging: 1 },
    bioAge: [
      {
        examDate: '2026-09-18',
        chronological: 36,
        low: 34,
        high: 39,
        confidence: 'medium',
        verdict: '身体状态和实际年龄差不多，血糖和尿酸有让它提前的苗头。',
        drivers: [
          { name: '空腹血糖临界', effect: 'older', note: '血糖偏高会加速血管老化，是最主要的加分项。' },
          { name: '尿酸偏高', effect: 'older', note: '长期偏高与血管和肾脏负担有关。' },
          { name: '白蛋白、血常规都很好', effect: 'younger', note: '营养和免疫状态良好，把生理年龄往回拉。' },
        ],
      },
      {
        examDate: '2025-09-12',
        chronological: 35,
        low: 32,
        high: 37,
        confidence: 'medium',
        verdict: '去年的状态比实际年龄略年轻。',
        drivers: [{ name: '血糖正常', effect: 'younger', note: '去年空腹血糖 5.4，在理想范围内。' }],
      },
    ],
    attention: [
      { name: '尿酸', code: 'UA', category: '肾功能', value: '458', unit: 'μmol/L', refText: '208-428', status: 'high', previous: '432', change: '↑ 26', confirmedByUser: false, explanation: '略高于上限。体检前一晚喝酒会让尿酸暂时升高。3 个月后复查，复查前 3 天不喝酒。', refs: ['demo-2'] },
      { name: '空腹血糖', code: 'GLU', category: '血糖', value: '6.1', unit: 'mmol/L', refText: '3.9-6.1', status: 'borderline', previous: '5.4', change: '↑ 0.7', confirmedByUser: true, explanation: '恰好在上限。6.1–6.9 属于空腹血糖受损（糖尿病前期的一种）。3 个月后复查并加测糖化血红蛋白。', refs: ['demo-1'] },
      { name: '维生素 D', code: '25-OH-D', category: '维生素', value: '18.2', unit: 'ng/mL', refText: '30-100', status: 'low', previous: '', change: '', confirmedByUser: false, explanation: '低于 20 属于缺乏，常待室内的人很常见。每天晒太阳 15–20 分钟。', refs: [] },
    ],
    imaging: [
      { title: '甲状腺右叶结节', exam: '甲状腺超声', finding: '0.6 × 0.4 cm，边界清楚，C-TIRADS 3 类（良性可能性大）。', risk: 'low', advice: '12 个月后复查超声即可。' },
    ],
    visits: [
      { department: '内分泌科', urgency: 'routine', when: '3 个月内', reason: '血糖到了临界，尿酸也偏高，需要评估代谢情况。', prepare: '空腹去，带上今年和去年的体检报告。', refs: ['demo-1'] },
    ],
    doctorQuestions: [
      { question: '我的糖化血红蛋白需要多久查一次？', purpose: '弄清血糖是偶尔偏高，还是长期在上升。' },
      { question: '尿酸到多少需要吃药？', purpose: '知道现在是只靠饮食，还是要考虑药物。' },
      { question: '甲状腺结节需要做穿刺吗？', purpose: '确认现在只观察就够了。' },
    ],
    nutrition: [
      { target: '尿酸偏高', advice: '少吃高嘌呤食物，多喝水，每天 2 升左右。', eatMore: ['低脂牛奶', '鸡蛋', '新鲜蔬菜'], eatLess: ['动物内脏', '海鲜', '浓肉汤'], refs: ['demo-2'] },
      { target: '空腹血糖临界', advice: '主食换一半粗粮，先吃菜再吃饭。', eatMore: ['燕麦', '糙米', '绿叶菜'], eatLess: ['含糖饮料', '白面包', '甜点'], refs: ['demo-1'] },
    ],
    rehab: [
      { title: '改善胰岛素敏感性的运动', body: '快走、骑车加上简单的力量练习。', dose: '每周 5 天快走 30 分钟，另加 2 次力量练习', caution: '空腹时不做剧烈运动。', refs: ['demo-3'] },
    ],
    advice: [
      { topic: 'alcohol', title: '饮酒', body: '尿酸对酒精敏感。复查前至少 3 天不喝，平时也尽量少喝。' },
      { topic: 'sleep', title: '日晒与作息', body: '每天户外活动 15–20 分钟，尽量 11 点前入睡。' },
    ],
    followUps: [
      { when: '3 个月后', items: ['空腹血糖 + 糖化血红蛋白', '尿酸、肝功能'], note: '复查前一晚 10 点后禁食，前 3 天不喝酒。' },
      { when: '12 个月后', items: ['甲状腺超声', '年度体检'], note: '' },
    ],
    trends: [
      { name: '空腹血糖 GLU', before: '5.4', after: '6.1', change: '+13%' },
      { name: '尿酸 UA', before: '432', after: '458', change: '+6%' },
    ],
    evidence: [
      { pmid: 'demo-1', relates: '空腹血糖临界', point: '饮食加运动的生活方式干预，能让空腹血糖受损的人更少发展成糖尿病。' },
      { pmid: 'demo-2', relates: '尿酸偏高', point: '酒精、海鲜和含糖饮料与尿酸升高相关，低脂奶制品与较低的尿酸相关。' },
      { pmid: 'demo-3', relates: '运动建议', point: '有氧运动加力量训练，比单做一种更能改善胰岛素敏感性。' },
    ],
    confirmations: [
      { label: '空腹血糖读数', value: '6.1 mmol/L（照片较模糊，已由你确认）' },
      { label: '体检前情况', value: '前一晚喝过酒，已纳入尿酸的解读' },
    ],
    urgent: '',
  };
}
