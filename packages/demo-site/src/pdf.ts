import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Notice } from './notices.js';
import { DEMO_LABEL, SITE_LABEL, formatInr } from './render.js';

export const PDF_PRODUCER = 'Chronicle Demo';

/** The standard fonts only cover WinAnsi; anything else becomes `?`. */
export function winAnsiSafe(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[^\x20-\x7e\u00a0-\u00ff]/g, '?');
}

/** `2026-10-30` -> `30/10/2026` (the PDF uses a different date style from the HTML page). */
export function formatDateDmy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function istMidnight(iso: string): Date {
  return new Date(Date.parse(`${iso}T00:00:00+05:30`));
}

export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * Renders a notice as a PDF. Output depends only on the notice state, so the same state always
 * gives the same bytes (CreationDate = printed date, ModDate = last content change).
 */
export async function renderNoticePdf(n: Notice): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsiSafe(`${n.circularNo} ${n.title} (synthetic demo)`));
  doc.setSubject('Synthetic demonstration notice');
  doc.setAuthor('Demo Government Portal (synthetic)');
  doc.setCreator('Chronicle demo-site');
  doc.setProducer(PDF_PRODUCER);
  doc.setCreationDate(istMidnight(n.printedDate));
  doc.setModificationDate(new Date(n.updatedAt * 1000));

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page: PDFPage = doc.addPage([595.28, 841.89]);
  const left = 56;
  const width = 595.28 - left * 2;
  let y = 790;

  const write = (text: string, font: PDFFont, size: number, gapAfter = 4): void => {
    for (const line of wrapText(winAnsiSafe(text), font, size, width)) {
      page.drawText(line, { x: left, y, font, size, color: rgb(0.1, 0.1, 0.1) });
      y -= size + 4;
    }
    y -= gapAfter;
  };

  page.drawRectangle({ x: left - 6, y: y - 8, width: width + 12, height: 24, color: rgb(0.48, 0.12, 0.12) });
  page.drawText(winAnsiSafe(DEMO_LABEL), { x: left, y, font: bold, size: 10, color: rgb(1, 1, 1) });
  y -= 40;

  write('DEMO GOVERNMENT (SYNTHETIC)', bold, 12, 2);
  write(n.department, regular, 11, 12);
  write(`No. ${n.circularNo}`, regular, 11, 0);
  write(`Dated ${formatDateDmy(n.printedDate)}`, regular, 11, 12);
  write('CIRCULAR', bold, 13, 4);
  write(`Subject: ${n.title} (${n.scheme})`, bold, 11, 10);
  n.clauses.forEach((c, i) => write(`${i + 1}. ${c}`, regular, 11, 6));
  write(
    `${n.clauses.length + 1}. The last date for receipt of applications is ${formatDateDmy(n.deadlinePdf)}.`,
    regular,
    11,
    6,
  );
  write(
    `${n.clauses.length + 2}. The amount payable is Rs ${formatInr(n.amountInr)} ${n.amountUnit}.`,
    regular,
    11,
    24,
  );
  write('By order, Demo Secretary (synthetic)', regular, 11, 30);
  write(SITE_LABEL, regular, 8, 0);

  return doc.save();
}
