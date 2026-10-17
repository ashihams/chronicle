import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/hash.js';
import {
  execTool,
  hasPdfHeader,
  normalizePdf,
  parsePdfInfo,
  PopplerMissingError,
  type ExecTool,
} from '../src/normalize/pdf.js';
import { scannedPdf, textPdf } from './helpers/pdf.js';

const popplerInstalled = await execTool('pdftotext', ['-v'], 5000).then(
  () => true,
  (err: unknown) => !(err instanceof PopplerMissingError),
);
// CI installs poppler-utils, so a missing binary there must fail instead of skipping.
const runPoppler = popplerInstalled || process.env.CI === 'true';

const NOTICE = [
  'SYNTHETIC DEMONSTRATION NOTICE',
  'Demo Department of Synthetic Affairs',
  'The last date to apply is 30 October 2026.',
  'The scholarship amount is Rs. 1,500 per month.',
];

async function leftoverTempFiles(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((f) => f.startsWith('chronicle-') && f.endsWith('.pdf'));
}

describe.runIf(runPoppler)('normalizePdf with poppler', () => {
  it('extracts and normalizes text and reads metadata', async () => {
    const before = await leftoverTempFiles();
    const r = await normalizePdf(await textPdf(NOTICE));
    expect(r.textExtracted).toBe(true);
    expect(r.text).toContain('the last date to apply is 30 october 2026.');
    expect(r.text).toBe(r.text.toLowerCase());
    expect(r.normSha256).toBe(sha256Hex(r.text));
    expect(r.meta).toEqual({
      producer: 'Synthetic Producer 1.0',
      creator: 'Chronicle test fixture',
      creationTs: Date.UTC(2026, 8, 1, 10) / 1000,
      modTs: Date.UTC(2026, 8, 2, 11, 30) / 1000,
    });
    expect(await leftoverTempFiles()).toEqual(before);
  });

  it('gives the same hash for the same text with different metadata', async () => {
    const a = await normalizePdf(await textPdf(NOTICE, 'Producer A'));
    const b = await normalizePdf(await textPdf(NOTICE, 'Producer B'));
    expect(a.normSha256).toBe(b.normSha256);
  });

  it('gives a different hash when the deadline changes', async () => {
    const a = await normalizePdf(await textPdf(NOTICE));
    const changed = NOTICE.map((l) => l.replace('30 October', '20 October'));
    const b = await normalizePdf(await textPdf(changed));
    expect(a.normSha256).not.toBe(b.normSha256);
  });

  it('treats a PDF without a text layer as scanned and hashes the raw bytes', async () => {
    const bytes = await scannedPdf();
    const r = await normalizePdf(bytes);
    expect(r.textExtracted).toBe(false);
    expect(r.normSha256).toBe(sha256Hex(bytes));
  });

  it('treats bytes poppler cannot read as scanned', async () => {
    const bytes = new TextEncoder().encode('<html>not a pdf</html>');
    const r = await normalizePdf(bytes);
    expect(r.textExtracted).toBe(false);
    expect(r.normSha256).toBe(sha256Hex(bytes));
    expect(r.meta.producer).toBeNull();
  });
});

describe('normalizePdf with a stubbed poppler', () => {
  const bytes = new TextEncoder().encode('%PDF-1.7 stub');

  it('passes the right arguments and uses the stub output', async () => {
    const calls: string[][] = [];
    const exec: ExecTool = async (cmd, args) => {
      calls.push([cmd, ...args.filter((a) => !a.endsWith('.pdf'))]);
      if (cmd === 'pdftotext') return 'Stub   TEXT '.repeat(10);
      return 'Producer: Stub\nCreationDate: 2026-01-02T03:04:05+05:30\n';
    };
    const r = await normalizePdf(bytes, { exec });
    expect(calls).toEqual([
      ['pdftotext', '-enc', 'UTF-8', '-'],
      ['pdfinfo', '-isodates', '-enc', 'UTF-8'],
      ['pdfsig'],
    ]);
    expect(r.textExtracted).toBe(true);
    expect(r.meta.producer).toBe('Stub');
    expect(r.meta.creationTs).toBe(Date.UTC(2026, 0, 1, 21, 34, 5) / 1000);
    expect(r.signature).toEqual({ status: 'unsigned', signerOrg: null });
  });

  it('parses pdfsig output into signature extras', async () => {
    const exec: ExecTool = async (cmd) => {
      if (cmd === 'pdftotext') return 'Stub   TEXT '.repeat(10);
      if (cmd === 'pdfinfo') return 'Producer: Stub\n';
      if (cmd === 'pdfsig') {
        return [
          'Signature #1',
          '  - Signer Certificate Distinguished Name: O=Demo Org, C=IN',
          '  - Signature Validation: Signature is Valid.',
        ].join('\n');
      }
      return '';
    };
    const r = await normalizePdf(bytes, { exec });
    expect(r.signature).toEqual({ status: 'signed_valid', signerOrg: 'Demo Org' });
  });

  it('leaves unsigned when pdfsig is missing', async () => {
    const exec: ExecTool = async (cmd) => {
      if (cmd === 'pdfsig') throw new PopplerMissingError(cmd);
      if (cmd === 'pdftotext') return 'Stub   TEXT '.repeat(10);
      return 'Producer: Stub\n';
    };
    const r = await normalizePdf(bytes, { exec });
    expect(r.signature.status).toBe('unsigned');
  });

  it('rethrows a missing poppler binary', async () => {
    const exec: ExecTool = async (cmd) => {
      throw new PopplerMissingError(cmd);
    };
    await expect(normalizePdf(bytes, { exec })).rejects.toBeInstanceOf(PopplerMissingError);
  });

  it('rethrows a missing pdfinfo after pdftotext succeeded', async () => {
    const exec: ExecTool = async (cmd) => {
      if (cmd === 'pdfinfo') throw new PopplerMissingError(cmd);
      return 'text';
    };
    await expect(normalizePdf(bytes, { exec })).rejects.toThrow(/pdfinfo was not found/);
  });

  it('keeps going when pdfinfo fails on a bad file', async () => {
    const exec: ExecTool = async (cmd) => {
      if (cmd === 'pdfinfo') throw new Error('Syntax Error');
      return 'x'.repeat(60);
    };
    const r = await normalizePdf(bytes, { exec });
    expect(r.textExtracted).toBe(true);
    expect(r.meta).toEqual({ producer: null, creator: null, creationTs: null, modTs: null });
  });

  it('reports a missing binary from execTool', async () => {
    await expect(execTool('chronicle-no-such-binary', [], 1000)).rejects.toBeInstanceOf(PopplerMissingError);
  });
});

describe('parsePdfInfo', () => {
  it('reads fields and ignores bad dates and empty values', () => {
    expect(parsePdfInfo('Producer:   \nCreator: Writer 2\nCreationDate: garbage\nPages: 1\r\n')).toEqual({
      producer: null,
      creator: 'Writer 2',
      creationTs: null,
      modTs: null,
    });
  });
});

describe('hasPdfHeader', () => {
  it('finds the header in the first KB', () => {
    expect(hasPdfHeader(new TextEncoder().encode('%PDF-1.4\n...'))).toBe(true);
    expect(hasPdfHeader(new TextEncoder().encode('\n\n%PDF-1.4'))).toBe(true);
    expect(hasPdfHeader(new TextEncoder().encode('<!doctype html>'))).toBe(false);
  });
});
