// Small, authored deterministic fixtures, not fetched from a third party in CI.
export const JXL_CHECKER = '/woIELASCAgQAHAASxiLFcIRbFzg7wOI6L9tOey/tiD9v391/fUHAA==';
export const STL_TRIANGLE = 'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n';
export function pdfFixture() {
  const stream = '0.07 0.10 0.15 rg 0 0 612 792 re f\n0.97 0.66 0.30 rg 36 700 540 5 re f\n1 1 1 rg BT /F1 30 Tf 36 740 Td (Inscription format test) Tj ET\n0.80 0.85 0.90 rg BT /F1 14 Tf 36 660 Td (A readable PDF page with local rendering.) Tj 0 -28 Td (No scripts, links, forms or attachments activated.) Tj ET\n0.97 0.66 0.30 rg 36 100 120 120 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 8 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /S /JavaScript /JS (globalThis.__pdfScriptMustNotRun = true) >>'
  ];
  let output = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(output));
}
