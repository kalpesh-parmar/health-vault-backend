/**
 * Language & Script Identification Helper (REQ-ML-01, REQ-ML-02, REQ-ML-04, REQ-ML-05)
 * High-speed in-process Unicode script analysis and Indic language identification.
 * Supports: English, Gujarati, Hindi, Marathi, Tamil across native scripts and Romanized transliterations.
 */

const MARATHI_DISTINCTIVE_CHAR = /\u0933/g; // ळ (Lla)

const MARATHI_KEYWORDS = [
  "आणि",
  "आहे",
  "आहेत",
  "औषध",
  "औषधे",
  "गोळ्या",
  "गोळी",
  "सकाळ",
  "दुपार",
  "संध्याकाळ",
  "रात्र",
  "रुग्ण",
  "तपासणी",
  "तपासावे",
  "दिनांक",
  "पत्ता",
  "वय",
  "नाव",
  "उपचार",
  "घ्यावे",
  "करावे",
  "माझ्या",
  "माझे",
  "माझी",
  "सांगा",
  "सांगणे",
  "सांगू",
  "रिपोर्टचा",
  "रिपोर्टची",
  "रिपोर्टचे",
  "कसा",
  "कशी",
  "काय",
];

const HINDI_KEYWORDS = [
  "और",
  "है",
  "हैं",
  "था",
  "थी",
  "थे",
  "दवाई",
  "दवा",
  "गोलियां",
  "गोली",
  "सुबह",
  "दोपहर",
  "शाम",
  "रात",
  "मरीज",
  "जांच",
  "कृपया",
  "खुराक",
  "लक्षण",
  "करना",
  "लेना",
  "दिए",
];

// Romanized Indic distinctive keywords & particles
const ROMANIZED_GUJARATI_WORDS = [
  "mara",
  "mari",
  "maro",
  "maru",
  "tamara",
  "tamari",
  "tamaro",
  "tamaru",
  "apo",
  "aapo",
  "nathi",
  "chhe",
  "che",
  "su",
  "shu",
  "aavi",
  "aavyo",
  "hata",
  "hati",
  "hatu",
  "ni",
  "na",
  "nu",
  "ma",
  "thi",
  "vishe",
  "saransh",
  "samjhavo",
  "samjhao",
  "tapas",
  "reportma",
  "ketlu",
  "ketla",
];

const ROMANIZED_HINDI_WORDS = [
  "mera",
  "meri",
  "mere",
  "apka",
  "apki",
  "apke",
  "batao",
  "bataiye",
  "samjhao",
  "samjhaiye",
  "kya",
  "kyu",
  "kyon",
  "hai",
  "hain",
  "tha",
  "thi",
  "hoga",
  "hogi",
  "ka",
  "ki",
  "ke",
  "ko",
  "se",
  "mein",
  "kripya",
  "dawa",
  "dawai",
  "kitna",
  "kitni",
  "jaanch",
  "karo",
];

const ROMANIZED_MARATHI_WORDS = [
  "majha",
  "majhi",
  "majhe",
  "majhya",
  "amcha",
  "amchi",
  "amche",
  "sanga",
  "sangava",
  "aahe",
  "aahet",
  "navhte",
  "hoti",
  "hote",
  "cha",
  "chi",
  "che",
  "chya",
  "madhe",
  "kiti",
  "kasa",
  "kashi",
  "kay",
  "aushadh",
  "aushadhe",
];

const ROMANIZED_TAMIL_WORDS = [
  "ennoda",
  "ungal",
  "ungaloda",
  "sollunga",
  "solla",
  "solavum",
  "irukku",
  "irukkirathu",
  "illai",
  "enna",
  "yeppadi",
  "patri",
  "endru",
  "aana",
  "kurippu",
  "marunthu",
  "marundhugal",
  "paritchai",
  "eppadi",
  "theriyuma",
];

