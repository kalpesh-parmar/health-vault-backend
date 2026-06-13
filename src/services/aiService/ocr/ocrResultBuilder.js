/**
 * Builds the canonical OCR response envelope for the configured AI model
 * so downstream consumers (`documentOcrJobService`, `medicalExtractionService`)
 * keep working unchanged.
 *
 * The shape mirrors what the Python ai-service `/v1/run-ocr` returns today:
 *
 *   {
 *     success, engine, ocr: { pages, text },
 *     structuredDocument: { pages, text, fullText, confidence, pageCount,
 *                           processedPageCount, paragraphs, medicalExtraction },
 *     metadata: { pageCount, processedPageCount, confidence, filename, mimeType },
 *     ocr_text,
 *     metrics: { used_ocr, used_ai_model, provider, engine, ... }
 *   }
 */

function emptyMedicalExtraction() {
  return {
    patientInfo: {},
    hospitalInfo: {},
    doctorInfo: {},
    diagnosis: [],
    medications: [],
    labResults: [],
    vitals: [],
    recommendations: [],
    summary: "",
  };
}

function buildLines(pageText) {
  return String(pageText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ text, confidence: null }));
}

function buildParagraphs(pages) {
  const paragraphs = [];
  for (const page of pages) {
    page.lines.forEach((line, order) => {
      paragraphs.push({
        text: line.text,
        confidence: line.confidence ?? null,
        page: page.page,
        label: "line",
        order,
      });
    });
  }
  return paragraphs;
}

/**
 * @param {object} input
 * @param {Array<{page:number,text:string,confidence?:number|null}>} input.pages
 * @param {string} input.engine            e.g. "provider:model-name"
 * @param {object} [input.medicalExtraction]
 * @param {string} input.filename
 * @param {string} input.mimeType
 * @param {number} [input.pageCount]
 * @param {number} [input.processedPageCount]
 * @param {object} [input.metrics]         engine-specific metrics to merge
 */
function buildOcrResult({
  pages,
  engine,
  medicalExtraction,
  filename,
  mimeType,
  pageCount,
  processedPageCount,
  metrics = {},
}) {
  const normalizedPages = (pages || []).map((page) => {
    const text = String(page.text || "").trim();
    return {
      page: page.page,
      text,
      confidence: page.confidence ?? null,
      lines: buildLines(text),
      elapsed_ms: page.elapsed_ms ?? 0,
    };
  });

  const nonEmptyPages = normalizedPages.filter((p) => p.text).length;
  const fullText = normalizedPages
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const confidences = normalizedPages
    .map((p) => p.confidence)
    .filter((c) => typeof c === "number" && Number.isFinite(c));
  const meanConfidence = confidences.length
    ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(4))
    : null;

  const resolvedPageCount = pageCount ?? normalizedPages.length;
  const resolvedProcessed = processedPageCount ?? normalizedPages.length;

  const structuredDocument = {
    pages: normalizedPages,
    text: fullText,
    fullText,
    confidence: meanConfidence,
    pageCount: resolvedPageCount,
    processedPageCount: resolvedProcessed,
    paragraphs: buildParagraphs(normalizedPages),
    medicalExtraction: medicalExtraction || emptyMedicalExtraction(),
  };

  const clientEngine = String(engine || "").split(":", 1)[0] || "unknown";

  return {
    success: true,
    engine,
    ocr: { pages: normalizedPages, text: fullText },
    structuredDocument,
    ocr_text: fullText,
    metadata: {
      pageCount: resolvedPageCount,
      processedPageCount: resolvedProcessed,
      confidence: meanConfidence,
      filename,
      mimeType,
      nonEmptyPages,
    },
    metrics: {
      engine,
      client_engine: clientEngine,
      used_ocr: true,
      used_ai_model: true,
      used_gemini: false,
      used_qwen_vl: false,
      used_direct_text: false,
      non_empty_pages: nonEmptyPages,
      page_count: resolvedPageCount,
      processed_page_count: resolvedProcessed,
      mean_confidence: meanConfidence,
      ...metrics,
    },
  };
}

module.exports = {
  buildOcrResult,
  buildLines,
  emptyMedicalExtraction,
};
