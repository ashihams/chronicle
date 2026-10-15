import { sha256Hex } from '../hash.js';

/**
 * Patterns for content that changes on every request (counters, timestamps, session tokens).
 * They are matched per line, before whitespace is collapsed, so `[^.\n]*` stops at a line break.
 * Changing this list changes hashes: bump NORMALIZER_VERSION.
 */
export const VOLATILE_PATTERNS: readonly RegExp[] = [
  /last updated[^.\n]*/gi,
  /visitors?[^.\n]*\d+/gi,
  /page (hits|views)[^.\n]*/gi,
  /printed on[^.\n]*/gi,
  /timestamp\W{0,3}\d{10}(\d{3})?\b/gi,
  /\b\d{10}(\d{3})?\W{0,3}timestamp/gi,
  /session[-_ ]?id\s*[:=]\s*\S+/gi,
  /csrf\S*/gi,
];

export interface NormalizeTextOptions {
  volatilePatterns?: readonly RegExp[];
}

/** NFKC, drop volatile patterns, collapse whitespace, trim, lowercase. */
export function normalizeText(raw: string, opts: NormalizeTextOptions = {}): string {
  let text = raw.normalize('NFKC').replace(/\r\n?/g, '\n');
  for (const re of opts.volatilePatterns ?? VOLATILE_PATTERNS) {
    const global = re.global ? re : new RegExp(re.source, `${re.flags}g`);
    text = text.replace(global, ' ');
  }
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Hash of normalized text, as stored in `norm_sha256`. */
export function normHash(normalizedText: string): string {
  return sha256Hex(normalizedText);
}