// Explicit output-language override patterns
const LANGUAGE_OVERRIDE_PATTERNS = [
  {
    language: "english",
    regex:
      /\b(?:in\s+english|english\s+ma|english\s+me|english\s+mein|english\s+madhe|english\s+la|english\s+il)\b/i,
  },
  {
    language: "hindi",
    regex:
      /\b(?:in\s+hindi|hindi\s+ma|hindi\s+me|hindi\s+mein|hindi\s+madhe|hindi\s+la|hindi\s+il)\b/i,
  },
  {
    language: "gujarati",
    regex: /\b(?:in\s+gujarati|gujarati\s+ma|gujarati\s+me|gujarati\s+mein)\b/i,
  },
  {
    language: "marathi",
    regex: /\b(?:in\s+marathi|marathi\s+madhe|marathi\s+me|marathi\s+mein)\b/i,
  },
  { language: "tamil", regex: /\b(?:in\s+tamil|tamil\s+il|tamil\s+la)\b/i },
];

function countMatches(str, regex) {
  if (!str) return 0;
  const matches = str.match(regex);
  return matches ? matches.length : 0;
}

function countWordOccurrences(text, words) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let count = 0;
  for (const word of words) {
    let pos = lower.indexOf(word);
    while (pos !== -1) {
      count++;
      pos = lower.indexOf(word, pos + word.length);
    }
  }
  return count;
}

function countRomanizedTokens(text, wordList) {
  if (!text) return 0;
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/);
  let count = 0;
  for (const token of tokens) {
    if (token && wordList.includes(token)) {
      count++;
    }
  }
  return count;
}

/**
 * Extracts explicit response-language overrides like "in English", "English ma", "Hindi me".
 * @param {string} text - User prompt
 * @returns {{ hasOverride: boolean, targetLanguage: string|null, cleanText: string }}
 */
function extractLanguageOverride(text) {
  if (!text || typeof text !== "string") {
    return { hasOverride: false, targetLanguage: null, cleanText: text || "" };
  }

  for (const pattern of LANGUAGE_OVERRIDE_PATTERNS) {
    if (pattern.regex.test(text)) {
      const clean = text.replace(pattern.regex, " ").replace(/\s+/g, " ").trim();
      return {
        hasOverride: true,
        targetLanguage: pattern.language,
        cleanText: clean,
      };
    }
  }

  return {
    hasOverride: false,
    targetLanguage: null,
    cleanText: text,
  };
}

/**
 * Detect scripts and languages in medical documents / OCR text (Legacy API)
 * @param {string} text - Raw or cleaned OCR text
 * @param {string} [userHint] - Optional user preferred language hint
 * @returns {{ detectedLanguages: string[], primaryLanguage: string, isIndic: boolean }}
 */
