import * as z from 'zod';

const Status = z.enum(['normal', 'high', 'low', 'borderline', 'abnormal', 'unknown']);
const Risk = z.enum(['low', 'medium', 'high', 'unknown']);

export const IndicatorSchema = z.object({
  name: z.string().describe('指标中文名，如「空腹血糖」'),
  code: z.string().nullable().describe('英文缩写，如 GLU；没有则为 null'),
  value: z.string().describe('报告上的原始结果文本，如 "6.1"、"阴性"、"3+"'),
  numeric: z.number().nullable().describe('结果的数值；非数值结果为 null'),
  unit: z.string().nullable(),
  refText: z.string().nullable().describe('参考范围原文，如 "3.9-6.1"、"<5.2"'),
  refLow: z.number().nullable(),
  refHigh: z.number().nullable(),
  status: Status,
  category: z.string().describe('分组，如 血常规、肝功能、肾功能、血脂、血糖、尿常规、甲状腺、肿瘤标志物、维生素、其他'),
  uncertain: z.boolean().describe('数值是否看不清、需要用户确认'),
});

export const ImagingSchema = z.object({
  title: z.string().describe('发现，如「甲状腺右叶结节」'),
  exam: z.string().describe('检查项目，如「甲状腺超声」'),
  finding: z.string().describe('报告原文要点'),
  risk: Risk,
});

export const QuestionSchema = z.object({
  id: z.string(),
  kind: z.enum(['illegible', 'multi_report', 'context', 'other']),
  type: z.enum(['single', 'multi']),
  tag: z.string().describe('2-4 个字的短标签，如「识别存疑」「补充信息」'),
  title: z.string().describe('直接向用户提的问题，口语化'),
  context: z.string().describe('一句话说明来源或为什么要问'),
  placeholder: z.string().describe('自由输入框里的示例，如「比如：纸质报告上写的是 5.8」'),
  options: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      note: z.string().nullable().describe('选项下方的一句补充说明'),
      recommended: z.boolean(),
      exclusive: z.boolean().describe('多选题中与其他选项互斥，如「都没有」'),
    }),
  ),
});

/** What Claude extracts from one uploaded file. */
export const FileAnalysisSchema = z.object({
  isHealthReport: z.boolean().describe('这个文件是否为体检/化验/检查报告'),
  reportDate: z.string().nullable().describe('体检日期 YYYY-MM-DD'),
  institution: z.string().nullable(),
  patient: z.object({ sex: z.string().nullable(), age: z.number().nullable() }),
  indicators: z.array(IndicatorSchema),
  imaging: z.array(ImagingSchema),
  summaryNotes: z.array(z.string()).describe('报告上医生总检结论、建议的原文要点；没有为空数组'),
  questions: z.array(QuestionSchema),
});

// Kept deliberately flat: no nullable fields (empty strings and 0 instead) so the constrained-decoding grammar stays small.
// Numbers for the range bars are not asked of the model; the server fills them in from the extracted indicators.
// Every text field is one short paragraph: at most three lines when read on a phone.
const Para = (what: string) => z.string().describe(`${what}；不超过 60 个汉字`);
/** Citations of an item: PMIDs from the literature provided with the request. */
const Refs = z.array(z.string()).describe('支持这条内容的文献 PMID，只能用提供的文献列表里的；没有为空数组');

const Evidence = z
  .array(
    z.object({
      pmid: z.string().describe('只能使用提供的文献列表里的 PMID'),
      relates: z.string().describe('对应哪项发现，如「尿酸偏高」'),
      point: Para('这篇文献说明了什么，用普通人能懂的话'),
    }),
  )
  .describe('你在这一部分引用的文献；没有为空数组');

/** What the report finds. Written as two parts (overview, findings) in parallel with the guidance: as a single
 * schema the report compiles to a grammar too large for structured output. */
