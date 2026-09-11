/* eslint-disable no-console */
const { ollamaClient } = require("../../../clients/ollamaClient");
const { env } = require("../../../configs/env");
// const { ONBOARDING_SYSTEM_PROMPT } = require("../prompts");
const patientRepository = require("../../../repositories/patientRepository");
const userOnboardingRepository = require("../../../repositories/userOnboardingRepository");
const authProviderRepository = require("../../../repositories/authProviderRepository");
const { normalizeLanguage } = require("../../../utils/commonUtils");
const medicationService = require("../../medication.service");
const medicationReminderService = require("../../medicationReminder.service");
const { languageTypeValues } = require("../../../enums/languageType");
const { bloodGroupTypeValues } = require("../../../enums/bloodGroupType");
// const { TRANSLATION_SYSTEM_PROMPT } = require("../prompts");
const { medicationTypeValues } = require("../../../enums/medicationType");
const { frequencyTypeValues } = require("../../../enums/frequencyType");
const { chatService } = require("./chat.service");
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
const { eq, desc } = require("drizzle-orm");
const { normalizeMedicine } = require("../../../helpers/medicineNormalize.helper");
const { toDbDate } = require("../../../utils/dateUtils");

const {
  cleanAndParseJson,
  // getLocalizedTranslation,
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
  getLocalizedText,
} = require("../../../helpers/onboarding.helper");

const {
  OnboardingStep,
  REQUIRED_PROFILE_FIELDS,
  isProfileComplete,
  getMissingRequiredStep,
  getNextRequiredOrOptionalStep,
  canSkipOnboarding,
  getProfileMismatches,
  mergeAndApplyProfile,
  computeCurrentStep,
  getNextStep,
} = require("./onboarding/onboardingStateMachine");

