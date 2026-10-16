export function AboutPage(): React.ReactElement {
  return (
    <article className="mx-auto max-w-2xl space-y-8 text-stardust">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-btc">About</p>
        <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl">About Chronicle</h1>
      </header>

      <section className="panel space-y-3 p-5 sm:p-6">
        <h2 className="font-heading text-xl font-semibold text-white">What it proves</h2>
        <p className="leading-relaxed">
          That one or more watchers fetched a public URL, saw a particular normalized hash (or a removal), and wrote
          that claim to Arkiv with a chain-verified creation time, creator address, and vantage label.
        </p>
      </section>

      <section className="panel space-y-3 p-5 sm:p-6">
        <h2 className="font-heading text-xl font-semibold text-white">What it does not prove</h2>
        <ul className="list-disc space-y-2 pl-5 leading-relaxed">
          <li>That a notice is authentic, authorized, or legally binding.</li>
          <li>Why a page changed, who ordered the change, or whether a change was proper.</li>
          <li>That disagreeing watchers are independent people (several wallets can be one operator).</li>
        </ul>
      </section>

      <section className="panel space-y-3 p-5 sm:p-6">
        <h2 className="font-heading text-xl font-semibold text-white">What stays off Arkiv</h2>
        <p className="leading-relaxed">
          Full document text, personal data, Telegram chat content, and user uploads for verification. Arkiv holds
          hashes, short summaries, and extracted fields such as deadlines. The indexer SQLite cache is derived and
          recomputable.
        </p>
      </section>

      <section className="panel space-y-3 p-5 sm:p-6">
        <h2 className="font-heading text-xl font-semibold text-white">Limitations</h2>
        <p className="leading-relaxed">
          This build runs on the Arkiv Tiramisu testnet. Entities expire unless renewed. Exact verify matching needs the
          same PDF or complete pasted text; partial forwards often will not match. Explorer deep-link formats are
          best-effort.
        </p>
      </section>

      <section className="panel space-y-3 p-5 sm:p-6">
        <h2 className="font-heading text-xl font-semibold text-white">Links</h2>
        <ul className="list-disc space-y-2 pl-5 leading-relaxed">
          <li>
            <a href="https://github.com/ashihams/chronicle" target="_blank" rel="noreferrer">
              Source repository
            </a>
          </li>
          <li>
            <a href="https://github.com/ashihams/chronicle/blob/main/arkiv/schema.md" target="_blank" rel="noreferrer">
              arkiv/schema.md
            </a>
          </li>
          <li>
            Run a watcher: set <code className="font-mono text-xs text-btc">WATCHER_PRIVATE_KEY</code>, point{' '}
            <code className="font-mono text-xs text-btc">WATCHLIST_PATH</code> at enabled sources, then{' '}
            <code className="font-mono text-xs text-btc">pnpm --filter watcher start</code>.
          </li>
        </ul>
      </section>
    </article>
  );
}