const AssessmentSchema = z.object({
  title: z.string().describe('如「2026 年度体检报告解读」'),
  score: z.object({
    low: z.number().describe('健康综合评分区间下限，0-100'),
    high: z.number().describe('健康综合评分区间上限，0-100'),
    label: z.enum(['很好', '良好', '一般', '需要留意', '需要重视']),
    note: Para('一句话说明分数主要被什么拉低'),
  }),
  headline: z.string().describe('结论：一句话说清整体情况，不超过 50 个汉字'),
  keyPoints: z.array(Para('结论要点')).describe('2-4 条，最重要的放最前'),
  patientLabel: z.string().describe('如「男 · 36 岁」，未知时写「未注明」'),
  examDate: z.string().describe('体检日期 YYYY-MM-DD，未知为空字符串'),
  compareDate: z.string().describe('对比的上次体检日期，没有为空字符串'),
  counts: z.object({
    total: z.number(),
    normal: z.number(),
    attention: z.number(),
    imaging: z.number(),
  }),
  bioAge: z
    .array(
      z.object({
        examDate: z.string().describe('这次体检的日期，未知为空字符串'),
        chronological: z.number().describe('当时的实际年龄，未知为 0'),
        low: z.number().describe('生理年龄区间下限'),
        high: z.number().describe('生理年龄区间上限'),
        confidence: z.enum(['low', 'medium', 'high']),
        verdict: Para('一句话结论，如「身体状态大约比实际年龄年轻 2–4 岁」'),
        drivers: z.array(
          z.object({
            name: z.string().describe('指标或情况，如「空腹血糖临界」'),
            effect: z.enum(['older', 'younger']),
            note: Para('它为什么让生理年龄偏大或偏小'),
          }),
        ),
      }),
    )
    .describe('每份（每个体检日期）报告一项，最近的在前'),
  attention: z.array(
    z.object({
      name: z.string(),
      code: z.string().describe('英文缩写，没有为空字符串'),
      category: z.string(),
      value: z.string(),
      unit: z.string(),
      refText: z.string(),
      status: z.enum(['high', 'low', 'borderline', 'abnormal']),
      previous: z.string().describe('上次结果，没有为空字符串'),
      change: z.string().describe('如「↑ 0.41」，没有为空字符串'),
      confirmedByUser: z.boolean(),
      explanation: Para('它是什么、可能的原因、怎么办'),
      refs: Refs,
    }),
  ),
  imaging: z.array(
    z.object({
      title: z.string(),
      exam: z.string(),
      finding: Para('报告原文要点，换成好懂的话'),
      risk: Risk,
      advice: Para('怎么办'),
    }),
  ),
  trends: z.array(
    z.object({
      name: z.string(),
      before: z.string(),
      after: z.string(),
      change: z.string().describe('如「+12%」'),
    }),
  ),
  confirmations: z.array(z.object({ label: z.string(), value: z.string() })),
  urgent: z.string().describe('存在需要尽快就医的危急值时的提醒，否则为空字符串'),
  evidence: Evidence,
});

/** The second half: what to do about it. */
export const GuidanceSchema = z.object({
  visits: z
    .array(
      z.object({
        department: z.string().describe('挂哪个科，如「内分泌科」'),
        urgency: z.enum(['routine', 'soon', 'urgent']).describe('routine 择期，soon 两周内，urgent 尽快'),
        when: z.string().describe('如「1 个月内」'),
        reason: Para('为什么要去'),
        prepare: Para('去之前准备什么、带什么；没有为空字符串'),
        refs: Refs,
      }),
    )
    .describe('就医建议；不需要就医时为空数组'),
  doctorQuestions: z
    .array(z.object({ question: z.string().describe('可以直接问医生的一句话'), purpose: Para('问这个是为了弄清什么') }))
    .describe('看医生时可以问的问题，3-6 个'),
  nutrition: z
    .array(
      z.object({
        target: z.string().describe('针对哪项发现，如「尿酸偏高」'),
        advice: Para('怎么吃'),
        eatMore: z.array(z.string()).describe('建议多吃的具体食物，2-4 个'),
        eatLess: z.array(z.string()).describe('建议少吃的具体食物，2-4 个'),
        refs: Refs,
      }),
    )
    .describe('对症的营养建议'),
  rehab: z
    .array(
      z.object({
        title: z.string().describe('如「改善胰岛素敏感性的运动」'),
        body: Para('做什么、怎么做'),
        dose: z.string().describe('频率和强度，如「每周 5 天，每次 30 分钟快走」'),
        caution: Para('注意事项；没有为空字符串'),
        refs: Refs,
      }),
    )
    .describe('对症的康复与运动建议'),
  advice: z
    .array(
      z.object({
        topic: z.enum(['alcohol', 'sleep', 'stress', 'weight', 'medical', 'other']),
        title: z.string(),
        body: Para('具体做法'),
      }),
    )
    .describe('饮食与运动以外的生活习惯建议，0-3 条'),
  followUps: z.array(
    z.object({
      when: z.string().describe('如「3 个月后」'),
      items: z.array(z.string()),
      note: Para('注意事项；没有为空字符串'),
    }),
  ),
  evidence: Evidence,
});

export const OverviewSchema = AssessmentSchema.omit({ attention: true, imaging: true, evidence: true });
export const FindingsSchema = AssessmentSchema.pick({ attention: true, imaging: true, evidence: true });

/** The whole report, as the parts together. */
export const ReportSchema = AssessmentSchema.extend(GuidanceSchema.shape);

export type FileAnalysis = z.infer<typeof FileAnalysisSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type ReportDraft = z.infer<typeof ReportSchema>;
type Attention = ReportDraft['attention'][number] & { numeric: number | null; refLow: number | null; refHigh: number | null };
/** A cited paper, with its details as PubMed has them (never as the model wrote them). */
export type Evidence = ReportDraft['evidence'][number] & { title: string; journal: string; year: string; url: string };
/** The biological age estimate, plus the PhenoAge reference it was anchored on (when it could be computed). */
export type BioAge = ReportDraft['bioAge'][number] & { phenoAge: number | null; crpImputed: boolean };
/** The report as stored and rendered: the model's draft plus numbers for the range bars and checked citations. */
export type ReportData = Omit<ReportDraft, 'attention' | 'evidence' | 'bioAge'> & { attention: Attention[]; evidence: Evidence[]; bioAge: BioAge[] };

export const AnswerSchema = z.object({
  questionId: z.string().max(80),
  optionIds: z.array(z.string().max(40)).max(10),
  note: z.string().max(500),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const HOURS = [3, 6, 12, 24] as const;
