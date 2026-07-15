/* End-to-end: generate a redacted PDF, then extract its text with pdf.js and
 * assert the redacted content is gone while the rest survives. */
const assert = require('assert');
const fs = require('fs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const { sanitize, wrapChars, drawLine } = require('../app.js');

async function generate(text, subs) {
  const spans = subs.map((s) => { const i = text.indexOf(s); return { start: i, end: i + s.length }; });
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 11, lh = 15, margin = 50, pageW = 595.28, pageH = 841.89, maxW = pageW - margin * 2;
  const clean = sanitize(text);
  const marks = new Array(clean.length).fill(false);
  for (const s of spans) for (let i = s.start; i < s.end; i++) marks[i] = true;
  const chars = [];
  for (let i = 0; i < clean.length; i++) chars.push({ c: clean[i], r: marks[i] });
  const lines = wrapChars(chars, font, size, maxW);
  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;
  for (const line of lines) { if (y < margin) { page = doc.addPage([pageW, pageH]); y = pageH - margin; } drawLine(page, line, margin, y, font, size, rgb); y -= lh; }
  return await doc.save();
}

async function extract(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const c = await page.getTextContent();
    out += c.items.map((i) => i.str).join(' ');
  }
  return out;
}

(async () => {
  const text = 'Patient John Smith, SSN 123-45-6789, email john@example.com, seen in London.';
  const bytes = await generate(text, ['John Smith', '123-45-6789']);
  fs.writeFileSync('/tmp/redacted-sample.pdf', Buffer.from(bytes));
  const extracted = await extract(bytes);

  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) { pass++; console.log('ok   -', name); } else { fail++; console.error('NOT ok -', name, '\n     extracted:', JSON.stringify(extracted)); } };

  t('kept: Patient', extracted.includes('Patient'));
  t('kept: email', extracted.includes('example.com'));
  t('kept: London', extracted.includes('London'));
  t('REDACTED name is unrecoverable', !extracted.includes('John Smith') && !extracted.includes('John') && !extracted.includes('Smith'));
  t('REDACTED ssn is unrecoverable', !extracted.includes('123-45-6789') && !extracted.includes('123') && !extracted.includes('6789'));

  console.log(`\nExtracted text: "${extracted.trim()}"`);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
