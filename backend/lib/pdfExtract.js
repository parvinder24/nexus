// Extracts plain text from a PDF's bytes.
//
// We originally used the "pdf-parse" package (simpler API), but testing
// found it threw "bad XRef entry" on multiple genuinely valid PDFs
// (confirmed valid with `qpdf --check` and `pdftotext`) - a real bug in
// that package's bundled parser, not bad input. pdfjs-dist is the actual
// PDF engine Mozilla maintains for Firefox's PDF viewer - more code to
// call directly, but it's the actively-maintained library other PDF
// packages wrap, and it correctly parsed everything pdf-parse failed on.
//
// pdfjs-dist is an ES module, and this project's other files use
// CommonJS (`require`) - `import()` (a dynamic import, returns a Promise)
// is how you load an ES module from CommonJS code.
async function extractTextFromPDF(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer);

  const doc = await pdfjsLib.getDocument({ data }).promise;
  let text = "";
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(" ") + "\n";
  }
  return text.trim();
}

module.exports = { extractTextFromPDF };
