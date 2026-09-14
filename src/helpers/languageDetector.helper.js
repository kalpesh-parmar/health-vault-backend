/**
 * Language & Script Identification Helper (REQ-01, REQ-02)
 * High-speed in-process Unicode script analysis and Indic language identification
 * Supports: English, Gujarati, Hindi, Marathi, Tamil, and mixed scripts.
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

/**
 * Detect scripts and languages in medical text
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
      // If ambiguous Devanagari, respect userHint if it's Hindi or Marathi
      if (userHint && userHint.toLowerCase() === "marathi") {
        scores.marathi = devanagariCount;
      } else if (userHint && userHint.toLowerCase() === "hindi") {
        scores.hindi = devanagariCount;
      } else {
        // Default to hindi as primary, marathi as secondary
        scores.hindi = devanagariCount;
        scores.marathi = Math.floor(devanagariCount * 0.5);
      }
    }
  }

  // Sort languages by character count in descending order
  const rankedLanguages = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);

  // If medical document has Latin terms (medicines, dosages, lab tests) alongside Indic, ensure English is present
  const isIndic = gujaratiCount > 0 || tamilCount > 0 || devanagariCount > 0;
  if (isIndic && latinCount >= 3 && !rankedLanguages.includes("english")) {
    rankedLanguages.push("english");
  }

  // Always ensure at least English if nothing was detected
  if (rankedLanguages.length === 0) {
    rankedLanguages.push("english");
  }

  // Integrate userHint if provided and not already included
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

module.exports = {
  detectLanguages,
};
