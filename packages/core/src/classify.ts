import { hasPdfHeader } from './normalize/pdf.js';
import type { ObservationState, SourceKind } from './states.js';
import { InvalidUrlError, canonicalizeUrl, sameDocumentUrl } from './url.js';

export interface FetchResult {
  /** Final HTTP status after redirects; 0 when the request failed. */
  status: number;
  finalUrl: string;
  redirectChainLen: number;
  contentType: string | null;
  bytes: Uint8Array | null;
  error?: string;
}

export interface ClassifySource {
  url: string;
  kind: SourceKind;
  mustContain?: string[];
}

/** Output of normalization for a 2xx response. Not needed for other statuses. */
export interface ClassifyContent {
  text: string;
  normSha256: string;
  textExtracted: boolean;
}

export interface ClassifyPrevious {
  /** Last content hash this watcher saw for the doc (kept across removed/unreachable states). */
  normSha256: string | null;
  textExtracted: boolean;
}

export interface ClassifyInput {
  fetch: FetchResult;
  source: ClassifySource;
  content?: ClassifyContent | null;
  prev: ClassifyPrevious | null;
}

export interface Classification {
  state: ObservationState;
  reason: string;
}

export const MIN_PAGE_TEXT_CHARS = 200;

/**
 * Soft-removal phrases only count on short pages, so a long notice that mentions "withdrawn"
 * in passing is not treated as removed.
 */
export const SOFT_REMOVED_MAX_CHARS = 1000;

export const SOFT_REMOVED_PATTERNS: readonly RegExp[] = [
  /not found/i,
  /no longer available/i,
  /page you requested/i,
  /has been removed/i,
  /withdrawn/i,
  /पृष्ठ नहीं मिला/,
  /இந்த பக்கம் கிடைக்கவில்லை/,
];

const ERROR_PATH_RE = /^\/(search|404|error)/i;

function isRedirectAway(sourceUrl: string, finalUrl: string): boolean {
  let src: URL;
  let fin: URL;
  try {
    if (sameDocumentUrl(sourceUrl, finalUrl)) return false;
    src = new URL(canonicalizeUrl(sourceUrl));
    fin = new URL(canonicalizeUrl(finalUrl));
  } catch (err) {
    if (err instanceof InvalidUrlError) return false;
    throw err;
  }
  return src.host !== fin.host || fin.pathname === '/' || ERROR_PATH_RE.test(fin.pathname);
}

function softRemovedReason(input: ClassifyInput, content: ClassifyContent): string | null {
  const { source, prev, fetch } = input;
  const text = content.text;
  if (source.kind === 'pdf') {
    if (fetch.bytes === null || !hasPdfHeader(fetch.bytes)) return 'response is not a PDF';
    if (!content.textExtracted && prev?.textExtracted === true) return 'PDF lost its text layer';
  } else {
    if (text.length < MIN_PAGE_TEXT_CHARS) return `page text is ${text.length} chars`;
    if (text.length <= SOFT_REMOVED_MAX_CHARS) {
      const hit = SOFT_REMOVED_PATTERNS.find((re) => re.test(text));
      if (hit) return `page matches ${hit.source}`;
    }
  }
  if (source.mustContain && source.mustContain.length > 0) {
    const lower = text.toLowerCase();
    if (!source.mustContain.some((s) => lower.includes(s.toLowerCase()))) return 'none of mustContain present';
  }
  return null;
}

export function classify(input: ClassifyInput): Classification {
  const { fetch, source, prev } = input;

  if (fetch.error !== undefined || fetch.status === 0) {
    return { state: 'unreachable', reason: fetch.error ?? 'network error' };
  }
  if (fetch.status >= 500) return { state: 'unreachable', reason: `http ${fetch.status}` };
  if (fetch.status === 404) return { state: 'removed_404', reason: 'http 404' };
  if (fetch.status === 410) return { state: 'removed_410', reason: 'http 410' };

  if (isRedirectAway(source.url, fetch.finalUrl)) {
    return { state: 'redirected', reason: `redirected to ${fetch.finalUrl}` };
  }

  // Other non-2xx answers (401, 403, 429, an unfollowed 3xx) say nothing about the document.
  if (fetch.status < 200 || fetch.status >= 300) return { state: 'unreachable', reason: `http ${fetch.status}` };

  const content = input.content;
  if (!content) return { state: 'unreachable', reason: 'no content to classify' };

  const soft = softRemovedReason(input, content);
  if (soft !== null) return { state: 'soft_removed', reason: soft };

  if (prev === null || prev.normSha256 === null) return { state: 'first_seen', reason: 'no previous observation' };
  if (prev.normSha256 === content.normSha256) return { state: 'present', reason: 'normalized hash unchanged' };
  return { state: 'changed', reason: 'normalized hash differs' };
}
