/**
 * Preferred-Language Clinical Summary & Key Points Helper (REQ-04)
 * Synthesizes patient-friendly medical summaries and deduplicates key clinical findings
 * across English, Gujarati, Hindi, Marathi, and Tamil.
 */

const { ollamaClient: defaultOllamaClient } = require("../clients/ollamaClient");
const defaultAiClient = require("../services/ai/clients/aiClient.service");
const { env } = require("../configs/env");

const SUPPORTED_LANGUAGES = ["english", "gujarati", "hindi", "marathi", "tamil"];

/**
 * Standardize language strings and aliases to canonical language names
 * @param {string} lang - Language code or name
 * @returns {string} One of: english, gujarati, hindi, marathi, tamil
 */
function normalizeLanguage(lang) {
  if (!lang || typeof lang !== "string") return "english";
  const clean = String(lang).toLowerCase().trim();

  if (clean === "en" || clean === "eng") return "english";
  if (clean === "gu" || clean === "guj") return "gujarati";
  if (clean === "hi" || clean === "hin") return "hindi";
  if (clean === "mr" || clean === "mar") return "marathi";
  if (clean === "ta" || clean === "tam") return "tamil";

  if (SUPPORTED_LANGUAGES.includes(clean)) return clean;
  return "english";
}

/**
 * Build medical summary prompt enforcing Latin preservation for drugs and tests
 * @param {string} rawText - Transcribed clinical text
 * @param {string} language - Target language name
 * @returns {string} Formatted Ollama prompt
 */
function buildSummaryPrompt(rawText, language = "gujarati") {
  const normLang = normalizeLanguage(language);
  const langDisplay = normLang.charAt(0).toUpperCase() + normLang.slice(1);

  return `You are a helpful medical translator. Summarize the following medical document in simple, clear ${langDisplay}.
Keep common medical terms, doctor names, hospital/clinic names, diagnoses, lab tests (such as Diabetes, Hypertension, Cholesterol, Thyroid, Hemoglobin, CBC, RBC, WBC, ECG, MRI, X-ray, CT Scan, Vitamin, Calcium), and drug/medication names with dosages (like "Metformin 500mg", "Dolo 650", "1-0-1") in English characters (like "Diabetes") or write them phonetically in English, as literal ${langDisplay} translations for these terms are uncommon, awkward, and confusing for patients.
The summary should be easy to understand for a layperson.
Limit the summary to 150-200 words.
Do not include any other text, markdown blocks, introductions, explanations, or notes. Output only the summary.

Medical Document Text:
"""
${rawText}
"""
/no_think`;
}

/**
 * Clean and simplify text for fingerprint comparison
 * @param {string} str
 * @returns {string}
 */
