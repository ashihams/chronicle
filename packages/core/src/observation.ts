import { ArkivValidationError, type Attrs } from './arkiv/types.js';
import { MAX_STRING_BYTES, MAX_USER_ATTRIBUTES, utf8Length, validateAttrs } from './arkiv/limits.js';
import { MAX_SUMMARY_CHARS } from './extract.js';
import { NORMALIZER_VERSION } from './hash.js';
import { MAX_TITLE_CHARS } from './normalize/html.js';
import {
  NO_CONTENT_STATES,
  OBSERVATION_STATES,
  SOURCE_KINDS,
  type ObservationState,
  type SourceKind,
} from './states.js';
import { canonicalizeUrl, docIdFor } from './url.js';

export const SCHEMA_V = 1;
/** Section 5.3: the observation payload carries no document text and stays small. */
export const MAX_OBSERVATION_PAYLOAD_BYTES = 4096;
export const MAX_CHANGE_VALUE_CHARS = 160;

export class ObservationBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObservationBuildError';
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LANG_RE = /^[a-z]{2,3}$/;

function fail(msg: string): never {
  throw new ObservationBuildError(msg);
}

function check(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

function checkSlug(name: string, v: string): void {
  check(SLUG_RE.test(v), `${name} "${v}" must be a lowercase slug`);
}

function checkHash(name: string, v: string): void {
  check(HASH_RE.test(v), `${name} must be 64 lowercase hex characters`);
}

function checkTs(name: string, v: number): void {
  check(Number.isSafeInteger(v) && v >= 0, `${name} must be a non-negative integer (unix seconds)`);
}

/** Cuts a string to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (utf8Length(s) <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = utf8Length(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

function truncateChars(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Runs the Arkiv limit checks and reports failures as ObservationBuildError. */
function finish(attrs: Attrs): Attrs {
  try {
    validateAttrs(attrs);
  } catch (err) {
    if (err instanceof ArkivValidationError) fail(err.message);
    throw err;
  }
  return attrs;
}

function payloadSize(payload: unknown): number {
  return utf8Length(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------------------------
// doc

export interface DocInput {
  noticeId: string;
  sourceKind: SourceKind;
  sourceUrl: string;
  department: string;
  scheme?: string | null;
  lang: string;
}

export interface DocPayload {
  title: string | null;
  registered_vantage: string;
  /** Always present: `source_url` is only an attribute when it fits in 128 bytes. */
  source_url: string;
}

export function buildDocAttrs(input: DocInput): Attrs {
  check(ID_RE.test(input.noticeId), `notice_id "${input.noticeId}" must be a lowercase id`);
  check((SOURCE_KINDS as readonly string[]).includes(input.sourceKind), `source_kind "${input.sourceKind}" is invalid`);
  checkSlug('department', input.department);
  if (input.scheme) checkSlug('scheme', input.scheme);
  check(LANG_RE.test(input.lang), `lang "${input.lang}" must be a 2-3 letter code`);

  const url = canonicalizeUrl(input.sourceUrl);
  const attrs: Attrs = {
    type: 'doc',
    schema_v: SCHEMA_V,
    doc_id: docIdFor(url),
    notice_id: input.noticeId,
    source_kind: input.sourceKind,
    department: input.department,
    lang: input.lang,
  };
  if (utf8Length(url) <= MAX_STRING_BYTES) attrs.source_url = url;
  if (input.scheme) attrs.scheme = input.scheme;
  return finish(attrs);
}

export function buildDocPayload(input: {
  title: string | null;
  registeredVantage: string;
  sourceUrl: string;
}): DocPayload {
  checkSlug('registered_vantage', input.registeredVantage);
  const payload: DocPayload = {
    title: input.title === null ? null : truncateChars(input.title, MAX_TITLE_CHARS),
    registered_vantage: input.registeredVantage,
    source_url: canonicalizeUrl(input.sourceUrl),
  };
  check(payloadSize(payload) <= MAX_OBSERVATION_PAYLOAD_BYTES, 'doc payload exceeds 4096 bytes');
  return payload;
}

// ---------------------------------------------------------------------------------------------
// observation

/** Stretch-stage attributes (S3, S5); absent in the baseline. */
export interface ObservationExtras {
  simhashHex?: string | null;
  sigStatus?: string | null;
  sigSignerOrg?: string | null;
  pdfProducer?: string | null;
  pdfCreatedTs?: number | null;
}

export interface ObservationInput {
  docId: string;
  noticeId: string;
  sourceKind: SourceKind;
  department: string;
  scheme?: string | null;
  vantage: string;
  observedAt: number;
  state: ObservationState;
  httpStatus: number;
  redirectChainLen: number;
  rawSha256?: string | null;
  normSha256?: string | null;
  prevNormSha256?: string | null;
  textExtracted: boolean;
  lastModifiedTs?: number | null;
  printedDateTs?: number | null;
  deadlineTs?: number | null;
  deadlineDate?: string | null;
  amountPaise?: number | null;
  severity: number;
  extras?: ObservationExtras;
}

/**
 * Attributes for an `observation` entity (section 5.3). Absent optional values are omitted, and
 * content hashes are dropped for removal and unreachable states.
 */
export function buildObservationAttrs(input: ObservationInput): Attrs {
  checkHash('doc_id', input.docId);
  check(ID_RE.test(input.noticeId), `notice_id "${input.noticeId}" must be a lowercase id`);
  check((SOURCE_KINDS as readonly string[]).includes(input.sourceKind), `source_kind "${input.sourceKind}" is invalid`);
  checkSlug('department', input.department);
  if (input.scheme) checkSlug('scheme', input.scheme);
  checkSlug('vantage', input.vantage);
  checkTs('observed_at', input.observedAt);
  check((OBSERVATION_STATES as readonly string[]).includes(input.state), `state "${input.state}" is invalid`);
  check(
    Number.isInteger(input.httpStatus) && input.httpStatus >= 0 && input.httpStatus <= 999,
    'http_status must be 0..999',
  );
  check(
    Number.isInteger(input.redirectChainLen) && input.redirectChainLen >= 0,
    'redirect_chain_len must be a non-negative integer',
  );
  check(
    Number.isInteger(input.severity) && input.severity >= 0 && input.severity <= 3,
    'severity must be an integer 0..3',
  );

  const attrs: Attrs = {
    type: 'observation',
    schema_v: SCHEMA_V,
    doc_id: input.docId,
    notice_id: input.noticeId,
    source_kind: input.sourceKind,
    vantage: input.vantage,
    observed_at: input.observedAt,
    normalizer_version: NORMALIZER_VERSION,
    state: input.state,
    http_status: input.httpStatus,
    redirect_chain_len: input.redirectChainLen,
    department: input.department,
    severity: input.severity,
  };
  if (input.scheme) attrs.scheme = input.scheme;

  if (!NO_CONTENT_STATES.has(input.state)) {
    if (!input.rawSha256 || !input.normSha256) fail(`state ${input.state} needs raw_sha256 and norm_sha256`);
    checkHash('raw_sha256', input.rawSha256);
    checkHash('norm_sha256', input.normSha256);
    attrs.raw_sha256 = input.rawSha256;
    attrs.norm_sha256 = input.normSha256;
    attrs.text_extracted = input.textExtracted ? 1 : 0;
  }
  if (input.prevNormSha256) {
    checkHash('prev_norm_sha256', input.prevNormSha256);
    attrs.prev_norm_sha256 = input.prevNormSha256;
  }

  const optTs: [string, number | null | undefined][] = [
    ['last_modified_ts', input.lastModifiedTs],
    ['printed_date_ts', input.printedDateTs],
    ['deadline_ts', input.deadlineTs],
    ['amount_paise', input.amountPaise],
  ];
  for (const [name, v] of optTs) {
    if (v === null || v === undefined) continue;
    checkTs(name, v);
    attrs[name] = v;
  }
  if (input.deadlineDate) {
    check(ISO_DATE_RE.test(input.deadlineDate), 'deadline_date must be YYYY-MM-DD');
    attrs.deadline_date = input.deadlineDate;
  }

  const x = input.extras ?? {};
  if (x.simhashHex) {
    check(/^[0-9a-f]{16}$/.test(x.simhashHex), 'simhash_hex must be 16 lowercase hex characters');
    attrs.simhash_hex = x.simhashHex;
  }
  if (x.sigStatus) {
    checkSlug('sig_status', x.sigStatus);
    attrs.sig_status = x.sigStatus;
  }
  const signer = x.sigSignerOrg?.replace(/\s+/g, ' ').trim();
  if (signer) attrs.sig_signer_org = truncateUtf8(signer, MAX_STRING_BYTES);
  // eslint-disable-next-line no-control-regex
  const producer = x.pdfProducer?.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (producer) attrs.pdf_producer = truncateUtf8(producer, MAX_STRING_BYTES);
  if (x.pdfCreatedTs !== null && x.pdfCreatedTs !== undefined) {
    checkTs('pdf_created_ts', x.pdfCreatedTs);
    attrs.pdf_created_ts = x.pdfCreatedTs;
  }

  check(Object.keys(attrs).length <= MAX_USER_ATTRIBUTES, `more than ${MAX_USER_ATTRIBUTES} attributes`);
  return finish(attrs);
}

export type ChangeField = 'deadline' | 'amount' | 'text' | 'removed';

export interface Change {
  field: ChangeField;
  from: string | null;
  to: string | null;
}

export interface ObservationPayload {
  title: string | null;
  summary_en: string;
  summary_ta: string | null;
  summary_hi: string | null;
  final_url: string;
  changes: Change[];
  extractor: { model: string; confidence: number };
  declared_supersedes: string | null;
}

export interface ObservationPayloadInput {
  title: string | null;
  summaryEn: string;
  summaryTa?: string | null;
  summaryHi?: string | null;
  finalUrl: string;
  changes: Change[];
  extractor: { model: string; confidence: number };
  declaredSupersedes?: string | null;
}

function truncOrNull(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t === '' ? null : truncateChars(t, max);
}

export function buildObservationPayload(input: ObservationPayloadInput): ObservationPayload {
  check(
    Number.isFinite(input.extractor.confidence) && input.extractor.confidence >= 0 && input.extractor.confidence <= 1,
    'extractor.confidence must be 0..1',
  );
  const payload: ObservationPayload = {
    title: truncOrNull(input.title, MAX_TITLE_CHARS),
    summary_en: truncOrNull(input.summaryEn, MAX_SUMMARY_CHARS) ?? '',
    summary_ta: truncOrNull(input.summaryTa, MAX_SUMMARY_CHARS * 2),
    summary_hi: truncOrNull(input.summaryHi, MAX_SUMMARY_CHARS * 2),
    final_url: input.finalUrl,
    changes: input.changes.map((c) => ({
      field: c.field,
      from: truncOrNull(c.from, MAX_CHANGE_VALUE_CHARS),
      to: truncOrNull(c.to, MAX_CHANGE_VALUE_CHARS),
    })),
    extractor: { model: input.extractor.model, confidence: input.extractor.confidence },
    declared_supersedes: truncOrNull(input.declaredSupersedes, MAX_CHANGE_VALUE_CHARS),
  };
  const size = payloadSize(payload);
  check(size <= MAX_OBSERVATION_PAYLOAD_BYTES, `observation payload is ${size} bytes; the limit is 4096`);
  return payload;
}

function paiseToRupees(p: number): string {
  return (p / 100).toFixed(2);
}

/**
 * The `changes` list for a payload. Text changes carry normalized hashes, never document text.
 */
export function describeChanges(input: {
  state: ObservationState;
  prevState?: ObservationState | null;
  prevNormSha256?: string | null;
  normSha256?: string | null;
  prevFields?: { deadline_date: string | null; amount_paise: number | null } | null;
  nextFields?: { deadline_date: string | null; amount_paise: number | null } | null;
}): Change[] {
  if (NO_CONTENT_STATES.has(input.state) && input.state !== 'unreachable') {
    return [{ field: 'removed', from: input.prevState ?? null, to: input.state }];
  }
  if (input.state !== 'changed') return [];
  const changes: Change[] = [];
  const prev = input.prevFields;
  const next = input.nextFields;
  if (prev && next) {
    if (prev.deadline_date !== next.deadline_date) {
      changes.push({ field: 'deadline', from: prev.deadline_date, to: next.deadline_date });
    }
    if (prev.amount_paise !== next.amount_paise) {
      changes.push({
        field: 'amount',
        from: prev.amount_paise === null ? null : paiseToRupees(prev.amount_paise),
        to: next.amount_paise === null ? null : paiseToRupees(next.amount_paise),
      });
    }
  }
  changes.push({ field: 'text', from: input.prevNormSha256 ?? null, to: input.normSha256 ?? null });
  return changes;
}
