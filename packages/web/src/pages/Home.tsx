import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchChanges, fetchDocs, fetchHealth, fetchWatchers, type DocListItem } from '../api';
import { Empty, ErrorBox, Loading } from '../components/Status';
import { formatDay, formatWhen, stateBadge } from '../format';

const THIRTY_DAYS = 30 * 86400;

export function HomePage(): React.ReactElement {
  const [department, setDepartment] = useState('');
  const [scheme, setScheme] = useState('');
  const [state, setState] = useState('');
  const [changedSince, setChangedSince] = useState('');
  const [liveField, setLiveField] = useState<'off' | 'deadline' | 'amount'>('off');

  const sinceTs = changedSince ? Math.floor(new Date(changedSince).getTime() / 1000) : undefined;

  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth });
  const watchers = useQuery({ queryKey: ['watchers'], queryFn: fetchWatchers });
  const docs = useQuery({
    queryKey: ['docs', department, scheme, state, sinceTs],
    queryFn: () =>
      fetchDocs({
        department: department || undefined,
        scheme: scheme || undefined,
        state: state || undefined,
        changed_since: sinceTs,
        limit: 100,
      }),
  });
  const changes30 = useQuery({
    queryKey: ['docs-changed-30'],
    queryFn: () => fetchDocs({ changed_since: Math.floor(Date.now() / 1000) - THIRTY_DAYS, limit: 1 }),
  });
  const live = useQuery({
    queryKey: ['arkiv-changes', liveField],
    queryFn: () => fetchChanges(liveField === 'off' ? 'any' : liveField, 30),
    enabled: liveField !== 'off',
  });

  const departments = useMemo(() => {
    const set = new Set((docs.data?.items ?? []).map((d) => d.department).filter(Boolean) as string[]);
    return [...set].sort();
  }, [docs.data]);

  const observationCount = (watchers.data?.items ?? []).reduce((n, w) => n + w.observation_count, 0);

  return (
    <div className="space-y-12">
      <section className="relative max-w-3xl">
        <p className="font-mono text-xs font-medium uppercase tracking-[0.22em] text-btc">
          <span className="live-dot mr-2 align-middle" aria-hidden />
          Chronicle
          {health.data?.ok ? <span className="ml-2 text-stardust">synced</span> : null}
        </p>
        <h1 className="mt-3 font-heading text-4xl font-bold leading-tight tracking-tight sm:text-5xl md:text-6xl">
          a public memory for records that <span className="text-gradient-gold">change</span>
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-stardust md:text-lg">
          Independent watchers record what a public notice said, when they saw it, and whether it later changed or
          disappeared. Browse observations, compare versions, and check a PDF or paste against the mirror — without
          trusting any single server&apos;s word alone.
        </p>
      </section>

      <section aria-label="Summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Docs tracked" value={docs.data?.total} loading={docs.isLoading} />
        <Stat label="Observations" value={observationCount || health.data?.entityCount} loading={watchers.isLoading} />
        <Stat label="Watchers" value={watchers.data?.items.length} loading={watchers.isLoading} />
        <Stat label="Changes (30 days)" value={changes30.data?.total} loading={changes30.isLoading} />
      </section>

      <section className="panel space-y-5 p-5 sm:p-6">
        <div className="flex flex-wrap items-end gap-4">
          <Filter label="Department" value={department} onChange={setDepartment}>
            <option value="">All</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Filter>
          <Filter label="Scheme" value={scheme} onChange={setScheme}>
            <option value="">All</option>
            <option value="demo-scheme">demo-scheme</option>
          </Filter>
          <Filter label="State" value={state} onChange={setState}>
            <option value="">All</option>
            <option value="first_seen">first_seen</option>
            <option value="present">present</option>
            <option value="changed">changed</option>
            <option value="removed_404">removed_404</option>
            <option value="soft_removed">soft_removed</option>
            <option value="redirected">redirected</option>
          </Filter>
          <label className="min-w-[10rem] flex-1">
            <span className="label">Changed since</span>
            <input
              type="date"
              className="field"
              value={changedSince}
              onChange={(e) => setChangedSince(e.target.value)}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="label !mb-0">Live Arkiv query</span>
          {(['off', 'deadline', 'amount'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={
                liveField === f ? 'btn-primary !min-h-10 !px-4 !text-xs' : 'btn-outline !min-h-10 !px-4 !text-xs'
              }
              onClick={() => setLiveField(f)}
            >
              {f === 'off' ? 'Mirror list' : `${f} changed`}
            </button>
          ))}
        </div>

        {liveField !== 'off' ? (
          <LiveChangesPanel field={liveField} query={live} />
        ) : docs.isLoading ? (
          <Loading label="Loading documents…" />
        ) : docs.isError ? (
          <ErrorBox error={docs.error} />
        ) : docs.data?.items.length === 0 ? (
          <Empty>No documents match these filters yet.</Empty>
        ) : (
          <DocsTable items={docs.data?.items ?? []} />
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  loading,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
}): React.ReactElement {
  return (
    <div className="panel-glass px-5 py-4">
      <p className="font-mono text-[11px] uppercase tracking-widest text-stardust">{label}</p>
      <p className="mt-2 font-heading text-3xl font-bold tabular-nums text-white">{loading ? '…' : (value ?? '—')}</p>
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="min-w-[9rem] flex-1">
      <span className="label">{label}</span>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function DocsTable({ items }: { items: DocListItem[] }): React.ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <thead className="border-b border-white/10 font-mono text-[11px] uppercase tracking-widest text-stardust">
          <tr>
            <th className="py-3 pr-3 font-medium">Document</th>
            <th className="py-3 pr-3 font-medium">Department</th>
            <th className="py-3 pr-3 font-medium">State</th>
            <th className="py-3 pr-3 font-medium">Last change</th>
            <th className="py-3 pr-3 font-medium">Observers</th>
            <th className="py-3 font-medium">Flags</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => {
            const disputed = d.open_flags.kinds.includes('vantage_disagreement');
            const badge = stateBadge(d.current_state, disputed);
            return (
              <tr key={d.doc_id} className="border-b border-white/5 transition hover:bg-white/[0.03]">
                <td className="py-3.5 pr-3">
                  <Link
                    to={`/docs/${d.doc_id}`}
                    className="font-heading font-semibold text-white no-underline hover:text-btc"
                  >
                    {d.title || d.notice_id || shortId(d.doc_id)}
                  </Link>
                  {d.scheme ? <p className="mt-0.5 font-mono text-[11px] text-stardust">{d.scheme}</p> : null}
                </td>
                <td className="py-3.5 pr-3 text-stardust">{d.department ?? '—'}</td>
                <td className="py-3.5 pr-3">
                  <span className={badge.className}>{badge.label}</span>
                </td>
                <td className="py-3.5 pr-3 font-mono text-xs tabular-nums text-stardust">
                  {formatDay(d.last_change_ts ?? d.last_seen_ts)}
                </td>
                <td className="py-3.5 pr-3 font-mono tabular-nums">{d.observer_count}</td>
                <td className="py-3.5">
                  {d.open_flags.count === 0 ? (
                    <span className="text-stardust/50">—</span>
                  ) : (
                    <span title={d.open_flags.kinds.join(', ')} className="badge-disputed">
                      {d.open_flags.count}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LiveChangesPanel({
  field,
  query,
}: {
  field: 'deadline' | 'amount';
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchChanges>>>>;
}): React.ReactElement {
  if (query.isLoading) return <Loading label="Running live Arkiv query…" />;
  if (query.isError) return <ErrorBox error={query.error} />;
  const data = query.data;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-btc/30 bg-btc/5 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-widest text-btc">
          <span className="live-dot" aria-hidden />
          Live Arkiv query
        </p>
        <pre className="mt-2 overflow-x-auto font-mono text-[11px] text-stardust">
          {JSON.stringify({ source: data?.source, where: data?.where, post_filter: data?.post_filter }, null, 2)}
        </pre>
      </div>
      {(data?.items.length ?? 0) === 0 ? (
        <Empty>No {field} changes in the last 30 days on Arkiv.</Empty>
      ) : (
        <ul className="divide-y divide-white/5">
          {data?.items.map((item) => (
            <li key={item.key} className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm">
              <span className="font-mono text-xs text-white">{String(item.attributes.notice_id ?? item.key)}</span>
              <span className="font-mono text-xs text-stardust">
                {formatWhen(Number(item.attributes.observed_at) || null)}
              </span>
              <a href={item.explorer_url} target="_blank" rel="noreferrer" className="font-mono text-xs no-underline">
                Explorer
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}