function detectLanguages(text, userHint = null) {
  if (!text || typeof text !== "string") {
    const fallback =
      userHint && userHint.toLowerCase() !== "english"
        ? [userHint.toLowerCase(), "english"]
        : ["english"];
    return {
      detectedLanguages: fallback,
      primaryLanguage: fallback[0],
      isIndic: false,
    };
  }

  const latinCount = countMatches(text, /[A-Za-z]/g);
  const gujaratiCount = countMatches(text, /[\u0A80-\u0AFF]/g);
  const tamilCount = countMatches(text, /[\u0B80-\u0BFF]/g);
  const devanagariCount = countMatches(text, /[\u0900-\u097F]/g);

  const scores = {};
  if (latinCount > 0) scores.english = latinCount;
  if (gujaratiCount > 0) scores.gujarati = gujaratiCount;
  if (tamilCount > 0) scores.tamil = tamilCount;

  if (devanagariCount > 0) {
    const marathiLlaCount = countMatches(text, MARATHI_DISTINCTIVE_CHAR);
    const marathiWordCount = countWordOccurrences(text, MARATHI_KEYWORDS);
    const hindiWordCount = countWordOccurrences(text, HINDI_KEYWORDS);

    const marathiScore = marathiLlaCount * 5 + marathiWordCount * 3;
    const hindiScore = hindiWordCount * 3;

    if (marathiScore > hindiScore) {
      scores.marathi = devanagariCount;
    } else if (hindiScore > marathiScore) {
      scores.hindi = devanagariCount;
    } else {
      if (userHint && userHint.toLowerCase() === "marathi") {
        scores.marathi = devanagariCount;
      } else if (userHint && userHint.toLowerCase() === "hindi") {
        scores.hindi = devanagariCount;
      } else {
        scores.hindi = devanagariCount;
        scores.marathi = Math.floor(devanagariCount * 0.5);
      }
    }
  }

  const rankedLanguages = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);

  const isIndic = gujaratiCount > 0 || tamilCount > 0 || devanagariCount > 0;
  if (isIndic && latinCount >= 3 && !rankedLanguages.includes("english")) {
    rankedLanguages.push("english");
  }

  if (rankedLanguages.length === 0) {
    rankedLanguages.push("english");
  }

  if (userHint && typeof userHint === "string") {
    const hintNorm = userHint.toLowerCase().trim();
    if (hintNorm && !rankedLanguages.includes(hintNorm)) {
      rankedLanguages.push(hintNorm);
    }
  }

  return {
    detectedLanguages: rankedLanguages,
    primaryLanguage: rankedLanguages[0] || "english",
    isIndic,
  };
}

/**
 * Detailed offline language and script detector for conversational chat queries.
 * Accurately detects Native Indic scripts and Romanized Indic transliterations.
 * @param {string} text - User prompt
 * @param {string} [userHint] - Optional session hint
 * @returns {{ language: string, script: string, inputScript: string, responseLanguage: string, responseScript: string, isRomanized: boolean, detectionConfidence: number, ambiguityFlag: boolean, hasExplicitOverride: boolean, cleanText: string }}
 */
