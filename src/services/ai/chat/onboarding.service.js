/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { ollamaClient } = require("../clients/ollamaClient");
const aiClient = require("../clients/aiClient.service");
const { env } = require("../../../configs/env");
// const { ONBOARDING_SYSTEM_PROMPT } = require("../prompts");
const patientRepository = require("../../../repositories/patientRepository");
const userOnboardingRepository = require("../../../repositories/userOnboardingRepository");
const authProviderRepository = require("../../../repositories/authProviderRepository");
const { normalizeLanguage } = require("../../../utils/commonUtils");
const medicationService = require("../../medication.service");
const { languageTypeValues, languageNativeLabels } = require("../../../enums/languageType");
const { bloodGroupTypeValues } = require("../../../enums/bloodGroupType");
// const { TRANSLATION_SYSTEM_PROMPT } = require("../prompts");
const { medicationTypeValues } = require("../../../enums/medicationType");
const { frequencyTypeValues } = require("../../../enums/frequencyType");
const { chatService } = require("./chat.service");
const medicationReminderService = require("../../medicationReminder.service");
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
const { eq, desc } = require("drizzle-orm");
const { normalizeMedicine } = require("../helpers/medicineNormalize");

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
        console.error("[OnboardingService] Failed parsing matching JSON block:", matchText, err);
      }
    }
    console.error("[OnboardingService] JSON parse failed. Raw AI text was:", text);
    throw new Error(`AI did not return a valid JSON object. Raw AI Response: "${text}"`);
  }
}

