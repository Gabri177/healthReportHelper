import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { customAlphabet, nanoid } from 'nanoid';
import type { Answer, FileAnalysis, Question, ReportData } from './schemas.ts';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const SESS_DIR = path.join(DATA_DIR, 'sessions');
const REP_DIR = path.join(DATA_DIR, 'reports');
const SESSION_TTL = 6 * 3600_000;
const SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

const reportId = customAlphabet('23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', 10);
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export type StoredFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  disk: string;
  status: 'reading' | 'done' | 'failed';
  analysis?: FileAnalysis;
  error?: string;
};

export type Session = {
  id: string;
  createdAt: number;
  files: StoredFile[];
  questions: Question[];
  answers: Answer[];
  mergeAsked: boolean;
  report?: ReportData;
  writing?: Promise<ReportData>;
};

export type ReportMeta = {
  id: string;
  createdAt: number;
  expiresAt: number;
  hours: number;
  codeHash: string | null;
  ownerHash: string;
  files: { name: string; mime: string; size: number; disk: string }[];
  report: ReportData;
};

const sessions = new Map<string, Session>();
const reports = new Map<string, ReportMeta>();

export async function init() {
  await fs.mkdir(SESS_DIR, { recursive: true });
  await fs.mkdir(REP_DIR, { recursive: true });
  // Uploads from a previous run are orphaned (sessions live in memory): drop them.
  for (const d of await fs.readdir(SESS_DIR)) await fs.rm(path.join(SESS_DIR, d), { recursive: true, force: true });
  for (const d of await fs.readdir(REP_DIR)) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(REP_DIR, d, 'meta.json'), 'utf8')) as ReportMeta;
      reports.set(meta.id, meta);
    } catch {
      await fs.rm(path.join(REP_DIR, d), { recursive: true, force: true });
    }
  }
  await cleanup();
}

// ---------- sessions (uploads in progress) ----------

export async function createSession(): Promise<Session> {
  const s: Session = { id: nanoid(18), createdAt: Date.now(), files: [], questions: [], answers: [], mergeAsked: false };
  await fs.mkdir(path.join(SESS_DIR, s.id), { recursive: true });
  sessions.set(s.id, s);
  return s;
}

export function getSession(id: string) {
  return sessions.get(id) ?? null;
}

export async function addFile(s: Session, f: { name: string; mime: string; data: Buffer }): Promise<StoredFile> {
  const id = nanoid(10);
  const disk = path.join(SESS_DIR, s.id, id);
  await fs.writeFile(disk, f.data);
  const stored: StoredFile = { id, name: f.name, mime: f.mime, size: f.data.length, disk, status: 'reading' };
  s.files.push(stored);
  return stored;
}

export async function dropSession(id: string) {
  sessions.delete(id);
  await fs.rm(path.join(SESS_DIR, id), { recursive: true, force: true });
}

// ---------- published reports ----------

export async function publish(s: Session, hours: number, requireCode: boolean) {
  if (!s.report) throw new Error('report not ready');
  const id = reportId();
  const dir = path.join(REP_DIR, id);
  await fs.mkdir(path.join(dir, 'files'), { recursive: true });
  const files = [];
  for (const [i, f] of s.files.filter(x => x.status === 'done').entries()) {
    const disk = path.join(dir, 'files', String(i));
    await fs.rename(f.disk, disk);
    files.push({ name: f.name, mime: f.mime, size: f.size, disk });
  }
  const code = requireCode ? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0') : null;
  const ownerToken = nanoid(32);
  const now = Date.now();
  const meta: ReportMeta = {
    id,
    createdAt: now,
    expiresAt: now + hours * 3600_000,
    hours,
    codeHash: code ? sha(`${id}:${code}`) : null,
    ownerHash: sha(ownerToken),
    files,
    report: s.report,
  };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  reports.set(id, meta);
  await dropSession(s.id);
  return { meta, code, ownerToken };
}

/** Returns the report, or null when it never existed or has expired (expired ones are deleted on the spot). */
export async function getReport(id: string): Promise<ReportMeta | null> {
  const meta = reports.get(id);
  if (!meta) return null;
  if (Date.now() >= meta.expiresAt) {
    await destroyReport(id);
    return null;
  }
  return meta;
}

export async function destroyReport(id: string) {
  reports.delete(id);
  await fs.rm(path.join(REP_DIR, id), { recursive: true, force: true });
}

export function checkOwner(meta: ReportMeta, token: string | undefined) {
  return !!token && sha(token) === meta.ownerHash;
}

export function checkCode(meta: ReportMeta, code: string) {
  return !!meta.codeHash && sha(`${meta.id}:${code.trim()}`) === meta.codeHash;
}

/** Value of the cookie that proves the visitor entered the right code. */
export function unlockToken(id: string) {
  return crypto.createHmac('sha256', SECRET).update(id).digest('hex');
}

export async function cleanup() {
  const now = Date.now();
  for (const [id, meta] of reports) if (now >= meta.expiresAt) await destroyReport(id);
  for (const [id, s] of sessions) if (now - s.createdAt > SESSION_TTL) await dropSession(id);
}
