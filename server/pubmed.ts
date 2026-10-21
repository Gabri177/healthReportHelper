/**
 * Literature for the report, straight from PubMed (NCBI E-utilities). The model only ever cites papers
 * found here, and the details shown in the report come from PubMed, not from the model.
 */

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const TIMEOUT = 10_000;

export type Paper = { pmid: string; title: string; journal: string; year: string; types: string[]; abstract: string };

function params(extra: Record<string, string>) {
  const p = new URLSearchParams({ tool: 'dixi', ...extra });
  if (process.env.NCBI_API_KEY) p.set('api_key', process.env.NCBI_API_KEY);
  return p.toString();
}

// NCBI allows 3 requests a second without an API key and 10 with one, for the whole server
const GAP = process.env.NCBI_API_KEY ? 110 : 350;
let nextSlot = 0;
/** Waits for this request's turn on the server-wide schedule. */
async function turn() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + GAP;
  if (at > now) await sleep(at - now);
}

async function get(path: string, query: Record<string, string>) {
  await turn();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(`${EUTILS}/${path}?${params(query)}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`PubMed ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
    )
    .replace(/\s+/g, ' ')
    .trim();
const first = (xml: string, re: RegExp) => {
  const m = xml.match(re);
  return m ? text(m[1]) : '';
};

/** PubMed IDs for a query: recent reviews, meta-analyses and guidelines first. */
async function search(query: string, max: number) {
  const term = `(${query}) AND ("systematic review"[pt] OR "meta-analysis"[pt] OR review[pt] OR "practice guideline"[pt] OR guideline[pt]) AND ("2014"[dp] : "3000"[dp]) AND english[la]`;
  const body = JSON.parse(await get('esearch.fcgi', { db: 'pubmed', term, retmax: String(max), sort: 'relevance', retmode: 'json' }));
  return (body?.esearchresult?.idlist ?? []) as string[];
}

async function fetchPapers(ids: string[]): Promise<Paper[]> {
  if (!ids.length) return [];
  const xml = await get('efetch.fcgi', { db: 'pubmed', id: ids.join(','), retmode: 'xml' });
  return xml
    .split(/<PubmedArticle>/)
    .slice(1)
    .map(a => {
      const pmid = first(a, /<PMID[^>]*>(\d+)<\/PMID>/);
      const year = first(a, /<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/) || first(a, /<PubDate>[\s\S]*?<MedlineDate>(\d{4})/);
      const abstract = [...a.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
        .map(m => {
          const label = m[1].match(/Label="([^"]+)"/)?.[1];
          return (label ? `${label}: ` : '') + text(m[2]);
        })
        .join(' ');
      return {
        pmid,
        title: first(a, /<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/),
        journal: first(a, /<ISOAbbreviation>([\s\S]*?)<\/ISOAbbreviation>/) || first(a, /<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/),
        year,
        types: [...a.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)].map(m => text(m[1])),
        abstract: abstract.length > 1400 ? `${abstract.slice(0, 1400)}…` : abstract,
      };
    })
    .filter(p => p.pmid && p.title);
}

/** Papers for each query (a few each), de-duplicated. Never throws: without PubMed the report is written without citations. */
export async function findLiterature(queries: string[], perQuery = 3): Promise<Paper[]> {
  const ids: string[] = [];
  try {
    for (const q of queries) for (const id of await search(q, perQuery)) if (!ids.includes(id)) ids.push(id);
    return await fetchPapers(ids.slice(0, 16));
  } catch (e) {
    console.warn('[pubmed]', (e as Error).message);
    return [];
  }
}

export const pubmedUrl = (pmid: string) => `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
