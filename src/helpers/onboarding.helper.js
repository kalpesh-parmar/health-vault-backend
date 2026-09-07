/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { aiClient } = require("../services/ai");

function cleanAndParseJson(text) {
  if (text && typeof text === "object") {
    text = text.text || JSON.stringify(text);
  }

  if (!text || typeof text !== "string") {
    throw new Error(`Empty or invalid response type from AI model. Raw response: "${text}"`);
  }

  let cleaned = text.trim();
  // Strip reasoning/think blocks emitted by Ollama reasoning models
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
  cleaned = cleaned
    .replace(/^```[a-zA-Z]*/, "")
    .replace(/```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Parsed result is not a JSON object");
    }
    return parsed;
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const matchText = jsonMatch[0].trim();
      try {
        const parsed = JSON.parse(matchText);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed;
        }
      } catch (err) {
        console.error("[OnboardingHelper] Failed parsing matching JSON block:", matchText, err);
      }
    }
    console.error("[OnboardingHelper] JSON parse failed. Raw AI text was:", text);
    throw new Error(`AI did not return a valid JSON object. Raw AI Response: "${text}"`);
  }
}

function getLocalizedTranslation(key, language) {
  try {
    let langCode = "en";
    if (language === "hindi" || language === "hi") langCode = "hi";
    else if (language === "marathi" || language === "mr") langCode = "mr";
    else if (language === "gujarati" || language === "gu") langCode = "gu";
    else if (language === "tamil" || language === "ta") langCode = "ta";

    const filePath = path.resolve(__dirname, `../i18n/onboarding/${langCode}.json`);
    if (fs.existsSync(filePath)) {
      const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (content && content[key]) {
        return content[key];
      }
    }

    // Strict fallback: if missing in target, resolve from en.json
    if (langCode !== "en") {
      const enFilePath = path.resolve(__dirname, "../i18n/onboarding/en.json");
      if (fs.existsSync(enFilePath)) {
        const enContent = JSON.parse(fs.readFileSync(enFilePath, "utf8"));
        if (enContent && enContent[key]) {
          return enContent[key];
        }
      }
    }
  } catch (err) {
    console.warn(`[OnboardingHelper] Failed to load local i18n file for ${language}:`, err.message);
  }
  return null;
}

