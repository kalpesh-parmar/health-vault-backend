/* eslint-disable no-console */
/**
 * Translation Model A/B Benchmarking Script (Phase 1, Commit 1E)
 *
 * Translates 5 synthetic medical sentences (strictly NO patient data / PII)
 * to Gujarati and Hindi across allowlisted models on LAN Ollama host.
 * Evaluates Indic script ratio (target >= 0.5) and placeholder integrity (exact match ⟦1⟧..⟦N⟧).
 *
 * Usage:
 *   node scripts/translationAB.js
 *   OLLAMA_URL=http://192.168.21.176:11434 node scripts/translationAB.js
 *   TRANSLATION_MODELS=qwen2.5:14b,gemma4:e4b node scripts/translationAB.js
 */

const axios = require("axios");
const {
  maskMedicalTokens,
  unmaskMedicalTokens,
  validatePlaceholderIntegrity,
  validateIndicScriptRatio,
  stripThinking,
} = require("../src/utils/textCleanUtils");

const SYNTHETIC_SENTENCES = [
  "The patient's fasting blood glucose is 110 mg/dL and HbA1c is 6.2%.",
  "Take Metformin 500mg once daily after breakfast for 30 days.",
  "Serum creatinine is 0.9 mg/dL which is within the normal range of 0.7 - 1.3 mg/dL.",
  "Thyroid Stimulating Hormone (TSH) level is 2.5 uIU/mL on report date 15-Jan-2026.",
  "Platelet count is 250000 /cumm and Hemoglobin is 14.5 g/dL.",
];

const TARGET_LANGUAGES = [
  { code: "gu", name: "Gujarati" },
  { code: "hi", name: "Hindi" },
];

const DEFAULT_MODELS = ["qwen2.5:14b", "qwen2.5:7b", "gemma4:e4b", "medgemma:4b"];

async function runTranslationAB() {
  const rawUrl = process.env.OLLAMA_URL || process.env.OLLAMA_HOST || "http://localhost:11434";
  const ollamaUrl = rawUrl.replace(/\/$/, "");
  const envModels = process.env.TRANSLATION_MODELS
    ? process.env.TRANSLATION_MODELS.split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : DEFAULT_MODELS;

  console.log("================================================================================");
  console.log("HEALTH VAULT TRANSLATION A/B EVALUATION BENCHMARK");
  console.log(`Ollama Endpoint: ${ollamaUrl}`);
  console.log(`Models under test: ${envModels.join(", ")}`);
  console.log(`Languages: ${TARGET_LANGUAGES.map((l) => l.name).join(", ")}`);
  console.log(`Synthetic sentences count: ${SYNTHETIC_SENTENCES.length}`);
  console.log("================================================================================\n");

  // Health check Ollama host
  try {
    await axios.get(`${ollamaUrl}/api/tags`, { timeout: 3000 });
  } catch (connErr) {
    console.warn(`[WARNING] Unable to reach Ollama endpoint at ${ollamaUrl}: ${connErr.message}`);
    console.warn(
      "Ensure Ollama is running and accessible on LAN when running this evaluation live.\n",
    );
    return;
  }

  for (const model of envModels) {
    console.log(`\n=================== EVALUATING MODEL: ${model} ===================`);

    for (const lang of TARGET_LANGUAGES) {
      console.log(`\n--- Target Language: ${lang.name} (${lang.code}) ---`);

      for (let i = 0; i < SYNTHETIC_SENTENCES.length; i++) {
        const sentence = SYNTHETIC_SENTENCES[i];
        const { maskedText, placeholders } = maskMedicalTokens(sentence);

        const prompt = `You are an expert medical translator for a healthcare application. Translate the following user query or medical text into natural, fluent ${lang.name}.
CRITICAL RULES:
1. Preserve medical entities in English characters or standard medical representation:
   - Doctor names, Hospital / Clinic names
   - Medicine / drug names, Lab test names
   - Numbers, dosages, and units
2. The text may contain bracketed placeholders like ⟦1⟧, ⟦2⟧ representing protected medical entities and numbers. You MUST preserve every placeholder ⟦1⟧, ⟦2⟧... exactly as written in your translation, in the appropriate grammatical position. Never translate, transliterate, remove, or modify any ⟦...⟧ placeholder.
3. Translate all explanatory sentences, findings, and patient instructions into clear, simple ${lang.name} suitable for a patient.
4. Do not alter clinical facts or measurements.
5. Output ONLY the translated text. Do not include markdown code fences, notes, explanations, or conversational filler.

Text to translate:
"""
${maskedText}
"""
/no_think`;

        try {
          const startTime = Date.now();
          const response = await axios.post(
            `${ollamaUrl}/api/generate`,
            {
              model,
              prompt,
              stream: false,
              think: false,
              options: { temperature: 0.1, num_ctx: 8192 },
            },
            { timeout: 30000 },
          );
          const duration = Date.now() - startTime;
          const rawOutput = (response.data?.response || "").trim();
          const cleanOutput = stripThinking(rawOutput);

          const hasIntegrity = validatePlaceholderIntegrity(cleanOutput, placeholders);
          const restoredText = unmaskMedicalTokens(cleanOutput, placeholders);
          const scriptRatioValid = validateIndicScriptRatio(restoredText, lang.code, 0.5);

          // Calculate script ratio
          const scriptRegex = lang.code === "gu" ? /[\u0A80-\u0AFF]/g : /[\u0900-\u097F]/g;
          const indicChars = (restoredText.match(scriptRegex) || []).length;
          const latinChars = (restoredText.match(/[a-zA-Z]/g) || []).length;
          const ratio =
            indicChars + latinChars > 0
              ? (indicChars / (indicChars + latinChars)).toFixed(3)
              : "0.000";

          console.log(`[Sentence ${i + 1}] (${duration}ms)`);
          console.log(`  Source:     ${sentence}`);
          console.log(`  Masked:     ${maskedText}`);
          console.log(`  Raw:        ${cleanOutput}`);
          console.log(`  Restored:   ${restoredText}`);
          console.log(
            `  Script:     Ratio=${ratio} (${scriptRatioValid ? "PASS >= 0.5" : "FAIL < 0.5"})`,
          );
          console.log(
            `  Integrity:  ${
              hasIntegrity
                ? "PASS (All placeholders preserved exactly once)"
                : "FAIL (Placeholder missing/duplicated)"
            }`,
          );
        } catch (err) {
          console.error(
            `  [ERROR] Failed to translate sentence ${i + 1} with ${model}: ${err.message}`,
          );
        }
      }
    }
  }

  console.log("\n================================================================================");
  console.log("TRANSLATION A/B EVALUATION COMPLETE");
  console.log("================================================================================");
}

if (require.main === module) {
  runTranslationAB().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
  });
}

module.exports = {
  runTranslationAB,
  SYNTHETIC_SENTENCES,
  TARGET_LANGUAGES,
  DEFAULT_MODELS,
};