function normalizeGenderLocally(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const cleaned = rawText
    .trim()
    .replace(/^['"“`’\s.,!?-]+|['"“`’\s.,!?-]+$/g, "")
    .toLowerCase();
  if (!cleaned) return null;

  const maleSet = new Set(["male", "m", "man", "boy", "guy", "पुरुष", "ஆண்"]);

  const femaleSet = new Set(["female", "f", "woman", "girl", "lady", "महिला", "स्त्री", "பெண்"]);

  const otherSet = new Set([
    "other",
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

function normalizePhone(phoneStr) {
  if (!phoneStr) return null;
  const cleaned = String(phoneStr)
    .trim()
    .replace(/[^\d+]/g, "");
  return cleaned.length >= 7 && cleaned.length <= 15 ? cleaned : null;
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

function getLocalizedTranslation(key, language) {
  try {
    let langCode = "en";
    if (language === "hindi" || language === "hi") langCode = "hi";
    else if (language === "marathi" || language === "mr") langCode = "mr";
    else if (language === "gujarati" || language === "gu") langCode = "gu";
    else if (language === "tamil" || language === "ta") langCode = "ta";

    const filePath = path.resolve(__dirname, `../../../i18n/onboarding/${langCode}.json`);
    if (fs.existsSync(filePath)) {
      const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (content && content[key]) {
        return content[key];
      }
    }

    // Strict fallback: if missing in target, resolve from en.json
    if (langCode !== "en") {
      const enFilePath = path.resolve(__dirname, "../../../i18n/onboarding/en.json");
      if (fs.existsSync(enFilePath)) {
        const enContent = JSON.parse(fs.readFileSync(enFilePath, "utf8"));
        if (enContent && enContent[key]) {
          return enContent[key];
        }
      }
    }
  } catch (err) {
    console.warn(
      `[OnboardingService] Failed to load local i18n file for ${language}:`,
      err.message,
    );
  }
  return null;
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

function normalizeDOB(dobStr) {
  if (!dobStr || typeof dobStr !== "string") return "";
  let cleaned = dobStr.trim();

  // Translate Gujarati (૦-૯) and Devanagari (०-९) digits to ASCII (0-9)
  const gujDigits = "૦૧૨૩૪૫૬૭૮૯";
  const devDigits = "०१२३४५६७८९";
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

async function extractFieldFromMessage(fieldType, text, _lang) {
  // Direct check for language independent skip patterns
  const lower = text.trim().toLowerCase();
  const skipPatterns = ["skip", "skip question", "skip_question", "question skip", "skipquestion"];
  if (skipPatterns.includes(lower)) {
    return null;
  }

  // --- CLOSED CHOICE FAST-PATHS (NO LLM CALL) ---
  if (fieldType === "dateOfBirth") {
    const fastDob = normalizeDOB(text);
    if (fastDob) {
      return fastDob;
    }
  } else if (fieldType === "flowMode") {
    const fastFm = normalizeFlowModeLocally(text);
    if (fastFm !== null) {
      return fastFm;
    }
  } else if (fieldType === "gender") {
    const fastGen = normalizeGenderLocally(text);
    if (fastGen !== null) {
      return fastGen;
    }
  } else if (fieldType === "bloodGroup") {
    const bgClean = text.trim().toUpperCase();
    const validBg = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
    if (validBg.includes(bgClean)) {
      return bgClean;
    }
  } else if (fieldType === "documentConfirmed" || fieldType === "yesNo") {
    const trimmed = text.trim().toLowerCase();
    const yesSet = ["yes", "y", "ha", "હા", "हाँ", "ஆம்", "સાચું", "true"];
    const noSet = ["no", "n", "na", "ના", "नहीं", "இல்லை", "ખોટું", "false"];
    if (yesSet.includes(trimmed)) return "YES";
    if (noSet.includes(trimmed)) return "NO";
  } else if (fieldType === "preferredLanguage") {
    const trimmed = text.trim().toLowerCase();
    if (["english", "eng", "en", "અંગ્રેજી"].includes(trimmed)) return "english";
    if (["gujarati", "gu", "ગુજરાતી"].includes(trimmed)) return "gujarati";
    if (["hindi", "hi", "હિન્દી"].includes(trimmed)) return "hindi";
    if (["marathi", "mr", "મરાઠી"].includes(trimmed)) return "marathi";
    if (["tamil", "ta", "તમિલ"].includes(trimmed)) return "tamil";
  } else if (fieldType === "medicationType") {
    const cleaned = text.trim().toUpperCase();
    if (medicationTypeValues.includes(cleaned)) {
      return cleaned;
    }
  } else if (fieldType === "frequency") {
    const cleaned = text.trim().toUpperCase();
    if (frequencyTypeValues.includes(cleaned)) {
      return cleaned;
    }
  } else if (fieldType === "foodFrequency") {
    const cleaned = text.trim().toUpperCase();
    if (["BEFORE_FOOD", "AFTER_FOOD"].includes(cleaned)) {
      return cleaned;
    }
  }

  let contextPrompt = "";
  if (fieldType === "preferredLanguage") {
    contextPrompt =
      "Identify user language preference. Return strictly either 'english', 'gujarati', 'hindi', 'marathi', or 'tamil'.";
  } else if (fieldType === "flowMode") {
    contextPrompt =
      "Identify user choice for document upload vs manual flow. Return strictly either 'UPLOAD' or 'MANUAL'.";
  } else if (fieldType === "documentConfirmed") {
    contextPrompt =
      "Determine if user confirmed (YES) or rejected (NO) the extracted document details. Return strictly either 'YES' or 'NO'.";
  } else if (fieldType === "firstName") {
    contextPrompt =
      "Extract the name from the user input (e.g. Kalpesh, or Kalpesh Parmar). Transliterate Gujarati, Hindi, Marathi, or Tamil names to English.";
  } else if (fieldType === "lastName") {
    contextPrompt =
      "Extract the last name from the user input. Transliterate or translate Gujarati, Hindi, Marathi, or Tamil names to English (e.g. શાહ -> Shah, शाह -> Shah, ஷா -> Shah).";
  } else if (fieldType === "dateOfBirth") {
    contextPrompt =
      "Extract and normalize the date of birth to YYYY-MM-DD. Support mixed formats like 'Jan 1st 1989' or '૧ જાન્યુઆરી ૧૯૯૯' -> '1999-01-01'. Return null if not a valid date.";
  } else if (fieldType === "gender") {
    contextPrompt =
      "Extract and normalize gender strictly to lowercase 'male', 'female', or 'other'. Return null if not determined.";
  } else if (fieldType === "bloodGroup") {
    contextPrompt =
      "Extract and normalize blood group to A+/A-/B+/B-/AB+/AB-/O+/O-. Return null if not found.";
  } else if (fieldType === "allergies") {
    contextPrompt =
      'Extract a list of allergies from the text. Return a JSON array of strings in the \'value\' field, e.g. ["dust", "peanuts"]. If none, return [].';
  } else if (fieldType === "yesNo") {
    contextPrompt =
      "Determine if user chose YES or NO. Return strictly either 'YES' or 'NO'. NEVER return 'YES/NO' combined.";
  } else if (fieldType === "medicationName") {
    contextPrompt = "Extract the name of the medicine from the user input.";
  } else if (fieldType === "medicationType") {
    contextPrompt = `Extract the type of medicine. Return strictly one of: ${medicationTypeValues.map((v) => `'${v}'`).join(", ")}.`;
  } else if (fieldType === "dosePerIntake") {
    contextPrompt = "Extract the numeric dose per intake. Return a number, e.g., 1, 1.5, 2.";
  } else if (fieldType === "frequency") {
    contextPrompt = `Extract the frequency of taking the medicine. Return strictly one of: ${frequencyTypeValues.map((v) => `'${v}'`).join(", ")}.`;
  } else if (fieldType === "medicationSchedule") {
    contextPrompt =
      "Extract the schedule times as a JSON object with keys like 'MORNING', 'AFTERNOON', 'EVENING', 'NIGHT' and values as time strings like '09:00:00'. If missing, return null.";
  } else if (fieldType === "time24Hour") {
    contextPrompt =
      "Extract a time of day from the text and format it as HH:MM:SS in 24-hour format (e.g. '09:00:00' or '22:00:00').";
  } else if (fieldType === "foodFrequency") {
    contextPrompt =
      "Extract the food frequency instruction. Return strictly 'BEFORE_FOOD' or 'AFTER_FOOD'.";
  } else if (fieldType === "totalQuantity") {
    contextPrompt = "Extract the total quantity of the medicine as a number, e.g. 10 or 30.";
  } else if (fieldType === "startDate") {
    contextPrompt =
      "Extract the date when the medicine should be started. Return strictly in YYYY-MM-DD format (e.g. 2024-01-01). Support formats like DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY.";
  }

  const messages = [
    {
      role: "system",
      content: `You are an AI assistant that extracts and normalizes values from user input.
Rule: Return ONLY a JSON object with a single key "value". If the value is missing or invalid, set "value" to null (or [] for allergies). Do not explain or output markdown code blocks. Response must be parseable by JSON.parse().`,
    },
    {
      role: "user",
      content: `Field: ${fieldType === "firstName" ? "Name" : fieldType}
Instructions: ${contextPrompt}
User Input: "${text}"`,
    },
  ];

  try {
    const response = await ollamaClient.chat(messages, env.chatModel, {
      temperature: 0.1,
      maxTokens: 64,
      think: false,
      timeout: 8000,
    });

    let parsed;
    try {
      parsed = cleanAndParseJson(response);
    } catch (parseErr) {
      console.warn(`[OnboardingService] Failed to parse AI response for ${fieldType}:`, parseErr);
      const cleanedRaw =
        typeof response === "string"
          ? response
              .replace(/<think>[\s\S]*?<\/think>/gi, "")
              .replace(/^```(?:json)?|```$/gi, "")
              .trim()
          : "";
      if (
        cleanedRaw &&
        cleanedRaw.length < 100 &&
        !cleanedRaw.includes("{") &&
        !cleanedRaw.includes("[")
      ) {
        console.warn(
          `[OnboardingService] AI returned raw string instead of JSON for ${fieldType}: "${cleanedRaw}"`,
        );
        return cleanedRaw;
      }
      return null;
    }

    let resultVal;
    if (parsed.value !== undefined) resultVal = parsed.value;
    else if (parsed[fieldType] !== undefined) resultVal = parsed[fieldType];
    else if (fieldType === "firstName" && parsed.FullName !== undefined)
      resultVal = parsed.FullName;
    else if (fieldType === "firstName" && parsed.Name !== undefined) resultVal = parsed.Name;
    else {
      const keys = Object.keys(parsed);
      if (keys.length === 1) resultVal = parsed[keys[0]];
    }

    if (
      resultVal === null &&
      text &&
      text.length > 0 &&
      text.length < 50 &&
      !["skip", "no", "none"].includes(text.toLowerCase())
    ) {
      console.warn(
        `[OnboardingService] AI explicitly returned null for ${fieldType}. Falling back to raw user input: "${text}"`,
      );
      if (fieldType === "dateOfBirth") {
        const norm = normalizeDOB(text);
        return norm || null;
      }
      return text.trim();
    }

    if (resultVal !== undefined) return resultVal;

    console.warn(`[OnboardingService] Unexpected JSON structure for ${fieldType}:`, parsed);
    return null;
  } catch (err) {
    console.error(`[OnboardingService] Failed to extract ${fieldType} from user input:`, err);
    console.log("error Response==", err.response?.data);

    return null;
  }
}

const OnboardingStep = {
  ASK_LANGUAGE: "ASK_LANGUAGE",
  ASK_UPLOAD_OR_SKIP: "ASK_UPLOAD_OR_SKIP",
  RESOLVE_PROFILE_SOURCE: "RESOLVE_PROFILE_SOURCE",
  ASK_UPLOAD_DOCUMENT: "ASK_UPLOAD_DOCUMENT",
  ASK_UPLOAD_DOCUMENT_FAILED: "ASK_UPLOAD_DOCUMENT_FAILED",
  CONFIRM_DOCUMENT_OWNERSHIP: "CONFIRM_DOCUMENT_OWNERSHIP",
  ASK_FIRST_NAME: "ASK_FIRST_NAME",
  ASK_LAST_NAME: "ASK_LAST_NAME",
  ASK_DOB: "ASK_DOB",
  ASK_GENDER: "ASK_GENDER",
  ASK_BLOOD_GROUP: "ASK_BLOOD_GROUP",
  ASK_ALLERGIES: "ASK_ALLERGIES",
  ASK_FOUND_MEDICINES: "ASK_FOUND_MEDICINES",
  ASK_ON_MEDICINES: "ASK_ON_MEDIClINES",
  REVIEW_MEDICINES_LIST: "REVIEW_MEDICINES_LIST",
  ASK_MEDICINE_DETAILS: "ASK_MEDICINE_DETAILS",
  CONFIRM_MEDICINE: "CONFIRM_MEDICINE",
  EDIT_MEDICINE: "EDIT_MEDICINE",
  REGISTER_USER: "REGISTER_USER",
  POST_ONBOARDING: "POST_ONBOARDING",
  COMPLETE: "COMPLETE",
};

function getMissingRequiredStep(state) {
  const data = state.existingUserData || {};
  const useDoc =
    state.useDocumentData !== false &&
    state.flowMode === "UPLOAD" &&
    state.documentConfirmed !== false &&
    !!state.documentData;

  const docData = useDoc ? state.documentData || {} : {};
  const loginData = state.loginData || {};

  const getVal = (key) =>
    data[key] ||
    loginData[key]?.value ||
    docData[key] ||
    (key === "phoneNumber" ? docData.mobile || docData.phoneNumber : null) ||
    null;

  if (!getVal("firstName")) return "ASK_FIRST_NAME";
  if (!getVal("lastName")) return "ASK_LAST_NAME";
  if (!getVal("dateOfBirth")) return "ASK_DOB";
  if (!getVal("gender")) return "ASK_GENDER";

  return null;
}

function getNextRequiredOrOptionalStep(state) {
  const data = state.existingUserData || {};

  // HARD RULE: If profile is NOT confirmed, check required fields FIRST, then show RESOLVE_PROFILE_SOURCE card
  if (!state.profileConfirmed) {
    const missingRequired = getMissingRequiredStep(state);
    if (missingRequired) {
      return missingRequired;
    }
    return "RESOLVE_PROFILE_SOURCE";
  }

  // HARD RULE: Once state.profileConfirmed === true, REQUIRED questions and RESOLVE_PROFILE_SOURCE must NEVER be returned again.
  // Move to OPTIONAL Q&A:
  if (
    (data.bloodGroup === undefined || data.bloodGroup === null || data.bloodGroup === "") &&
    !state.bloodGroupSkipped
  ) {
    return "ASK_BLOOD_GROUP";
  }

  const hasAllergies = Array.isArray(data.allergies) && data.allergies.length > 0;
  if (!hasAllergies && !state.allergiesSkipped) {
    return "ASK_ALLERGIES";
  }

  // Medication Flow
  if (!state.medicationFlowDone) {
    const useDoc =
      state.useDocumentData !== false &&
      state.flowMode === "UPLOAD" &&
      state.documentConfirmed !== false;

    if (!state.medicationFlowStarted) {
      state.medicationFlowStarted = true;
      if (useDoc && state.foundMedicines && state.foundMedicines.length > 0) {
        state.medicinesToAdd = medicationService.buildFromDocument(state.foundMedicines);
        return "REVIEW_MEDICINES_LIST";
      } else {
        return "MEDICINE_OPTIONS";
      }
    }
    if (state.currentStep) {
      return state.currentStep;
    }
    return "MEDICINE_OPTIONS";
  }

  return "REGISTER_USER";
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

function getProfileMismatches(state) {
  console.log("[RAW LOGIN DATA] loginData:", JSON.stringify(state.loginData, null, 2));
  console.log("[RAW DOCUMENT DATA] documentData:", JSON.stringify(state.documentData, null, 2));

  // Change 6 Correction: Gate document exclusion on state.useDocumentData === false OR flowMode is MANUAL/SKIP OR !documentData
  const useDoc =
    state.useDocumentData !== false &&
    state.flowMode === "UPLOAD" &&
    state.documentConfirmed !== false &&
    !!state.documentData;

  if (!state.loginData || !useDoc) {
    return { hasMismatch: false, fields: [] };
  }

  const docData = state.documentData || {};
  const fields = [];

  const compareKeys = [
    { key: "firstName", label: "First Name", type: "name" },
    { key: "lastName", label: "Last Name", type: "name" },
    { key: "phoneNumber", label: "Phone Number", type: "phone" },
    { key: "dateOfBirth", label: "Date of Birth", type: "dob" },
    { key: "gender", label: "Gender", type: "gender" },
    { key: "email", label: "Email", type: "email" },
  ];

  for (const item of compareKeys) {
    const loginField = state.loginData[item.key] || { value: null, verified: false };
    const rawLogin = loginField.value;

    let rawDoc = docData[item.key];
    if (item.key === "phoneNumber" && rawDoc === undefined) {
      rawDoc = docData.mobile || docData.phoneNumber;
    }

    const normalizedLogin = normalizeFieldVal(rawLogin, item.type);
    const normalizedDoc = normalizeFieldVal(rawDoc, item.type);

    let isMismatch = false;
    if (loginField.verified) {
      // Verified fields are never marked as mismatch
      isMismatch = false;
    } else if (normalizedLogin && normalizedDoc) {
      if (item.type === "phone") {
        isMismatch = !isSamePhone(normalizedLogin, normalizedDoc);
      } else {
        isMismatch = normalizedLogin !== normalizedDoc;
      }
    }

    console.log("[INSTRUMENTATION] getProfileMismatches field evaluation:", {
      key: item.key,
      verified: loginField.verified,
      rawLogin,
      rawDoc,
      normalizedLogin,
      normalizedDoc,
      isMismatch,
    });

    fields.push({
      key: item.key,
      label: item.label,
      loginValue: rawLogin || null,
      documentValue: loginField.verified ? rawLogin : rawDoc || null,
      isMismatch,
      verified: loginField.verified,
    });
  }

  const hasMismatch = fields.some((f) => f.isMismatch === true);
  console.log("[INSTRUMENTATION] getProfileMismatches final decision:", {
    hasMismatch,
    computedMode: hasMismatch ? "CONFLICT" : "CONFIRM",
  });

  return { hasMismatch, fields };
}

function mergeAndApplyProfile(state, sourceChoice = null, editedData = null) {
  const compareKeys = ["firstName", "lastName", "phoneNumber", "dateOfBirth", "gender", "email"];

  const useDoc =
    state.useDocumentData !== false &&
    state.flowMode === "UPLOAD" &&
    state.documentConfirmed !== false &&
    !!state.documentData;

  const docData = useDoc ? state.documentData || {} : {};

  for (const key of compareKeys) {
    const loginField = state.loginData?.[key] || { value: null, verified: false };
    const rawLogin = loginField.value;

    let rawDoc = docData[key];
    if (key === "phoneNumber" && rawDoc === undefined) {
      rawDoc = docData.mobile || docData.phoneNumber;
    }

    const normalizedLogin = normalizeFieldVal(rawLogin, key === "phoneNumber" ? "phone" : key);
    const normalizedDoc = normalizeFieldVal(rawDoc, key === "phoneNumber" ? "phone" : key);

    const isMismatch =
      !loginField.verified &&
      normalizedLogin &&
      normalizedDoc &&
      (key === "phoneNumber"
        ? !isSamePhone(normalizedLogin, normalizedDoc)
        : normalizedLogin !== normalizedDoc);

    const existingVal = state.existingUserData?.[key] || null;
    const shownValue = loginField.verified ? rawLogin : rawLogin || rawDoc || existingVal || null;

    if (loginField.verified) {
      state.existingUserData[key] = rawLogin;
    } else if (editedData) {
      if (editedData[key] !== undefined && editedData[key] !== null && editedData[key] !== "") {
        state.existingUserData[key] = editedData[key];
      } else {
        state.existingUserData[key] = existingVal || shownValue;
      }
    } else if (isMismatch && sourceChoice) {
      const chosenVal = sourceChoice === "DOCUMENT" ? rawDoc : rawLogin;
      state.existingUserData[key] = chosenVal || existingVal || null;
    } else {
      state.existingUserData[key] = existingVal || rawLogin || rawDoc || null;
    }
  }

  // Normalize and validate names & phone number & email & dob & gender
  if (state.existingUserData.firstName) {
    state.existingUserData.firstName = normalizeName(state.existingUserData.firstName);
  }
  if (state.existingUserData.lastName) {
    state.existingUserData.lastName = normalizeName(state.existingUserData.lastName);
  }
  if (state.existingUserData.phoneNumber) {
    const normPhone = normalizePhone(state.existingUserData.phoneNumber);
    if (normPhone) {
      state.existingUserData.phoneNumber = normPhone;
    }
  }
  if (state.existingUserData.dateOfBirth) {
    const normDob = normalizeDOB(String(state.existingUserData.dateOfBirth));
    if (normDob) {
      state.existingUserData.dateOfBirth = normDob;
    }
  }
  if (state.existingUserData.gender) {
    const lowerGender = String(state.existingUserData.gender).trim().toLowerCase();
    if (lowerGender === "male" || lowerGender === "female") {
      state.existingUserData.gender = lowerGender;
    } else {
      state.existingUserData.gender = null;
    }
  }
  if (state.existingUserData.email) {
    const trimmedEmail = String(state.existingUserData.email).trim().toLowerCase();
    if (/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
      state.existingUserData.email = trimmedEmail;
    } else {
      state.existingUserData.email = null;
    }
  }
}

function computeCurrentStep(state) {
  if (state.isOnboardingCompleted) {
    return state.flowMode === "MANUAL" ? "COMPLETE" : "POST_ONBOARDING";
  }
  if (!state.preferredLanguage) return "ASK_LANGUAGE";
  if (!state.flowMode) return "ASK_UPLOAD_OR_SKIP";

  if (state.flowMode === "UPLOAD") {
    const isUploaded = state.documentUploaded || state.uploadedMedicalDocument || false;
    if (state.ocrFailed) return "ASK_UPLOAD_DOCUMENT_FAILED";
    if (!isUploaded) return "ASK_UPLOAD_DOCUMENT";
    if (
      state.documentExtracted &&
      (state.documentOwnershipConfirmed === undefined || state.documentOwnershipConfirmed === null)
    ) {
      return "CONFIRM_DOCUMENT_OWNERSHIP";
    }
  }

  return getNextRequiredOrOptionalStep(state);
}

async function updateStateFromMessage(state, message, userId = null) {
  const msg = (message || "").trim();
  const lower = msg.toLowerCase();
  const isSkip = [
    "skip",
    "skip question",
    "skip_question",
    "question skip",
    "skipquestion",
  ].includes(lower);

  if (!state.currentStep) return;

  switch (state.currentStep) {
    case "ASK_LANGUAGE": {
      const langVal = msg.toLowerCase();
      if (languageTypeValues.includes(langVal)) {
        state.preferredLanguage = langVal;
        state.currentStep = "ASK_UPLOAD_OR_SKIP";
      } else {
        const extractedLang = await extractFieldFromMessage("preferredLanguage", msg, "english");
        if (extractedLang && typeof extractedLang === "string") {
          const langNorm = extractedLang.toLowerCase();
          if (languageTypeValues.includes(langNorm)) {
            state.preferredLanguage = langNorm;
            state.currentStep = "ASK_UPLOAD_OR_SKIP";
          }
        }
      }
      break;
    }

    case "ASK_UPLOAD_OR_SKIP": {
      const fastFm = normalizeFlowModeLocally(msg);
      if (fastFm) {
        state.flowMode = fastFm;
        state.currentStep = computeCurrentStep(state);
      } else {
        const extractedFM = await extractFieldFromMessage("flowMode", msg, state.preferredLanguage);
        if (extractedFM && typeof extractedFM === "string") {
          const fmNorm = normalizeFlowModeLocally(extractedFM) || extractedFM.toUpperCase();
          if (fmNorm === "UPLOAD" || fmNorm === "MANUAL") {
            state.flowMode = fmNorm;
          }
        }
        if (!state.flowMode) {
          state.flowMode = state.documentUploaded ? "UPLOAD" : "MANUAL";
        }
        state.currentStep = computeCurrentStep(state);
      }
      break;
    }

    case "RESOLVE_PROFILE_SOURCE": {
      if (state.profileConfirmed) {
        state.currentStep = computeCurrentStep(state);
        break;
      }
      let payload;
      try {
        payload = JSON.parse(msg);
      } catch {
        const msgUpper = msg.toUpperCase();
        if (msgUpper === "SOCIAL" || msgUpper === "LOGIN" || msgUpper === "YES") {
          payload = { source: "LOGIN" };
        } else if (msgUpper === "DOCUMENT" || msgUpper === "NO") {
          payload = { source: "DOCUMENT" };
        }
      }

      if (payload && payload.confirmed) {
        mergeAndApplyProfile(state);
        state.profileConfirmed = true;
        state.profileManuallyEdited = false;
        state.stepClarificationNeeded = false;
        state.currentStep = computeCurrentStep(state);
      } else if (payload && payload.source) {
        mergeAndApplyProfile(state, payload.source);
        state.profileConfirmed = true;
        state.profileManuallyEdited = false;
        state.stepClarificationNeeded = false;
        state.currentStep = computeCurrentStep(state);
      } else if (payload && payload.edited) {
        const isEditValid = validateEditedFields(payload.edited);
        if (isEditValid) {
          if (payload.edited.gender) {
            const normG = normalizeGenderLocally(String(payload.edited.gender));
            if (normG) payload.edited.gender = normG;
          }
          if (payload.edited.dateOfBirth) {
            const normD = normalizeDOB(String(payload.edited.dateOfBirth));
            if (normD) payload.edited.dateOfBirth = normD;
          }
          mergeAndApplyProfile(state, null, payload.edited);
          state.profileManuallyEdited = true;
          state.profileConfirmed = false;
          state.stepClarificationNeeded = false;
          state.currentStep = "RESOLVE_PROFILE_SOURCE";
        } else {
          state.profileConfirmed = false;
          state.stepClarificationNeeded = true;
          state.currentStep = "RESOLVE_PROFILE_SOURCE";
        }
      } else {
        state.profileConfirmed = false;
        state.currentStep = "RESOLVE_PROFILE_SOURCE";
      }
      break;
    }

    case "ASK_UPLOAD_DOCUMENT": {
      const isUploaded = state.documentUploaded || state.uploadedMedicalDocument || false;
      if (isUploaded) {
        state.currentStep = getNextRequiredOrOptionalStep(state);
      } else if (msg === "OCR_FAILED") {
        state.ocrFailed = true;
        state.currentStep = "ASK_UPLOAD_DOCUMENT_FAILED";
      }
      break;
    }

    case "ASK_UPLOAD_DOCUMENT_FAILED": {
      if (msg === "RETRY_UPLOAD" || msg.toUpperCase() === "RETRY_UPLOAD") {
        state.ocrFailed = false;
        state.currentStep = "ASK_UPLOAD_DOCUMENT";
      } else if (msg === "MANUAL" || msg.toUpperCase() === "MANUAL") {
        state.flowMode = "MANUAL";
        state.ocrFailed = false;
        state.currentStep = getNextRequiredOrOptionalStep(state);
      }
      break;
    }

    case "CONFIRM_DOCUMENT_OWNERSHIP": {
      if (
        state.documentOwnershipConfirmed !== undefined &&
        state.documentOwnershipConfirmed !== null
      ) {
        break;
      }
      let answer = null;
      try {
        const payload = JSON.parse(msg);
        if (payload && payload.value) {
          answer = String(payload.value).toUpperCase();
        } else if (payload && payload.confirm !== undefined) {
          answer = payload.confirm ? "YES" : "NO";
        }
      } catch {
        const msgUpper = msg.toUpperCase();
        if (msgUpper === "YES" || msgUpper === "Y") {
          answer = "YES";
        } else if (msgUpper === "NO" || msgUpper === "N") {
          answer = "NO";
        }
      }

      if (!answer) {
        const extractedConf = await extractFieldFromMessage("yesNo", msg, state.preferredLanguage);
        if (extractedConf && typeof extractedConf === "string") {
          const confNorm = extractedConf.toUpperCase();
          if (confNorm === "YES" || confNorm === "NO") {
            answer = confNorm;
          }
        }
      }

      if (answer === "YES") {
        state.documentOwnershipConfirmed = true;
        state.documentConfirmed = true;
        state.useDocumentData = true;
        state.currentStep = computeCurrentStep(state);
      } else if (answer === "NO") {
        state.documentOwnershipConfirmed = false;
        state.documentConfirmed = false;
        state.useDocumentData = false;
        state.flowMode = "MANUAL";
        state.documentUploaded = false;
        state.uploadedMedicalDocument = false;
        state.documentText = "";
        state.documentExtracted = false;

        const rollbackData = {
          firstName: state.loginData?.firstName?.value || null,
          lastName: state.loginData?.lastName?.value || null,
          dateOfBirth: state.loginData?.dateOfBirth?.value
            ? new Date(state.loginData.dateOfBirth.value)
            : null,
          gender: state.loginData?.gender?.value || null,
          mobile: state.loginData?.phoneNumber?.value || null,
        };
        if (state.loginData?.email?.value) {
          rollbackData.email = state.loginData.email.value;
        }

        state.existingUserData = {
          firstName: rollbackData.firstName,
          lastName: rollbackData.lastName,
          dateOfBirth: state.loginData?.dateOfBirth?.value || null,
          gender: rollbackData.gender,
          email: rollbackData.email,
          bloodGroup: null,
          allergies: [],
          phoneNumber: rollbackData.mobile,
        };

        if (userId) {
          await patientRepository.updateById(userId, rollbackData);
        }

        state.currentStep = getNextRequiredOrOptionalStep(state);
      }
      break;
    }

    case "ASK_FIRST_NAME": {
      const nameVal = await extractFieldFromMessage("firstName", msg, state.preferredLanguage);
      if (nameVal) {
        const { firstName, lastName } = splitName(nameVal);
        state.existingUserData.firstName = firstName || null;
        if (lastName) {
          state.existingUserData.lastName = lastName;
        }
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_LAST_NAME": {
      const nameVal = await extractFieldFromMessage("lastName", msg, state.preferredLanguage);
      if (nameVal) {
        state.existingUserData.lastName = nameVal;
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_DOB": {
      const dobVal = await extractFieldFromMessage("dateOfBirth", msg, state.preferredLanguage);
      const dob = normalizeDOB(dobVal);
      if (dob) {
        state.existingUserData.dateOfBirth = dob;
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_GENDER": {
      const genVal = await extractFieldFromMessage("gender", msg, state.preferredLanguage);
      if (genVal && typeof genVal === "string") {
        const genNorm = genVal.toLowerCase();
        if (genNorm === "male" || genNorm === "female") {
          state.existingUserData.gender = genNorm;
        }
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_BLOOD_GROUP": {
      if (isSkip || msg.toUpperCase() === "SKIP") {
        state.bloodGroupSkipped = true;
        state.existingUserData.bloodGroup = null;
      } else {
        const norm = msg.trim().toUpperCase().replace(/\s+/g, "");
        if (bloodGroupTypeValues.includes(norm)) {
          state.existingUserData.bloodGroup = norm;
        } else {
          const extractedBg = await extractFieldFromMessage(
            "bloodGroup",
            msg,
            state.preferredLanguage,
          );
          if (extractedBg && typeof extractedBg === "string") {
            const bgVal = extractedBg.toUpperCase().replace(/\s+/g, "");
            if (bloodGroupTypeValues.includes(bgVal)) {
              state.existingUserData.bloodGroup = bgVal;
            }
          }
        }
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_ALLERGIES": {
      if (isSkip || msg.toUpperCase() === "SKIP") {
        state.allergiesSkipped = true;
        state.existingUserData.allergies = [];
      } else {
        const allergiesVal = await extractFieldFromMessage(
          "allergies",
          msg,
          state.preferredLanguage,
        );
        if (Array.isArray(allergiesVal)) {
          state.existingUserData.allergies = allergiesVal;
        }
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_FOUND_MEDICINES":
    case "ASK_ON_MEDICINES": {
      const yesNoVal = await extractFieldFromMessage("yesNo", msg, state.preferredLanguage);
      const isYes =
        (yesNoVal && typeof yesNoVal === "string" && yesNoVal.toUpperCase() === "YES") ||
        msg.toUpperCase() === "YES";
      if (isYes) {
        state.medicinesFlowStarted = true;
        if (state.currentStep === "ASK_FOUND_MEDICINES") {
          state.medicinesToAdd = (state.foundMedicines || []).map((m, index) => {
            const { onboardingMed } = normalizeMedicine(m, index);
            return onboardingMed;
          });
          // so the user is routed to REVIEW_MEDICINES_LIST to delete unwanted medicines.
        } else {
          state.medicinesToAdd = [{ isConfirmed: false }];
          state.medicinesConfirmed = true; // Skip review step since there's no list to review yet
        }
      } else {
        state.medicinesSkipped = true;
        state.medicinesFlowStarted = true;
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "REVIEW_MEDICINES_LIST": {
      let payload;
      try {
        payload = JSON.parse(msg);
      } catch {
        payload = {};
      }

      if (payload.selected) {
        const selectedIds = payload.selected;

        // Optionally update medicines if FE sends updated list in payload
        if (Array.isArray(payload.medicines)) {
          payload.medicines.forEach((updatedMed) => {
            const medId = updatedMed.id || updatedMed.client_med_id;
            if (medId) {
              const idx = (state.medicinesToAdd || []).findIndex(
                (m) => (m.id && m.id === medId) || (m.client_med_id && m.client_med_id === medId),
              );
              if (idx >= 0) {
                state.medicinesToAdd[idx] = {
                  ...state.medicinesToAdd[idx],
                  ...updatedMed,
                };
              }
            }
          });
        }

        state.medicinesToAdd = (state.medicinesToAdd || []).map((m) => ({
          ...m,
          selected: selectedIds.includes(m.id || m.client_med_id),
        }));

        let nextIncompleteIndex = -1;
        for (let i = 0; i < state.medicinesToAdd.length; i++) {
          const m = state.medicinesToAdd[i];
          if (m.selected) {
            try {
              await medicationService.validate(m);
            } catch {
              nextIncompleteIndex = i;
              break;
            }
          }
        }

        if (nextIncompleteIndex >= 0) {
          state.currentMedicineIndex = nextIncompleteIndex;
          state.currentStep = "ADD_MEDICINE";
        } else {
          // Filter selected medicines that have NOT been saved in DB yet (preventing duplicate insertion)
          const unsavedMeds = state.medicinesToAdd.filter((m) => m.selected && !m.isSaved);
          if (unsavedMeds.length > 0) {
            const bulkCreated = await medicationService.bulkCreate(userId, unsavedMeds);

            for (let i = 0; i < unsavedMeds.length; i++) {
              const created = bulkCreated[i];
              const unsaved = unsavedMeds[i];
              const matchIdx = state.medicinesToAdd.findIndex(
                (m) =>
                  (m.client_med_id && m.client_med_id === unsaved.client_med_id) ||
                  (m.id && m.id === unsaved.id),
              );
              if (matchIdx >= 0 && created) {
                state.medicinesToAdd[matchIdx].isSaved = true;
                state.medicinesToAdd[matchIdx].dbId = created.id;
                try {
                  await medicationReminderService.createReminder(userId, {
                    medicationId: created.id,
                  });
                } catch (err) {
                  console.error(
                    `[OnboardingService] Failed to create reminder for bulk medicine ${created.id}:`,
                    err,
                  );
                }
              }
            }
          }
          state.currentStep = "MEDICINE_OPTIONS";
        }
      } else if (payload.addNew) {
        state.currentStep = "ADD_MEDICINE";
        state.currentMedicineIndex = undefined;
      } else if (payload.skipAll) {
        state.medicationFlowDone = true;
        state.currentStep = "MEDICINE_OPTIONS";
      }
      break;
    }

    case "EDIT_MEDICINE":
    case "ADD_MEDICINE": {
      let payload;
      try {
        payload = JSON.parse(msg);
      } catch {
        payload = {};
      }

      if (payload.medicine) {
        try {
          await medicationService.validate(payload.medicine);
        } catch {
          break;
        }

        let newMed = {
          ...payload.medicine,
          client_med_id: payload.clientMedId || payload.medicine.client_med_id,
          id: payload.clientMedId || payload.medicine.client_med_id,
        };

        if (!state.medicinesToAdd) state.medicinesToAdd = [];

        let existingIdx = -1;
        if (
          state.currentStep === "EDIT_MEDICINE" &&
          state.currentMedicineIndex !== undefined &&
          state.currentMedicineIndex !== null &&
          state.currentMedicineIndex >= 0 &&
          state.currentMedicineIndex < state.medicinesToAdd.length
        ) {
          existingIdx = state.currentMedicineIndex;
          if (!newMed.client_med_id) {
            newMed.client_med_id = state.medicinesToAdd[existingIdx].client_med_id;
            newMed.id = state.medicinesToAdd[existingIdx].id;
          }
        } else if (newMed.client_med_id) {
          existingIdx = state.medicinesToAdd.findIndex(
            (m) =>
              (m.client_med_id && m.client_med_id === newMed.client_med_id) ||
              (m.id && m.id === newMed.client_med_id),
          );
        }

        if (existingIdx >= 0) {
          state.medicinesToAdd[existingIdx] = {
            ...state.medicinesToAdd[existingIdx],
            ...newMed,
            selected: true,
          };
          newMed = state.medicinesToAdd[existingIdx];
        } else {
          if (!newMed.client_med_id) {
            const newId = `med_${Date.now()}`;
            newMed.client_med_id = newId;
            newMed.id = newId;
          }
          state.medicinesToAdd.push({ ...newMed, selected: true, isSaved: false });
        }

        state.activeMedicine = newMed;
        // Bypassing CONFIRM_MEDICINE step -> return directly to REVIEW_MEDICINES_LIST with updated list
        state.currentStep = "REVIEW_MEDICINES_LIST";
      }
      break;
    }

    /*
    // TEMPORARILY COMMENTED OUT: CONFIRM_MEDICINE step logic (bypassed in favor of REVIEW_MEDICINES_LIST direct confirmation)
    case "CONFIRM_MEDICINE": {
      let payload;
      try {
        payload = JSON.parse(msg);
      } catch {
        payload = {};
      }

      if (payload.confirmed) {
        if (state.confirmMode === "SINGLE") {
          if (!state.activeMedicine?.client_med_id) {
            throw new Error("client_med_id is missing");
          }

          const createdMedication = await medicationService.create(userId, state.activeMedicine);

          try {
            await medicationReminderService.createReminder(userId, {
              medicationId: createdMedication.id,
            });
          } catch (err) {
            console.error(
              "[OnboardingService] Failed to create reminder for single medicine:",
              err,
            );
          }

          let nextIncompleteIndex = -1;
          for (let i = 0; i < state.medicinesToAdd.length; i++) {
            const m = state.medicinesToAdd[i];
            if (m.selected && m.client_med_id !== state.activeMedicine.client_med_id) {
              try {
                await medicationService.validate(m);
              } catch {
                nextIncompleteIndex = i;
                break;
              }
            }
          }

          if (nextIncompleteIndex >= 0) {
            state.currentMedicineIndex = nextIncompleteIndex;
            state.currentStep = "EDIT_MEDICINE";
          } else {
            const savedClientMedIds = [state.activeMedicine.client_med_id];
            const otherValidMeds = (state.medicinesToAdd || []).filter(
              (m) => m.selected && !savedClientMedIds.includes(m.client_med_id),
            );

            if (otherValidMeds.length > 0) {
              state.validMedsToBulkCreate = otherValidMeds;
              state.confirmMode = "BULK";
              state.currentStep = "CONFIRM_MEDICINE";
            } else {
              state.currentStep = "MEDICINE_OPTIONS";
            }
          }
        } else if (state.confirmMode === "BULK") {
          if (state.validMedsToBulkCreate && state.validMedsToBulkCreate.length > 0) {
            const bulkCreated = await medicationService.bulkCreate(
              userId,
              state.validMedsToBulkCreate,
            );

            for (const med of bulkCreated) {
              try {
                await medicationReminderService.createReminder(userId, { medicationId: med.id });
              } catch (err) {
                console.error(
                  `[OnboardingService] Failed to create reminder for bulk medicine ${med.id}:`,
                  err,
                );
              }
            }
          }
          state.currentStep = "MEDICINE_OPTIONS";
        }
      } else if (payload.edit) {
        state.currentStep = "EDIT_MEDICINE";
        if (state.confirmMode === "SINGLE") {
          const idx = state.medicinesToAdd.findIndex(
            (m) => m.client_med_id === state.activeMedicine.client_med_id,
          );
          if (idx >= 0) state.currentMedicineIndex = idx;
        }
      }
      break;
    }
    */

    case "MEDICINE_OPTIONS": {
      let payload;
      try {
        payload = JSON.parse(msg);
      } catch {
        if (msg === "ADD" || msg === "DASHBOARD" || msg === "ASK_REPORT") {
          payload = { key: msg };
        } else {
          payload = {};
        }
      }

      const key = payload.key || msg;
      if (key === "ADD") {
        state.currentStep = "ADD_MEDICINE";
        state.currentMedicineIndex = undefined;
      } else if (key === "DASHBOARD" || key === "ASK_REPORT") {
        state.medicationFlowDone = true;
        state.isOnboardingCompleted = true;
        state.currentStep = computeCurrentStep(state);
      }
      break;
    }

    case "REGISTER_USER":
    case "COMPLETE":
    case "POST_ONBOARDING": {
      if (msg === "ADD_MORE_MEDICINES" || msg.toLowerCase().includes("add more medicines")) {
        state.isOnboardingCompleted = false;
        state.medicinesConfirmed = true; // Skip review step since we are starting a fresh medicine
        state.medicinesSavedToDb = false;
        state.medicinesToAdd = [{}];
        state.currentMedicineIndex = 0;
        state.currentStep = "ASK_MEDICINE_NAME";
        break;
      } else if (msg === "GO_TO_DASHBOARD") {
        state.isOnboardingCompleted = true;
        state.currentStep = "COMPLETE";
        break;
      }

      state.currentStep = computeCurrentStep(state);
      break;
    }
  }
}

// const staticTranslations = {
//   Yes: { gujarati: "હા", hindi: "हाँ", marathi: "हो", tamil: "ஆம்" },
//   No: { gujarati: "ના", hindi: "नहीं", marathi: "नाही", tamil: "இல்லை" },
//   Skip: { gujarati: "છોડી દો", hindi: "छोड़ें", marathi: "वगळा", tamil: "தவிர்க்கவும்" },
//   Confirm: {
//     gujarati: "પુષ્ટિ કરો",
//     hindi: "पुष्टि करें",
//     marathi: "पुष्टी करा",
//     tamil: "உறுதிப்படுத்துக",
//   },
//   Edit: {
//     gujarati: "ફેરફાર કરો",
//     hindi: "संपादित करें",
//     marathi: "संपादित करा",
//     tamil: "திருத்து",
//   },
// };

async function translateMessage(text, language) {
  if (!text || language === "english") return text;

  try {
    return await aiClient.translate(text, "english", language);
  } catch (err) {
    console.error(`[OnboardingService] Failed to translate text to ${language}:`, err);
    return text; // Fallback to English
  }
}

function getNextStep(state) {
  return state.currentStep || computeCurrentStep(state);
}

async function createResponse(step, state) {
  return await getLocalizedResponse(step, state);
}

async function getLocalizedResponse(step, state) {
  switch (step) {
    case "ASK_LANGUAGE":
      return {
        action: "ASK_LANGUAGE",
        message: await getLocalizedText(
          "onboarding.askLanguage.message",
          "Welcome! Please select your preferred language.",
          state.preferredLanguage,
        ),
        options: languageTypeValues.map((lang) => ({
          label: languageNativeLabels[lang] || lang,
          value: lang,
        })),
      };

    case "ASK_UPLOAD_OR_SKIP":
      return {
        action: "ASK_UPLOAD_OR_SKIP",
        message: await getLocalizedText(
          "onboarding.askUploadOrSkip.message",
          "How would you like to provide your details?",
          state.preferredLanguage,
        ),
        options: [
          {
            label: await getLocalizedText(
              "onboarding.askUploadOrSkip.upload",
              "Upload Medical Document",
              state.preferredLanguage,
            ),
            value: "UPLOAD",
          },
          {
            label: await getLocalizedText(
              "onboarding.askUploadOrSkip.manual",
              "Enter Details Manually",
              state.preferredLanguage,
            ),
            value: "MANUAL",
          },
        ],
      };

    case "RESOLVE_PROFILE_SOURCE": {
      const useDoc =
        state.useDocumentData !== false &&
        state.flowMode === "UPLOAD" &&
        state.documentConfirmed !== false &&
        !!state.documentData;

      const { hasMismatch, fields } = getProfileMismatches(state);
      const mode = hasMismatch && !state.profileManuallyEdited ? "CONFLICT" : "CONFIRM";

      const loginFirstName = state.socialData?.firstName || "";
      const loginLastName = state.socialData?.lastName || "";
      const docFirstName = useDoc ? state.documentData?.firstName || "" : "";
      const docLastName = useDoc ? state.documentData?.lastName || "" : "";

      const loginName = [loginFirstName, loginLastName].filter(Boolean).join(" ");
      const docName = [docFirstName, docLastName].filter(Boolean).join(" ");

      let message, title, subtitle, explainer;
      if (mode === "CONFLICT") {
        message = await getLocalizedText(
          "onboarding.source.conflict.message",
          "I found two different sources for your details. Please review and choose which one is correct.",
          state.preferredLanguage,
        );
        title = await getLocalizedText(
          "onboarding.source.conflict.title",
          "We found two different profiles",
          state.preferredLanguage,
        );
        subtitle = await getLocalizedText(
          "onboarding.source.conflict.subtitle",
          "Please review and choose the one you prefer",
          state.preferredLanguage,
        );
        explainer = await getLocalizedText(
          "onboarding.source.conflict.explainer",
          "Name details can sometimes be written differently in documents vs social profiles.",
          state.preferredLanguage,
        );
      } else {
        message = state.stepClarificationNeeded
          ? await getLocalizedText(
              "onboarding.source.confirm.clarificationMessage",
              "Some details were invalid. Please check and confirm all details below.",
              state.preferredLanguage,
            )
          : await getLocalizedText(
              "onboarding.source.confirm.message",
              "Here are your details. Please confirm they're correct — you can edit anything if needed.",
              state.preferredLanguage,
            );
        title = await getLocalizedText(
          "onboarding.source.confirm.title",
          "Confirm your profile details",
          state.preferredLanguage,
        );
        subtitle = await getLocalizedText(
          "onboarding.source.confirm.subtitle",
          "Please check and confirm all details below",
          state.preferredLanguage,
        );
        explainer = null;
      }

      const useSocialText = await getLocalizedText(
        "onboarding.source.useSocialLogin",
        "Use Social Login",
        state.preferredLanguage,
      );
      const useDocText = await getLocalizedText(
        "onboarding.source.useDocument",
        "Use Document",
        state.preferredLanguage,
      );

      let loginSummary, documentSummary;
      if (loginName) {
        loginSummary = await getLocalizedText(
          "onboarding.source.loginSummary",
          "{name} ({provider})",
          state.preferredLanguage,
          { name: loginName, provider: useSocialText },
        );
      } else {
        loginSummary = await getLocalizedText(
          "onboarding.source.loginSummaryEmpty",
          "{provider} Details",
          state.preferredLanguage,
          { provider: useSocialText },
        );
      }

      if (docName) {
        documentSummary = await getLocalizedText(
          "onboarding.source.documentSummary",
          "{name} (Medical Document)",
          state.preferredLanguage,
          { name: docName },
        );
      } else {
        documentSummary = await getLocalizedText(
          "onboarding.source.documentSummaryEmpty",
          "{provider} Details",
          state.preferredLanguage,
          { provider: useDocText },
        );
      }

      const displayKeys = [
        { key: "firstName", label: "First Name", type: "name" },
        { key: "lastName", label: "Last Name", type: "name" },
        { key: "phoneNumber", label: "Phone Number", type: "phone" },
        { key: "dateOfBirth", label: "Date of Birth", type: "dob" },
        { key: "gender", label: "Gender", type: "gender" },
        { key: "email", label: "Email", type: "email" },
      ];

      const docData = useDoc ? state.documentData || {} : {};

      const localizedFields = await Promise.all(
        displayKeys.map(async (item) => {
          const k = item.key;
          const mismatchField = fields.find((f) => f.key === k);
          const loginField = state.loginData?.[k] || { value: null, verified: false };

          let loginVal = mismatchField ? mismatchField.loginValue : loginField.value || null;
          let docVal = mismatchField
            ? mismatchField.documentValue
            : useDoc
              ? docData[k] || null
              : null;
          if (k === "phoneNumber" && docVal === null && useDoc) {
            docVal = docData.mobile || docData.phoneNumber || null;
          }

          const existingVal = state.existingUserData?.[k] || null;
          let singleVal = loginField.verified
            ? loginVal
            : existingVal || loginVal || docVal || null;

          if (k === "gender") {
            if (loginVal)
              loginVal = await getLocalizedText(
                `onboarding.fieldValue.${loginVal}`,
                loginVal,
                state.preferredLanguage,
              );
            if (docVal)
              docVal = await getLocalizedText(
                `onboarding.fieldValue.${docVal}`,
                docVal,
                state.preferredLanguage,
              );
            if (singleVal)
              singleVal = await getLocalizedText(
                `onboarding.fieldValue.${singleVal}`,
                singleVal,
                state.preferredLanguage,
              );
          }

          // Localize field label
          const fieldLabelKey = `onboarding.field.${k}`;
          const localizedLabel = await getLocalizedText(
            fieldLabelKey,
            item.label,
            state.preferredLanguage,
          );

          const isMismatch =
            mode === "CONFIRM" ? false : mismatchField ? mismatchField.isMismatch : false;

          return {
            key: k,
            label: localizedLabel,
            loginValue: loginVal,
            documentValue: docVal,
            value: singleVal,
            isMismatch,
            verified: loginField.verified,
            editable: !loginField.verified,
          };
        }),
      );

      const payload = {
        action: "RESOLVE_PROFILE_SOURCE",
        mode,
        message,
        title,
        subtitle,
        fields: localizedFields,
        loginSummary,
        documentSummary,
        loginProvider: state.loginProvider || "email",
      };

      if (mode === "CONFLICT") {
        payload.explainer = explainer;
      }

      console.log(
        "[INSTRUMENTATION] [RESOLVE_PROFILE_SOURCE] final payload fields:",
        JSON.stringify(payload.fields, null, 2),
      );
      return payload;
    }
    case "ASK_UPLOAD_DOCUMENT":
      return {
        action: "ASK_UPLOAD_DOCUMENT",
        message: await getLocalizedText(
          "onboarding.askUploadDocument.message",
          "Please upload your medical document (Prescription, Lab Report, etc.).",
          state.preferredLanguage,
        ),
      };

    case "ASK_UPLOAD_DOCUMENT_FAILED": {
      const retryLabel = await getLocalizedText(
        "onboarding.retryUpload",
        "Retry Upload",
        state.preferredLanguage,
      );
      const manualLabel = await getLocalizedText(
        "onboarding.manual",
        "Enter Details Manually",
        state.preferredLanguage,
      );
      const failedMsg = await getLocalizedText(
        "onboarding.upload.failed",
        "❌ Document processing failed. Please try again or enter details manually.",
        state.preferredLanguage,
      );

      return {
        action: "ASK_UPLOAD_DOCUMENT_FAILED",
        message: failedMsg,
        options: [
          { label: retryLabel, value: "RETRY_UPLOAD" },
          { label: manualLabel, value: "MANUAL" },
        ],
      };
    }

    case "PROCESSING_DOCUMENT":
      return {
        action: "PROCESSING_DOCUMENT",
        message: await getLocalizedText(
          "onboarding.processingDocument.message",
          "I am analyzing your document...",
          state.preferredLanguage,
        ),
      };

    case "CONFIRM_DOCUMENT_OWNERSHIP": {
      const yesLabel = await getLocalizedText("onboarding.yes", "Yes", state.preferredLanguage);
      const noLabel = await getLocalizedText("onboarding.no", "No", state.preferredLanguage);
      const ownershipMsg = await getLocalizedText(
        "onboarding.document.ownership",
        "Is this document yours?",
        state.preferredLanguage,
      );

      return {
        action: "CONFIRM_DOCUMENT_OWNERSHIP",
        message: ownershipMsg,
        options: [
          { label: yesLabel, value: "YES" },
          { label: noLabel, value: "NO" },
        ],
      };
    }

    case "ASK_FIRST_NAME":
      return {
        action: "ASK_FIRST_NAME",
        message: await getLocalizedText(
          "onboarding.askFirstName.message",
          "What is your first name?",
          state.preferredLanguage,
        ),
      };

    case "ASK_LAST_NAME":
      return {
        action: "ASK_LAST_NAME",
        message: await getLocalizedText(
          "onboarding.askLastName.message",
          "What is your last name?",
          state.preferredLanguage,
        ),
      };

    case "ASK_DOB":
      return {
        action: "ASK_DOB",
        message: await getLocalizedText(
          "onboarding.askDob.message",
          "What is your date of birth?",
          state.preferredLanguage,
        ),
      };

    case "ASK_GENDER":
      return {
        action: "ASK_GENDER",
        message: await getLocalizedText(
          "onboarding.askGender.message",
          "What is your gender?",
          state.preferredLanguage,
        ),
        options: [
          {
            label: await getLocalizedText(
              "onboarding.fieldValue.male",
              "Male",
              state.preferredLanguage,
            ),
            value: "male",
          },
          {
            label: await getLocalizedText(
              "onboarding.fieldValue.female",
              "Female",
              state.preferredLanguage,
            ),
            value: "female",
          },
        ],
      };

    case "ASK_BLOOD_GROUP":
      return {
        action: "ASK_BLOOD_GROUP",
        message: await getLocalizedText(
          "onboarding.askBloodGroup.message",
          "What is your blood group? You can skip this question.",
          state.preferredLanguage,
        ),
        options: [
          {
            label: await getLocalizedText("onboarding.skip", "Skip", state.preferredLanguage),
            value: "SKIP",
          },
          ...bloodGroupTypeValues.map((bg) => ({ label: bg, value: bg })),
        ],
      };

    case "ASK_ALLERGIES":
      return {
        action: "ASK_ALLERGIES",
        message: await getLocalizedText(
          "onboarding.askAllergies.message",
          "Do you have any allergies? You can skip this question.",
          state.preferredLanguage,
        ),
        options: [
          {
            label: await getLocalizedText("onboarding.skip", "Skip", state.preferredLanguage),
            value: "SKIP",
          },
        ],
      };

    case "REVIEW_MEDICINES_LIST":
      return {
        action: "REVIEW_MEDICINES_LIST",
        message: await getLocalizedText(
          "onboarding.reviewMedicinesList.message",
          "Please review the list of medications extracted from your document:",
          state.preferredLanguage,
        ),
        options: [
          {
            label: await getLocalizedText(
              "onboarding.reviewMedicinesList.confirm",
              "Confirm Selected",
              state.preferredLanguage,
            ),
            value: "CONFIRM",
          },
          {
            label: await getLocalizedText(
              "onboarding.reviewMedicinesList.addNew",
              "Add New",
              state.preferredLanguage,
            ),
            value: "ADD",
          },
          {
            label: await getLocalizedText(
              "onboarding.reviewMedicinesList.skipAll",
              "Skip All",
              state.preferredLanguage,
            ),
            value: "SKIP",
          },
        ],
        medicines: state.medicinesToAdd || [],
      };

    case "EDIT_MEDICINE":
    case "ADD_MEDICINE": {
      const idx = state.currentMedicineIndex;
      const med = idx !== undefined && state.medicinesToAdd ? state.medicinesToAdd[idx] : null;
      const message = med
        ? await getLocalizedText(
            "onboarding.addMedicine.messageEdit",
            "Please edit details for {name}:",
            state.preferredLanguage,
            { name: med.name },
          )
        : await getLocalizedText(
            "onboarding.addMedicine.messageNew",
            "Please enter the new medication details:",
            state.preferredLanguage,
          );
      return {
        action: med ? "EDIT_MEDICINE" : "ADD_MEDICINE",
        message,
        medicine: med,
      };
    }

    /*
    // TEMPORARILY COMMENTED OUT: CONFIRM_MEDICINE step response builder (bypassed in favor of REVIEW_MEDICINES_LIST direct confirmation)
    case "CONFIRM_MEDICINE": {
      let title = "";
      let lines = [];
      const lang = state.preferredLanguage;

      if (state.confirmMode === "SINGLE" && state.activeMedicine) {
        const med = state.activeMedicine;
        title =
          med.name ||
          (await getLocalizedText("onboarding.confirmMedicine.title", "Medicine Summary", lang));

        // Localize type:
        const typeLabel = await getLocalizedText(
          `onboarding.medicationType.${med.type}`,
          med.type,
          lang,
        );

        // Localize dose:
        const typeLower = med.type.toLowerCase();
        const doseTypeKey =
          med.type === "TABLET"
            ? "onboarding.dose.tablets"
            : med.type === "CAPSULE"
              ? "onboarding.dose.capsules"
              : "";
        const doseUnitText = doseTypeKey
          ? await getLocalizedText(doseTypeKey, `${typeLower}(s)`, lang)
          : med.dose.unit;
        const doseStr =
          med.type === "TABLET" || med.type === "CAPSULE"
            ? `${med.dose.count} ${doseUnitText}`
            : `${med.dose.value} ${doseUnitText}`;

        // Localize frequency:
        const freqText = await getLocalizedText(
          `onboarding.medicationFrequency.${med.frequency}`,
          med.frequency,
          lang,
        );

        // Localize times:
        let timesVal = [];
        if (med.medicationSchedule) {
          if (Array.isArray(med.medicationSchedule.times)) {
            timesVal = med.medicationSchedule.times;
          } else {
            const sch = med.medicationSchedule;
            if (sch.Morning) timesVal.push(sch.Morning);
            if (sch.Noon) timesVal.push(sch.Noon);
            if (sch.Night) timesVal.push(sch.Night);
            if (Array.isArray(sch.Custom)) timesVal.push(...sch.Custom);
          }
        }
        const noneText = await getLocalizedText("common.none", "None", lang);
        const timesStr = timesVal.length > 0 ? timesVal.join(", ") : noneText;

        // Localize prescribed by and notes:
        const prescribedByStr = med.prescribed_by || noneText;
        const notesStr = med.notes || noneText;

        lines = [
          `Type: ${typeLabel}`,
          `Dose: ${doseStr}`,
          `Frequency: ${freqText}`,
          `Times: ${timesStr}`,
          `Prescribed By: ${prescribedByStr}`,
          `Notes: ${notesStr}`,
        ];
      } else if (state.confirmMode === "BULK" && state.validMedsToBulkCreate) {
        title = await getLocalizedText(
          "onboarding.confirmMedicine.titleBulk",
          "Confirm all medications",
          lang,
        );
        lines = await Promise.all(
          state.validMedsToBulkCreate.map(async (m) => {
            const typeLower = m.type.toLowerCase();
            const doseTypeKey =
              m.type === "TABLET"
                ? "onboarding.dose.tablets"
                : m.type === "CAPSULE"
                  ? "onboarding.dose.capsules"
                  : "";
            const doseUnitText = doseTypeKey
              ? await getLocalizedText(doseTypeKey, `${typeLower}(s)`, lang)
              : m.dose.unit;
            const doseStr =
              m.type === "TABLET" || m.type === "CAPSULE"
                ? `${m.dose.count} ${doseUnitText}`
                : `${m.dose.value} ${doseUnitText}`;
            const freqText = await getLocalizedText(
              `onboarding.medicationFrequency.${m.frequency}`,
              m.frequency,
              lang,
            );
            const timesVal =
              m.medicationSchedule?.times || m.medicationSchedule?.reminderTimes || [];
            const timesStr =
              Array.isArray(timesVal) && timesVal.length > 0 ? ` @ ${timesVal.join(", ")}` : "";
            return `${m.name} (${doseStr}, ${freqText}${timesStr})`;
          }),
        );
      }

      return {
        action: "CONFIRM_MEDICINE",
        message: await getLocalizedText(
          "onboarding.confirmMedicine.message",
          "Please verify if these details are correct before saving:",
          lang,
        ),
        summary: { title, lines },
      };
    }
    */

    case "MEDICINE_OPTIONS":
      return {
        action: "MEDICINE_OPTIONS",
        message: await getLocalizedText(
          "onboarding.medicineOptions.message",
          "What would you like to do next?",
          state.preferredLanguage,
        ),
        options: [
          {
            key: "ADD",
            label: await getLocalizedText(
              "onboarding.medicineOptions.addAnother",
              "Add Another Medicine",
              state.preferredLanguage,
            ),
            primary: true,
          },
          {
            key: "DASHBOARD",
            label: await getLocalizedText(
              "onboarding.medicineOptions.goToDashboard",
              "Go to Dashboard",
              state.preferredLanguage,
            ),
            primary: false,
          },
          {
            key: "ASK_REPORT",
            label: await getLocalizedText(
              "onboarding.medicineOptions.askAboutReport",
              "Ask About My Report",
              state.preferredLanguage,
            ),
            primary: false,
          },
        ],
      };

    case "COMPLETE":
    case "POST_ONBOARDING": {
      return {
        action: step,
        message: await getLocalizedText(
          "onboarding.complete.message",
          "Thank you! Onboarding is complete.",
          state.preferredLanguage,
        ),
        options: [],
      };
    }

    default:
      return {
        action: step,
        message: "Processing...",
      };
  }
}

class OnboardingService {
  async chat(
    message,
    history = [],
    state = {},
    userId = null,
    sessionId = null,
    displayLabel = null,
  ) {
    if (!state) {
      state = {};
    }

    if (state.preferredLanguage) {
      state.preferredLanguage = normalizeLanguage(state.preferredLanguage);
    }

    // Ensure all medication-related state properties are initialized
    if (state.medicinesToAdd === undefined || state.medicinesToAdd === null)
      state.medicinesToAdd = [];
    if (state.foundMedicines === undefined || state.foundMedicines === null)
      state.foundMedicines = [];
    if (state.medicinesFlowStarted === undefined || state.medicinesFlowStarted === null)
      state.medicinesFlowStarted = false;
    if (state.medicinesConfirmed === undefined || state.medicinesConfirmed === null)
      state.medicinesConfirmed = false;
    if (state.currentMedicineIndex === undefined) state.currentMedicineIndex = null;
    if (state.medicinesSavedToDb === undefined || state.medicinesSavedToDb === null)
      state.medicinesSavedToDb = false;
    if (state.activeMedicine === undefined) state.activeMedicine = null;
    if (state.confirmMode === undefined) state.confirmMode = null;
    if (state.pendingQueue === undefined || state.pendingQueue === null) state.pendingQueue = [];
    if (state.validMedsToBulkCreate === undefined || state.validMedsToBulkCreate === null)
      state.validMedsToBulkCreate = [];
    if (state.medicationFlowDone === undefined || state.medicationFlowDone === null)
      state.medicationFlowDone = false;

    let msg = "";
    if (typeof message === "object" && message !== null) {
      msg = JSON.stringify(message);
    } else {
      msg = (message || "").trim();
    }
    if (sessionId && msg) {
      await chatService.appendChatMessage({
        sessionId,
        role: "user",
        content: msg,
      });
    }
    // Ensure state fields are initialized
    if (!state.existingUserData) {
      state.existingUserData = {
        firstName: null,
        lastName: null,
        dateOfBirth: null,
        gender: null,
        email: null,
        bloodGroup: null,
        allergies: [],
        phoneNumber: null,
        medicalConditions: [],
        address: null,
      };
    }
    if (state.isOnboardingCompleted === undefined) state.isOnboardingCompleted = false;
    if (state.documentUploaded === undefined)
      state.documentUploaded = state.uploadedMedicalDocument || false;
    if (state.documentConfirmed === undefined) state.documentConfirmed = false;
    if (state.documentOwnershipConfirmed === undefined) {
      state.documentOwnershipConfirmed = state.documentConfirmed ? true : null;
    }
    if (state.bloodGroupSkipped === undefined) state.bloodGroupSkipped = false;
    if (state.allergiesSkipped === undefined) state.allergiesSkipped = false;
    if (state.documentExtracted === undefined) state.documentExtracted = false;

    // Synchronize medications from DB for UPLOAD flow if they are not loaded yet or if document changed
    if (
      state.flowMode === "UPLOAD" &&
      (state.documentId !== state.loadedDocumentId ||
        !state.foundMedicines ||
        state.foundMedicines.length === 0)
    ) {
      try {
        let docRow = null;
        if (state.documentId) {
          const rows = await db.select().from(document).where(eq(document.id, state.documentId));
          docRow = rows[0] || null;
        } else if (userId) {
          const rows = await db
            .select()
            .from(document)
            .where(eq(document.userId, userId))
            .orderBy(desc(document.createdAt))
            .limit(1);
          docRow = rows[0] || null;
        }

        if (docRow) {
          // Handle async race: if extraction is in progress, poll up to 5 times (1s interval)
          let attempts = 0;
          while (docRow && docRow.ocrStatus === "in_progress" && attempts < 5) {
            console.log(
              `[OnboardingService] Document ${docRow.id} extraction in progress. Polling attempt ${attempts + 1}...`,
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const rows = await db.select().from(document).where(eq(document.id, docRow.id));
            docRow = rows[0] || null;
            attempts++;
          }

          if (docRow && docRow.ocrStatus === "completed" && docRow.structuredExtractedData) {
            const structured = docRow.structuredExtractedData;
            if (Array.isArray(structured.medications) && structured.medications.length > 0) {
              state.foundMedicines = structured.medications;
              state.loadedDocumentId = docRow.id;
              console.log(
                `[OnboardingService] Loaded ${state.foundMedicines.length} medications from DB document ${docRow.id}`,
              );
            }
          }
        }
      } catch (err) {
        console.warn("[OnboardingService] Failed to load medicines from DB:", err.message);
      }
    }

    // Check for social login data
    if (
      state.hasLoginData === undefined ||
      state.hasLoginData === null ||
      state.loginData === undefined
    ) {
      if (userId) {
        const patient = await patientRepository.findById(userId);
        if (patient) {
          const providers = await authProviderRepository.findByUserId(userId);
          const providerNames = providers.map((p) => p.provider);

          let primaryProvider = "email";
          if (providerNames.includes("google")) {
            primaryProvider = "google";
          } else if (providerNames.includes("facebook")) {
            primaryProvider = "facebook";
          } else if (providerNames.includes("microsoft")) {
            primaryProvider = "microsoft";
          } else if (providerNames.includes("apple")) {
            primaryProvider = "apple";
          } else if (providerNames.includes("mobile")) {
            primaryProvider = "mobile";
          } else if (providerNames.includes("password")) {
            primaryProvider = "email";
          }
          state.loginProvider = primaryProvider;

          let isPhoneVerified = false;
          let isEmailVerified = false;

          if (providerNames.includes("mobile")) {
            isPhoneVerified = true;
          }
          if (providerNames.some((p) => ["google", "facebook", "microsoft", "apple"].includes(p))) {
            if (patient.email) {
              isEmailVerified = true;
            }
          }
          if (patient.email && (providers.length === 0 || providerNames.includes("password"))) {
            isEmailVerified = true;
          }

          let fullMobile = null;
          if (patient.mobile) {
            fullMobile = (patient.countryCode || "") + patient.mobile;
          }

          state.loginData = {
            firstName: { value: patient.firstName || null, verified: false, provenance: "profile" },
            lastName: {
              value:
                patient.lastName !== "+91" && !patient.lastName?.startsWith("+")
                  ? patient.lastName
                  : null,
              verified: false,
              provenance: "profile",
            },
            email: {
              value: patient.email || null,
              verified: isEmailVerified,
              provenance: isEmailVerified ? "auth" : "profile",
            },
            gender: { value: patient.gender || null, verified: false, provenance: "profile" },
            dateOfBirth: {
              value: patient.dateOfBirth ? patient.dateOfBirth.toISOString().split("T")[0] : null,
              verified: false,
              provenance: "profile",
            },
            phoneNumber: {
              value: fullMobile,
              verified: isPhoneVerified,
              provenance: isPhoneVerified ? "auth" : "profile",
            },
          };

          state.hasLoginData = Object.values(state.loginData).some(
            (field) => field.value !== null && field.value !== "",
          );

          // Backward compatibility aliases
          state.hasSocialData = state.hasLoginData;
          state.socialData = {
            firstName: state.loginData.firstName.value,
            lastName: state.loginData.lastName.value,
            email: state.loginData.email.value,
            gender: state.loginData.gender.value,
            dateOfBirth: state.loginData.dateOfBirth.value,
            phoneNumber: state.loginData.phoneNumber.value,
          };
        } else {
          state.hasLoginData = false;
          state.loginData = null;
          state.hasSocialData = false;
          state.socialData = null;
        }
      } else {
        state.hasLoginData = false;
        state.loginData = null;
        state.hasSocialData = false;
        state.socialData = null;
      }
    }

    // Standardize empty string properties to null in existingUserData
    if (state.existingUserData) {
      const uData = state.existingUserData;
      if (uData.firstName === "") uData.firstName = null;
      if (uData.lastName === "") uData.lastName = null;
      if (uData.dateOfBirth === "") uData.dateOfBirth = null;
      if (uData.gender === "") uData.gender = null;
      if (uData.email === "") uData.email = null;
      if (uData.bloodGroup === "") uData.bloodGroup = null;
      if (uData.phoneNumber === "") uData.phoneNumber = null;
      if (uData.address === "") uData.address = null;
    }
    // Initialize state.currentStep if not present
    if (!state.currentStep) {
      state.currentStep = computeCurrentStep(state);
    }
    // Apply alias map for backward compatibility
    if (
      state.currentStep === "CONFIRM_DOCUMENT_DETAILS" ||
      state.currentStep === "ASK_DOCUMENT_CONFIRMATION"
    ) {
      state.currentStep = "CONFIRM_DOCUMENT_OWNERSHIP";
    }
    if (state.currentStep === "ASK_USE_SOCIAL_LOGIN_INFO") {
      state.currentStep = "RESOLVE_PROFILE_SOURCE";
    }
    // 1. If onboarding is completed, return completed status immediately
    if (state.isOnboardingCompleted) {
      if (msg === "ADD_MORE_MEDICINES" || msg.toLowerCase().includes("add more medicines")) {
        // Let it pass through to updateStateFromMessage
      } else {
        state.currentStep = state.flowMode === "MANUAL" ? "COMPLETE" : "POST_ONBOARDING";
        const step = getNextStep(state);
        return createResponse(step, state);
      }
    }
    const isInitCall = history.length === 0 && msg.toLowerCase() === "hello";
    if (userId && !state.chatSessionId) {
      try {
        const session = await chatService.createOnboardingSession({
          userId,
          title: "Health Onboarding",
          metadata: {
            type: "ONBOARDING",
          },
        });
        state.chatSessionId = session.id;
        console.log(`[OnboardingService] Created new onboarding chat session: ${session.id}`);
      } catch (err) {
        console.error("[OnboardingService] Failed to create onboarding session:", err);
      }
    }

    if (!isInitCall && state.chatSessionId) {
      let resolvedLabel = null;
      if (state.currentStep && msg !== undefined && msg !== null) {
        try {
          const prevResponse = await createResponse(state.currentStep, state);
          if (prevResponse && Array.isArray(prevResponse.options)) {
            const matchedOpt = prevResponse.options.find(
              (opt) => opt && String(opt.value).toLowerCase() === String(msg).toLowerCase(),
            );
            if (matchedOpt && matchedOpt.label) {
              resolvedLabel = matchedOpt.label;
            }
          }
        } catch (err) {
          console.warn(
            "[OnboardingService] Failed to resolve option label server-side:",
            err.message,
          );
        }
      }
      const userContent =
        resolvedLabel || displayLabel || (msg !== undefined && msg !== null ? msg : "");

      await chatService.appendChatMessage({
        sessionId: state.chatSessionId,
        userId,
        role: "user",
        content: userContent,
        metadata: {
          rawValue: msg !== undefined && msg !== null ? msg : "",
          stepKey: state.currentStep || null,
        },
      });
    }
    // 2. Process incoming user message based on current expected step BEFORE update
    if (!isInitCall) {
      await updateStateFromMessage(state, msg, userId);
    }
    // Extra safeguard: if a document has already been uploaded/extracted in UPLOAD flow,
    // ensure we don't get stuck in upload/confirm steps.
    const isDocUploaded = state.documentUploaded || state.uploadedMedicalDocument || false;
    if (state.flowMode === "UPLOAD" && isDocUploaded) {
      if (
        state.currentStep === "ASK_UPLOAD_DOCUMENT" ||
        state.currentStep === "ASK_UPLOAD_OR_SKIP"
      ) {
        if (
          state.documentOwnershipConfirmed === undefined ||
          state.documentOwnershipConfirmed === null
        ) {
          state.currentStep = "CONFIRM_DOCUMENT_OWNERSHIP";
        } else {
          state.currentStep = computeCurrentStep(state);
        }
      }
    }

    // 3. If Medical Document uploaded in UPLOAD flow, fetch extracted data from DB
    if (state.flowMode === "UPLOAD" && state.documentId && !state.documentExtracted) {
      console.log(
        `[OnboardingService] Fetching pre-extracted document data for documentId: ${state.documentId}...`,
      );
      try {
        const [doc] = await db.select().from(document).where(eq(document.id, state.documentId));

        const extracted = doc?.structuredExtractedData;
        const hasStructuredData =
          extracted && typeof extracted === "object" && Object.keys(extracted).length > 0;

        if (doc && hasStructuredData) {
          const patientInfo = extracted.patientInfo || {};

          // Extract raw values from patientInfo or top-level extracted fields
          let rawFirstName = patientInfo.firstName || extracted.firstName || "";
          let rawLastName = patientInfo.lastName || extracted.lastName || "";
          if (!rawFirstName && !rawLastName && (patientInfo.patientName || extracted.patientName)) {
            const parts = splitName(patientInfo.patientName || extracted.patientName);
            rawFirstName = parts.firstName;
            rawLastName = parts.lastName;
          }

          const rawDob =
            patientInfo.dateOfBirth ||
            extracted.dateOfBirth ||
            patientInfo.reportDate ||
            extracted.reportDate ||
            "";
          const rawGender = patientInfo.gender || extracted.gender || "";
          const rawEmail = patientInfo.email || extracted.email || "";
          const rawPhone =
            patientInfo.phoneNumber ||
            extracted.phoneNumber ||
            patientInfo.mobile ||
            extracted.mobile ||
            "";
          const rawBloodGroup = extracted.bloodGroup || patientInfo.bloodGroup || "";
          const rawAllergies = Array.isArray(extracted.allergies)
            ? extracted.allergies
            : Array.isArray(patientInfo.allergies)
              ? patientInfo.allergies
              : [];

          // Normalize each value with the same helpers used for login data
          const normFirstName = normalizeName(rawFirstName) || "";
          const normLastName = normalizeName(rawLastName) || "";
          const normDob = normalizeDOB(rawDob) || "";
          const normGender = rawGender ? String(rawGender).trim().toLowerCase() : "";
          const normEmail = rawEmail ? String(rawEmail).trim() : "";
          const normPhone = normalizePhone(rawPhone) || (rawPhone ? String(rawPhone).trim() : "");
          const normBloodGroup = rawBloodGroup ? String(rawBloodGroup).trim() : "";
          const normAllergies = rawAllergies.map((a) => String(a).trim()).filter(Boolean);

          // Build state.documentData as a FLAT object
          state.documentData = {
            firstName: normFirstName || null,
            lastName: normLastName || null,
            dateOfBirth: normDob || null,
            gender: normGender || null,
            email: normEmail || null,
            phoneNumber: normPhone || null,
            bloodGroup: normBloodGroup || null,
            allergies: normAllergies,
          };

          // Existing state.existingUserData assignment
          if (normFirstName || normLastName) {
            state.existingUserData.firstName = normFirstName || state.existingUserData.firstName;
            state.existingUserData.lastName = normLastName || state.existingUserData.lastName;
          }

          if (normDob) {
            state.existingUserData.dateOfBirth = normDob;
          }

          if (normGender) {
            state.existingUserData.gender = normGender;
          }

          if (normEmail) {
            state.existingUserData.email = normEmail;
          }

          if (normBloodGroup) {
            state.existingUserData.bloodGroup = normBloodGroup;
          }

          if (normAllergies.length > 0) {
            state.existingUserData.allergies = normAllergies;
          }

          if (normPhone) {
            state.existingUserData.phoneNumber = normPhone;
          }

          if (Array.isArray(patientInfo.medicalConditions)) {
            state.existingUserData.medicalConditions = patientInfo.medicalConditions.map((c) =>
              String(c).trim(),
            );
          }

          if (patientInfo.address) {
            state.existingUserData.address = patientInfo.address.trim();
          }

          if (Array.isArray(extracted.medications) && extracted.medications.length > 0) {
            state.foundMedicines = extracted.medications;
          } else {
            state.foundMedicines = [];
          }

          // Set state.documentExtracted = true ONLY after documentData is successfully assigned
          state.documentExtracted = true;
          state.documentUploaded = true;
          state.currentStep = computeCurrentStep(state);
          console.log(
            "[OnboardingService] Successfully loaded and merged document data:",
            state.documentData,
          );

          if (state.chatSessionId && !state.documentAttachedToChat) {
            try {
              await chatService.attachDocumentToSession({
                sessionId: state.chatSessionId,
                userId,
                documentId: state.documentId,
              });
              state.documentAttachedToChat = true;
              console.log("[OnboardingService] Successfully attached document to chat session.");
            } catch (attachErr) {
              console.error(
                "[OnboardingService] Failed to attach document to chat session:",
                attachErr,
              );
            }
          }
        } else {
          console.warn(
            "[OnboardingService] Document or structuredExtractedData not found/empty in DB.",
          );
          state.ocrFailed = true;
          state.documentExtracted = false;
          state.currentStep = "ASK_UPLOAD_DOCUMENT_FAILED";
        }
      } catch (err) {
        console.error("[OnboardingService] Failed to load document data from DB:", err);
        state.ocrFailed = true;
        state.documentExtracted = false;
        state.currentStep = "ASK_UPLOAD_DOCUMENT_FAILED";
      }
    }

    // 4. Resolve next step after updates
    // If the step is REGISTER_USER, mark as completed
    if (state.currentStep === "REGISTER_USER") {
      state.currentStep = state.flowMode === "MANUAL" ? "COMPLETE" : "POST_ONBOARDING";
    }

    if (userId && state.existingUserData) {
      const shouldWritePatientProfile =
        state.flowMode === "MANUAL" ||
        state.flowMode === "SKIP" ||
        (state.flowMode === "UPLOAD" &&
          state.documentOwnershipConfirmed === true &&
          (state.profileConfirmed === true || !state.hasLoginData));

      const updateData = {};
      if (shouldWritePatientProfile) {
        if (
          state.existingUserData.firstName !== undefined &&
          state.existingUserData.firstName !== null
        )
          updateData.firstName = state.existingUserData.firstName;
        if (
          state.existingUserData.lastName !== undefined &&
          state.existingUserData.lastName !== null
        )
          updateData.lastName = state.existingUserData.lastName;
        if (state.existingUserData.dateOfBirth)
          updateData.dateOfBirth = new Date(state.existingUserData.dateOfBirth);
        if (state.existingUserData.gender !== undefined && state.existingUserData.gender !== null)
          updateData.gender = state.existingUserData.gender || null;
        if (state.existingUserData.email) updateData.email = state.existingUserData.email;
        if (
          state.existingUserData.phoneNumber !== undefined &&
          state.existingUserData.phoneNumber !== null
        )
          updateData.mobile = state.existingUserData.phoneNumber;

        if (updateData.firstName !== undefined || updateData.lastName !== undefined) {
          const existingPatient = await patientRepository.findById(userId);
          if (existingPatient) {
            const mergedFirstName =
              updateData.firstName !== undefined ? updateData.firstName : existingPatient.firstName;
            const mergedLastName =
              updateData.lastName !== undefined ? updateData.lastName : existingPatient.lastName;
            updateData.fullName = `${mergedFirstName || ""} ${mergedLastName || ""}`.trim();
          }
        }
      }
      if (state.existingUserData.bloodGroup)
        updateData.bloodGroup = state.existingUserData.bloodGroup;
      if (state.existingUserData.allergies && state.existingUserData.allergies.length > 0)
        updateData.allergies = state.existingUserData.allergies;

      if (state.isOnboardingCompleted) {
        updateData.status = "ACTIVE";
        // updateData.isVerified = true;
        updateData.onboardingCompleted = true;
      }

      if (state.preferredLanguage) {
        updateData.preferredLanguage = normalizeLanguage(state.preferredLanguage);
      }

      if (Object.keys(updateData).length > 0) {
        await patientRepository.updateById(userId, updateData);
      }
    }

    // Persist onboarding state to database for resumption on app reopen
    if (userId) {
      const existingRecord = await userOnboardingRepository.findByUserId(userId);
      const stateToSave = {
        preferredLanguage: state.preferredLanguage,
        flowMode: state.flowMode,
        currentStep: state.currentStep,
        documentUploaded: state.documentUploaded,
        documentConfirmed: state.documentConfirmed,
        documentOwnershipConfirmed: state.documentOwnershipConfirmed,
        documentExtracted: state.documentExtracted,
        isOnboardingCompleted: state.isOnboardingCompleted,
        existingUserData: state.existingUserData,
        bloodGroupSkipped: state.bloodGroupSkipped,
        allergiesSkipped: state.allergiesSkipped,
        uploadedMedicalDocument: state.uploadedMedicalDocument,
        medicinesToAdd: state.medicinesToAdd,
        foundMedicines: state.foundMedicines,
        medicinesFlowStarted: state.medicinesFlowStarted,
        medicinesConfirmed: state.medicinesConfirmed,
        currentMedicineIndex: state.currentMedicineIndex,
        medicinesSkipped: state.medicinesSkipped,
        medicinesSavedToDb: state.medicinesSavedToDb,
        hasSocialData: state.hasSocialData,
        socialData: state.socialData,
        hasLoginData: state.hasLoginData,
        loginData: state.loginData,
        profileConfirmed: state.profileConfirmed,
        documentText: state.documentText,
        documentData: state.documentData,
        loginProvider: state.loginProvider,
        documentId: state.documentId || null,
        loadedDocumentId: state.loadedDocumentId || null,
        chatSessionId: state.chatSessionId || null,
        documentAttachedToChat: state.documentAttachedToChat || false,
        activeMedicine: state.activeMedicine || null,
        confirmMode: state.confirmMode || null,
        pendingQueue: state.pendingQueue || [],
        validMedsToBulkCreate: state.validMedsToBulkCreate || [],
        medicationFlowDone: state.medicationFlowDone || false,
      };

      if (existingRecord) {
        await userOnboardingRepository.updateByUserId(userId, {
          data: stateToSave,
          isCompleted: state.isOnboardingCompleted,
        });
      } else {
        await userOnboardingRepository.create({
          userId,
          data: stateToSave,
          isCompleted: state.isOnboardingCompleted,
          step: 1,
        });
      }
    }

    const nextStep = getNextStep(state);
    const response = await createResponse(nextStep, state);

    let assistantMsgCreatedAt = new Date().toISOString();
    if (state.chatSessionId) {
      const savedMsg = await chatService.appendChatMessage({
        sessionId: state.chatSessionId,
        userId,
        role: "assistant",
        content: response.message,
        metadata: {
          action: response.action || null,
          renderType: response.renderType || null,
          options: response.options || null,
          fields: response.fields || null,
          mode: response.mode || null,
          title: response.title || null,
          subtitle: response.subtitle || null,
          explainer: response.explainer || null,
          loginSummary: response.loginSummary || null,
          documentSummary: response.documentSummary || null,
          loginProvider: response.loginProvider || null,
          medicine: response.medicine || null,
          summary: response.summary || null,
          medicines: response.medicines || null,
        },
      });
      if (savedMsg && savedMsg.createdAt) {
        assistantMsgCreatedAt =
          typeof savedMsg.createdAt.toISOString === "function"
            ? savedMsg.createdAt.toISOString()
            : new Date(savedMsg.createdAt).toISOString();
      }
    }
    // Response is already localized via getLocalizedResponse static key lookup.
    // Double translation block removed to prevent corruption of translated templates.

    console.log("[INSTRUMENTATION] FINAL outgoing onboarding assistant payload:", {
      action: response.action,
      mode: response.mode,
      title: response.title,
      subtitle: response.subtitle,
      hasFields: !!response.fields,
      fieldsLength: response.fields?.length,
    });

    return {
      ...response,
      createdAt: assistantMsgCreatedAt,
      timestamp: new Date(assistantMsgCreatedAt).getTime(),
      state: state,
    };
  }
}

const onboardingService = new OnboardingService();

module.exports = {
  OnboardingService,
  onboardingService,
  splitName,
  normalizeDOB,
  normalizeFlowModeLocally,
  normalizeGenderLocally,
  isValidGender,
  isValidFirstName,
  isValidLastName,
  validateEditedFields,
  extractFieldFromMessage,
  OnboardingStep,
};
