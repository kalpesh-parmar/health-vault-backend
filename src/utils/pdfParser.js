/**
 * Universal PDF parser helper that safely handles both pdf-parse v1 (function)
 * and pdf-parse v2 (PDFParse class) exports without throwing TypeError.
 */

async function parsePdf(buffer, options = {}) {
  if (!buffer || buffer.length === 0) {
    throw new Error("Cannot parse empty PDF buffer");
  }

  const pdfPkg = require("pdf-parse");

  // pdf-parse v1 export format: pdf(buffer, options) -> Promise<{ text, numpages, info, ... }>
  if (typeof pdfPkg === "function") {
    return await pdfPkg(buffer, options);
  }

  // pdf-parse v2 export format: { PDFParse: class ... }
  if (pdfPkg && typeof pdfPkg.PDFParse === "function") {
    const parser = new pdfPkg.PDFParse({ data: buffer, ...options });
    const textResult = await parser.getText();
    const infoResult = await parser.getInfo().catch(() => ({}));
    return {
      text: textResult?.text || "",
      numpages: Number(textResult?.total || infoResult?.total || 1),
      info: infoResult,
    };
  }

  // Fallback for default export wrappers
  if (pdfPkg && typeof pdfPkg.default === "function") {
    return await pdfPkg.default(buffer, options);
  }

  throw new Error("Unsupported pdf-parse module structure");
}

module.exports = {
  parsePdf,
};
