const { env } = require("../../../configs/env");
const { createAiProvider, extractGeneratedText } = require("../aiModelFactory");
const { buildOcrResult, emptyMedicalExtraction } = require("./ocrResultBuilder");
const { ocrLogger, withTimeout } = require("./ocrLogger");
const { GeminiInvalidResponseError } = require("./ocrErrors");

/**
 * Primary OCR + document-extraction engine backed by the configured AI
 * provider/model.
 *
 * The service uses exactly one configured model (`AI_MODEL`). Any timeout,
 * model/API failure, or invalid response is surfaced to the caller; there is
 * no provider switch, backup model, or fallback OCR engine.
 */

// Structured-output schema for reliable JSON when the selected provider supports it.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page: { type: "integer" },
          text: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["page", "text"],
      },
    },
    tables: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page: { type: "integer" },
          rows: { type: "array", items: { type: "array", items: { type: "string" } } },
        },
      },
    },
    keyValues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
          page: { type: "integer" },
        },
      },
    },
    medicalExtraction: {
      type: "object",
      properties: {
        patientInfo: { type: "object" },
        hospitalInfo: { type: "object" },
        doctorInfo: { type: "object" },
        diagnosis: { type: "array", items: { type: "string" } },
        medications: { type: "array", items: { type: "object" } },
        labResults: { type: "array", items: { type: "object" } },
        vitals: { type: "array", items: { type: "object" } },
        recommendations: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
      },
    },
  },
  required: ["pages"],
};

const OCR_PROMPT = [
  "You are a precise OCR and document-understanding engine for medical documents.",
  "Transcribe ALL visible text from the document EXACTLY as it appears, page by page.",
  "Rules:",
  "- Return one `pages` entry per source page, in order, with 1-based `page` numbers.",
  "- Preserve line breaks, numbers, units, ranges, dates, and names verbatim.",
  "- Render tables as `tables[].rows` (array of row arrays) AND keep them inline in the page text.",
  "- Capture form fields and labelled values as `keyValues` entries.",
  "- Populate `medicalExtraction` only from text actually present; never invent values.",
  "- Set a per-page `confidence` between 0 and 1 reflecting transcription certainty.",
  "- If a page is genuinely blank, return its `text` as an empty string.",
  "- Do not diagnose, prescribe, summarise, or add commentary.",
].join("\n");

