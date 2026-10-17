import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Layout } from '../src/components/Layout';
import { DocPage } from '../src/pages/Doc';
import { HomePage } from '../src/pages/Home';
import { VerifyPage } from '../src/pages/Verify';

const DOC_ID = 'a'.repeat(64);

function json(data: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }),
  );
}

function renderApp(path: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="docs/:docId" element={<DocPage />} />
            <Route path="verify" element={<VerifyPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web smoke', () => {
  it('renders the home table from a seeded fake backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo) => {
        const url = String(input);
        if (url.startsWith('/api/health')) return json({ ok: true, lastSyncTs: 1, entityCount: 3, chainHead: 9 });
        if (url.startsWith('/api/watchers')) {
          return json({
            items: [
              {
                creator: '0xaa',
                vantages: ['test'],
                observation_count: 2,
                first_seen_ts: 1,
                last_seen_ts: 2,
                docs_covered: 1,
                explorer_url: '#',
              },
            ],
          });
        }
        if (url.includes('changed_since=')) return json({ total: 1, limit: 1, offset: 0, items: [] });
        if (url.startsWith('/api/docs')) {
          return json({
            total: 1,
            limit: 100,
            offset: 0,
            items: [
              {
                doc_id: DOC_ID,
                notice_id: 'demo-001',
                title: 'Demo merit scholarship',
                source_url: 'https://example.test/1',
                source_kind: 'page',
                department: 'demo-dept',
                scheme: 'demo-scheme',
                current_state: 'changed',
                current_seq: 2,
                last_change_ts: 1_760_000_100,
                last_seen_ts: 1_760_000_100,
                observer_count: 2,
                open_flags: { count: 0, kinds: [] },
                current_version: { seq: 2, deadline_ts: null, amount_paise: null, summary_en: 'Deadline moved.' },
              },
            ],
          });
        }
        return json({ error: 'missing stub', code: 'not_found' }, 404);
      }),
    );

    renderApp('/');
    expect(screen.getByRole('heading', { name: /public memory for records that change/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Demo merit scholarship' })).toBeInTheDocument());
    expect(screen.getByText('Changed')).toBeInTheDocument();
    expect(screen.getAllByText('demo-dept').length).toBeGreaterThan(0);
  });

  it('renders a doc timeline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo) => {
        const url = String(input);
        if (url === `/api/docs/${DOC_ID}`) {
          return json({
            doc: {
              doc_id: DOC_ID,
              notice_id: 'demo-001',
              title: 'Demo merit scholarship',
              source_url: null,
              department: 'demo-dept',
              doc_entity_url: null,
            },
            status: { current_state: 'changed', current_seq: 2, last_seen_ts: 2, last_change_ts: 2, removed: false },
            versions: [
              {
                seq: 1,
                normalizer_version: 'n1',
                norm_sha256: 'b'.repeat(64),
                first_seen_ts: 1,
                observer_count: 1,
                status: 'superseded',
                summary_en: 'First',
                deadline_ts: null,
                amount_paise: null,
              },
              {
                seq: 2,
                normalizer_version: 'n1',
                norm_sha256: 'c'.repeat(64),
                first_seen_ts: 2,
                observer_count: 1,
                status: 'current',
                summary_en: 'Deadline moved.',
                deadline_ts: null,
                amount_paise: null,
              },
            ],
            flags: [],
            observers: [],
            observation_count: 2,
          });
        }
        if (url === `/api/docs/${DOC_ID}/timeline`) {
          return json({
            doc_id: DOC_ID,
            events: [
              {
                kind: 'observation',
                ts: 1,
                state: 'first_seen',
                creator: '0xabc',
                owner: '0xabc',
                summary_en: 'First look',
                vantage: 'test',
                created_ts: 1,
                observed_at: 1,
                norm_sha256: 'b'.repeat(64),
                explorer_url: '#',
              },
              { kind: 'version', ts: 1, label: 'version 1 first seen', seq: 1 },
              {
                kind: 'observation',
                ts: 2,
                state: 'changed',
                creator: '0xabc',
                owner: '0xabc',
                summary_en: 'Deadline moved.',
                vantage: 'test',
                created_ts: 2,
                observed_at: 2,
                norm_sha256: 'c'.repeat(64),
                explorer_url: '#',
              },
            ],
          });
        }
        return json({ error: 'missing stub', code: 'not_found' }, 404);
      }),
    );

    renderApp(`/docs/${DOC_ID}`);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Demo merit scholarship' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Timeline' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('version 1 first seen')).toBeInTheDocument());
    expect(screen.getAllByText('Deadline moved.').length).toBeGreaterThan(0);
  });

  it('verify page returns exact_match for seeded text and no_match otherwise', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo, init?: RequestInit) => {
        if (String(input) !== '/api/match') return json({ error: 'no', code: 'not_found' }, 404);
        const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
        if (body.text?.includes('seeded notice body')) {
          return json({
            result: 'exact_match',
            match: {
              doc_id: DOC_ID,
              title: 'Seeded',
              department: 'demo-dept',
              version_seq: 1,
              current_seq: 1,
              status: 'current',
              superseded_at: null,
              observer_count: 1,
              changes_since: [],
              timeline_url: `/docs/${DOC_ID}`,
            },
            note: 'Matches version 1, which is the current version.',
            forgery_reports: { distinct_creators: 0, reason_codes: [], note: null },
          });
        }
        return json({
          result: 'no_match',
          match: null,
          note: 'No exact match. Treat as unverified. This does not mean it is forged.',
          forgery_reports: { distinct_creators: 0, reason_codes: [], note: null },
        });
      }),
    );

    renderApp('/verify');
    expect(screen.getByText(/processed in memory/i)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/paste the full notice/i), 'seeded notice body for the test');
    await user.click(screen.getByRole('button', { name: /check text/i }));
    await waitFor(() =>
      expect(screen.getByText(/Matches version 1, which is the current version/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/^Exact match$/i)).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText(/paste the full notice/i));
    await user.type(screen.getByPlaceholderText(/paste the full notice/i), 'unrelated paste');
    await user.click(screen.getByRole('button', { name: /check text/i }));
    await waitFor(() => expect(screen.getByText(/No exact match/i)).toBeInTheDocument());
    expect(screen.getByText(/^No match$/i)).toBeInTheDocument();
  });
});
