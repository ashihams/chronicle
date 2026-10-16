export function Loading({ label = 'Loading…' }: { label?: string }): React.ReactElement {
  return (
    <p className="flex items-center gap-2 font-mono text-sm text-stardust" role="status">
      <span className="live-dot" aria-hidden />
      {label}
    </p>
  );
}

export function ErrorBox({ error }: { error: Error }): React.ReactElement {
  return (
    <div className="panel border-btc-burn/40 bg-btc-burn/10 p-4 text-sm text-white" role="alert">
      <p className="font-heading font-semibold text-btc">Something went wrong</p>
      <p className="mt-1 text-stardust">{error.message}</p>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="font-mono text-sm text-stardust">{children}</p>;
}