const {
  REPORT_QUESTIONS_I18N,
  getLocalizedResponse,
  createResponse,
} = require("./onboarding/stepResponseBuilder");

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
  } else if (fieldType === "firstName" || fieldType === "lastName") {
    const cleaned = text.trim();
    if (isValidFirstName(cleaned) && cleaned.split(/\s+/).length <= 2) {
      return cleaned;
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
  } else if (fieldType === "allergies") {
    const trimmed = text.trim().toLowerCase();
    const negativeSet = [
      "no",
      "none",
      "no allergies",
      "no allergy",
      "nil",
      "n/a",
      "nothing",
      "na",
      "ના",
      "નથી",
      "કોઈ એલર્જી નથી",
      "नहीं",
      "कोई एलर्जी नहीं",
    ];
    if (negativeSet.includes(trimmed)) {
      return [];
    }
    if (trimmed && trimmed.length < 60 && !/[?!=]/.test(trimmed)) {
      const items = text
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      if (
        items.length > 0 &&
        items.every((i) => i.length < 30 && (!i.includes(" ") || i.split(" ").length <= 3))
      ) {
        return items;
      }
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

    if (resultVal && typeof resultVal === "object" && !Array.isArray(resultVal)) {
      resultVal = resultVal.value || resultVal.content || resultVal.text || null;
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
// Note: OnboardingStep, REQUIRED_PROFILE_FIELDS, isProfileComplete, getMissingRequiredStep,
// getNextRequiredOrOptionalStep, canSkipOnboarding, getProfileMismatches, mergeAndApplyProfile,
// computeCurrentStep, and getNextStep are imported from ./onboarding/onboardingStateMachine

async function updateStateFromMessage(state, message, userId = null) {
  let rawText = "";
  if (typeof message === "object" && message !== null) {
    rawText = JSON.stringify(message);
  } else {
    rawText = (message || "").trim();
  }

  let extractedVal = rawText;
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === "object") {
      extractedVal = String(
        parsed.value || parsed.key || parsed.label || parsed.option || rawText,
      ).trim();
    }
  } catch {
    // Plain string
  }

  const msg = extractedVal;
  const lower = msg.toLowerCase();
  const isSkip = [
    "skip",
    "skip question",
    "skip_question",
    "question skip",
    "skipquestion",
  ].includes(lower);

  let isMedicineSelectionMsg = false;
  if (rawText) {
    try {
      const parsed = JSON.parse(rawText);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed.selected !== undefined ||
          parsed.action === "CONFIRM" ||
          parsed.value === "CONFIRM" ||
          parsed.value === "CONFIRM_SELECTED")
      ) {
        isMedicineSelectionMsg = true;
      }
    } catch {
      const upper = String(rawText).trim().toUpperCase();
      if (upper === "CONFIRM" || upper === "CONFIRM_SELECTED") {
        isMedicineSelectionMsg = true;
      }
    }
  }

  if (
    isMedicineSelectionMsg &&
    (!state.currentStep ||
      state.currentStep === "MEDICINE_OPTIONS" ||
      state.currentStep === "POST_ONBOARDING")
  ) {
    state.currentStep = "REVIEW_MEDICINES_LIST";
  }

  if (!state.currentStep) return;

  switch (state.currentStep) {
    case "ASK_LANGUAGE": {
      const langVal = msg.toLowerCase();
      if (languageTypeValues.includes(langVal)) {
        state.preferredLanguage = langVal;
        state.currentStep = "ASK_UPLOAD_OR_SKIP";
        if (userId) {
          try {
            await patientRepository.updateById(userId, { preferredLanguage: langVal });
          } catch (err) {
            console.warn(
              "[OnboardingService] Immediate DB update for preferredLanguage failed:",
              err.message,
            );
          }
        }
      } else {
        const extractedLang = await extractFieldFromMessage("preferredLanguage", msg, "english");
        if (extractedLang && typeof extractedLang === "string") {
          const langNorm = extractedLang.toLowerCase();
          if (languageTypeValues.includes(langNorm)) {
            state.preferredLanguage = langNorm;
            state.currentStep = "ASK_UPLOAD_OR_SKIP";
            if (userId) {
              try {
                await patientRepository.updateById(userId, { preferredLanguage: langNorm });
              } catch (err) {
                console.warn(
                  "[OnboardingService] Immediate DB update for preferredLanguage failed:",
                  err.message,
                );
              }
            }
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
        const socialOptions = [
          "SOCIAL",
          "LOGIN",
          "SOCIAL_LOGIN",
          "GOOGLE",
          "FACEBOOK",
          "APPLE",
          "MICROSOFT",
          "MOBILE",
          "USE_SOCIAL",
          "USE SOCIAL",
          "USE_SOCIAL_LOGIN",
          "YES",
        ];
        const docOptions = [
          "DOCUMENT",
          "DOC",
          "MEDICAL_DOCUMENT",
          "USE_DOCUMENT",
          "USE DOCUMENT",
          "USE_DOCUMENT_DATA",
          "DOCUMENT_DATA",
          "MEDICAL DOCUMENT",
          "NO",
        ];
        if (
          socialOptions.includes(msgUpper) ||
          msgUpper.includes("SOCIAL") ||
          msgUpper.includes("LOGIN")
        ) {
          payload = { source: "LOGIN" };
        } else if (docOptions.includes(msgUpper) || msgUpper.includes("DOCUMENT")) {
          payload = { source: "DOCUMENT" };
        }
      }

      if (payload && typeof payload === "object") {
        if (!payload.source && !payload.edited) {
          const sourceVal =
            payload.source ||
            payload.value ||
            payload.option ||
            payload.key ||
            payload.selected ||
            payload.displayLabel ||
            payload.label ||
            payload.text;
          if (typeof sourceVal === "string") {
            const upper = sourceVal.toUpperCase();
            if (
              [
                "SOCIAL",
                "LOGIN",
                "SOCIAL_LOGIN",
                "GOOGLE",
                "FACEBOOK",
                "APPLE",
                "MICROSOFT",
                "MOBILE",
                "USE_SOCIAL",
                "USE SOCIAL",
                "USE_SOCIAL_LOGIN",
                "YES",
              ].includes(upper) ||
              upper.includes("SOCIAL") ||
              upper.includes("LOGIN")
            ) {
              payload.source = "LOGIN";
            } else if (
              [
                "DOCUMENT",
                "DOC",
                "MEDICAL_DOCUMENT",
                "USE_DOCUMENT",
                "USE DOCUMENT",
                "USE_DOCUMENT_DATA",
                "DOCUMENT_DATA",
                "MEDICAL DOCUMENT",
                "NO",
              ].includes(upper) ||
              upper.includes("DOCUMENT")
            ) {
              payload.source = "DOCUMENT";
            } else if (
              ["MANUAL", "EDIT", "EDIT_MANUALLY", "MANUAL_ENTRY"].includes(upper) ||
              upper.includes("MANUAL") ||
              upper.includes("EDIT")
            ) {
              payload.source = "MANUAL";
            }
          }

          if (
            !payload.source &&
            (payload.firstName || payload.lastName || payload.dateOfBirth || payload.gender)
          ) {
            payload.edited = {
              firstName: payload.firstName,
              lastName: payload.lastName,
              dateOfBirth: payload.dateOfBirth,
              gender: payload.gender,
              phoneNumber: payload.phoneNumber,
              email: payload.email,
            };
          }
        }
      }

      if (payload && (payload.confirmed || payload.source || payload.edited)) {
        if (payload.edited) {
          if (payload.edited.gender) {
            const normG = normalizeGenderLocally(String(payload.edited.gender));
            if (normG) payload.edited.gender = normG;
          }
          if (payload.edited.dateOfBirth) {
            const normD = normalizeDOB(String(payload.edited.dateOfBirth));
            if (normD) payload.edited.dateOfBirth = normD;
          }
        }

        const sourceToUse = payload.source || state.selectedProfileSource || null;
        if (payload.source === "MANUAL" && !payload.edited && payload.confirmed === false) {
          state.profileManuallyEdited = true;
          state.selectedProfileSource = "MANUAL";
          state.currentStep = "RESOLVE_PROFILE_SOURCE";
        } else {
          mergeAndApplyProfile(state, sourceToUse, payload.edited || null);
          state.profileConfirmed = true;
          state.selectedProfileSource = payload.edited
            ? "MANUAL"
            : sourceToUse === "DOCUMENT"
              ? "DOCUMENT"
              : sourceToUse === "LOGIN" || sourceToUse === "SOCIAL"
                ? "SOCIAL"
                : "MANUAL";
          state.profileManuallyEdited =
            !!payload.edited || state.selectedProfileSource === "MANUAL";
          state.stepClarificationNeeded = false;
          state.currentStep = computeCurrentStep(state);
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
      const msgUpper = String(msg || "")
        .toUpperCase()
        .trim();
      const lower = String(msg || "")
        .toLowerCase()
        .trim();
      if (
        msgUpper === "RETRY_UPLOAD" ||
        msgUpper === "RETRY" ||
        lower.includes("retry") ||
        lower.includes("ફરી પ્રયાસ")
      ) {
        state.ocrFailed = false;
        state.documentId = null;
        state.documentUploaded = false;
        state.uploadedMedicalDocument = false;
        state.documentExtracted = false;
        state.currentStep = "ASK_UPLOAD_DOCUMENT";
      } else if (
        msgUpper === "MANUAL" ||
        msgUpper === "ENTER DETAILS MANUALLY" ||
        lower.includes("manual") ||
        lower.includes("મેન્યુઅલી")
      ) {
        state.flowMode = "MANUAL";
        state.ocrFailed = false;
        state.documentId = null;
        state.documentUploaded = false;
        state.uploadedMedicalDocument = false;
        state.documentExtracted = false;
        state.useDocumentData = false;
        state.currentStep = getNextRequiredOrOptionalStep(state);
      }
      break;
    }

    case "CONFIRM_DOCUMENT_OWNERSHIP": {
      let answer = null;
      let rawObj = null;

      if (typeof message === "object" && message !== null) {
        rawObj = message;
      } else {
        try {
          const parsed = JSON.parse(rawText);
          if (parsed && typeof parsed === "object") {
            rawObj = parsed;
          }
        } catch {
          // Plain string
        }
      }

      if (rawObj) {
        const val = String(
          rawObj.value ||
            rawObj.answer ||
            rawObj.confirm ||
            rawObj.action ||
            rawObj.actionType ||
            rawObj.key ||
            rawObj.label ||
            "",
        ).toUpperCase();
        if (
          ["YES", "Y", "TRUE", "CONFIRM", "CONFIRMED", "ACCEPT", "ACCEPT_DOCUMENT"].includes(val) ||
          rawObj.confirm === true ||
          rawObj.documentConfirmed === true
        ) {
          answer = "YES";
        } else if (
          ["NO", "N", "FALSE", "REJECT", "DECLINE"].includes(val) ||
          rawObj.confirm === false ||
          rawObj.documentConfirmed === false
        ) {
          answer = "NO";
        }
      }

      if (!answer) {
        const msgUpper = String(msg || "")
          .trim()
          .toUpperCase();
        if (["YES", "Y", "TRUE", "HA", "હાં", "હા", "સાચું", "हाँ", "1"].includes(msgUpper)) {
          answer = "YES";
        } else if (
          ["NO", "N", "FALSE", "NA", "ના", "નથી", "ખોટું", "नहीं", "0"].includes(msgUpper)
        ) {
          answer = "NO";
        }
      }

      if (!answer) {
        const extractedConf = await extractFieldFromMessage(
          "yesNo",
          rawText,
          state.preferredLanguage,
        );
        if (extractedConf && typeof extractedConf === "string") {
          const confNorm = extractedConf.toUpperCase();
          if (confNorm === "YES" || confNorm === "NO") {
            answer = confNorm;
          }
        }
      }

      if (!answer) {
        const lowerStr = rawText.toLowerCase().trim();
        const yesPhrases = [
          "yes",
          "y",
          "ha",
          "હા",
          "હાં",
          "સાચું",
          "हाँ",
          "true",
          "mine",
          "my document",
          "આ મારી",
          "મારું છે",
          "હા મારી છે",
        ];
        const noPhrases = ["no", "n", "na", "ના", "નથી", "नहीं", "ખોટું", "false", "not mine"];
        if (yesPhrases.some((p) => lowerStr === p || lowerStr.includes(p))) {
          answer = "YES";
        } else if (noPhrases.some((p) => lowerStr === p || lowerStr.includes(p))) {
          answer = "NO";
        }
      }

      if (answer === "YES") {
        state.documentOwnershipConfirmed = true;
        state.documentConfirmed = true;
        state.useDocumentData = true;

        // Auto-populate existingUserData and persist document patient details to DB
        if (state.documentData) {
          if (!state.existingUserData) state.existingUserData = {};
          const d = state.documentData;
          if (d.firstName) state.existingUserData.firstName = d.firstName;
          if (d.lastName) state.existingUserData.lastName = d.lastName;
          if (d.dateOfBirth) state.existingUserData.dateOfBirth = d.dateOfBirth;
          if (d.gender) state.existingUserData.gender = d.gender;
          if (d.bloodGroup) state.existingUserData.bloodGroup = d.bloodGroup;
          if (Array.isArray(d.allergies) && d.allergies.length > 0) {
            state.existingUserData.allergies = d.allergies;
          }

          if (userId) {
            try {
              const fn = state.existingUserData.firstName || "";
              const ln = state.existingUserData.lastName || "";
              const fullName = [fn, ln].filter(Boolean).join(" ");
              await patientRepository.updateById(userId, {
                ...(fn ? { firstName: fn } : {}),
                ...(ln ? { lastName: ln } : {}),
                ...(fullName ? { fullName } : {}),
                ...(state.existingUserData.dateOfBirth
                  ? { dateOfBirth: toDbDate(state.existingUserData.dateOfBirth) }
                  : {}),
                ...(state.existingUserData.gender ? { gender: state.existingUserData.gender } : {}),
                ...(state.existingUserData.bloodGroup
                  ? { bloodGroup: state.existingUserData.bloodGroup }
                  : {}),
                ...(Array.isArray(state.existingUserData.allergies) &&
                state.existingUserData.allergies.length > 0
                  ? { allergies: state.existingUserData.allergies }
                  : {}),
              });
            } catch (dbErr) {
              console.warn(
                "[OnboardingService] Failed to auto-save document details to patient DB:",
                dbErr.message,
              );
            }
          }
        }

        const isSocial =
          state.hasSocialData === true ||
          ["google", "facebook", "microsoft", "apple"].includes(state.loginProvider);
        state.profileConfirmed = !isSocial;
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
          dateOfBirth: toDbDate(state.loginData?.dateOfBirth?.value),
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
      let rawVal = msg;
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === "object") {
          rawVal = String(parsed.value || parsed.firstName || parsed.name || msg).trim();
        }
      } catch {
        // Not a JSON payload
      }

      let nameVal = await extractFieldFromMessage("firstName", rawVal, state.preferredLanguage);
      if (!nameVal && rawVal && typeof rawVal === "string") {
        const cleaned = rawVal.replace(/[{}[\]"]/g, "").trim();
        if (cleaned.length > 0 && cleaned.length < 50) {
          nameVal = cleaned;
        }
      }

      if (nameVal) {
        const { firstName, lastName } = splitName(nameVal);
        const finalFn = firstName || nameVal;
        state.existingUserData.firstName = finalFn;
        if (!state.loginData) state.loginData = {};
        state.loginData.firstName = { value: finalFn, verified: true, provenance: "manual" };

        if (lastName) {
          if (!state.existingUserData.lastName) state.existingUserData.lastName = lastName;
          if (!state.loginData.lastName || !state.loginData.lastName.value) {
            state.loginData.lastName = { value: lastName, verified: true, provenance: "manual" };
          }
        }

        if (userId) {
          try {
            const existingP = await patientRepository.findById(userId);
            const fn = finalFn || existingP?.firstName || "";
            const ln = (lastName !== undefined ? lastName : existingP?.lastName) || "";
            const fullName = `${fn} ${ln}`.trim();
            await patientRepository.updateById(userId, { firstName: finalFn, fullName });
          } catch (err) {
            console.warn(
              "[OnboardingService] Immediate DB update for firstName failed:",
              err.message,
            );
          }
        }
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_LAST_NAME": {
      let rawVal = msg;
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === "object") {
          rawVal = String(parsed.value || parsed.lastName || parsed.name || msg).trim();
        }
      } catch {
        // Not a JSON payload
      }

      let nameVal = await extractFieldFromMessage("lastName", rawVal, state.preferredLanguage);
      if (!nameVal && rawVal && typeof rawVal === "string") {
        const cleaned = rawVal.replace(/[{}[\]"]/g, "").trim();
        if (cleaned.length > 0 && cleaned.length < 50) {
          nameVal = cleaned;
        }
      }

      if (nameVal) {
        state.existingUserData.lastName = nameVal;
        if (!state.loginData) state.loginData = {};
        state.loginData.lastName = { value: nameVal, verified: true, provenance: "manual" };

        if (userId) {
          try {
            const existingP = await patientRepository.findById(userId);
            const fn = existingP?.firstName || state.existingUserData.firstName || "";
            const fullName = `${fn} ${nameVal}`.trim();
            await patientRepository.updateById(userId, { lastName: nameVal, fullName });
          } catch (err) {
            console.warn(
              "[OnboardingService] Immediate DB update for lastName failed:",
              err.message,
            );
          }
        }
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_DOB": {
      let rawVal = msg;
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === "object") {
          rawVal = String(parsed.value || parsed.dateOfBirth || parsed.dob || msg).trim();
        }
      } catch {
        // Not a JSON payload
      }

      let dobVal = await extractFieldFromMessage("dateOfBirth", rawVal, state.preferredLanguage);
      if (!dobVal && rawVal && typeof rawVal === "string") {
        dobVal = rawVal.trim();
      }

      const dob = normalizeDOB(dobVal);
      if (dob) {
        state.existingUserData.dateOfBirth = dob;
        if (!state.loginData) state.loginData = {};
        state.loginData.dateOfBirth = { value: dob, verified: true, provenance: "manual" };

        if (userId) {
          try {
            await patientRepository.updateById(userId, { dateOfBirth: toDbDate(dob) });
          } catch (err) {
            console.warn(
              "[OnboardingService] Immediate DB update for dateOfBirth failed:",
              err.message,
            );
          }
        }
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_GENDER": {
      let rawVal = msg;
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === "object") {
          rawVal = String(parsed.value || parsed.gender || msg).trim();
        }
      } catch {
        // Not a JSON payload
      }

      let genVal = await extractFieldFromMessage("gender", rawVal, state.preferredLanguage);
      if (!genVal && rawVal && typeof rawVal === "string") {
        const lower = rawVal.toLowerCase().trim();
        if (
          lower.includes("female") ||
          lower.includes("woman") ||
          lower.includes("girl") ||
          lower === "f" ||
          lower.includes("મહિલા") ||
          lower.includes("સ્ત્રી")
        ) {
          genVal = "female";
        } else if (
          lower.includes("male") ||
          lower.includes("man") ||
          lower.includes("boy") ||
          lower === "m" ||
          lower.includes("પુરુષ")
        ) {
          genVal = "male";
        }
      }

      if (genVal && typeof genVal === "string") {
        const genNorm = genVal.toLowerCase();
        if (genNorm === "male" || genNorm === "female") {
          state.existingUserData.gender = genNorm;
          if (!state.loginData) state.loginData = {};
          state.loginData.gender = { value: genNorm, verified: true, provenance: "manual" };

          if (userId) {
            try {
              await patientRepository.updateById(userId, { gender: genNorm });
            } catch (err) {
              console.warn(
                "[OnboardingService] Immediate DB update for gender failed:",
                err.message,
              );
            }
          }
        }
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_BLOOD_GROUP": {
      let rawVal = msg;
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === "object") {
          rawVal = String(
            parsed.value || parsed.key || parsed.label || parsed.option || msg,
          ).trim();
        }
      } catch {
        // Not a JSON string payload
      }

      const upperVal = rawVal.trim().toUpperCase();
      const isSkipVal = isSkip || upperVal === "SKIP" || upperVal === "SKIP_QUESTION";

      if (isSkipVal) {
        state.bloodGroupSkipped = true;
        state.existingUserData.bloodGroup = null;
      } else {
        const norm = upperVal.replace(/\s+/g, "");
        if (bloodGroupTypeValues.includes(norm)) {
          state.existingUserData.bloodGroup = norm;
        } else {
          const extractedBg = await extractFieldFromMessage(
            "bloodGroup",
            rawVal,
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
      if (userId) {
        try {
          await patientRepository.updateById(userId, {
            bloodGroup: state.existingUserData.bloodGroup || null,
          });
        } catch (err) {
          console.warn(
            "[OnboardingService] Immediate DB update for bloodGroup failed:",
            err.message,
          );
        }
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_ALLERGIES": {
      const negativePatterns = [
        "no",
        "none",
        "no allergies",
        "no allergy",
        "nil",
        "n/a",
        "nothing",
        "na",
        "ના",
        "નથી",
        "કોઈ એલર્જી નથી",
        "नहीं",
        "कोई एलर्जी नहीं",
      ];
      const isNegative =
        isSkip ||
        msg.toUpperCase() === "SKIP" ||
        negativePatterns.includes(msg.trim().toLowerCase());

      if (isNegative) {
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
          state.allergiesSkipped = true;
        } else if (typeof allergiesVal === "string" && allergiesVal.trim()) {
          const parsed = allergiesVal
            .replace(/^\[|\]$/g, "")
            .split(",")
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
            .filter(Boolean);
          state.existingUserData.allergies = parsed.length > 0 ? parsed : [allergiesVal.trim()];
          state.allergiesSkipped = true;
        } else if (msg.trim()) {
          state.existingUserData.allergies = [msg.trim()];
          state.allergiesSkipped = true;
        }
      }
      if (userId) {
        try {
          await patientRepository.updateById(userId, {
            allergies: state.existingUserData.allergies || [],
          });
        } catch (err) {
          console.warn(
            "[OnboardingService] Immediate DB update for allergies failed:",
            err.message,
          );
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
          const docMeds = (state.foundMedicines || []).map((m, index) => {
            const { onboardingMed } = normalizeMedicine(m, index);
            if (m.isSaved) onboardingMed.isSaved = true;
            if (m.dbId) onboardingMed.dbId = m.dbId;
            return onboardingMed;
          });
          const existingManualMeds = (state.medicinesToAdd || []).filter(
            (m) =>
              m &&
              (m.source === "MANUAL" ||
                m.isManual ||
                m.source !== "OCR" ||
                (m.id && (String(m.id).startsWith("med_") || String(m.id).startsWith("client_"))) ||
                (m.client_med_id &&
                  (String(m.client_med_id).startsWith("med_") ||
                    String(m.client_med_id).startsWith("client_")))),
          );
          const combined = [...docMeds];
          for (const manualMed of existingManualMeds) {
            const medId = manualMed.id || manualMed.client_med_id;
            if (!combined.some((c) => (c.id || c.client_med_id) === medId)) {
              combined.push(manualMed);
            }
          }
          state.medicinesToAdd = combined;
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
        const upper = String(msg || "")
          .trim()
          .toUpperCase();
        payload = { value: upper };
      }

      const val = String(payload.value || payload.action || payload.key || msg || "")
        .trim()
        .toUpperCase();

      const isConfirm =
        val === "CONFIRM" || val === "CONFIRM_SELECTED" || payload.selected !== undefined;
      const isAdd = val === "ADD" || val === "ADD_NEW" || payload.addNew;
      const isSkip = val === "SKIP" || val === "SKIP_ALL" || payload.skipAll;

      // Handle duplicate conflict resolution payloads if provided
      if (Array.isArray(payload.resolutions)) {
        payload.resolutions.forEach((res) => {
          const medId = res.client_med_id || res.id || res.name;
          const idx = (state.medicinesToAdd || []).findIndex(
            (m) =>
              (m.client_med_id && m.client_med_id === medId) ||
              (m.id && m.id === medId) ||
              (m.name && String(m.name).toLowerCase() === String(res.name || "").toLowerCase()),
          );
          if (idx >= 0) {
            const currentMed = state.medicinesToAdd[idx];
            if (res.resolution === "KEEP_EXISTING" || res.resolution === "REMOVE_NEW") {
              currentMed.selected = false;
              currentMed.resolution = res.resolution;
            } else if (res.resolution === "REPLACE") {
              currentMed.selected = true;
              currentMed.resolution = "REPLACE";
              currentMed.replaceMedicationId = res.targetMedicationId || res.replaceMedicationId;
            } else if (res.resolution === "EDIT" && res.updatedMedication) {
              state.medicinesToAdd[idx] = {
                ...currentMed,
                ...res.updatedMedication,
                selected: true,
                resolution: "EDIT",
              };
            }
            if (state.medicinesToAdd[idx]) {
              state.medicinesToAdd[idx].duplicateInfo = {
                ...(state.medicinesToAdd[idx].duplicateInfo || {}),
                hasDuplicate: false,
              };
            }
          }
        });
      }

      if (isConfirm) {
        state.medicinesConfirmed = true;
        const selectedIds =
          payload.selected ||
          (state.medicinesToAdd || []).map((m) => m.id || m.client_med_id).filter(Boolean);

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

        state.medicinesToAdd = (state.medicinesToAdd || []).map((m) => {
          const isSelected =
            m.resolution === "KEEP_EXISTING" || m.resolution === "REMOVE_NEW"
              ? false
              : selectedIds.length > 0
                ? selectedIds.includes(m.id || m.client_med_id)
                : true;

          return {
            ...m,
            selected: isSelected,
            duplicateInfo: {
              hasDuplicate: false,
              conflictType: null,
              matchedMedication: null,
              matchedMedications: [],
              suggestedActions: [],
              isAlreadySaved: Boolean(m.isSaved || m.dbId),
            },
          };
        });

        let nextIncompleteIndex = -1;
        for (let i = 0; i < state.medicinesToAdd.length; i++) {
          const m = state.medicinesToAdd[i];
          if (m.selected) {
            try {
              const { onboardingMed } = normalizeMedicine(m, i);
              await medicationService.validate(onboardingMed);
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
          // Process soft-deletions for replaced medications
          for (const m of state.medicinesToAdd) {
            const targetId =
              m.replaceMedicationId ||
              m.targetMedicationId ||
              m.duplicateInfo?.matchedMedication?.id ||
              m.matchedMedicationId;
            if (m.selected && m.resolution === "REPLACE" && targetId && userId) {
              try {
                await medicationService.deleteMedication(targetId, userId);
              } catch (delErr) {
                console.warn(
                  `[OnboardingService] Soft-delete warning for replaced med ${targetId}:`,
                  delErr.message,
                );
              }
            }
          }

          // Filter selected medicines that have NOT been saved in DB yet (preventing duplicate insertion)
          const unsavedMeds = state.medicinesToAdd.filter(
            (m) =>
              m.selected &&
              !m.isSaved &&
              m.resolution !== "KEEP_EXISTING" &&
              m.resolution !== "REMOVE_NEW",
          );
          if (unsavedMeds.length > 0 && userId) {
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
      } else if (isAdd) {
        state.currentStep = "ADD_MEDICINE";
        state.currentMedicineIndex = undefined;
      } else if (isSkip) {
        state.medicationFlowDone = true;
        state.medicinesConfirmed = true;
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

      const medObj =
        payload.medicine ||
        (payload.name || payload.medicationName || payload.medication_name ? payload : null);

      if (medObj) {
        if (!state.medicinesToAdd) state.medicinesToAdd = [];

        const isExplicitAddNew =
          payload.addNew === true ||
          payload.action === "ADD" ||
          payload.action === "ADD_NEW" ||
          payload.mode === "ADD" ||
          payload.isEditing === false ||
          state.currentStep === "ADD_MEDICINE";

        const payloadMedId = payload.clientMedId || medObj.client_med_id || medObj.id;
        let matchedIndex = -1;
        if (!isExplicitAddNew && payloadMedId && Array.isArray(state.medicinesToAdd)) {
          matchedIndex = state.medicinesToAdd.findIndex(
            (m) =>
              (m.id && m.id === payloadMedId) ||
              (m.client_med_id && m.client_med_id === payloadMedId),
          );
        }

        let existingIdx = -1;
        if (!isExplicitAddNew) {
          if (matchedIndex >= 0) {
            existingIdx = matchedIndex;
          } else if (
            state.currentStep === "EDIT_MEDICINE" &&
            state.currentMedicineIndex !== undefined &&
            state.currentMedicineIndex !== null &&
            state.currentMedicineIndex >= 0 &&
            state.currentMedicineIndex < state.medicinesToAdd.length
          ) {
            existingIdx = state.currentMedicineIndex;
          }
        }

        let clientMedId;
        if (existingIdx >= 0 && state.medicinesToAdd[existingIdx]) {
          clientMedId =
            payloadMedId ||
            state.medicinesToAdd[existingIdx].client_med_id ||
            state.medicinesToAdd[existingIdx].id ||
            `med_${Date.now()}`;
        } else {
          // When adding a new medicine, generate a fresh unique ID so it never overwrites existing items
          clientMedId = `med_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        }

        const rawType = String(medObj.type || medObj.medicationType || "TABLET").toUpperCase();
        const rawFreq = String(medObj.frequency || "ONCE").toUpperCase();

        let newMed = {
          ...medObj,
          name: medObj.name || medObj.medicationName || "New Medicine",
          client_med_id: clientMedId,
          id: clientMedId,
          type: rawType,
          frequency: rawFreq,
        };

        if (newMed.type === "TABLET" || newMed.type === "CAPSULE") {
          if (!newMed.dose || typeof newMed.dose !== "object") {
            newMed.dose = { count: 1 };
          } else if (newMed.dose.count === undefined && newMed.dose.value !== undefined) {
            newMed.dose.count = Number(newMed.dose.value) || 1;
          }
        } else {
          if (!newMed.dose || typeof newMed.dose !== "object") {
            const defaultUnit =
              rawType === "INJECTION" || rawType === "SYRUP"
                ? "ml"
                : rawType === "DROPS"
                  ? "drops"
                  : "puff";
            newMed.dose = { value: 1, unit: defaultUnit };
          }
        }

        try {
          await medicationService.validate(newMed);
        } catch (valErr) {
          console.warn("[OnboardingService] Medicine validation issue:", valErr.message);
        }

        if (existingIdx >= 0 && existingIdx < state.medicinesToAdd.length) {
          state.medicinesToAdd[existingIdx] = {
            ...state.medicinesToAdd[existingIdx],
            ...newMed,
            selected: true,
          };
          newMed = state.medicinesToAdd[existingIdx];
        } else {
          state.medicinesToAdd.push({ ...newMed, selected: true, isSaved: false });
        }

        state.activeMedicine = newMed;
        state.currentMedicineIndex = undefined;

        if (userId && Array.isArray(state.medicinesToAdd) && state.medicinesToAdd.length > 0) {
          try {
            state.medicinesToAdd = await medicationService.checkDuplicateMedicationsBatch(
              userId,
              state.medicinesToAdd,
            );
          } catch (batchErr) {
            console.warn(
              "[OnboardingService] Failed to check batch duplicates after ADD_MEDICINE:",
              batchErr.message,
            );
          }
        }

        // Direct transition to REVIEW_MEDICINES_LIST with updated list
        state.currentStep = "REVIEW_MEDICINES_LIST";
      }
      break;
    }

    case "MEDICINE_OPTIONS": {
      let payload;
      try {
        payload = JSON.parse(msg);
      } catch {
        payload = {};
      }

      const rawKey = String(payload.key || payload.value || payload.action || msg || "")
        .trim()
        .toUpperCase();
      let key = rawKey;
      if (rawKey === "ASK_ABOUT_REPORT" || rawKey.includes("REPORT")) {
        key = "ASK_REPORT";
      } else if (
        rawKey === "ADD" ||
        rawKey === "ADD_MEDICINE" ||
        rawKey === "ADD_MORE_MEDICINES" ||
        rawKey.includes("ADD ANOTHER MEDICINE") ||
        rawKey.includes("ADD MEDICINE")
      ) {
        key = "ADD";
      } else if (
        rawKey === "DASHBOARD" ||
        rawKey === "GO_TO_DASHBOARD" ||
        rawKey.includes("DASHBOARD")
      ) {
        key = "DASHBOARD";
      }

      if (key === "ADD") {
        state.currentStep = "ADD_MEDICINE";
        state.currentMedicineIndex = undefined;
      } else if (key === "DASHBOARD") {
        state.medicationFlowDone = true;
        state.isOnboardingCompleted = true;
        state.medicinesConfirmed = true;
        state.currentStep = "COMPLETE";
      } else if (key === "ASK_REPORT") {
        state.medicationFlowDone = true;
        state.isOnboardingCompleted = false;
        state.medicinesConfirmed = true;
        state.currentStep = "ASK_REPORT";
      }
      break;
    }

    case "ASK_REPORT":
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
      } else if (msg === "GO_TO_DASHBOARD" || msg === "DASHBOARD") {
        state.isOnboardingCompleted = true;
        state.currentStep = "COMPLETE";
        break;
      }

      state.currentStep = "ASK_REPORT";
      break;
    }
  }
}

// Note: getNextStep is imported from ./onboarding/onboardingStateMachine
// createResponse and getLocalizedResponse are imported from ./onboarding/stepResponseBuilder

async function saveOnboardingState(userId, state) {
  if (!userId) return;

  if (state.existingUserData) {
    const shouldWritePatientProfile =
      state.flowMode === "MANUAL" ||
      state.flowMode === "SKIP" ||
      state.profileConfirmed === true ||
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
      if (state.existingUserData.lastName !== undefined && state.existingUserData.lastName !== null)
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
    if (Array.isArray(state.existingUserData.allergies))
      updateData.allergies = state.existingUserData.allergies;

    if (state.isOnboardingCompleted || state.hasSkipped) {
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
    bloodGroupSkipped: state.bloodGroupSkipped ?? false,
    allergiesSkipped: state.allergiesSkipped ?? false,
    hasSkipped: state.hasSkipped || false,
    completionMessageSent: state.completionMessageSent || false,
    pendingProfileConflict: state.pendingProfileConflict || false,
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
    selectedProfileSource: state.selectedProfileSource || null,
    useSocialData: state.useSocialData || false,
    useDocumentData: state.useDocumentData || false,
    profileManuallyEdited: state.profileManuallyEdited || false,
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
    if (userId && !state.userId) {
      state.userId = userId;
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
    if (
      state.activeMedicine &&
      (state.activeMedicine.name || state.activeMedicine.medicationName)
    ) {
      const activeId = state.activeMedicine.id || state.activeMedicine.client_med_id;
      const activeName = (state.activeMedicine.name || state.activeMedicine.medicationName || "")
        .trim()
        .toLowerCase();
      const exists = (state.medicinesToAdd || []).some(
        (m) =>
          (activeId && (m.id === activeId || m.client_med_id === activeId)) ||
          ((m.name || m.medicationName || "").trim().toLowerCase() === activeName &&
            activeName.length > 0),
      );
      if (!exists) {
        state.medicinesToAdd.push({
          ...state.activeMedicine,
          selected:
            state.activeMedicine.selected !== undefined ? state.activeMedicine.selected : true,
          isSaved: false,
        });
      }
    }
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
      state.documentOwnershipConfirmed = null;
    }
    if (state.bloodGroupSkipped === undefined) state.bloodGroupSkipped = false;
    if (state.allergiesSkipped === undefined) state.allergiesSkipped = false;
    if (state.documentExtracted === undefined) state.documentExtracted = false;
    if (state.selectedProfileSource === undefined) state.selectedProfileSource = null;
    if (state.useSocialData === undefined) state.useSocialData = false;
    if (state.useDocumentData === undefined) state.useDocumentData = false;
    if (state.profileManuallyEdited === undefined) state.profileManuallyEdited = false;

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
            state.loadedDocumentId = docRow.id;
            state.documentId = docRow.id;
            state.documentUploaded = true;
            state.documentExtracted = true;
            if (Array.isArray(structured.medications) && structured.medications.length > 0) {
              state.foundMedicines = structured.medications;
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
    if (state.loginData && typeof state.loginData === "object") {
      state.hasLoginData = Object.values(state.loginData).some(
        (field) => field && field.value !== null && field.value !== "",
      );
      state.hasSocialData = state.hasLoginData;
      state.socialData = {
        firstName: state.loginData.firstName?.value || null,
        lastName: state.loginData.lastName?.value || null,
        email: state.loginData.email?.value || null,
        gender: state.loginData.gender?.value || null,
        dateOfBirth: state.loginData.dateOfBirth?.value || null,
        phoneNumber: state.loginData.phoneNumber?.value || null,
      };
    } else if (
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
          state.loginProvider = state.loginProvider || primaryProvider;

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
            const rawMob = String(patient.mobile).trim();
            const rawCode = patient.countryCode ? String(patient.countryCode).trim() : "";
            fullMobile =
              rawMob.startsWith("+") || (rawCode && rawMob.startsWith(rawCode))
                ? rawMob
                : rawCode + rawMob;
            fullMobile = normalizePhone(fullMobile) || fullMobile;
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
            (field) => field && field.value !== null && field.value !== "",
          );

          const isSocialProvider = ["google", "facebook", "microsoft", "apple"].includes(
            primaryProvider,
          );

          if (state.hasSocialData === undefined) {
            state.hasSocialData = isSocialProvider;
          }
          state.socialData = isSocialProvider
            ? {
                firstName: state.loginData.firstName.value,
                lastName: state.loginData.lastName.value,
                email: state.loginData.email.value,
                gender: state.loginData.gender.value,
                dateOfBirth: state.loginData.dateOfBirth.value,
                phoneNumber: state.loginData.phoneNumber.value,
              }
            : null;
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

      if (userId) {
        try {
          const patientRec = await patientRepository.findById(userId);
          if (patientRec) {
            if (patientRec.firstName && !uData.firstName) uData.firstName = patientRec.firstName;
            if (patientRec.lastName && !uData.lastName) uData.lastName = patientRec.lastName;
            if (patientRec.dateOfBirth && !uData.dateOfBirth) {
              uData.dateOfBirth =
                typeof patientRec.dateOfBirth.toISOString === "function"
                  ? patientRec.dateOfBirth.toISOString().split("T")[0]
                  : String(patientRec.dateOfBirth).split("T")[0];
            }
            if (patientRec.gender && !uData.gender) uData.gender = patientRec.gender;
            if (patientRec.email && !uData.email) uData.email = patientRec.email;
            if (patientRec.mobile && !uData.phoneNumber) {
              const rawMob = String(patientRec.mobile).trim();
              const rawCode = patientRec.countryCode ? String(patientRec.countryCode).trim() : "";
              const combined =
                rawMob.startsWith("+") || (rawCode && rawMob.startsWith(rawCode))
                  ? rawMob
                  : rawCode + rawMob;
              uData.phoneNumber = normalizePhone(combined) || combined;
            }
            if (patientRec.bloodGroup && !uData.bloodGroup) {
              uData.bloodGroup = patientRec.bloodGroup;
              state.bloodGroupSkipped = true;
            }
            if (
              patientRec.allergies &&
              Array.isArray(patientRec.allergies) &&
              patientRec.allergies.length > 0 &&
              (!uData.allergies || uData.allergies.length === 0)
            ) {
              uData.allergies = patientRec.allergies;
              state.allergiesSkipped = true;
            }
          }
        } catch (err) {
          console.warn(
            "[OnboardingService] Failed to backfill existingUserData from patients table:",
            err.message,
          );
        }
      }
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
    // 1. If onboarding is completed and medication flow is done, return completed status immediately
    const data = state.existingUserData || {};
    const hasUnansweredOptional =
      ((data.bloodGroup === undefined || data.bloodGroup === null || data.bloodGroup === "") &&
        !state.bloodGroupSkipped) ||
      ((!Array.isArray(data.allergies) || data.allergies.length === 0) && !state.allergiesSkipped);
    if (state.isOnboardingCompleted && state.medicationFlowDone && !hasUnansweredOptional) {
      if (
        msg === "ADD_MORE_MEDICINES" ||
        msg.toLowerCase().includes("add more medicines") ||
        msg === "ASK_REPORT" ||
        msg === "ASK_ABOUT_REPORT" ||
        state.currentStep === "ASK_REPORT"
      ) {
        // Let it pass through to updateStateFromMessage
      } else {
        state.currentStep = state.flowMode === "MANUAL" ? "COMPLETE" : "POST_ONBOARDING";
        const step = getNextStep(state);
        await saveOnboardingState(userId, state);
        const response = await createResponse(step, state);
        return {
          ...response,
          state,
          canSkip: true,
        };
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
    // 2. If Medical Document uploaded in UPLOAD flow, fetch extracted data from DB BEFORE updating state from message
    if (
      state.flowMode === "UPLOAD" &&
      state.documentId &&
      (!state.documentExtracted ||
        !state.documentData ||
        Object.keys(state.documentData).length === 0) &&
      state.currentStep !== "ASK_UPLOAD_DOCUMENT_FAILED"
    ) {
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

          const rawDob = patientInfo.dateOfBirth || extracted.dateOfBirth || "";
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

          // Assign document data to state.existingUserData ONLY if profile is already confirmed AND document profile source was selected
          const allowDocIdentityOverride =
            state.profileConfirmed && state.selectedProfileSource === "DOCUMENT";

          if (allowDocIdentityOverride) {
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

            if (normPhone) {
              state.existingUserData.phoneNumber = normPhone;
            }
          }

          if (normBloodGroup) {
            state.existingUserData.bloodGroup = normBloodGroup;
          }

          if (normAllergies.length > 0) {
            state.existingUserData.allergies = normAllergies;
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
            const builtMeds = medicationService.buildFromDocument(state.foundMedicines);
            const existingMeds = Array.isArray(state.medicinesToAdd) ? state.medicinesToAdd : [];
            const existingManualMeds = existingMeds.filter(
              (m) =>
                m &&
                (m.source === "MANUAL" ||
                  m.isManual ||
                  m.source !== "OCR" ||
                  (m.id &&
                    (String(m.id).startsWith("med_") || String(m.id).startsWith("client_"))) ||
                  (m.client_med_id &&
                    (String(m.client_med_id).startsWith("med_") ||
                      String(m.client_med_id).startsWith("client_")))),
            );

            if (
              state.activeMedicine &&
              (state.activeMedicine.name || state.activeMedicine.medicationName)
            ) {
              const activeId = state.activeMedicine.id || state.activeMedicine.client_med_id;
              const activeName = (
                state.activeMedicine.name ||
                state.activeMedicine.medicationName ||
                ""
              )
                .trim()
                .toLowerCase();
              const isAlreadyPresent = existingManualMeds.some(
                (m) =>
                  (activeId && (m.id === activeId || m.client_med_id === activeId)) ||
                  ((m.name || m.medicationName || "").trim().toLowerCase() === activeName &&
                    activeName.length > 0),
              );
              if (!isAlreadyPresent) {
                existingManualMeds.push({
                  ...state.activeMedicine,
                  selected:
                    state.activeMedicine.selected !== undefined
                      ? state.activeMedicine.selected
                      : true,
                  isSaved: false,
                });
              }
            }

            const combinedMeds = [...builtMeds];
            const builtIdSet = new Set(
              builtMeds.map((b) => b.id || b.client_med_id).filter(Boolean),
            );
            const builtNameSet = new Set(
              builtMeds
                .map((b) => (b.name || b.medicationName || "").trim().toLowerCase())
                .filter(Boolean),
            );

            for (const manualMed of existingManualMeds) {
              const medId = manualMed.id || manualMed.client_med_id;
              const medName = (manualMed.name || manualMed.medicationName || "")
                .trim()
                .toLowerCase();
              if ((medId && builtIdSet.has(medId)) || (medName && builtNameSet.has(medName))) {
                continue;
              }
              combinedMeds.push(manualMed);
            }

            if (userId) {
              state.medicinesToAdd = await medicationService.checkDuplicateMedicationsBatch(
                userId,
                combinedMeds,
              );
            } else {
              state.medicinesToAdd = combinedMeds;
            }
          } else {
            state.foundMedicines = [];
          }

          // Set state.documentExtracted = true ONLY after documentData is successfully assigned
          state.documentExtracted = true;
          state.documentUploaded = true;
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

    // 3. Process incoming user message based on current expected step AFTER document data pre-loading
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

    // 4. Resolve next step after updates
    // If the step is REGISTER_USER, COMPLETE, or POST_ONBOARDING, mark as completed
    if (
      state.currentStep === "REGISTER_USER" ||
      state.currentStep === "COMPLETE" ||
      state.currentStep === "POST_ONBOARDING"
    ) {
      state.isOnboardingCompleted = true;
      state.medicationFlowDone = true;
      state.medicinesConfirmed = true;
      state.currentStep = state.flowMode === "MANUAL" ? "COMPLETE" : "POST_ONBOARDING";
    }

    const canSkipNow = canSkipOnboarding(state);
    let completionMessage = null;
    let completionMessageId = null;
    if (canSkipNow && !state.completionMessageSent) {
      state.completionMessageSent = true;
      completionMessage = await getLocalizedText(
        "onboarding.canSkip.message",
        "Your onboarding is complete! The Skip button is now enabled. You can tap Skip to go directly to the Dashboard and complete any remaining steps later.",
        state.preferredLanguage,
      );
      if (state.chatSessionId) {
        try {
          const savedNoticeMsg = await chatService.appendChatMessage({
            sessionId: state.chatSessionId,
            userId,
            role: "assistant",
            content: completionMessage,
            metadata: {
              action: "ONBOARDING_COMPLETED_NOTICE",
            },
          });
          if (savedNoticeMsg?.id) {
            completionMessageId = savedNoticeMsg.id;
          }
        } catch (msgErr) {
          console.warn(
            "[OnboardingService] Failed to append completion notice message:",
            msgErr.message,
          );
        }
      }
      if (!completionMessageId) {
        completionMessageId = `ai-comp-${Date.now()}`;
      }
    }

    state.canSkip = canSkipNow;

    const nextStep = getNextStep(state);
    if (nextStep && nextStep !== "COMPLETE" && nextStep !== "POST_ONBOARDING") {
      state.currentStep = nextStep;
    } else if (nextStep === "COMPLETE" || nextStep === "POST_ONBOARDING") {
      state.currentStep = nextStep;
      state.isOnboardingCompleted = true;
    }
    await saveOnboardingState(userId, state);

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
          document: response.document || null,
          suggestedQuestions: response.suggestedQuestions || null,
          keyFindings: response.document?.keyFindings || null,
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
      canSkip: canSkipNow,
      ...(completionMessage
        ? {
            completionMessage,
            completionMessageId,
            completionAction: "ONBOARDING_COMPLETED_NOTICE",
          }
        : {}),
    };
  }
}

const onboardingService = new OnboardingService();

module.exports = {
  OnboardingService,
  onboardingService,
  saveOnboardingState,
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
  canSkipOnboarding,
  isProfileComplete,
  REQUIRED_PROFILE_FIELDS,
  getMissingRequiredStep,
  getNextRequiredOrOptionalStep,
  getProfileMismatches,
  mergeAndApplyProfile,
  computeCurrentStep,
  getNextStep,
  createResponse,
  getLocalizedResponse,
  REPORT_QUESTIONS_I18N,
};
