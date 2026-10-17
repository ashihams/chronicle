import { FakeArkivClient, FakeArkivNetwork, sha256Hex, type Attrs, type ObservationState } from '@chronicle/core';
import { pino } from 'pino';
import type { IndexerSettings } from '../src/indexer.js';
import type { ObsInput } from '../src/derive.js';
import type { ObservationAttrs } from '../src/schema.js';

export const silentLog = pino({ level: 'silent' });

export const SETTINGS: IndexerSettings = { disagreeWindowMinutes: 30, backdateDays: 7, clockSkewSeconds: 3600 };

export const ADDR_A = '0x00000000000000000000000000000000000000aa';
export const ADDR_B = '0x00000000000000000000000000000000000000bb';
export const ADDR_C = '0x00000000000000000000000000000000000000cc';

export const T0 = 1_800_000_000;
export const DAY = 86400;

export const DOC_ID = sha256Hex('https://example.test/circulars/1');
export const DOC_ID_2 = sha256Hex('https://example.test/circulars/2');

/** Synthetic content hashes. */
export const H = (n: number): string => sha256Hex(`synthetic-version-${n}`);

export interface ObsSpec {
  docId?: string;
  state?: ObservationState;
  hash?: string;
  vantage?: string;
  observedAt: number;
  normalizerVersion?: string;
  printedDateTs?: number;
  lastModifiedTs?: number;
  deadlineTs?: number;
  amountPaise?: number;
  department?: string;
  severity?: number;
}

const CONTENT: ReadonlySet<string> = new Set(['first_seen', 'present', 'changed']);

/** Valid observation attributes (section 5.3) for synthetic test data. */
export function obsAttrs(s: ObsSpec): Attrs {
  const state = s.state ?? 'present';
  const content = CONTENT.has(state);
  const a: Attrs = {
    type: 'observation',
    schema_v: 1,
    doc_id: s.docId ?? DOC_ID,
    notice_id: 'synthetic-001',
    source_kind: 'page',
    vantage: s.vantage ?? 'test-vantage',
    observed_at: s.observedAt,
    normalizer_version: s.normalizerVersion ?? 'n1',
    state,
    http_status: state === 'removed_404' ? 404 : state === 'unreachable' ? 0 : 200,
    redirect_chain_len: 0,
    department: s.department ?? 'synthetic-dept',
    severity: s.severity ?? (content ? 0 : 3),
  };
  if (content) {
    const h = s.hash ?? H(1);
    a.norm_sha256 = h;
    a.raw_sha256 = h;
  }
  if (s.printedDateTs !== undefined) a.printed_date_ts = s.printedDateTs;
  if (s.lastModifiedTs !== undefined) a.last_modified_ts = s.lastModifiedTs;
  if (s.deadlineTs !== undefined) a.deadline_ts = s.deadlineTs;
  if (s.amountPaise !== undefined) a.amount_paise = s.amountPaise;
  return a;
}

export function docAttrs(docId = DOC_ID, extra: Attrs = {}): Attrs {
  return {
    type: 'doc',
    schema_v: 1,
    doc_id: docId,
    notice_id: 'synthetic-001',
    source_kind: 'page',
    source_url: 'https://example.test/circulars/1',
    department: 'synthetic-dept',
    lang: 'en',
    ...extra,
  };
}

let seq = 0;

/** A derive input built directly, without a chain. `ts` is the chain time; block = ts / 2. */
export function obsInput(
  creator: string,
  ts: number,
  spec: Partial<ObsSpec> = {},
  extra: Partial<Pick<ObsInput, 'status' | 'key' | 'summaryEn'>> = {},
): ObsInput {
  seq += 1;
  return {
    key: extra.key ?? `0x${seq.toString(16).padStart(64, '0')}`,
    creator,
    createdBlock: Math.floor(ts / 2),
    createdTs: ts,
    status: extra.status ?? 'live',
    attrs: obsAttrs({ observedAt: ts, ...spec }) as ObservationAttrs,
    summaryEn: extra.summaryEn ?? null,
  };
}

/** An in-memory chain whose block time follows a settable clock, with three writers. */
export class Chain {
  t = T0;
  readonly network = new FakeArkivNetwork({ clock: () => this.t });
  readonly a = new FakeArkivClient(ADDR_A, this.network);
  readonly b = this.a.withAddress(ADDR_B);
  readonly c = this.a.withAddress(ADDR_C);

  advance(seconds: number): void {
    this.t += seconds;
  }

  async observe(
    client: FakeArkivClient,
    spec: Partial<ObsSpec> = {},
    payload: unknown = { title: 'Synthetic circular', summary_en: 'Synthetic summary.' },
  ): Promise<string> {
    const r = await client.createEntity({
      attributes: obsAttrs({ observedAt: this.t, ...spec }),
      payload,
      ttlSeconds: 180 * DAY,
    });
    return r.key;
  }

  async doc(client: FakeArkivClient, docId = DOC_ID, title = 'Synthetic circular'): Promise<string> {
    const r = await client.createEntity({
      attributes: docAttrs(docId),
      payload: { title, registered_vantage: 'test-vantage', source_url: 'https://example.test/circulars/1' },
      ttlSeconds: 180 * DAY,
    });
    return r.key;
  }
}
