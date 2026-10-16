import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeArkivClient, FakeArkivNetwork, normalizePdf, normalizeText, normHash } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { buildApi } from '../src/api.js';
import { IndexerDb } from '../src/db.js';
import { DOC_ID, T0, silentLog } from './helpers.js';

// file bytes may change from SQLite bookkeeping; we assert content + marker absence

/**
 * `/api/match` must not persist uploads or pasted text in SQLite, and poppler temp PDFs
 * must be deleted after normalizePdf (used by the match path).
 */
describe('/api/match persistence', () => {
  it('does not write match text into the indexer DB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-match-db-'));
    const dbPath = join(dir, 'indexer.db');
    const db = new IndexerDb(dbPath);
    const marker = `UNIQUE_MATCH_MARKER_${Date.now()}_user@example.test_chat_room`;
    const text = `Synthetic circular line.\n${marker}\n`;
    const hash = normHash(normalizeText(text));

    db.upsertDoc({
      docId: DOC_ID,
      noticeId: 'n1',
      sourceUrl: 'https://example.test/a',
      sourceKind: 'page',
      department: 'demo-dept',
      scheme: null,
      lang: 'en',
      title: 't',
      docEntityKey: null,
    });
    db.replaceVersions(DOC_ID, [
      {
        docId: DOC_ID,
        normalizerVersion: 'n1',
        seq: 1,
        normSha256: hash,
        firstSeenBlock: 1,
        firstSeenTs: T0,
        firstEntityKey: '0x1',
        observerCount: 1,
        status: 'current',
        deadlineTs: null,
        amountPaise: null,
        summaryEn: 'First.',
      },
    ]);

    const versionsBefore = db.versionsForDoc(DOC_ID).map((v) => ({ ...v }));
    const docsBefore = db.listDocs({ limit: 50, offset: 0 });

    const app = await buildApi({
      db,
      arkiv: new FakeArkivClient(undefined, new FakeArkivNetwork()),
      explorerBase: 'https://explorer.example.test',
      log: silentLog,
      chainId: 7738577,
      rpcHttp: 'https://rpc.example.test',
      now: () => T0,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/match',
        headers: { 'content-type': 'application/json' },
        payload: { text },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ result: 'exact_match' });
    } finally {
      await app.close();
    }

    // Mirror rows unchanged; request body never lands in SQLite (file may still touch headers).
    expect(db.versionsForDoc(DOC_ID)).toEqual(versionsBefore);
    expect(db.listDocs({ limit: 50, offset: 0 })).toEqual(docsBefore);
    db.close();
    const after = readFileSync(dbPath);
    expect(after.includes(marker)).toBe(false);
  });

  it('removes chronicle-*.pdf temp files after normalizePdf', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'chronicle-match-pdf-'));
    const pdfBytes = new Uint8Array(Buffer.from('%PDF-1.4\n%FAKE\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'));
    await normalizePdf(pdfBytes, {
      tmpDir: tmp,
      exec: async (cmd) => {
        if (cmd === 'pdftotext') return '';
        if (cmd === 'pdfinfo') return 'Producer: test\n';
        return '';
      },
    });
    const leftover = readdirSync(tmp).filter((f) => f.startsWith('chronicle-') && f.endsWith('.pdf'));
    expect(leftover).toEqual([]);
  });
});