function toFingerprint(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .replace(/^(?:diagnosis|abnormal finding|medication):\s*/i, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deduplicate and extract key clinical points and findings (REQ-04)
 * Ensures every critical diagnosis, abnormal test, and medication is highlighted exactly once.
 * @param {object} structuredData - Parsed medical data
 * @param {string} [summaryText] - Generated summary
 * @param {string} [_language] - Preferred language
 * @returns {string[]} Deduplicated key clinical findings
 */
function extractKeyPoints(structuredData = {}, summaryText = "", _language = "english") {
  const points = [];
  const fingerprints = new Set();

  function addPoint(text) {
    if (!text || typeof text !== "string") return;
    const clean = text.trim();
    if (!clean || clean.length < 3) return;

    // Filter out common non-informative phrases
    const lower = clean.toLowerCase();
    if (
      lower.includes("no summary") ||
      lower.includes("as per schema") ||
      lower.includes("not available") ||
      (lower.includes("within normal limits") && !lower.includes("abnormal"))
    ) {
      return;
    }

    const fp = toFingerprint(clean);
    if (!fp) return;

    const fpTokens = new Set(fp.split(" ").filter((w) => w.length > 2));

    // Deduplication check: check if already present, substring, or token subset
    for (const existingFp of fingerprints) {
      if (existingFp === fp || existingFp.includes(fp) || fp.includes(existingFp)) {
        return; // Already covered by an existing finding
      }
      if (fpTokens.size > 0) {
        const existingTokens = new Set(existingFp.split(" ").filter((w) => w.length > 2));
        const isSubset1 = [...fpTokens].every((t) => existingTokens.has(t));
        const isSubset2 = [...existingTokens].every((t) => fpTokens.has(t));
        if (isSubset1 || isSubset2) {
          return; // Token subset covered
        }
      }
    }

    fingerprints.add(fp);
    points.push(clean);
  }

  // 1. Primary Diagnoses / Conditions
  const rawDiag = structuredData.diagnosis || structuredData.medicalConditions || [];
  const diagList = Array.isArray(rawDiag) ? rawDiag : [rawDiag];
  for (const d of diagList) {
    if (typeof d === "string" && d.trim()) {
      addPoint(`Diagnosis: ${d.trim()}`);
    } else if (d && typeof d === "object" && (d.condition || d.name)) {
      addPoint(`Diagnosis: ${(d.condition || d.name).trim()}`);
    }
  }

  // 2. Abnormal Lab & Diagnostic Test Results
  const tests = structuredData.testResults || structuredData.labResults || [];
  if (Array.isArray(tests)) {
    for (const t of tests) {
      const isAbnormal =
        t.isAbnormal === true ||
        (typeof t.status === "string" &&
          ["ABNORMAL", "HIGH", "LOW", "CRITICAL"].includes(t.status.toUpperCase()));
      if (isAbnormal && t.name) {
        const val = t.value ? `: ${t.value} ${t.unit || ""}`.trim() : "";
        const status = t.status ? ` (${t.status})` : " (Abnormal)";
        addPoint(`Abnormal Finding: ${t.name}${val}${status}`);
      }
    }
  }

  // 3. Prescribed Medications with Dosages
  const meds = structuredData.medications || [];
  if (Array.isArray(meds)) {
    for (const m of meds) {
      const name = m.canonicalName || m.name;
      if (!name) continue;
      const details = [];
      if (m.dosage) details.push(m.dosage);
      if (m.frequency && m.frequency !== m.dosage) details.push(m.frequency);
      if (m.duration) details.push(m.duration);
      if (m.instructions) details.push(m.instructions);

      const desc = details.length > 0 ? ` (${details.join(", ")})` : "";
      addPoint(`Medication: ${name}${desc}`);
    }
  }

  // 4. Fallback to summary bullet points if structured items yielded few findings
  if (points.length === 0 && summaryText && typeof summaryText === "string") {
    const sentences = summaryText
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 15 && !s.toLowerCase().startsWith("this is a summary"));

    for (const s of sentences) {
      addPoint(s);
      if (points.length >= 4) break;
    }
  }

  // Cap at 7 key points to prevent information overload
  return points.slice(0, 7);
}

/**
 * Synthesize clinical summary and deduplicated key points across all 4 operational cases (REQ-04)
 * @param {object} params
 * @param {string} params.rawText - OCR transcribed document text
 * @param {object} [params.structuredData] - Extracted clinical entities
 * @param {string} [params.preferredLanguage] - User's preferred language
 * @param {string[]} [params.detectedLanguages] - Languages detected in document
 * @param {object} [params.ollamaClient] - Ollama client instance
 * @param {object} [params.aiClient] - AI Client instance for translation
 * @param {string} [params.structuringModel] - Model identifier
 * @returns {Promise<{ summary: string, summaryEnglish: string, summaryInPreferredLanguage: string, summaryLanguage: string, keyPoints: string[], detectedLanguages: string[] }>}
 */
async function synthesizeClinicalSummary({
  rawText,
  structuredData = {},
  preferredLanguage = "english",
  detectedLanguages = ["english"],
  ollamaClient = defaultOllamaClient,
  aiClient = defaultAiClient,
  structuringModel = null,
}) {
  const targetLang = normalizeLanguage(preferredLanguage);
  const detected =
    Array.isArray(detectedLanguages) && detectedLanguages.length > 0
      ? detectedLanguages
      : ["english"];

  const model = structuringModel || env.chatModel || env.aiModel || "medgemma:4b";

  let summaryEnglish = "";
  let summaryPreferredLanguage = "";

  if (!rawText || !rawText.trim()) {
    return {
      summary: "",
      summaryEnglish: "",
      summaryInPreferredLanguage: "",
      summaryLanguage: targetLang,
      keyPoints: [],
      detectedLanguages: detected,
    };
  }

  // Case 4: Absent/fallback or English preference
  if (targetLang === "english") {
    const prompt = buildSummaryPrompt(rawText, "english");
    try {
      const response = await ollamaClient.generate(prompt, model, {
        temperature: 0.1,
        maxTokens: 512,
        think: false,
        rawOptions: { num_ctx: 8192 },
      });
      summaryEnglish = (
        typeof response === "string" ? response : response?.response || response?.text || ""
      ).trim();
    } catch {
      summaryEnglish = "";
    }
    summaryPreferredLanguage = summaryEnglish;
  } else {
    // Case 1, 2, 3: Target is Indic (Gujarati, Hindi, Marathi, Tamil)
    // First generate English summary if not provided
    const promptEng = buildSummaryPrompt(rawText, "english");
    const promptPref = buildSummaryPrompt(rawText, targetLang);

    try {
      // Parallel execution for lowest total latency
      const [respEng, respPref] = await Promise.all([
        ollamaClient.generate(promptEng, model, {
          temperature: 0.1,
          maxTokens: 512,
          think: false,
          rawOptions: { num_ctx: 8192 },
        }),
        ollamaClient.generate(promptPref, model, {
          temperature: 0.1,
          maxTokens: 512,
          think: false,
          rawOptions: { num_ctx: 8192 },
        }),
      ]);

      summaryEnglish = (
        typeof respEng === "string" ? respEng : respEng?.response || respEng?.text || ""
      ).trim();
      summaryPreferredLanguage = (
        typeof respPref === "string" ? respPref : respPref?.response || respPref?.text || ""
      ).trim();
    } catch {
      // Graceful fallback to translation if direct multi-generation failed
      if (!summaryEnglish) {
        try {
          const resp = await ollamaClient.generate(promptEng, model, {
            temperature: 0.1,
            maxTokens: 512,
            think: false,
            rawOptions: { num_ctx: 8192 },
          });
          summaryEnglish = (
            typeof resp === "string" ? resp : resp?.response || resp?.text || ""
          ).trim();
        } catch {
          summaryEnglish = "";
        }
      }

      if (summaryEnglish && !summaryPreferredLanguage) {
        try {
          summaryPreferredLanguage = await aiClient.translate(
            summaryEnglish,
            "english",
            targetLang,
          );
        } catch {
          summaryPreferredLanguage = summaryEnglish;
        }
      }
    }

    // Secondary fallback: if direct generation produced empty string, attempt translation of English
    if (!summaryPreferredLanguage && summaryEnglish) {
      try {
        summaryPreferredLanguage = await aiClient.translate(summaryEnglish, "english", targetLang);
      } catch {
        summaryPreferredLanguage = summaryEnglish;
      }
    }
  }

  // Final fallback
  if (!summaryPreferredLanguage && summaryEnglish) {
    summaryPreferredLanguage = summaryEnglish;
  }

  const primarySummary = summaryPreferredLanguage || summaryEnglish;
  const keyPoints = extractKeyPoints(structuredData, primarySummary, targetLang);

  return {
    summary: primarySummary,
    summaryEnglish,
    summaryInPreferredLanguage: summaryPreferredLanguage,
    summaryLanguage: targetLang,
    keyPoints,
    detectedLanguages: detected,
  };
}

module.exports = {
  SUPPORTED_LANGUAGES,
  normalizeLanguage,
  buildSummaryPrompt,
  extractKeyPoints,
  synthesizeClinicalSummary,
};
