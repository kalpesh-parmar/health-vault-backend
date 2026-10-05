const crypto = require("crypto");

const cleanOCRText = (data) => {
  return data
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/```json|```/g, "")
    .trim();
};

function stripThinking(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/(?:think|thinking|reasoning)>/gi, "")
    .replace(/<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*$/gi, "")
    .trim();
}

function sanitizeLLMOutput(text) {
  return stripThinking(text);
}

const SCRIPT_RANGES = {
  gujarati: /[\u0A80-\u0AFF]/g,
  gu: /[\u0A80-\u0AFF]/g,
  hindi: /[\u0900-\u097F]/g,
  hi: /[\u0900-\u097F]/g,
  marathi: /[\u0900-\u097F]/g,
  mr: /[\u0900-\u097F]/g,
  tamil: /[\u0B80-\u0BFF]/g,
  ta: /[\u0B80-\u0BFF]/g,
  telugu: /[\u0C00-\u0C7F]/g,
  te: /[\u0C00-\u0C7F]/g,
  kannada: /[\u0C80-\u0CFF]/g,
  kn: /[\u0C80-\u0CFF]/g,
  bengali: /[\u0980-\u09FF]/g,
  bn: /[\u0980-\u09FF]/g,
  punjabi: /[\u0A00-\u0A7F]/g,
  pa: /[\u0A00-\u0A7F]/g,
};

function validateIndicScriptRatio(text, targetLang, minRatio = 0.5) {
  if (!text || typeof text !== "string") return false;
  const norm = String(targetLang || "")
    .toLowerCase()
    .trim();
  if (norm === "en" || norm === "english") return true;

  const scriptRegex = SCRIPT_RANGES[norm];
  if (!scriptRegex) return true;

  const targetMatches = text.match(scriptRegex) || [];
  const latinMatches = text.match(/[a-zA-Z]/g) || [];
  const totalAlphabetic = targetMatches.length + latinMatches.length;

  if (totalAlphabetic === 0) return false;
  return targetMatches.length / totalAlphabetic >= minRatio;
}

const MEDICAL_PATTERNS = [
  // Dates: DD-MMM-YYYY, DD/MM/YYYY, YYYY-MM-DD
  {
    name: "date_named",
    regex: /\b\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*-\d{2,4}\b/gi,
  },
  { name: "date_slash", regex: /\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/g },
  // Numeric ranges (e.g. 4.0 - 5.6%, 12.0 to 15.0)
  {
    name: "range",
    regex:
      /\b\d+(?:\.\d+)?\s*(?:-|to)\s*\d+(?:\.\d+)?(?:\s*(?:%|(?:mg\/dL|g\/dL|µg\/dL|ug\/dL|mcg\/dL|mg\/L|mmol\/L|µmol\/L|umol\/L|uIU\/mL|mU\/L|IU\/mL|pg\/mL|ng\/mL|fL|pg|mg|ml|gm|mcg|iu)\b))?/gi,
  },
  // Numbers with clinical units or standalone units (handling % which is non-word)
  {
    name: "number_unit",
    regex:
      /\b\d+(?:\.\d+)?\s*(?:%|(?:mg\/dL|g\/dL|µg\/dL|ug\/dL|mcg\/dL|mg\/L|mmol\/L|µmol\/L|umol\/L|uIU\/mL|mU\/L|IU\/mL|pg\/mL|ng\/mL|fL|pg|mg|ml|gm|mcg|iu|mm\/hr|sec|seconds|min|minutes|hrs|hours|days|tablets|capsules|pills)\b)/gi,
  },
  // Blood pressure e.g. 120/80 mmHg
  { name: "bp", regex: /\b\d{2,3}\/\d{2,3}(?:\s*mmHg)?\b/gi },
  // Key medical tokens / test names / drugs
  {
    name: "medical_token",
    regex:
      /\b(?:HbA1c|TSH|PT\/INR|INR|Hb|Hemoglobin|WBC|RBC|Platelet\s+Count|Platelets|Creatinine|LDL|HDL|VLDL|Cholesterol|Triglycerides|Bilirubin|Urea|BUN|Glucose|FBS|PPBS|RBS|SGOT|AST|SGPT|ALT|Alkaline\s+Phosphatase|ALP|Total\s+Protein|Albumin|Globulin|Calcium|Sodium|Potassium|Chloride|Uric\s+Acid|ESR|CRP|Vitamin\s+D|Vitamin\s+B12|Ferritin|Iron|TIBC|PSA|FT3|FT4|Troponin|D-Dimer|Metformin|Atorvastatin|Telmisartan|Amlodipine|Paracetamol|Azithromycin|Amoxicillin)\b/gi,
  },
  // Standalone numbers (integers / floats)
  { name: "number_standalone", regex: /\b\d+(?:\.\d+)?\b/g },
];

