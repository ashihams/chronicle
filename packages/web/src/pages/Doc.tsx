import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { fetchDoc, fetchTimeline, type TimelineEvent } from '../api';
import { CopyButton } from '../components/CopyButton';
import { Empty, ErrorBox, Loading } from '../components/Status';
import { flagExplanation, formatWhen, shortHex, stateBadge } from '../format';

export function DocPage(): React.ReactElement {
  const { docId = '' } = useParams();
  const detail = useQuery({
    queryKey: ['doc', docId],
    queryFn: () => fetchDoc(docId),
    enabled: /^[0-9a-f]{64}$/.test(docId),
  });
  const timeline = useQuery({
    queryKey: ['timeline', docId],
    queryFn: () => fetchTimeline(docId),
    enabled: /^[0-9a-f]{64}$/.test(docId),
  });

  if (!/^[0-9a-f]{64}$/.test(docId)) return <ErrorBox error={new Error('Invalid document id')} />;
  if (detail.isLoading) return <Loading label="Loading document…" />;
  if (detail.isError) return <ErrorBox error={detail.error} />;
  const d = detail.data!;
  const contradiction = d.flags.find((f) => f.open && f.kind === 'contradiction');
  const disputed = d.flags.some((f) => f.open && f.kind === 'vantage_disagreement');
  const badge = stateBadge(d.status.current_state, disputed, contradiction !== undefined);
  const contradictionBadge =
    contradiction !== undefined &&
    typeof contradiction.details === 'object' &&
    contradiction.details !== null &&
    'notice_badge' in contradiction.details &&
    typeof (contradiction.details as { notice_badge?: unknown }).notice_badge === 'string'
      ? (contradiction.details as { notice_badge: string }).notice_badge
      : null;
  const verifyCmd = `chronicle verify --doc ${docId}`;

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <p className="font-mono text-[11px] uppercase tracking-widest text-stardust">
            {d.doc.department ?? 'Document'}
          </p>
          <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
            {d.doc.title || d.doc.notice_id || 'Untitled notice'}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className={badge.className}>{badge.label}</span>
            {contradictionBadge ? (
              <span className="badge-disputed" title={contradictionBadge}>
                {contradictionBadge}
              </span>
            ) : null}
            {d.doc.source_url ? (
              <a href={d.doc.source_url} target="_blank" rel="noreferrer" className="font-mono text-xs no-underline">
                Source
              </a>
            ) : null}
            {d.doc.doc_entity_url ? (
              <a
                href={d.doc.doc_entity_url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs no-underline"
              >
                Doc entity
              </a>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className="btn-primary no-underline" href={`/api/bundle/${docId}`} download>
            Export evidence bundle
          </a>
          <CopyButton value={verifyCmd} label="Copy verify command" />
        </div>
      </div>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="panel p-5 sm:p-6">
          <h2 className="font-heading text-xl font-semibold">Versions</h2>
          {d.versions.length === 0 ? (
            <div className="mt-3">
              <Empty>No content versions yet.</Empty>
            </div>
          ) : (
            <ol className="mt-4 space-y-3">
              {d.versions.map((v) => (
                <li
                  key={`${v.normalizer_version}-${v.seq}`}
                  className="relative rounded-xl border border-white/10 bg-black/30 p-4 before:absolute before:left-0 before:top-0 before:h-3 before:w-3 before:rounded-tl-xl before:border-l before:border-t before:border-btc/60 after:absolute after:bottom-0 after:right-0 after:h-3 after:w-3 after:rounded-br-xl after:border-b after:border-r after:border-btc/40"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-heading font-semibold">
                      v{v.seq}{' '}
                      <span className="font-mono text-[11px] font-normal uppercase tracking-wider text-stardust">
                        {v.status === 'current' ? 'current' : 'superseded'}
                      </span>
                    </p>
                    <p className="font-mono text-[11px] text-stardust">{formatWhen(v.first_seen_ts)}</p>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-stardust">{v.summary_en || 'No summary.'}</p>
                  <p className="mt-2 font-mono text-[11px] text-stardust">
                    {v.observer_count} observer{v.observer_count === 1 ? '' : 's'} ·{' '}
                    <span className="text-white/80">{shortHex(v.norm_sha256, 8, 6)}</span>
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="panel p-5 sm:p-6">
          <h2 className="font-heading text-xl font-semibold">Flags</h2>
          <p className="mt-1 text-sm text-stardust">
            Plain-language conditions derived from the mirror. Not accusations.
          </p>
          {d.flags.length === 0 ? (
            <div className="mt-4">
              <Empty>No flags on this document.</Empty>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {d.flags.map((f) => (
                <li
                  key={f.id}
                  className={`rounded-xl border p-4 ${
                    f.open ? 'border-btc-gold/30 bg-btc-gold/5' : 'border-white/10 bg-black/20 opacity-70'
                  }`}
                >
                  <p className="font-heading text-sm font-semibold capitalize">
                    {f.kind.replace(/_/g, ' ')}
                    {!f.open ? (
                      <span className="ml-2 font-mono text-[11px] font-normal uppercase text-stardust">resolved</span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-stardust">{flagExplanation(f.kind)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="panel p-5 sm:p-6">
        <h2 className="font-heading text-xl font-semibold">Timeline</h2>
        {timeline.isLoading ? (
          <Loading label="Loading timeline…" />
        ) : timeline.isError ? (
          <ErrorBox error={timeline.error} />
        ) : (
          <ol className="relative mt-8 space-y-8 border-l-2 border-transparent pl-8">
            <span className="chain-line absolute bottom-0 left-0 top-0 w-0.5" aria-hidden />
            {(timeline.data?.events ?? []).map((e, i) => (
              <TimelineItem key={`${e.kind}-${e.ts}-${i}`} event={e} />
            ))}
          </ol>
        )}
      </section>

      <p className="text-sm">
        <Link to="/" className="font-mono text-xs uppercase tracking-wider no-underline">
          ← All documents
        </Link>
      </p>
    </div>
  );
}

function TimelineItem({ event }: { event: TimelineEvent }): React.ReactElement {
  if (event.kind === 'version') {
    return (
      <li className="relative">
        <span className="absolute -left-[2.35rem] top-1 flex h-5 w-5 items-center justify-center rounded-full border border-btc bg-void text-[10px] font-mono text-btc shadow-glow">
          ◆
        </span>
        <p className="font-mono text-[11px] text-stardust">{formatWhen(event.ts)}</p>
        <p className="font-heading font-semibold">{String(event.label ?? `version ${String(event.seq)} first seen`)}</p>
      </li>
    );
  }
  if (event.kind === 'flag') {
    return (
      <li className="relative">
        <span className="absolute -left-[2.35rem] top-1 flex h-5 w-5 items-center justify-center rounded-full border border-btc-gold/60 bg-btc-gold/20 text-[10px] text-btc-gold">
          !
        </span>
        <p className="font-mono text-[11px] text-stardust">{formatWhen(event.ts)}</p>
        <p className="font-heading font-semibold capitalize">
          Flag: {String(event.flag_kind ?? event.kind).replace(/_/g, ' ')}
        </p>
        <p className="mt-1 text-sm text-stardust">{flagExplanation(String(event.flag_kind ?? ''))}</p>
      </li>
    );
  }

  const creator = String(event.creator ?? '');
  const owner = String(event.owner ?? '');
  const skew =
    typeof event.observed_at === 'number' && typeof event.created_ts === 'number'
      ? Math.abs(event.observed_at - event.created_ts) > 3600
      : false;

  return (
    <li className="relative">
      <span className="absolute -left-[2.2rem] top-1.5 h-3.5 w-3.5 rounded-full border-2 border-btc/70 bg-surface shadow-glow" />
      <p className="font-mono text-[11px] text-stardust">{formatWhen(event.ts)}</p>
      <p className="font-heading font-semibold capitalize text-btc">{String(event.state ?? 'observation')}</p>
      <div className="mt-2 space-y-1.5 text-sm text-stardust">
        <p>
          <span className="text-stardust/70">Creator </span>
          <span className="font-mono text-white/90">{shortHex(creator)}</span>
          <CopyButton value={creator} label="Copy" />
          <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-stardust/60">
            Original writer (creator)
          </span>
        </p>
        {owner && owner !== creator ? (
          <p>
            <span className="text-stardust/70">Current owner </span>
            <span className="font-mono text-white/90">{shortHex(owner)}</span>
          </p>
        ) : null}
        {event.vantage ? <p>Vantage: {String(event.vantage)}</p> : null}
        <p>
          Chain time {formatWhen(Number(event.created_ts) || null)}
          {event.observed_at !== null && event.observed_at !== undefined ? (
            <>
              {' '}
              · observed_at {formatWhen(Number(event.observed_at))}
              {skew ? <span className="ml-2 text-btc-gold">skew warning</span> : null}
            </>
          ) : null}
        </p>
        {event.norm_sha256 ? (
          <p className="font-mono text-xs text-white/80">
            hash {shortHex(String(event.norm_sha256), 10, 8)} <CopyButton value={String(event.norm_sha256)} />
          </p>
        ) : null}
        {event.summary_en ? <p className="leading-relaxed text-white/85">{String(event.summary_en)}</p> : null}
        {typeof event.explorer_url === 'string' ? (
          <a href={event.explorer_url} target="_blank" rel="noreferrer" className="font-mono text-xs no-underline">
            Open in explorer
          </a>
        ) : null}
      </div>
    </li>
  );
}
