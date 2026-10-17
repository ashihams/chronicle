import { describe, expect, it } from 'vitest';
import {
  isOnlinePdfEditor,
  orgFromDn,
  parsePdfSig,
  pdfCreatedAfterPrinted,
} from '../src/pdf-sig.js';

describe('parsePdfSig', () => {
  it('classifies unsigned files', () => {
    expect(parsePdfSig("File 'x.pdf' does not contain any digital signatures")).toEqual({
      status: 'unsigned',
      signerOrg: null,
    });
  });

  it('classifies a valid signature and takes O= only', () => {
    const out = [
      'Digital Signature Info of: notice.pdf',
      'Signature #1',
      '  - Signer Certificate Common Name: Alice Example',
      '  - Signer Certificate Distinguished Name: CN=Alice Example, O=Demo Signing Authority, C=IN',
      '  - Signature Validation: Signature is Valid.',
    ].join('\n');
    expect(parsePdfSig(out)).toEqual({
      status: 'signed_valid',
      signerOrg: 'Demo Signing Authority',
    });
  });

  it('classifies modified-after-sign', () => {
    const out = [
      'Signature #1',
      '  - Signer Certificate Distinguished Name: O=City Council',
      '  - Signature Validation: Document has been altered or corrupted since it was signed',
    ].join('\n');
    expect(parsePdfSig(out)).toEqual({ status: 'signed_modified', signerOrg: 'City Council' });
  });

  it('classifies invalid without inventing an org from a personal CN', () => {
    const out = ['Signature #1', '  - Signer Certificate Common Name: Bob', '  - Signature is Invalid'].join(
      '\n',
    );
    expect(parsePdfSig(out)).toEqual({ status: 'signed_invalid', signerOrg: null });
  });
});

describe('orgFromDn', () => {
  it('reads O= and ignores bare CN', () => {
    expect(orgFromDn('CN=Alice, O=Demo Org, C=IN')).toBe('Demo Org');
    expect(orgFromDn('CN=Alice Only')).toBeNull();
  });
});

describe('metadata helpers', () => {
  it('detects known online editors', () => {
    expect(isOnlinePdfEditor('iLovePDF 2.0')).toBe(true);
    expect(isOnlinePdfEditor('LibreOffice 24')).toBe(false);
    expect(isOnlinePdfEditor(null)).toBe(false);
  });

  it('flags creation more than 30 days after printed date', () => {
    const printed = Date.UTC(2026, 0, 1) / 1000;
    expect(pdfCreatedAfterPrinted(printed + 31 * 86400, printed)).toBe(true);
    expect(pdfCreatedAfterPrinted(printed + 10 * 86400, printed)).toBe(false);
  });
});
