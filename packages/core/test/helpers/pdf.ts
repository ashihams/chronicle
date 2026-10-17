import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/** A synthetic text PDF. Fixed dates keep the bytes deterministic. */
export async function textPdf(lines: string[], producer = 'Synthetic Producer 1.0'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer(producer);
  doc.setCreator('Chronicle test fixture');
  doc.setCreationDate(new Date('2026-09-01T10:00:00Z'));
  doc.setModificationDate(new Date('2026-09-02T11:30:00Z'));
  const page = doc.addPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, i) => page.drawText(line, { x: 50, y: 760 - i * 18, font, size: 12 }));
  return doc.save();
}

/** A PDF with only shapes and no text layer, standing in for a scanned notice. */
export async function scannedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2026-09-01T10:00:00Z'));
  doc.setModificationDate(new Date('2026-09-01T10:00:00Z'));
  const page = doc.addPage();
  page.drawRectangle({ x: 50, y: 600, width: 400, height: 150, color: rgb(0.2, 0.2, 0.2) });
  return doc.save();
}
