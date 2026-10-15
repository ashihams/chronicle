import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { DemoState, MutateBody, MutationError, type Notice } from './notices.js';
import { renderNoticePdf } from './pdf.js';
import { SOFT_REMOVED_MESSAGE, renderAdmin, renderIndex, renderMessage, renderNotice } from './render.js';

export const VANTAGE_HEADER = 'x-chronicle-vantage';
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

export interface DemoAppOptions {
  adminToken: string;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
  logger?: boolean | { level: string };
}

function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const HTML = 'text/html; charset=utf-8';

export function buildDemoApp(opts: DemoAppOptions): { app: FastifyInstance; state: DemoState } {
  const now = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  const state = new DemoState(now);
  const app = Fastify({
    logger: opts.logger ?? false,
    ignoreTrailingSlash: true,
    bodyLimit: 16 * 1024,
  });

  // Non-JSON bodies are read (within bodyLimit) and ignored, so a bare POST from any client works
  // for /admin/reset and a form-encoded mutate gets a 400 from validation instead of a 415.
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, _body, done) => done(null, undefined));

  const volatile = (): { visitors: number; now: number } => ({ visitors: state.nextVisitor(), now: now() });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-demo-notice', 'synthetic demonstration content');
  });

  const sendMessage = (reply: FastifyReply, code: number, heading: string, message: string): FastifyReply =>
    reply
      .code(code)
      .type(HTML)
      .send(renderMessage(heading, message, volatile()));

  /** Applies removal, redirect and vantage rules shared by the HTML and PDF routes. */
  const gate = (req: FastifyRequest, reply: FastifyReply, n: Notice | undefined): Notice | null => {
    if (!n) {
      void sendMessage(reply, 404, 'Not found', 'No such circular on this synthetic demo site.');
      return null;
    }
    const vantage = req.headers[VANTAGE_HEADER];
    if (typeof vantage === 'string' && n.hiddenFromVantages.includes(vantage.trim().toLowerCase())) {
      void sendMessage(reply, 404, 'Not found', 'No such circular on this synthetic demo site.');
      return null;
    }
    switch (n.status) {
      case 'removed_404':
        void sendMessage(reply, 404, 'Not found', 'No such circular on this synthetic demo site.');
        return null;
      case 'removed_410':
        void sendMessage(
          reply,
          410,
          'Gone',
          'This circular has been permanently removed from the synthetic demo site.',
        );
        return null;
      case 'redirected':
        void reply.redirect('/circulars/', 302);
        return null;
      case 'soft_removed':
        void sendMessage(reply, 200, 'Notice unavailable', SOFT_REMOVED_MESSAGE);
        return null;
      case 'live':
        return n;
    }
  };

  app.get('/', async (_req, reply) => reply.redirect('/circulars/', 302));

  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nAllow: /\n'));

  app.get('/circulars', async (_req, reply) =>
    reply.type(HTML).send(
      renderIndex(
        state.list().filter((n) => !n.delisted),
        volatile(),
      ),
    ),
  );

  app.get<{ Params: { file: string } }>('/circulars/:file', async (req, reply) => {
    const m = /^(\d{3})(\.pdf)?$/.exec(req.params.file);
    const n = gate(req, reply, m?.[1] ? state.get(m[1]) : undefined);
    if (!n) return reply;
    reply.header('last-modified', new Date(n.updatedAt * 1000).toUTCString());
    if (m?.[2]) return reply.type('application/pdf').send(Buffer.from(await renderNoticePdf(n)));
    return reply.type(HTML).send(renderNotice(n, volatile()));
  });

  app.get('/admin', async (_req, reply) => reply.type(HTML).send(renderAdmin()));

  const requireToken = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!tokenMatches(opts.adminToken, req.headers[ADMIN_TOKEN_HEADER])) {
      await reply.code(401).send({ ok: false, error: 'missing or wrong x-admin-token' });
    }
  };

  app.get('/admin/state', { preHandler: requireToken }, async () => ({ ok: true, ...state.snapshot() }));

  app.post('/admin/reset', { preHandler: requireToken }, async () => {
    state.reset();
    return { ok: true };
  });

  app.post('/admin/mutate', { preHandler: requireToken }, async (req, reply) => {
    const parsed = MutateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    try {
      return { ok: true, notice: state.mutate(parsed.data) };
    } catch (err) {
      if (err instanceof MutationError) return reply.code(err.statusCode).send({ ok: false, error: err.message });
      throw err;
    }
  });

  return { app, state };
}
