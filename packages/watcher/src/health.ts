import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface HealthStatus {
  last_pass_ts: number | null;
  source_count: number;
  wallet_address: string | null;
  vantage: string;
}

export interface HealthServer {
  port: number;
  close(): Promise<void>;
}

/** `GET /health` returns the watcher status as JSON; everything else is 404. */
export async function startHealthServer(opts: {
  port: number;
  host?: string;
  status: () => HealthStatus;
}): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...opts.status() }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
