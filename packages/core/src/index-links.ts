import * as cheerio from 'cheerio';
import { canonicalizeUrl, docIdFor, InvalidUrlError } from './url.js';

export interface IndexLink {
  /** Canonical absolute URL. */
  url: string;
  docId: string;
  title: string;
}

const MAX_TITLE = 120;

/**
 * Parses links from an HTML index page. Relative hrefs are resolved against `baseUrl`.
 * Duplicate URLs keep the first title. Invalid / non-http(s) hrefs are skipped.
 */
export function parseIndexLinks(html: string, linkSelector: string, baseUrl: string): IndexLink[] {
  const $ = cheerio.load(html);
  const out: IndexLink[] = [];
  const seen = new Set<string>();
  $(linkSelector).each((_, el) => {
    const href = $(el).attr('href');
    if (href === undefined || href.trim() === '') return;
    let abs: string;
    try {
      abs = canonicalizeUrl(new URL(href, baseUrl).href);
    } catch (err) {
      if (err instanceof InvalidUrlError || err instanceof TypeError) return;
      throw err;
    }
    try {
      const u = new URL(abs);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    } catch {
      return;
    }
    const docId = docIdFor(abs);
    if (seen.has(docId)) return;
    seen.add(docId);
    const raw = $(el).text().replace(/\s+/g, ' ').trim() || abs;
    const title = raw.length <= MAX_TITLE ? raw : `${raw.slice(0, MAX_TITLE - 1)}…`;
    out.push({ url: abs, docId, title });
  });
  return out;
}

/** Stable hash input for the link set (doc_id + title), sorted by doc_id. */
export function linksFingerprint(links: { docId: string; title: string }[]): string {
  const rows = [...links].map((l) => `${l.docId}\t${l.title}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return rows.join('\n');
}
