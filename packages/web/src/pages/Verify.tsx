import { useState } from 'react';
import { Link } from 'react-router-dom';
import { matchFile, matchText, type MatchResponse } from '../api';
import { ErrorBox, Loading } from '../components/Status';
import { formatDay } from '../format';

export function VerifyPage(): React.ReactElement {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<MatchResponse | null>(null);

  async function run(kind: 'text' | 'file'): Promise<void> {
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const res =
        kind === 'file'
          ? await matchFile(
              file ??
                (() => {
                  throw new Error('Choose a PDF first');
                })(),
            )
          : await matchText(text);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-btc">Verifier</p>
        <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
          Verify a <span className="text-gradient-gold">copy</span>
        </h1>
        <p className="mt-4 leading-relaxed text-stardust">
          Paste the full text of a notice, or upload a PDF. Chronicle normalizes it in memory, hashes it, and looks for
          an exact match among mirrored versions. Nothing you submit is stored or written to the database.
        </p>
        <p className="mt-2 text-sm text-stardust/80">
          Exact matching works best for the same PDF or complete pasted text. Short WhatsApp excerpts often differ in
          formatting and will not match.
        </p>
      </header>

      <section className="panel space-y-5 p-5 sm:p-6">
        <label className="block">
          <span className="label">Paste text</span>
          <textarea
            className="field min-h-[10rem] !h-auto font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the full notice text…"
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={pending || text.trim() === ''}
          onClick={() => void run('text')}
        >
          Check text
        </button>

        <div className="border-t border-white/10 pt-5">
          <label className="block">
            <span className="label">Or upload a PDF</span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              className="field !h-auto cursor-pointer py-3 file:mr-3 file:rounded-full file:border-0 file:bg-btc/20 file:px-3 file:py-1 file:font-mono file:text-xs file:text-btc"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button
            type="button"
            className="btn-primary mt-4"
            disabled={pending || file === null}
            onClick={() => void run('file')}
          >
            Check PDF
          </button>
        </div>

        <p className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-[11px] leading-relaxed text-stardust">
          Privacy: processed in memory on the indexer, not stored. Poppler may write a temporary file for PDF text
          extraction that is deleted before the response returns.
        </p>
      </section>

      {pending ? <Loading label="Checking…" /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {result ? <ResultCard result={result} /> : null}
    </div>
  );
}

function ResultCard({ result }: { result: MatchResponse }): React.ReactElement {
  const match = result.match;
  const ok = result.result === 'exact_match';
  return (
    <section className={`panel p-5 sm:p-6 ${ok ? 'border-btc/40 shadow-glow' : 'border-white/15'}`} aria-live="polite">
      <p className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-widest text-stardust">
        {ok ? <span className="live-dot" aria-hidden /> : null}
        <span>{ok ? 'Exact match' : 'No match'}</span>
      </p>
      <p className="mt-3 font-heading text-xl text-white">{result.note}</p>
      {match ? (
        <div className="mt-5 space-y-2 text-sm text-stardust">
          <p>
            <span className="text-stardust/70">Document </span>
            <Link className="font-heading font-semibold text-btc no-underline" to={match.timeline_url}>
              {match.title || match.doc_id.slice(0, 12)}
            </Link>
            {match.department ? <span> · {match.department}</span> : null}
          </p>
          <p className="font-mono text-xs">
            Matched version {match.version_seq}
            {match.status === 'superseded' && match.superseded_at
              ? ` (superseded ${formatDay(match.superseded_at)})`
              : ' (current)'}
            {match.current_seq !== null ? ` · current is v${match.current_seq}` : null}
          </p>
          {match.changes_since.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5">
              {match.changes_since.map((c) => (
                <li key={c.seq}>
                  v{c.seq} · {formatDay(c.first_seen_ts)} · {c.summary_en || 'No summary'}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
