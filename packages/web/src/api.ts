export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json()) as { error?: string; code?: string } & T;
  if (!res.ok) {
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code ?? 'error');
  }
  return body;
}

export interface Health {
  ok: boolean;
  lastSyncTs: number | null;
  lastLivenessTs?: number | null;
  entityCount: number;
  chainHead: number | null;
}

export interface DocListItem {
  doc_id: string;
  notice_id: string | null;
  title: string | null;
  source_url: string | null;
  source_kind: string | null;
  department: string | null;
  scheme: string | null;
  lang?: string | null;
  current_state: string | null;
  current_seq: number | null;
  last_seen_ts: number | null;
  last_change_ts: number | null;
  observer_count: number;
  open_flags: { count: number; kinds: string[] };
  current_version: {
    seq: number;
    deadline_ts: number | null;
    amount_paise: number | null;
    summary_en: string | null;
  } | null;
}

export interface DocsResponse {
  total: number;
  limit: number;
  offset: number;
  items: DocListItem[];
}

export interface DocDetail {
  doc: DocListItem & { doc_entity_url: string | null };
  status: {
    current_state: string | null;
    current_seq: number | null;
    last_seen_ts: number | null;
    last_change_ts: number | null;
    removed: boolean;
  };
  versions: {
    normalizer_version: string;
    seq: number;
    norm_sha256: string;
    first_seen_block: number;
    first_seen_ts: number;
    first_entity_key: string;
    observer_count: number;
    status: 'current' | 'superseded';
    deadline_ts: number | null;
    amount_paise: number | null;
    summary_en: string | null;
    summary_ta?: string | null;
    summary_hi?: string | null;
  }[];
  flags: {
    id: number;
    kind: string;
    severity: number;
    details: unknown;
    entity_keys: string[];
    created_ts: number;
    resolved_ts: number | null;
    open: boolean;
  }[];
  observers: {
    creator: string;
    vantages: string[];
    observation_count: number;
    latest_state: string | null;
    latest_norm_sha256: string | null;
    latest_created_ts: number;
    latest_entity_key: string;
    explorer_url: string;
  }[];
  observation_count: number;
  provenance: {
    sig_status: string | null;
    sig_signer_org: string | null;
    pdf_producer: string | null;
    pdf_created_ts: number | null;
  } | null;
}

export interface TimelineEvent {
  kind: 'observation' | 'version' | 'flag';
  ts: number;
  [k: string]: unknown;
}

export interface WatcherItem {
  creator: string;
  vantages: string[];
  observation_count: number;
  first_seen_ts: number;
  last_seen_ts: number;
  docs_covered: number;
  explorer_url: string;
}

export interface LiveChanges {
  source: string;
  where: unknown;
  post_filter?: string;
  items: { key: string; attributes: Record<string, unknown>; explorer_url: string }[];
}

export interface MatchResponse {
  result: 'exact_match' | 'similar_match' | 'no_match';
  match: {
    doc_id: string;
    title: string | null;
    department: string | null;
    version_seq: number;
    current_seq: number | null;
    status: 'current' | 'superseded';
    superseded_at: number | null;
    observer_count: number;
    changes_since: { seq: number; summary_en: string | null; first_seen_ts: number }[];
    timeline_url: string;
    hamming_distance?: number;
  } | null;
  note: string;
  similar_label?: string;
  forgery_reports: {
    distinct_creators: number;
    reason_codes: string[];
    note: string | null;
  };
}

export function fetchHealth(): Promise<Health> {
  return getJson('/api/health');
}

export function fetchDocs(q: {
  department?: string | undefined;
  scheme?: string | undefined;
  state?: string | undefined;
  changed_since?: number | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): Promise<DocsResponse> {
  const params = new URLSearchParams();
  if (q.department) params.set('department', q.department);
  if (q.scheme) params.set('scheme', q.scheme);
  if (q.state) params.set('state', q.state);
  if (q.changed_since !== undefined) params.set('changed_since', String(q.changed_since));
  if (q.q) params.set('q', q.q);
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  if (q.offset !== undefined) params.set('offset', String(q.offset));
  const qs = params.toString();
  return getJson(`/api/docs${qs ? `?${qs}` : ''}`);
}

export function fetchDoc(docId: string): Promise<DocDetail> {
  return getJson(`/api/docs/${docId}`);
}

export function fetchTimeline(docId: string): Promise<{ doc_id: string; events: TimelineEvent[] }> {
  return getJson(`/api/docs/${docId}/timeline`);
}

export function fetchWatchers(): Promise<{ items: WatcherItem[] }> {
  return getJson('/api/watchers');
}

export function fetchChanges(field: 'deadline' | 'amount' | 'any', days = 30): Promise<LiveChanges> {
  return getJson(`/api/arkiv/changes?days=${days}&field=${field}`);
}

export async function matchText(text: string, lang: 'en' | 'ta' | 'hi' = 'en'): Promise<MatchResponse> {
  const res = await fetch('/api/match', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, lang }),
  });
  const body = (await res.json()) as MatchResponse & { error?: string; code?: string };
  if (!res.ok) throw new ApiError(body.error ?? 'Match failed', res.status, body.code ?? 'error');
  return body;
}

export async function matchFile(file: File, lang: 'en' | 'ta' | 'hi' = 'en'): Promise<MatchResponse> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('lang', lang);
  const res = await fetch('/api/match', { method: 'POST', body: form });
  const body = (await res.json()) as MatchResponse & { error?: string; code?: string };
  if (!res.ok) throw new ApiError(body.error ?? 'Match failed', res.status, body.code ?? 'error');
  return body;
}
