import { useQuery } from '@tanstack/react-query';
import { fetchWatchers } from '../api';
import { CopyButton } from '../components/CopyButton';
import { Empty, ErrorBox, Loading } from '../components/Status';
import { formatWhen, shortHex } from '../format';

export function WatchersPage(): React.ReactElement {
  const q = useQuery({ queryKey: ['watchers'], queryFn: fetchWatchers });

  return (
    <div className="space-y-8">
      <header className="max-w-3xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-btc">Network</p>
        <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">Watchers</h1>
        <p className="mt-4 rounded-xl border border-btc-gold/30 bg-btc-gold/5 px-4 py-3 text-sm leading-relaxed text-btc-gold/90">
          More watchers means more corroboration, not proof of truth. Several wallets can belong to one person.
        </p>
      </header>

      {q.isLoading ? (
        <Loading label="Loading watchers…" />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (q.data?.items.length ?? 0) === 0 ? (
        <Empty>No watchers have written observations yet.</Empty>
      ) : (
        <div className="panel overflow-x-auto p-2 sm:p-4">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="border-b border-white/10 font-mono text-[11px] uppercase tracking-widest text-stardust">
              <tr>
                <th className="py-3 pr-3 font-medium">Creator</th>
                <th className="py-3 pr-3 font-medium">Vantages</th>
                <th className="py-3 pr-3 font-medium">Observations</th>
                <th className="py-3 pr-3 font-medium">Docs</th>
                <th className="py-3 pr-3 font-medium">First seen</th>
                <th className="py-3 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.items.map((w) => (
                <tr key={w.creator} className="border-b border-white/5 hover:bg-white/[0.03]">
                  <td className="py-3.5 pr-3">
                    <span className="font-mono text-xs text-white">{shortHex(w.creator, 8, 6)}</span>
                    <CopyButton value={w.creator} />
                    <a
                      href={w.explorer_url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 font-mono text-xs no-underline"
                    >
                      Explorer
                    </a>
                  </td>
                  <td className="py-3.5 pr-3 text-stardust">{w.vantages.join(', ') || '—'}</td>
                  <td className="py-3.5 pr-3 font-mono tabular-nums">{w.observation_count}</td>
                  <td className="py-3.5 pr-3 font-mono tabular-nums">{w.docs_covered}</td>
                  <td className="py-3.5 pr-3 font-mono text-[11px] text-stardust">{formatWhen(w.first_seen_ts)}</td>
                  <td className="py-3.5 font-mono text-[11px] text-stardust">{formatWhen(w.last_seen_ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