function maskMedicalTokens(text) {
  if (!text || typeof text !== "string") {
    return { maskedText: text || "", placeholders: [] };
  }

  const matches = [];
  for (const { regex } of MEDICAL_PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
      });
    }
  }

  // Deduplicate overlapping ranges: sort by start ascending, then length descending
  matches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });

  const cleanMatches = [];
  let lastEnd = -1;
  for (const match of matches) {
    if (match.start >= lastEnd) {
      cleanMatches.push(match);
      lastEnd = match.end;
    }
  }

  // Construct masked text and placeholder objects (1-indexed ⟦1⟧, ⟦2⟧...)
  const placeholders = [];
  let maskedText = "";
  let currIdx = 0;

  for (let i = 0; i < cleanMatches.length; i++) {
    const match = cleanMatches[i];
    maskedText += text.slice(currIdx, match.start);
    const placeholder = `⟦${i + 1}⟧`;
    maskedText += placeholder;
    placeholders.push({
      placeholder,
      original: match.text,
      index: i + 1,
    });
    currIdx = match.end;
  }
  maskedText += text.slice(currIdx);

  return { maskedText, placeholders };
}

function unmaskMedicalTokens(text, placeholders) {
  if (!text || !placeholders || !placeholders.length) return text || "";
  let result = text;
  for (const { original, index } of placeholders) {
    const regex = new RegExp(`⟦\\s*${index}\\s*⟧`, "g");
    result = result.replace(regex, original);
  }
  return result;
}

function validatePlaceholderIntegrity(translatedText, placeholders) {
  const count = Array.isArray(placeholders) ? placeholders.length : Number(placeholders) || 0;
  if (!translatedText || typeof translatedText !== "string") {
    return count === 0;
  }

  const foundPlaceholders = translatedText.match(/⟦\s*\d+\s*⟧/g) || [];

  if (foundPlaceholders.length !== count) {
    return false;
  }

  for (let i = 1; i <= count; i++) {
    const pattern = new RegExp(`⟦\\s*${i}\\s*⟧`, "g");
    const occurrences = translatedText.match(pattern);
    if (!occurrences || occurrences.length !== 1) {
      return false;
    }
  }

  return true;
}

function splitSentences(text) {
  if (!text || typeof text !== "string") return [];
  const protectedText = text.replace(
    /\b(Dr|Mr|Mrs|Ms|Prof|Sr|Jr|Tab|Cap|Inj|vs|e\.g|i\.e)\./gi,
    "$1⟦DOT⟧",
  );
  const rawSentences = protectedText.split(/(?<=[.!?;\n])\s+/);
  return rawSentences.map((s) => s.replace(/⟦DOT⟧/g, ".").trim()).filter((s) => s.length > 0);
}

function generateTranslationCacheKey(text, targetLang, modelName) {
  const content = `${String(text || "").trim()}:${String(targetLang || "")
    .trim()
    .toLowerCase()}:${String(modelName || "")
    .trim()
    .toLowerCase()}`;
  return crypto.createHash("sha256").update(content).digest("hex");
}

module.exports = {
  cleanOCRText,
  stripThinking,
  sanitizeLLMOutput,
  validateIndicScriptRatio,
  maskMedicalTokens,
  unmaskMedicalTokens,
  validatePlaceholderIntegrity,
  splitSentences,
  generateTranslationCacheKey,
};
