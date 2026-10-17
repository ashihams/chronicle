import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

/**
 * Explorer deep links. The explorer is a single-page app that answers 200 for every path, so these
 * formats are unconfirmed (HUMAN item in PROGRESS.md).
 */
export function explorerLinks(base: string): {
  entity(key: string): string;
  tx(hash: string): string;
  address(addr: string): string;
} {
  const b = base.replace(/\/+$/, '');
  return {
    entity: (key) => `${b}/entity/${key}`,
    tx: (hash) => `${b}/tx/${hash}`,
    address: (addr) => `${b}/address/${addr}`,
  };
}

/** Fixed-window request counter per client, e.g. 60 requests per minute per IP. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /** Records a request; returns the seconds to wait when over the limit, else 0. */
  hit(client: string): number {
    const now = this.nowMs();
    if (this.windows.size > 10_000) {
      for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
    }
    const w = this.windows.get(client);
    if (w === undefined || now - w.start >= this.windowMs) {
      this.windows.set(client, { start: now, count: 1 });
      return 0;
    }
    w.count += 1;
    return w.count > this.max ? Math.ceil((w.start + this.windowMs - now) / 1000) : 0;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export interface StaticFile {
  body: Buffer;
  contentType: string;
}

/**
 * Resolves a URL path inside the web build. Unknown paths fall back to `index.html` (SPA routing);
 * paths that escape the build directory are refused.
 */
export function resolveStatic(root: string, urlPath: string): StaticFile | null {
  const base = resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }
  const target = resolve(join(base, normalize(decoded)));
  if (target !== base && !target.startsWith(base + sep)) return null;
  let file = target;
  if (!existsSync(file) || !statSync(file).isFile()) {
    file = join(base, 'index.html');
    if (!existsSync(file)) return null;
  }
  return {
    body: readFileSync(file),
    contentType: CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
  };
}