function detectChatLanguage(text, userHint = null) {
  if (!text || typeof text !== "string" || !text.trim()) {
    return {
      language: "english",
      script: "Latn",
      inputScript: "Latn",
      responseLanguage: "english",
      responseScript: "Latn",
      isRomanized: false,
      detectionConfidence: 1.0,
      ambiguityFlag: false,
      hasExplicitOverride: false,
      cleanText: "",
    };
  }

  // 1. Check for explicit response language override first
  const override = extractLanguageOverride(text);
  const evaluationText = override.hasOverride ? override.cleanText : text;

  // 2. Check Unicode Native Scripts
  const gujaratiCount = countMatches(evaluationText, /[\u0A80-\u0AFF]/g);
  const tamilCount = countMatches(evaluationText, /[\u0B80-\u0BFF]/g);
  const devanagariCount = countMatches(evaluationText, /[\u0900-\u097F]/g);

  if (gujaratiCount >= 2) {
    const targetLang = override.hasOverride ? override.targetLanguage : "gujarati";
    return {
      language: targetLang,
      script: targetLang === "english" ? "Latn" : "Gujr",
      inputScript: "Gujr",
      responseLanguage: targetLang,
      responseScript: targetLang === "english" ? "Latn" : "Gujr",
      isRomanized: false,
      detectionConfidence: 0.98,
      ambiguityFlag: false,
      hasExplicitOverride: override.hasOverride,
      cleanText: evaluationText,
    };
  }

  if (tamilCount >= 2) {
    const targetLang = override.hasOverride ? override.targetLanguage : "tamil";
    return {
      language: targetLang,
      script: targetLang === "english" ? "Latn" : "Taml",
      inputScript: "Taml",
      responseLanguage: targetLang,
      responseScript: targetLang === "english" ? "Latn" : "Taml",
      isRomanized: false,
      detectionConfidence: 0.98,
      ambiguityFlag: false,
      hasExplicitOverride: override.hasOverride,
      cleanText: evaluationText,
    };
  }

  if (devanagariCount >= 2) {
    const marathiLlaCount = countMatches(evaluationText, MARATHI_DISTINCTIVE_CHAR);
    const marathiWordCount = countWordOccurrences(evaluationText, MARATHI_KEYWORDS);
    const hindiWordCount = countWordOccurrences(evaluationText, HINDI_KEYWORDS);

    let baseLang = "hindi";
    if (marathiLlaCount > 0 || marathiWordCount > hindiWordCount) {
      baseLang = "marathi";
    }

    const targetLang = override.hasOverride ? override.targetLanguage : baseLang;
    return {
      language: targetLang,
      script: targetLang === "english" ? "Latn" : "Deva",
      inputScript: "Deva",
      responseLanguage: targetLang,
      responseScript: targetLang === "english" ? "Latn" : "Deva",
      isRomanized: false,
      detectionConfidence: 0.95,
      ambiguityFlag: false,
      hasExplicitOverride: override.hasOverride,
      cleanText: evaluationText,
    };
  }

  // 3. Latin script - evaluate Romanized Indic particles vs English
  const gujTokens = countRomanizedTokens(evaluationText, ROMANIZED_GUJARATI_WORDS);
  const hinTokens = countRomanizedTokens(evaluationText, ROMANIZED_HINDI_WORDS);
  const marTokens = countRomanizedTokens(evaluationText, ROMANIZED_MARATHI_WORDS);
  const tamTokens = countRomanizedTokens(evaluationText, ROMANIZED_TAMIL_WORDS);

  const romanizedScores = {
    gujarati: gujTokens,
    hindi: hinTokens,
    marathi: marTokens,
    tamil: tamTokens,
  };

  const topRomanized = Object.entries(romanizedScores).sort((a, b) => b[1] - a[1])[0];

  if (topRomanized && topRomanized[1] >= 1) {
    const detectedRegional = topRomanized[0];
    const targetLang = override.hasOverride ? override.targetLanguage : detectedRegional;
    return {
      language: targetLang,
      inputLanguage: detectedRegional,
      script: "Latn",
      inputScript: "Latn",
      responseLanguage: targetLang,
      responseScript:
        targetLang === "english"
          ? "Latn"
          : targetLang === "gujarati"
            ? "Gujr"
            : targetLang === "tamil"
              ? "Taml"
              : "Deva",
      isRomanized: true,
      detectionConfidence: Math.min(0.95, 0.75 + topRomanized[1] * 0.1),
      ambiguityFlag: false,
      hasExplicitOverride: override.hasOverride,
      cleanText: evaluationText,
    };
  }

  // 4. Default Latin is English
  const englishIndicators = [
    "what",
    "is",
    "my",
    "how",
    "are",
    "tell",
    "show",
    "give",
    "can",
    "you",
    "when",
    "where",
    "which",
    "why",
    "the",
    "value",
    "report",
    "result",
    "please",
    "explain",
    "summarize",
    "summary",
    "normal",
    "high",
    "low",
    "level",
    "levels",
    "about",
  ];
  const lowerTokens = evaluationText.toLowerCase().split(/[^a-z0-9]+/);
  const hasEnglishTokens = lowerTokens.some((t) => englishIndicators.includes(t));

  const targetLang = override.hasOverride
    ? override.targetLanguage
    : hasEnglishTokens
      ? "english"
      : userHint && userHint !== "english"
        ? userHint
        : "english";
  return {
    language: targetLang,
    inputLanguage: targetLang,
    script: "Latn",
    inputScript: "Latn",
    responseLanguage: targetLang,
    responseScript: "Latn",
    isRomanized: false,
    detectionConfidence: 0.9,
    ambiguityFlag: false,
    hasExplicitOverride: override.hasOverride,
    cleanText: evaluationText,
  };
}

module.exports = {
  detectLanguages,
  detectChatLanguage,
  extractLanguageOverride,
};
