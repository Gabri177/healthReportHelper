import type { Answer, Question, ReportData } from '../server/schemas';

export type { Answer, Question, ReportData };

export type UploadResult = {
  fileId: string;
  ok: boolean;
  error?: string;
  reportDate?: string | null;
  indicatorCount?: number;
  attentionCount?: number;
  questions: Question[];
};

export type Published = {
  reportId: string;
  url: string;
  code: string | null;
  ownerToken: string;
  expiresAt: number;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('网络连接失败，请检查网络');
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !(body && 'fileId' in body)) throw new Error(body?.error || `请求失败（${res.status}）`);
  return body as T;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const createSession = () => call<{ sessionId: string; mock: boolean }>('/api/sessions', { method: 'POST' });

export function uploadFile(sessionId: string, blob: Blob, name: string) {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('file', blob, name);
  return call<UploadResult>(`/api/sessions/${sessionId}/files`, { method: 'POST', body: fd });
}

export const sendAnswers = (sessionId: string, answers: Answer[]) => call<void>(`/api/sessions/${sessionId}/answers`, post({ answers }));

export const finish = (sessionId: string, answers: Answer[]) =>
  call<{ report: ReportData }>(`/api/sessions/${sessionId}/finish`, post({ answers }));

export const publish = (sessionId: string, hours: number, requireCode: boolean) =>
  call<Published>(`/api/sessions/${sessionId}/publish`, post({ hours, requireCode }));

export const destroy = (reportId: string, ownerToken: string) =>
  call<void>(`/api/reports/${reportId}`, { method: 'DELETE', headers: { 'x-owner-token': ownerToken } });

export const ownerUnlock = (reportId: string, ownerToken: string) =>
  call<void>(`/api/reports/${reportId}/owner-unlock`, { method: 'POST', headers: { 'x-owner-token': ownerToken } });
