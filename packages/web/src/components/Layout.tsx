import { NavLink, Outlet } from 'react-router-dom';

const links = [
  { to: '/', label: 'Home', end: true },
  { to: '/verify', label: 'Verify' },
  { to: '/watchers', label: 'Watchers' },
  { to: '/about', label: 'About' },
];

export function Layout(): React.ReactElement {
  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[28rem] bg-grid-fade opacity-60" aria-hidden />
      <div
        className="pointer-events-none absolute -left-24 top-24 h-64 w-64 animate-float rounded-full bg-btc/10 blur-[120px]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute right-0 top-40 h-72 w-72 rounded-full bg-btc-gold/5 blur-[140px]"
        aria-hidden
      />

      <header className="relative z-10 border-b border-white/10 bg-void/70 backdrop-blur-lg">
        <div className="shell flex flex-wrap items-center justify-between gap-4 py-4">
          <NavLink to="/" className="group no-underline">
            <span className="font-heading text-2xl font-bold tracking-tight text-white transition group-hover:text-btc">
              Chronicle
            </span>
            <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-widest text-stardust group-hover:text-btc/80">
              public memory · arkiv
            </span>
          </NavLink>
          <nav className="flex flex-wrap items-center gap-1" aria-label="Primary">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) => (isActive ? 'nav-link-active' : 'nav-link')}
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="relative z-10 shell flex-1 py-10 sm:py-14">
        <Outlet />
      </main>

      <footer className="relative z-10 border-t border-white/10 py-6 text-center font-mono text-xs tracking-wide text-stardust">
        Demonstration build on Arkiv Tiramisu testnet. Not legal advice.
      </footer>
    </div>
  );
}