class AiTokenBucket {
  constructor(maxConcurrent) {
    this.max = Math.max(1, maxConcurrent);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

// ──────────────────────────────────────────────
// Response text extraction helpers
// ──────────────────────────────────────────────

/**
 * Safely extract the text payload from an AI provider response.
 *
 * The `@google/genai` SDK may return the generated text in different shapes
 * depending on the version and whether `responseMimeType` was configured:
 *
 *   - `response.text` — flat string (common when responseMimeType is set)
 *   - `response.candidates[0].content.parts[0].text` — standard candidate
 *     structure
 *   - `response.candidates[0].content.parts[0].inlineData` — when the
 *     response is a binary payload (rare for text prompts)
 */
function extractResponseText(response) {
  const text = extractGeneratedText(response);
  if (
    text === null &&
    Array.isArray(response?.candidates) &&
    response.candidates[0]?.finishReason
  ) {
    ocrLogger.warn("unknown", "ai_finish_reason", {
      finishReason: response.candidates[0].finishReason,
      finishMessage: response.candidates[0].finishMessage || null,
    });
  }
  return text;
}

/**
 * Attempt to extract a JSON payload from an AI response text using
 * progressively more aggressive fallback strategies.
 *
 * Strategies applied in order:
 *   1. Direct JSON.parse on trimmed text.
 *   2. Strip markdown code fences (```json ... ``` or ``` ... ```).
 *   3. Strip BOM / non-printable leading bytes.
 *   4. Regex extraction: find the first `{...}` or `[...]` block.
 *   5. Attempt to tolerate trailing commas (Hjson-style repair).
 *   6. Attempt to extract partial JSON from truncated responses.
 *
 * Returns `{ parsed, strategy }` on success or `{ parsed: null, error }`
 * with a human-readable failure reason.
 */
function safeParseJson(text) {
  if (!text) {
    return { parsed: null, error: "Response text is empty or null" };
  }

  const raw = String(text);
  const strategies = [
    { name: "direct", fn: () => JSON.parse(raw.trim()) },
    {
      name: "strip_markdown_fence",
      fn: () => {
        const stripped = raw
          .replace(/```(?:json)?\s*/gi, "")
          .replace(/```\s*$/g, "")
          .trim();
        return JSON.parse(stripped);
      },
    },
    { name: "strip_bom", fn: () => JSON.parse(raw.replace(/^\uFEFF/, "").trim()) },
    {
      name: "regex_extract",
      fn: () => {
        // Find the outermost JSON structure (object or array) by comparing
        // start positions. The structure that opens first is outermost.
        const objMatch = raw.match(/\{[\s\S]*\}/);
        const arrMatch = raw.match(/\[[\s\S]*\]/);
        if (!objMatch && !arrMatch) throw new Error("No JSON structure found");
        let outermost;
        if (objMatch && arrMatch) {
          outermost = objMatch.index <= arrMatch.index ? objMatch[0] : arrMatch[0];
        } else {
          outermost = objMatch ? objMatch[0] : arrMatch[0];
        }
        return JSON.parse(outermost);
      },
    },
    {
      name: "trailing_comma_repair",
      fn: () => {
        // Replace trailing commas before closing braces/brackets.
        const cleaned = raw.replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(cleaned);
      },
    },
    {
      name: "truncated_repair",
      fn: () => {
        // Use a stack to track open structures in nesting order.
        // When the JSON is truncated, we close in reverse nesting order
        // so the result is syntactically valid.
        const stack = [];
        let inStr = false;
        let escaped = false;
        // First find the start of JSON content
        const firstContent = raw.match(/[[{]/);
        if (!firstContent) throw new Error("No structure found");
        for (let i = firstContent.index; i < raw.length; i++) {
          const ch = raw[i];
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === "\\" && inStr) {
            escaped = true;
            continue;
          }
          if (ch === '"') {
            inStr = !inStr;
            continue;
          }
          if (inStr) continue;
          if (ch === "{") {
            stack.push("}");
          } else if (ch === "[") {
            stack.push("]");
          } else if (ch === "}" || ch === "]") {
            if (stack.length > 0 && stack[stack.length - 1] === ch) {
              stack.pop();
            }
          }
        }
        // Build the repaired string: original content from first structure
        // onward + all closing characters in reverse order.
        const body = raw.slice(firstContent.index);
        const closing = stack.reverse().join("");
        return JSON.parse(body + closing);
      },
    },
  ];

  const errors = [];
  for (const { name, fn } of strategies) {
    try {
      const parsed = fn();
      // Only accept objects or arrays — reject primitives (numbers,
      // strings, booleans) that would fail schema validation anyway.
      if (parsed !== null && parsed !== undefined && typeof parsed === "object") {
        return { parsed, strategy: name };
      }
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  return {
    parsed: null,
    error: errors.join("; "),
  };
}

// ──────────────────────────────────────────────
// Schema validation
// ──────────────────────────────────────────────

/**
 * Validate a parsed AI response against the expected schema defined
 * in RESPONSE_SCHEMA.
 *
 * Returns `{ valid: true }` or `{ valid: false, errors: string[] }` with
 * human-readable descriptions of every field that failed validation.
 */
function validateGeminiResponse(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, errors: ["Response must be a JSON object"] };
  }

  const errors = [];

  // --- pages (required) ---
  if (!Array.isArray(parsed.pages)) {
    errors.push("Missing or invalid required field 'pages': expected an array");
  } else if (parsed.pages.length === 0) {
    errors.push("Field 'pages' is an empty array — no page data was returned");
  } else {
    for (let i = 0; i < parsed.pages.length; i++) {
      const p = parsed.pages[i];
      if (!p || typeof p !== "object") {
        errors.push(`pages[${i}]: expected an object, got ${typeof p}`);
        continue;
      }
      if (typeof p.page !== "number") {
        errors.push(`pages[${i}].page: expected a number, got ${typeof p.page}`);
      }
      if (typeof p.text !== "string") {
        errors.push(`pages[${i}].text: expected a string, got ${typeof p.text}`);
      }
      if (p.confidence !== undefined && p.confidence !== null && typeof p.confidence !== "number") {
        errors.push(`pages[${i}].confidence: expected a number, got ${typeof p.confidence}`);
      }
    }
  }

  // --- tables (optional) ---
  if (parsed.tables !== undefined && !Array.isArray(parsed.tables)) {
    errors.push("Field 'tables': expected an array");
  }

  // --- keyValues (optional) ---
  if (parsed.keyValues !== undefined && !Array.isArray(parsed.keyValues)) {
    errors.push("Field 'keyValues': expected an array");
  }

  // --- medicalExtraction (optional) ---
  if (parsed.medicalExtraction !== undefined) {
    if (typeof parsed.medicalExtraction !== "object" || Array.isArray(parsed.medicalExtraction)) {
      errors.push("Field 'medicalExtraction': expected an object");
    } else {
      const stringArrays = ["diagnosis", "medications", "labResults", "vitals", "recommendations"];
      for (const field of stringArrays) {
        if (
          parsed.medicalExtraction[field] !== undefined &&
          !Array.isArray(parsed.medicalExtraction[field])
        ) {
          errors.push(`medicalExtraction.${field}: expected an array`);
        }
      }
      if (
        parsed.medicalExtraction.summary !== undefined &&
        typeof parsed.medicalExtraction.summary !== "string"
      ) {
        errors.push("medicalExtraction.summary: expected a string");
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

const validateAiResponse = validateGeminiResponse;

function mergeTablesIntoPages(parsed) {
  const pages = Array.isArray(parsed?.pages) ? parsed.pages : [];
  const tablesByPage = new Map();
  for (const table of parsed?.tables || []) {
    const rows = (table?.rows || []).map((row) =>
      Array.isArray(row) ? row.join(" | ") : String(row),
    );
    if (!rows.length) continue;
    const block = rows.join("\n");
    tablesByPage.set(table.page, [...(tablesByPage.get(table.page) || []), block]);
  }
  return pages.map((page) => {
    const extraTables = tablesByPage.get(page.page);
    const baseText = String(page.text || "");
    const hasTableText =
      extraTables && !extraTables.every((t) => baseText.includes(t.split("\n")[0]));
    const text = hasTableText ? `${baseText}\n${extraTables.join("\n")}`.trim() : baseText;
    return {
      page: page.page,
      text,
      confidence: typeof page.confidence === "number" ? page.confidence : null,
    };
  });
}

class GeminiOcrService {
  constructor() {
    this._provider = null;
    this._bucket = new AiTokenBucket(env.aiPageConcurrency);
  }

  get isConfigured() {
    return Boolean(env.aiBaseUrl && env.aiModel);
  }

  provider() {
    if (!this._provider) {
      this._provider = createAiProvider();
    }
    return this._provider;
  }

  /**
   * Run configured AI OCR over a single document buffer.
   * @returns {Promise<object>} canonical OCR result envelope
   */
  async extract({ buffer, filename, mimeType, traceId }) {
    const startedAt = Date.now();
    const base64 = buffer.toString("base64");

    await this._bucket.acquire();
    let parsed;
    let rawResponseText = null;
    try {
      ocrLogger.info(traceId, "ai_model_request", {
        engine: this.provider().status().engine,
        model: env.aiModel,
        mimeType,
        bytes: buffer.length,
      });

      const { raw, text } = await withTimeout(
        this.provider().generateJson({
          parts: [{ inlineData: { mimeType, data: base64 } }, { text: OCR_PROMPT }],
          schema: RESPONSE_SCHEMA,
          temperature: 0,
        }),
        env.aiTimeoutMs,
        "ai_generate_content",
      );

      // --- Step 1: Extract raw text from any SDK response shape ---
      rawResponseText = text ?? extractResponseText(raw);

      // Log the raw response text (truncated for safety) BEFORE any parsing.
      // This is critical for debugging invalid responses.
      ocrLogger.info(traceId, "ai_model_raw_response", {
        engine: this.provider().status().engine,
        model: env.aiModel,
        present: rawResponseText !== null,
        strategy: rawResponseText !== null ? "extracted" : "no_text",
        length: rawResponseText ? rawResponseText.length : 0,
        preview: rawResponseText
          ? rawResponseText.length > 1000
            ? rawResponseText.slice(0, 1000) + `…[+${rawResponseText.length - 1000} chars]`
            : rawResponseText
          : null,
      });

      if (rawResponseText === null) {
        throw new GeminiInvalidResponseError({
          message: "Configured AI model returned an empty response",
          details: { model: env.aiModel },
          rawSnippet: null,
          parseError: "extractResponseText returned null",
        });
      }

      // --- Step 2: Attempt JSON parsing with fallback strategies ---
      const parseResult = safeParseJson(rawResponseText);
      if (!parseResult.parsed) {
        throw new GeminiInvalidResponseError({
          message: "Configured AI model response could not be parsed as JSON",
          details: { model: env.aiModel, attemptedStrategies: parseResult.error },
          rawSnippet:
            rawResponseText.length > 500
              ? rawResponseText.slice(0, 500) + `…[+${rawResponseText.length - 500} chars]`
              : rawResponseText,
          parseError: parseResult.error,
        });
      }
      parsed = parseResult.parsed;

      ocrLogger.info(traceId, "ai_model_parsed", {
        strategy: parseResult.strategy,
        keys: Object.keys(parsed),
        hasPages: Array.isArray(parsed.pages),
        pageCount: Array.isArray(parsed.pages) ? parsed.pages.length : 0,
      });

      // --- Step 3: Validate parsed response against expected schema ---
      const validation = validateGeminiResponse(parsed);
      if (!validation.valid) {
        throw new GeminiInvalidResponseError({
          message: "Configured AI model response does not match the expected schema",
          details: { model: env.aiModel, validationErrorCount: validation.errors.length },
          rawSnippet:
            rawResponseText.length > 500 ? rawResponseText.slice(0, 500) : rawResponseText,
          parseError: null,
          validationErrors: validation.errors,
        });
      }
    } finally {
      this._bucket.release();
    }

    const pages = mergeTablesIntoPages(parsed);
    const medicalExtraction = { ...emptyMedicalExtraction(), ...(parsed.medicalExtraction || {}) };

    const result = buildOcrResult({
      pages,
      engine: `${this.provider().status().engine}:${env.aiModel}`,
      medicalExtraction,
      filename,
      mimeType,
      pageCount: pages.length,
      processedPageCount: pages.length,
      metrics: {
        ai_ms: Date.now() - startedAt,
        processing_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
        key_values: Array.isArray(parsed.keyValues) ? parsed.keyValues.length : 0,
        tables: Array.isArray(parsed.tables) ? parsed.tables.length : 0,
      },
    });

    ocrLogger.info(traceId, "ai_model_done", {
      pages: pages.length,
      nonEmptyPages: result.metadata.nonEmptyPages,
      textChars: result.ocr_text.length,
      confidence: result.metadata.confidence,
      ms: Date.now() - startedAt,
    });
    return result;
  }
}

module.exports = new GeminiOcrService();
module.exports.GeminiOcrService = GeminiOcrService;

// Exported for unit testing
module.exports.extractResponseText = extractResponseText;
module.exports.safeParseJson = safeParseJson;
module.exports.validateGeminiResponse = validateGeminiResponse;
module.exports.validateAiResponse = validateAiResponse;
module.exports.RESPONSE_SCHEMA = RESPONSE_SCHEMA;
