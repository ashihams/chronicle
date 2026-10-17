/**
 * Stretch S3: parse `pdfsig` output. Chain-of-trust is out of scope — we only classify
 * signature intact / modified / invalid / unsigned, and take organization from the DN `O=` field.
 */

export const SIG_STATUSES = ['signed_valid', 'signed_modified', 'signed_invalid', 'unsigned'] as const;
export type SigStatus = (typeof SIG_STATUSES)[number];

export interface PdfSignatureInfo {
  status: SigStatus;
  /** Issuer organization only (`O=` from the DN). Never a personal CN. */
  signerOrg: string | null;
}

const ORG_RE = /(?:^|[,\/]\s*|:\s*)O\s*=\s*([^,\/]+)/i;

/**
 * Extracts the organization component from a Distinguished Name or similar field.
 * Returns null when only a personal-looking Common Name is present.
 */
export function orgFromDn(text: string): string | null {
  const m = ORG_RE.exec(text);
  if (m?.[1] === undefined) return null;
  const org = m[1].replace(/\s+/g, ' ').trim();
  return org === '' ? null : org;
}

/** Parses stdout (and stderr-like text) from poppler `pdfsig`. */
export function parsePdfSig(output: string): PdfSignatureInfo {
  const text = output.replace(/\r\n/g, '\n');
  if (
    /does not contain any (digital )?signatures/i.test(text) ||
    /no digital signature/i.test(text) ||
    /File '.*' does not contain/i.test(text)
  ) {
    return { status: 'unsigned', signerOrg: null };
  }

  let status: SigStatus = 'signed_invalid';
  if (/Document has been altered|modified after (it was )?sign|Signature has been modified/i.test(text)) {
    status = 'signed_modified';
  } else if (/Signature is Valid|Signature Validation:\s*Valid/i.test(text)) {
    status = 'signed_valid';
  } else if (/Signature is Invalid|Signature Validation:\s*Invalid|not valid/i.test(text)) {
    status = 'signed_invalid';
  } else if (/Signature #?\s*\d/i.test(text) || /Signer Certificate/i.test(text)) {
    // Presence of a signature block without a clear verdict → treat as invalid for safety.
    status = 'signed_invalid';
  } else {
    return { status: 'unsigned', signerOrg: null };
  }

  let signerOrg: string | null = null;
  for (const line of text.split('\n')) {
    if (/Distinguished Name|Signer Certificate|Organization/i.test(line)) {
      const org = orgFromDn(line);
      if (org !== null) {
        signerOrg = org;
        break;
      }
    }
  }
  return { status, signerOrg };
}

/** Producers treated as online / consumer editors for soft metadata flags. */
export const ONLINE_PDF_EDITORS = [
  'ilovepdf',
  'smallpdf',
  'sejda',
  'pdf24',
  'camscanner',
  'genius scan',
  'pdfcandy',
  'sodapdf',
  'pdfescape',
  'pdf filler',
  'pdffiller',
  'hipdf',
  'lightpdf',
  'pdf2go',
] as const;

export function isOnlinePdfEditor(producer: string | null | undefined): boolean {
  if (producer === null || producer === undefined || producer.trim() === '') return false;
  const p = producer.toLowerCase();
  return ONLINE_PDF_EDITORS.some((name) => p.includes(name));
}

/** True when PDF CreationDate is more than `days` after the printed date (both unix seconds). */
export function pdfCreatedAfterPrinted(pdfCreatedTs: number, printedDateTs: number, days = 30): boolean {
  return pdfCreatedTs > printedDateTs + days * 86400;
}