function normalizeGenderLocally(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const cleaned = rawText
    .trim()
    .replace(/^['"“`’\s.,!?-]+|['"“`’\s.,!?-]+$/g, "")
    .toLowerCase();
  if (!cleaned) return null;

  const maleSet = new Set(["male", "m", "man", "boy", "guy", "पुरुष", "ஆண்"]);

  const femaleSet = new Set(["female", "f", "woman", "girl", "lady", "महिला", "સ્ત્રી", "பெண்"]);

  const otherSet = new Set([
    "other",
    "o",
    "non-binary",
    "nonbinary",
    "nb",
    "prefer not to say",
    "अन्य",
    "மற்றவை",
  ]);

  // Dynamically pull localized tokens from existing i18n dictionaries
  for (const lang of ["gu", "hi", "mr", "ta", "en"]) {
    const mVal = getLocalizedTranslation("onboarding.fieldValue.male", lang);
    if (mVal) maleSet.add(mVal.trim().toLowerCase());

    const fVal = getLocalizedTranslation("onboarding.fieldValue.female", lang);
    if (fVal) femaleSet.add(fVal.trim().toLowerCase());

    const oVal = getLocalizedTranslation("onboarding.fieldValue.other", lang);
    if (oVal) otherSet.add(oVal.trim().toLowerCase());
  }

  if (maleSet.has(cleaned)) return "male";
  if (femaleSet.has(cleaned)) return "female";
  if (otherSet.has(cleaned)) return "other";

  return null;
}

function isValidGender(genderStr) {
  if (!genderStr || typeof genderStr !== "string") return false;
  const lower = genderStr.trim().toLowerCase();
  return lower === "male" || lower === "female" || lower === "other";
}

function isValidFirstName(name) {
  if (!name || typeof name !== "string") return false;
  const cleaned = name.trim();
  return cleaned.length >= 1 && /^[\p{L}\s.'-]+$/u.test(cleaned);
}

function isValidLastName(name) {
  if (!name || typeof name !== "string") return false;
  const cleaned = name.trim();
  return cleaned.length >= 1 && /^[\p{L}\s.'-]+$/u.test(cleaned);
}

function normalizeDOB(dobStr) {
  if (!dobStr || typeof dobStr !== "string") return "";
  let cleaned = dobStr.trim();

  // Translate Gujarati (૦-૯) and Devanagari (०-९) digits to ASCII (0-9)
  const gujDigits = "૦૧૨૩૪૫૬૭૮૯";
  const devDigits = "०१२૩૪૫૬૭૮૯";
  cleaned = cleaned
    .replace(/[૦-૯]/g, (d) => gujDigits.indexOf(d))
    .replace(/[०-९]/g, (d) => devDigits.indexOf(d));

  // Regex to check YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned;
  }
  // Check DD.MM.YYYY, DD/MM/YYYY or DD-MM-YYYY
  const matchDmy = cleaned.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (matchDmy) {
    const day = matchDmy[1].padStart(2, "0");
    const month = matchDmy[2].padStart(2, "0");
    const year = matchDmy[3];
    return `${year}-${month}-${day}`;
  }
  return "";
}

function normalizePhone(phoneStr) {
  if (!phoneStr) return null;
  const cleaned = String(phoneStr)
    .trim()
    .replace(/[^\d+]/g, "");
  return cleaned.length >= 7 && cleaned.length <= 15 ? cleaned : null;
}

function validateEditedFields(editedData) {
  if (!editedData || typeof editedData !== "object") return false;

  if (
    editedData.firstName !== undefined &&
    editedData.firstName !== null &&
    editedData.firstName !== ""
  ) {
    if (!isValidFirstName(editedData.firstName)) return false;
  }
  if (
    editedData.lastName !== undefined &&
    editedData.lastName !== null &&
    editedData.lastName !== ""
  ) {
    if (!isValidLastName(editedData.lastName)) return false;
  }
  if (editedData.gender !== undefined && editedData.gender !== null && editedData.gender !== "") {
    const normGen = normalizeGenderLocally(String(editedData.gender));
    if (!normGen || !isValidGender(normGen)) return false;
  }
  if (
    editedData.dateOfBirth !== undefined &&
    editedData.dateOfBirth !== null &&
    editedData.dateOfBirth !== ""
  ) {
    const normDob = normalizeDOB(String(editedData.dateOfBirth));
    if (!normDob) return false;
  }
  if (
    editedData.phoneNumber !== undefined &&
    editedData.phoneNumber !== null &&
    editedData.phoneNumber !== ""
  ) {
    const normPhone = normalizePhone(String(editedData.phoneNumber));
    if (!normPhone) return false;
  }

  return true;
}

function normalizeFlowModeLocally(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const cleaned = rawText.trim().toUpperCase();
  const uploadSet = new Set(["UPLOAD", "DOCUMENT_UPLOADED", "DOC_UPLOAD"]);
  const manualSet = new Set(["MANUAL", "MANUAL_ENTRY", "SKIP", "SKIP_QUESTION"]);
  if (uploadSet.has(cleaned)) return "UPLOAD";
  if (manualSet.has(cleaned)) return "MANUAL";
  return null;
}

function splitName(fullName) {
  if (!fullName || typeof fullName !== "string") {
    return { firstName: "", lastName: "" };
  }
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function normalizeName(name) {
  if (!name) return null;
  const cleaned = String(name).trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  return cleaned;
}

function isSamePhone(p1, p2) {
  if (!p1 || !p2) return false;
  const digits1 = String(p1).replace(/\D/g, "");
  const digits2 = String(p2).replace(/\D/g, "");

  if (digits1.length === 0 || digits2.length === 0) return false;

  const last10_1 = digits1.slice(-10);
  const last10_2 = digits2.slice(-10);

  if (last10_1 !== last10_2) return false;

  if (digits1.length > 10 && digits2.length > 10) {
    const cc1 = digits1.slice(0, digits1.length - 10);
    const cc2 = digits2.slice(0, digits2.length - 10);
    return cc1 === cc2;
  }

  return true;
}

function normalizeFieldVal(val, type) {
  if (val === undefined || val === null) return "";
  const str = String(val).trim();
  const lower = str.toLowerCase();
  if (lower === "" || lower === "null" || lower === "undefined" || lower === "nan") {
    return "";
  }
  if (type === "name") {
    return lower.replace(/\s+/g, " ");
  }
  if (type === "gender") {
    return lower;
  }
  return str;
}
async function translateMessage(text, language) {
  if (!text || language === "english") return text;

  try {
    return await aiClient.translate(text, "english", language);
  } catch (err) {
    console.error(`[OnboardingService] Failed to translate text to ${language}:`, err);
    return text; // Fallback to English
  }
}
async function getLocalizedText(key, defaultEnglish, language, variables = {}) {
  let text = getLocalizedTranslation(key, language);
  if (!text) {
    text = await translateMessage(defaultEnglish, language);
  }
  if (text && typeof text === "string") {
    for (const [varName, varVal] of Object.entries(variables)) {
      text = text.replace(new RegExp(`\\{${varName}\\}`, "g"), String(varVal));
    }
  }
  return text;
}

module.exports = {
  cleanAndParseJson,
  getLocalizedTranslation,
  normalizeGenderLocally,
  isValidGender,
  isValidFirstName,
  isValidLastName,
  normalizeDOB,
  normalizePhone,
  validateEditedFields,
  normalizeFlowModeLocally,
  splitName,
  normalizeName,
  isSamePhone,
  normalizeFieldVal,
  getLocalizedText,
};
