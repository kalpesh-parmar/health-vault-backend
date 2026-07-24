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
const medicationService = require("../../medicationService");
const { languageTypeValues, languageNativeLabels } = require("../../../enums/languageType");
const { bloodGroupTypeValues } = require("../../../enums/bloodGroupType");
// const { TRANSLATION_SYSTEM_PROMPT } = require("../prompts");
const { medicationTypeValues } = require("../../../enums/medicationType");
const { frequencyTypeValues } = require("../../../enums/frequencyType");
const { chatService } = require("./chat.service");
const medicationReminderService = require("../../medicationReminderService");
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

function splitName(fullName) {
  if (!fullName) return { firstName: "", middleName: "", lastName: "" };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: "", middleName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], middleName: "", lastName: "" };
  if (parts.length === 2) return { firstName: parts[0], middleName: "", lastName: parts[1] };

  const firstName = parts[0];
  const lastName = parts[parts.length - 1];
  const middleName = parts.slice(1, -1).join(" ");
  return { firstName, middleName, lastName };
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
  if (!dobStr) return "";
  const cleaned = dobStr.trim();
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
      "Extract and normalize gender strictly to lowercase 'male' or 'female'. For 'Male'/'પુરુષ'/'ஆண்' return 'male', for 'Female'/'સ્ત્રી'/'பெண்' return 'female'. Return null if not determined.";
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
      maxTokens: 128,
      think: false,
    });

    let parsed;
    try {
      parsed = cleanAndParseJson(response);
    } catch (parseErr) {
      const cleanedRaw =
        typeof response === "string" ? response.replace(/^```(?:json)?|```$/gi, "").trim() : "";
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
      throw parseErr;
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

function getNextRequiredOrOptionalStep(state) {
  const data = state.existingUserData || {};
  if (!data.firstName) return "ASK_FIRST_NAME";
  if (!data.lastName) return "ASK_LAST_NAME";
  if (!data.dateOfBirth) return "ASK_DOB";
  if (!data.gender) return "ASK_GENDER";

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
    if (!state.medicationFlowStarted) {
      state.medicationFlowStarted = true;
      if (state.flowMode === "UPLOAD" && state.foundMedicines && state.foundMedicines.length > 0) {
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

  if (!state.loginData) {
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

  const docData = state.documentData || {};

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

    const shownValue = loginField.verified ? rawLogin : rawLogin || rawDoc || null;

    if (loginField.verified) {
      state.existingUserData[key] = rawLogin;
    } else if (editedData) {
      // Exclude verified fields from editedData application (ignored on backend for verified fields)
      if (editedData[key] !== undefined) {
        state.existingUserData[key] = editedData[key];
      } else {
        state.existingUserData[key] = shownValue;
      }
    } else if (isMismatch && sourceChoice) {
      state.existingUserData[key] = sourceChoice === "DOCUMENT" ? rawDoc : rawLogin;
    } else {
      // Non-conflicting/document-only fields are kept and not wiped by source choice
      state.existingUserData[key] = rawLogin || rawDoc || null;
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
    if (
      state.documentExtracted &&
      state.documentConfirmed &&
      state.hasLoginData &&
      !state.profileConfirmed
    ) {
      return "RESOLVE_PROFILE_SOURCE";
    }
  } else if (state.flowMode === "MANUAL" || state.flowMode === "SKIP") {
    if (state.hasLoginData && !state.profileConfirmed) {
      return "RESOLVE_PROFILE_SOURCE";
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
      const fmVal = msg.toUpperCase();
      if (fmVal === "UPLOAD" || fmVal === "MANUAL") {
        state.flowMode = fmVal;
        state.currentStep = computeCurrentStep(state);
      } else {
        const extractedFM = await extractFieldFromMessage("flowMode", msg, state.preferredLanguage);
        if (extractedFM && typeof extractedFM === "string") {
          const fmNorm = extractedFM.toUpperCase();
          if (fmNorm === "UPLOAD" || fmNorm === "MANUAL") {
            state.flowMode = fmNorm;
            state.currentStep = computeCurrentStep(state);
          }
        }
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
        state.currentStep = computeCurrentStep(state);
      } else if (payload && payload.source) {
        mergeAndApplyProfile(state, payload.source);
        state.profileConfirmed = true;
        state.currentStep = computeCurrentStep(state);
      } else if (payload && payload.edited) {
        mergeAndApplyProfile(state, null, payload.edited);
        state.profileConfirmed = true;
        state.currentStep = computeCurrentStep(state);
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
        state.currentStep = computeCurrentStep(state);
      } else if (answer === "NO") {
        state.documentOwnershipConfirmed = false;
        state.documentConfirmed = false;
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
        state.medicinesToAdd = (state.medicinesToAdd || []).map((m) => ({
          ...m,
          selected: selectedIds.includes(m.id),
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
          state.validMedsToBulkCreate = state.medicinesToAdd.filter((m) => m.selected);
          state.confirmMode = "BULK";
          state.currentStep = "CONFIRM_MEDICINE";
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
          state.currentMedicineIndex !== undefined &&
          state.currentMedicineIndex >= 0 &&
          state.currentMedicineIndex < state.medicinesToAdd.length
        ) {
          existingIdx = state.currentMedicineIndex;
          if (!newMed.client_med_id) {
            newMed.client_med_id = state.medicinesToAdd[existingIdx].client_med_id;
            newMed.id = state.medicinesToAdd[existingIdx].id;
          }
        } else {
          existingIdx = state.medicinesToAdd.findIndex(
            (m) => m.client_med_id && m.client_med_id === newMed.client_med_id,
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
          state.medicinesToAdd.push({ ...newMed, selected: true });
        }

        state.activeMedicine = newMed;
        state.confirmMode = "SINGLE";
        state.currentStep = "CONFIRM_MEDICINE";
      }
      break;
    }

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
      } else if (key === "DASHBOARD") {
        state.medicationFlowDone = true;
        state.isOnboardingCompleted = true;
        state.currentStep = "COMPLETE";
      } else if (key === "ASK_REPORT") {
        state.medicationFlowDone = true;
        state.isOnboardingCompleted = true;
        state.currentStep = "POST_ONBOARDING";
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
      const { hasMismatch, fields } = getProfileMismatches(state);
      const mode = hasMismatch ? "CONFLICT" : "CONFIRM";

      const loginFirstName = state.socialData?.firstName || "";
      const loginLastName = state.socialData?.lastName || "";
      const docFirstName = state.documentData?.firstName || "";
      const docLastName = state.documentData?.lastName || "";

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
        message = await getLocalizedText(
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

      const localizedFields = await Promise.all(
        fields.map(async (f) => {
          let loginVal = f.loginValue;
          let docVal = f.documentValue;
          let singleVal = f.verified ? loginVal : loginVal || docVal || null;

          if (f.key === "gender") {
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
          const fieldLabelKey = `onboarding.field.${f.key}`;
          const localizedLabel = await getLocalizedText(
            fieldLabelKey,
            f.label,
            state.preferredLanguage,
          );

          return {
            ...f,
            label: localizedLabel,
            loginValue: loginVal,
            documentValue: docVal,
            value: singleVal,
            isMismatch: mode === "CONFIRM" ? false : f.isMismatch,
            editable: !f.verified,
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
    if (state.currentMedicineIndex === undefined || state.currentMedicineIndex === null)
      state.currentMedicineIndex = 0;
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

        if (doc && doc.structuredExtractedData) {
          const extracted = doc.structuredExtractedData;
          const patientInfo = extracted.patientInfo || {};

          if (patientInfo.firstName || patientInfo.lastName) {
            state.existingUserData.firstName =
              patientInfo.firstName || state.existingUserData.firstName;
            state.existingUserData.lastName =
              patientInfo.lastName || state.existingUserData.lastName;
          }

          if (patientInfo.dateOfBirth) {
            state.existingUserData.dateOfBirth = normalizeDOB(patientInfo.dateOfBirth);
          }

          if (patientInfo.gender) {
            state.existingUserData.gender = patientInfo.gender;
          }

          if (patientInfo.email) {
            state.existingUserData.email = patientInfo.email.trim();
          }

          if (extracted.bloodGroup || patientInfo.bloodGroup) {
            state.existingUserData.bloodGroup = extracted.bloodGroup || patientInfo.bloodGroup;
          }

          if (Array.isArray(extracted.allergies)) {
            state.existingUserData.allergies = extracted.allergies.map((a) => String(a).trim());
          } else if (Array.isArray(patientInfo.allergies)) {
            state.existingUserData.allergies = patientInfo.allergies.map((a) => String(a).trim());
          }

          if (patientInfo.phoneNumber) {
            state.existingUserData.phoneNumber = patientInfo.phoneNumber.trim();
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

          state.documentExtracted = true;
          state.documentUploaded = true;
          state.currentStep = computeCurrentStep(state);
          console.log("[OnboardingService] Successfully loaded and merged document data.");

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
          console.warn("[OnboardingService] Document or structuredExtractedData not found in DB.");
        }
      } catch (err) {
        console.error("[OnboardingService] Failed to load document data from DB:", err);
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
        updateData.isVerified = true;
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

    if (state.chatSessionId) {
      await chatService.appendChatMessage({
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
  OnboardingStep,
};
