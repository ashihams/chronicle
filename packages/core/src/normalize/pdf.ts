import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../hash.js';
import { normalizeText } from './text.js';

export const PDF_TOOL_TIMEOUT_MS = 30_000;
/** Below this many normalized characters a PDF is treated as scanned (image only). */
export const MIN_PDF_TEXT_CHARS = 50;

export interface PdfMeta {
  producer: string | null;
  creator: string | null;
  creationTs: number | null; // unix seconds
  modTs: number | null;
}

export interface NormalizedPdf {
  text: string;
  textExtracted: boolean;
  /** sha256 of the normalized text, or of the raw bytes when no text could be extracted. */
  normSha256: string;
  meta: PdfMeta;
}

/** Runs a poppler binary and resolves with stdout. Injectable so tests can stub poppler. */
export type ExecTool = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

export class PopplerMissingError extends Error {
  constructor(cmd: string) {
    super(`${cmd} was not found on PATH; install poppler-utils`);
    this.name = 'PopplerMissingError';
  }
}

export const execTool: ExecTool = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') reject(new PopplerMissingError(cmd));
          else reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });

export function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

function parseDate(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Parses `pdfinfo -isodates` output. */
export function parsePdfInfo(output: string): PdfMeta {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) fields.set(m[1].trim(), m[2].trim());
  }
  const text = (k: string): string | null => {
    const v = fields.get(k);
    return v === undefined || v === '' ? null : v;
  };
  return {
    producer: text('Producer'),
    creator: text('Creator'),
    creationTs: parseDate(fields.get('CreationDate')),
    modTs: parseDate(fields.get('ModDate')),
  };
}

const EMPTY_META: PdfMeta = { producer: null, creator: null, creationTs: null, modTs: null };

export interface NormalizePdfOptions {
  exec?: ExecTool;
  tmpDir?: string;
}

/**
 * Extracts and normalizes PDF text with poppler. A PDF that poppler cannot read, or whose text
 * is shorter than MIN_PDF_TEXT_CHARS, is treated as scanned: `textExtracted` is false and
 * `normSha256` falls back to the raw-bytes hash. Throws only when poppler is missing.
 */
export async function normalizePdf(bytes: Uint8Array, opts: NormalizePdfOptions = {}): Promise<NormalizedPdf> {
  const exec = opts.exec ?? execTool;
  const file = join(opts.tmpDir ?? tmpdir(), `chronicle-${randomUUID()}.pdf`);
  const rawSha = sha256Hex(bytes);
  await writeFile(file, bytes);
  try {
    let text = '';
    try {
      text = normalizeText(await exec('pdftotext', ['-enc', 'UTF-8', file, '-'], PDF_TOOL_TIMEOUT_MS));
    } catch (err) {
      if (err instanceof PopplerMissingError) throw err;
    }
    let meta = EMPTY_META;
    try {
      meta = parsePdfInfo(await exec('pdfinfo', ['-isodates', '-enc', 'UTF-8', file], PDF_TOOL_TIMEOUT_MS));
    } catch (err) {
      if (err instanceof PopplerMissingError) throw err;
    }
    const textExtracted = text.length >= MIN_PDF_TEXT_CHARS;
    return { text, textExtracted, normSha256: textExtracted ? sha256Hex(text) : rawSha, meta };
  } finally {
    await rm(file, { force: true });
  }
}
