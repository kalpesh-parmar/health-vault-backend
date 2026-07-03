/* eslint-disable no-console */
const { ollamaClient } = require("../clients/ollamaClient");
const { ONBOARDING_SYSTEM_PROMPT, TRANSLATION_SYSTEM_PROMPT } = require("../prompts");
const patientRepository = require("../../../repositories/patientRepository");
const userOnboardingRepository = require("../../../repositories/userOnboardingRepository");
const medicationService = require("../../medicationService");
const medicationReminderService = require("../../medicationReminderService");
const { languageTypeValues, languageNativeLabels } = require("../../../enums/languageType");
const { bloodGroupTypeValues } = require("../../../enums/bloodGroupType");
const { medicationTypeValues } = require("../../../enums/medicationType");
const { frequencyTypeValues } = require("../../../enums/frequencyType");

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
  if (!fullName) return { firstName: "", lastName: "" };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  const firstName = parts[0];
  const lastName = parts.slice(1).join(" ");
  return { firstName, lastName };
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
      "Extract the first name from the user input. Transliterate or translate Gujarati, Hindi, Marathi, or Tamil names to English (e.g. કલ્પેશ -> Kalpesh, रमेश -> Ramesh, ரமேஷ் -> Ramesh).";
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
    contextPrompt = "Determine if user chose YES or NO. Return strictly either 'YES' or 'NO'.";
  } else if (fieldType === "medicationName") {
    contextPrompt = "Extract the name of the medicine from the user input.";
  } else if (fieldType === "medicationType") {
    contextPrompt =
      "Extract the type of medicine. Return strictly one of: 'TABLET', 'CAPSULE', 'SYRUP', 'INJECTION', 'DROPS', 'CREAM', 'OINTMENT', 'LOTION', 'INHALER', 'SUPPOSITORY', 'PATCH', 'OTHER'.";
  } else if (fieldType === "dosePerIntake") {
    contextPrompt = "Extract the numeric dose per intake. Return a number, e.g., 1, 1.5, 2.";
  } else if (fieldType === "frequency") {
    contextPrompt =
      "Extract the frequency of taking the medicine. Return strictly one of: 'ONCE_DAILY', 'TWICE_DAILY', 'THRICE_DAILY', 'FOUR_TIMES_DAILY', 'AS_NEEDED', 'EVERY_OTHER_DAY', 'ONCE_A_WEEK'.";
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
      content: `Field: ${fieldType}
Instructions: ${contextPrompt}
User Input: "${text}"`,
    },
  ];

  try {
    const response = await ollamaClient.chat(messages, "qwen3:32b", {
      temperature: 0.1,
      maxTokens: 128,
      think: false,
    });
    const parsed = cleanAndParseJson(response);
    return parsed.value;
  } catch (err) {
    console.error(`[OnboardingService] Failed to extract ${fieldType} from user input:`, err);
    return null;
  }
}

const OnboardingStep = {
  ASK_LANGUAGE: "ASK_LANGUAGE",
  ASK_UPLOAD_OR_SKIP: "ASK_UPLOAD_OR_SKIP",
  ASK_USE_SOCIAL_LOGIN_INFO: "ASK_USE_SOCIAL_LOGIN_INFO",
  ASK_UPLOAD_DOCUMENT: "ASK_UPLOAD_DOCUMENT",
  ASK_DOCUMENT_CONFIRMATION: "ASK_DOCUMENT_CONFIRMATION",
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
  if (!state.medicinesSkipped) {
    if (!state.medicinesFlowStarted) {
      if (state.flowMode === "UPLOAD" && state.foundMedicines && state.foundMedicines.length > 0) {
        return "ASK_FOUND_MEDICINES";
      } else {
        return "ASK_ON_MEDICINES";
      }
    }

    if (state.medicinesToAdd && state.medicinesToAdd.length > 0) {
      if (!state.medicinesConfirmed) {
        return "REVIEW_MEDICINES_LIST";
      }

      for (let i = 0; i < state.medicinesToAdd.length; i++) {
        const med = state.medicinesToAdd[i];

        if (!med.medicationName) {
          state.currentMedicineIndex = i;
          return "ASK_MEDICINE_NAME";
        }
        if (!med.medicationType) {
          state.currentMedicineIndex = i;
          return "ASK_MEDICINE_TYPE";
        }
        if (med.dosePerIntake === undefined) {
          state.currentMedicineIndex = i;
          return "ASK_DOSE_PER_INTAKE";
        }
        if (!med.frequency) {
          state.currentMedicineIndex = i;
          return "ASK_MEDICINE_FREQUENCY";
        }
        if (!med.medicationSchedule || Object.keys(med.medicationSchedule).length === 0) {
          state.currentMedicineIndex = i;
          return "ASK_MEDICINE_SCHEDULE";
        }
        if (!med.foodFrequency) {
          state.currentMedicineIndex = i;
          return "ASK_MEDICINE_FOOD_FREQUENCY";
        }
        if (!med.startDate) {
          state.currentMedicineIndex = i;
          return "ASK_MEDICINE_START_DATE";
        }
        if (med.totalQuantity === undefined) {
          state.currentMedicineIndex = i;
          return "ASK_MEDICINE_QUANTITY";
        }
        if (med.ongoing === undefined) {
          state.currentMedicineIndex = i;
          return "ASK_MEDICINE_ONGOING";
        }
        if (!med.isConfirmed) {
          state.currentMedicineIndex = i;
          return "CONFIRM_MEDICINE";
        }
      }
    }
  }

  return "REGISTER_USER";
}

function computeCurrentStep(state) {
  if (state.isOnboardingCompleted) {
    return state.flowMode === "MANUAL" ? "COMPLETE" : "POST_ONBOARDING";
  }
  if (!state.preferredLanguage) return "ASK_LANGUAGE";
  if (!state.flowMode) return "ASK_UPLOAD_OR_SKIP";

  if (state.flowMode === "UPLOAD") {
    const isUploaded = state.documentUploaded || state.uploadedMedicalDocument || false;
    if (!isUploaded) return "ASK_UPLOAD_DOCUMENT";
    if (state.documentExtracted && !state.documentConfirmed) {
      return "CONFIRM_DOCUMENT_DETAILS";
    }
    if (state.documentExtracted && state.hasSocialData && !state.socialDataConfirmed) {
      return "ASK_USE_SOCIAL_LOGIN_INFO";
    }
  }

  return getNextRequiredOrOptionalStep(state);
}

async function updateStateFromMessage(state, message) {
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
      const langVal = msg;
      if (languageTypeValues.includes(langVal)) {
        state.preferredLanguage = langVal;
        state.currentStep = "ASK_UPLOAD_OR_SKIP";
      } else {
        const extractedLang = await extractFieldFromMessage("preferredLanguage", msg, "english");
        if (languageTypeValues.includes(extractedLang)) {
          state.preferredLanguage = extractedLang;
          state.currentStep = "ASK_UPLOAD_OR_SKIP";
        }
      }
      break;
    }

    case "ASK_UPLOAD_OR_SKIP": {
      const fmVal = msg;
      if (fmVal === "UPLOAD" || fmVal === "MANUAL") {
        state.flowMode = fmVal;
        if (fmVal === "MANUAL" && state.hasSocialData) {
          state.socialDataConfirmed = true;
          if (state.socialData) {
            state.existingUserData.firstName =
              state.socialData.firstName || state.existingUserData.firstName;
            state.existingUserData.lastName =
              state.socialData.lastName || state.existingUserData.lastName;
            state.existingUserData.email = state.socialData.email || state.existingUserData.email;
            state.existingUserData.gender =
              state.socialData.gender || state.existingUserData.gender;
            state.existingUserData.dateOfBirth =
              state.socialData.dateOfBirth || state.existingUserData.dateOfBirth;
          }
        }
        state.currentStep = computeCurrentStep(state);
      } else {
        const extractedFM = await extractFieldFromMessage("flowMode", msg, state.preferredLanguage);
        if (extractedFM === "UPLOAD" || extractedFM === "MANUAL") {
          state.flowMode = extractedFM;
          if (extractedFM === "MANUAL" && state.hasSocialData) {
            state.socialDataConfirmed = true;
            if (state.socialData) {
              state.existingUserData.firstName =
                state.socialData.firstName || state.existingUserData.firstName;
              state.existingUserData.lastName =
                state.socialData.lastName || state.existingUserData.lastName;
              state.existingUserData.email = state.socialData.email || state.existingUserData.email;
              state.existingUserData.gender =
                state.socialData.gender || state.existingUserData.gender;
              state.existingUserData.dateOfBirth =
                state.socialData.dateOfBirth || state.existingUserData.dateOfBirth;
            }
          }
          state.currentStep = computeCurrentStep(state);
        }
      }
      break;
    }

    case "ASK_USE_SOCIAL_LOGIN_INFO": {
      const msgUpper = msg.toUpperCase();
      const isSocial = msgUpper === "SOCIAL" || msgUpper === "YES";
      const isDocument = msgUpper === "DOCUMENT" || msgUpper === "NO";

      if (isSocial) {
        state.socialDataConfirmed = true;
        if (state.socialData) {
          state.existingUserData.firstName =
            state.socialData.firstName || state.existingUserData.firstName;
          state.existingUserData.lastName =
            state.socialData.lastName || state.existingUserData.lastName;
          state.existingUserData.email = state.socialData.email || state.existingUserData.email;
          state.existingUserData.gender = state.socialData.gender || state.existingUserData.gender;
          state.existingUserData.dateOfBirth =
            state.socialData.dateOfBirth || state.existingUserData.dateOfBirth;
        }
        state.currentStep = computeCurrentStep(state);
      } else if (isDocument) {
        state.socialDataConfirmed = true;
        state.currentStep = computeCurrentStep(state);
      }
      break;
    }

    case "ASK_UPLOAD_DOCUMENT": {
      const isUploaded = state.documentUploaded || state.uploadedMedicalDocument || false;
      if (isUploaded) {
        state.currentStep = getNextRequiredOrOptionalStep(state);
      }
      break;
    }

    case "CONFIRM_DOCUMENT_DETAILS": {
      const msgUpper = msg.toUpperCase();
      if (msgUpper === "YES") {
        state.documentConfirmed = true;
        state.currentStep = computeCurrentStep(state);
      } else if (msgUpper === "NO") {
        state.documentConfirmed = false;
        state.flowMode = "MANUAL";
        state.documentUploaded = false;
        state.uploadedMedicalDocument = false;
        state.documentText = "";
        state.documentExtracted = false;
        state.existingUserData = {
          firstName: null,
          lastName: null,
          dateOfBirth: null,
          gender: null,
          email: null,
          bloodGroup: null,
          allergies: [],
        };
        state.currentStep = "ASK_FIRST_NAME";
      } else {
        const extractedConf = await extractFieldFromMessage(
          "documentConfirmed",
          msg,
          state.preferredLanguage,
        );
        if (extractedConf === "YES") {
          state.documentConfirmed = true;
          state.currentStep = computeCurrentStep(state);
        } else if (extractedConf === "NO") {
          state.documentConfirmed = false;
          state.flowMode = "MANUAL";
          state.documentUploaded = false;
          state.uploadedMedicalDocument = false;
          state.documentText = "";
          state.documentExtracted = false;
          state.existingUserData = {
            firstName: null,
            lastName: null,
            dateOfBirth: null,
            gender: null,
            email: null,
            bloodGroup: null,
            allergies: [],
          };
          state.currentStep = "ASK_FIRST_NAME";
        }
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
      if (genVal === "male" || genVal === "female") {
        state.existingUserData.gender = genVal;
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_BLOOD_GROUP": {
      if (isSkip || msg.toUpperCase() === "SKIP") {
        state.bloodGroupSkipped = true;
        state.existingUserData.bloodGroup = null;
      } else {
        const bgVal = await extractFieldFromMessage("bloodGroup", msg, state.preferredLanguage);
        if (bloodGroupTypeValues.includes(bgVal)) {
          state.existingUserData.bloodGroup = bgVal;
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
      if (yesNoVal === "YES" || msg.toUpperCase() === "YES") {
        state.medicinesFlowStarted = true;
        if (state.currentStep === "ASK_FOUND_MEDICINES") {
          state.medicinesToAdd = (state.foundMedicines || []).map((m) => {
            let parsedDose = undefined;
            if (m.dosage && typeof m.dosage === "string") {
              const parts = m.dosage
                .split("-")
                .map((p) => parseInt(p, 10))
                .filter((n) => !isNaN(n));
              if (parts.length > 0) {
                parsedDose = Math.max(...parts);
              }
            }
            return {
              medicationName: m.name || m.medicationName,
              medicationType: undefined,
              dosePerIntake: parsedDose,
              frequency: undefined,
              medicationSchedule: undefined,
              foodFrequency: undefined,
              startDate: undefined,
              totalQuantity: undefined,
              ongoing: undefined,
              isConfirmed: false,
            };
          });
          // Intentionally NOT setting medicinesConfirmed to true here,
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
      const txt = msg.toUpperCase();
      if (txt.includes("EDIT") || txt === "NO") {
        // UI handle
      } else {
        state.medicinesConfirmed = true;
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_MEDICINE_NAME": {
      const idx = state.currentMedicineIndex;
      const med = state.medicinesToAdd[idx];
      med.medicationName = await extractFieldFromMessage(
        "medicationName",
        msg,
        state.preferredLanguage,
      );
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }
    case "ASK_MEDICINE_TYPE": {
      const idx = state.currentMedicineIndex;
      const med = state.medicinesToAdd[idx];
      if (medicationTypeValues.includes(msg.toUpperCase())) {
        med.medicationType = msg.toUpperCase();
      } else {
        med.medicationType = await extractFieldFromMessage(
          "medicationType",
          msg,
          state.preferredLanguage,
        );
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }
    case "ASK_DOSE_PER_INTAKE": {
      const idx = state.currentMedicineIndex;
      const med = state.medicinesToAdd[idx];
      med.dosePerIntake = await extractFieldFromMessage(
        "dosePerIntake",
        msg,
        state.preferredLanguage,
      );
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }
    case "ASK_MEDICINE_FREQUENCY": {
      const idx = state.currentMedicineIndex;
      const med = state.medicinesToAdd[idx];
      if (frequencyTypeValues.includes(msg.toUpperCase())) {
        med.frequency = msg.toUpperCase();
      } else {
        med.frequency = await extractFieldFromMessage("frequency", msg, state.preferredLanguage);
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }
    case "ASK_MEDICINE_SCHEDULE": {
      const idx = state.currentMedicineIndex;
      const med = state.medicinesToAdd[idx];
      if (!med.tempTimes) med.tempTimes = [];

      let expectedDoses = 1;
      if (med.frequency === "TWICE_DAILY") expectedDoses = 2;
      if (med.frequency === "THREE_TIMES_DAILY") expectedDoses = 3;
      if (med.frequency === "FOUR_TIMES_DAILY") expectedDoses = 4;

      const timeVal = await extractFieldFromMessage("time24Hour", msg, state.preferredLanguage);
      if (timeVal) {
        med.tempTimes.push(timeVal);
      }

      if (med.tempTimes.length >= expectedDoses || med.frequency === "AS_NEEDED") {
        let schedule = {};
        let customTimes = [];

        for (const timeStr of med.tempTimes) {
          const hour = parseInt(timeStr.split(":")[0], 10);
          let key = "Custom";
          if (hour >= 5 && hour < 12) key = "Morning";
          else if (hour >= 12 && hour < 17) key = "Noon";
          else if (hour >= 17 || hour < 5) key = "Night";

          if (key !== "Custom" && !schedule[key]) {
            schedule[key] = timeStr;
          } else {
            customTimes.push(timeStr);
          }
        }

        if (customTimes.length > 0) {
          schedule.CUSTOM = customTimes;
        }

        med.medicationSchedule = schedule;
        delete med.tempTimes;
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }
    case "ASK_MEDICINE_FOOD_FREQUENCY": {
      const idx = state.currentMedicineIndex;
      const med = state.medicinesToAdd[idx];
      if (msg.toUpperCase() === "BEFORE_FOOD" || msg.toUpperCase() === "AFTER_FOOD") {
        med.foodFrequency = msg.toUpperCase();
      } else {
        med.foodFrequency = await extractFieldFromMessage(
          "foodFrequency",
          msg,
          state.preferredLanguage,
        );
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }
    case "ASK_MEDICINE_START_DATE": {
      const idx = state.currentMedicineIndex;
      const med = state.medicinesToAdd[idx];
      const d = await extractFieldFromMessage("startDate", msg, state.preferredLanguage);
      if (d) med.startDate = d;
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }
    case "ASK_MEDICINE_QUANTITY": {
      const idx = state.currentMedicineIndex;
      const med = state.medicinesToAdd[idx];
      const quantity = await extractFieldFromMessage("totalQuantity", msg, state.preferredLanguage);
      med.totalQuantity = parseInt(quantity, 10);
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }
    case "ASK_MEDICINE_ONGOING": {
      const idx = state.currentMedicineIndex;
      const med = state.medicinesToAdd[idx];
      const yesNoVal = await extractFieldFromMessage("yesNo", msg, state.preferredLanguage);
      med.ongoing = yesNoVal === "YES" || msg.toUpperCase() === "YES";
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "CONFIRM_MEDICINE": {
      const txt = msg.toUpperCase();
      const yesNoVal = await extractFieldFromMessage("yesNo", msg, state.preferredLanguage);
      if (txt.includes("EDIT") || txt === "NO" || yesNoVal === "NO") {
        // Keep the values but mark as unconfirmed so UI can open edit form
        state.medicinesToAdd[state.currentMedicineIndex].isConfirmed = false;
        state.currentStep = "EDIT_MEDICINE";
      } else {
        state.medicinesToAdd[state.currentMedicineIndex].isConfirmed = true;
        state.currentStep = getNextRequiredOrOptionalStep(state);
      }
      break;
    }

    case "EDIT_MEDICINE": {
      // The UI has sent the updated medicine details in the state.
      // We mark it as confirmed and proceed.
      state.medicinesToAdd[state.currentMedicineIndex].isConfirmed = true;
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "REGISTER_USER":
    case "COMPLETE":
    case "POST_ONBOARDING": {
      state.currentStep = computeCurrentStep(state);
      break;
    }
  }
}

async function translateMessage(text, language) {
  if (!text || language === "english") return text;

  const messages = [
    {
      role: "system",
      content: TRANSLATION_SYSTEM_PROMPT(language),
    },
    {
      role: "user",
      content: text,
    },
  ];

  try {
    const response = await ollamaClient.chat(messages, "qwen3:32b", {
      temperature: 0.1,
      maxTokens: 256,
      think: false,
    });
    return response.trim();
  } catch (err) {
    console.error(`[OnboardingService] Failed to translate text to ${language}:`, err);
    return text; // Fallback to English
  }
}

function getNextStep(state) {
  return state.currentStep || computeCurrentStep(state);
}

function createResponse(step, state) {
  return getLocalizedResponse(step, state);
}

function getLocalizedResponse(step, state) {
  switch (step) {
    case "ASK_LANGUAGE":
      return {
        action: "ASK_LANGUAGE",
        message: "Welcome! please select your preferred language..?",
        options: languageTypeValues.map((lang) => ({
          label: languageNativeLabels[lang] || lang,
          value: lang,
        })),
      };

    case "ASK_UPLOAD_OR_SKIP":
      return {
        action: "ASK_UPLOAD_OR_SKIP",
        message: "How would you like to provide your details?",
        options: [
          { label: "Upload Medical Document", value: "UPLOAD" },
          { label: "Enter Details Manually", value: "MANUAL" },
        ],
      };

    case "ASK_USE_SOCIAL_LOGIN_INFO":
      return {
        action: "ASK_USE_SOCIAL_LOGIN_INFO",
        message:
          "We found existing details from your social login. Should we use those, or the details from the uploaded document?",
        options: [
          { label: "Use Login Details", value: "SOCIAL" },
          { label: "Use Document Details", value: "DOCUMENT" },
        ],
      };
    case "ASK_UPLOAD_DOCUMENT":
      return {
        action: "ASK_UPLOAD_DOCUMENT",
        message: "Please upload your medical document (Prescription, Lab Report, etc.).",
      };

    case "PROCESSING_DOCUMENT":
      return {
        action: "PROCESSING_DOCUMENT",
        message: "I am analyzing your document...",
      };

    // case "CONFIRM_DOCUMENT_DETAILS":
    //   return {
    //     action: "CONFIRM_DOCUMENT_DETAILS",
    //     message: "I have extracted the details. Please confirm if they are correct.",
    //     options: [
    //       { label: "Yes, they are correct", value: "YES" },
    //       { label: "No, let me enter manually", value: "NO" },
    //     ],
    //   };
    case "CONFIRM_DOCUMENT_DETAILS":
      return {
        action: "CONFIRM_DOCUMENT_DETAILS",
        message: "I have extracted the details. Please confirm if they are correct.",
        options: [
          { label: "Yes, they are correct", value: "YES" },
          { label: "No, let me enter manually", value: "NO" },
        ],
      };

    case "ASK_FIRST_NAME":
      return { action: "ASK_FIRST_NAME", message: "What is your first name?" };

    case "ASK_LAST_NAME":
      return { action: "ASK_LAST_NAME", message: "What is your last name?" };

    case "ASK_DOB":
      return {
        action: "ASK_DOB",
        message: "What is your date of birth?",
      };

    case "ASK_GENDER":
      return {
        action: "ASK_GENDER",
        message: "What is your gender?",
        options: [
          { label: "Male", value: "male" },
          { label: "Female", value: "female" },
        ],
      };

    case "ASK_BLOOD_GROUP":
      return {
        action: "ASK_BLOOD_GROUP",
        message: "What is your blood group? You can skip this question.",
        options: [
          { label: "Skip", value: "SKIP" },
          ...bloodGroupTypeValues.map((bg) => ({ label: bg, value: bg })),
        ],
      };

    case "ASK_ALLERGIES":
      return {
        action: "ASK_ALLERGIES",
        message: "Do you have any allergies? You can skip this question.",
        options: [{ label: "Skip", value: "SKIP" }],
      };

    case "ASK_FOUND_MEDICINES": {
      const medNames = (state.foundMedicines || [])
        .map((m) => m.name || m.medicationName)
        .filter(Boolean)
        .join(", ");
      return {
        action: "ASK_FOUND_MEDICINES",
        message: `We found the following medicines in your document: ${medNames}. Do you want to add these to your profile?`,
        options: [
          { label: "Yes", value: "YES" },
          { label: "No", value: "NO" },
        ],
      };
    }

    case "ASK_ON_MEDICINES":
      return {
        action: "ASK_ON_MEDICINES",
        message: "Would you like to manually add any medicines?",
        options: [
          { label: "Yes", value: "YES" },
          { label: "No", value: "NO" },
        ],
      };

    case "REVIEW_MEDICINES_LIST":
      return {
        action: "REVIEW_MEDICINES_LIST",
        message: "Please review your medicine list.",
        options: [
          { label: "Confirm", value: "CONFIRM" },
          { label: "Edit", value: "EDIT" },
        ],
      };

    case "ASK_MEDICINE_NAME":
      return {
        action: "ASK_MEDICINE_NAME",
        message: "What is the name of the medicine?",
      };
    case "ASK_MEDICINE_TYPE":
      return {
        action: "ASK_MEDICINE_TYPE",
        message: "What type of medicine is it?",
        options: medicationTypeValues.map((mt) => ({ label: mt, value: mt })),
      };
    case "ASK_DOSE_PER_INTAKE":
      return {
        action: "ASK_DOSE_PER_INTAKE",
        message: "What is the dose per intake?",
      };
    case "ASK_MEDICINE_FREQUENCY":
      return {
        action: "ASK_MEDICINE_FREQUENCY",
        message: "How often do you take it?",
        options: frequencyTypeValues.map((ft) => ({ label: ft, value: ft })),
      };
    case "ASK_MEDICINE_SCHEDULE": {
      const idx = state?.currentMedicineIndex || 0;
      const med = state?.medicinesToAdd?.[idx] || {};
      let doseNum = (med.tempTimes?.length || 0) + 1;
      return {
        action: "ASK_MEDICINE_SCHEDULE",
        message: `Please provide the exact time for dose ${doseNum} (e.g. '09:00:00' or '22:00:00').`,
      };
    }
    case "ASK_MEDICINE_FOOD_FREQUENCY":
      return {
        action: "ASK_MEDICINE_FOOD_FREQUENCY",
        message: "When do you take it in relation to food?",
        options: [
          { label: "Before Food", value: "BEFORE_FOOD" },
          { label: "After Food", value: "AFTER_FOOD" },
        ],
      };
    case "ASK_MEDICINE_START_DATE":
      return {
        action: "ASK_MEDICINE_START_DATE",
        message: "When did you start taking this medicine (YYYY-MM-DD)?",
      };
    case "ASK_MEDICINE_QUANTITY":
      return {
        action: "ASK_MEDICINE_QUANTITY",
        message: "What is the total quantity prescribed?",
      };
    case "ASK_MEDICINE_ONGOING":
      return {
        action: "ASK_MEDICINE_ONGOING",
        message: "Are you currently taking this medication (Ongoing)?",
        options: [
          { label: "Yes", value: "YES" },
          { label: "No", value: "NO" },
        ],
      };

    case "CONFIRM_MEDICINE":
      return {
        action: "CONFIRM_MEDICINE",
        message: "Are these details correct?",
        options: [
          { label: "Yes", value: "YES" },
          { label: "Edit", value: "EDIT" },
        ],
      };

    case "EDIT_MEDICINE":
      return {
        action: "EDIT_MEDICINE",
        message: "Please edit the medication details and submit.",
        options: [{ label: "Confirm", value: "CONFIRM" }],
      };

    case "COMPLETE":
    case "POST_ONBOARDING": {
      const hasMedicines =
        state.medicinesToAdd && state.medicinesToAdd.length > 0 && !state.medicinesSkipped;
      const finalOptions = [];
      finalOptions.push({ label: "Go to Dashboard", value: "GO_TO_DASHBOARD" });

      // Only show the report option if they uploaded a document (POST_ONBOARDING step)
      if (step === "POST_ONBOARDING") {
        finalOptions.push({ label: "Ask About My Report", value: "ASK_ABOUT_REPORT" });
      }
      if (hasMedicines) {
        finalOptions.push({ label: "Add More Medicines", value: "ADD_MORE_MEDICINES" });
        finalOptions.push({ label: "View My Medicines", value: "VIEW_MEDICINES" });
      }

      return {
        action: step,
        message: "Thank you! Onboarding is complete. What would you like to do next?",
        options: finalOptions,
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
  async chat(message, history = [], state = {}, userId = null) {
    const msg = (message || "").trim();

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
    if (state.bloodGroupSkipped === undefined) state.bloodGroupSkipped = false;
    if (state.allergiesSkipped === undefined) state.allergiesSkipped = false;
    if (state.documentExtracted === undefined) state.documentExtracted = false;

    // Check for social login data
    if (state.hasSocialData === undefined) {
      if (userId) {
        const patient = await patientRepository.findById(userId);
        if (patient && patient.firstName && patient.firstName !== "User") {
          state.hasSocialData = true;
          state.socialData = {
            firstName: patient.firstName,
            lastName:
              patient.lastName !== "+91" && !patient.lastName?.startsWith("+")
                ? patient.lastName
                : null,
            email: patient.email,
            gender: patient.gender,
            dateOfBirth: patient.dateOfBirth
              ? patient.dateOfBirth.toISOString().split("T")[0]
              : null,
          };
        } else {
          state.hasSocialData = false;
        }
      } else {
        state.hasSocialData = false;
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
    // 1. If onboarding is completed, return completed status immediately
    if (state.isOnboardingCompleted) {
      state.currentStep = state.flowMode === "MANUAL" ? "COMPLETE" : "POST_ONBOARDING";
      const step = getNextStep(state);
      return createResponse(step, state);
    }
    const isInitCall = history.length === 0 && msg.toLowerCase() === "hello";

    // 2. Process incoming user message based on current expected step BEFORE update
    if (!isInitCall) {
      await updateStateFromMessage(state, msg);
    }
    // Extra safeguard: if a document has already been uploaded/extracted in UPLOAD flow,
    // ensure we don't get stuck in upload/confirm steps.
    const isDocUploaded = state.documentUploaded || state.uploadedMedicalDocument || false;
    if (state.flowMode === "UPLOAD" && isDocUploaded) {
      if (
        state.currentStep === "ASK_UPLOAD_DOCUMENT" ||
        state.currentStep === "ASK_UPLOAD_OR_SKIP" ||
        state.currentStep === "ASK_DOCUMENT_CONFIRMATION"
      ) {
        state.currentStep = getNextRequiredOrOptionalStep(state);
      }
    }

    // 3. If Medical Document uploaded in UPLOAD flow, perform extraction using Qwen3 or use pre-extracted data
    if (
      state.flowMode === "UPLOAD" &&
      (state.uploadedMedicalDocument || state.documentUploaded) &&
      (state.documentText || state.documentData) &&
      !state.documentExtracted
    ) {
      if (state.documentData) {
        console.log("[OnboardingService] Using pre-extracted document data from state...");
        const extracted = state.documentData;

        if (extracted.firstName || extracted.lastName) {
          state.existingUserData.firstName =
            extracted.firstName || state.existingUserData.firstName;
          state.existingUserData.lastName = extracted.lastName || state.existingUserData.lastName;
        }

        if (extracted.dateOfBirth) {
          state.existingUserData.dateOfBirth = normalizeDOB(extracted.dateOfBirth);
        }

        if (extracted.gender) {
          state.existingUserData.gender = extracted.gender;
        }

        if (extracted.email) {
          state.existingUserData.email = extracted.email.trim();
        }

        if (extracted.bloodGroup) {
          state.existingUserData.bloodGroup = extracted.bloodGroup;
        }

        if (Array.isArray(extracted.allergies)) {
          state.existingUserData.allergies = extracted.allergies.map((a) => String(a).trim());
        }

        if (extracted.phoneNumber) {
          state.existingUserData.phoneNumber = extracted.phoneNumber.trim();
        }

        if (Array.isArray(extracted.medicalConditions)) {
          state.existingUserData.medicalConditions = extracted.medicalConditions.map((c) =>
            String(c).trim(),
          );
        }

        if (extracted.address) {
          state.existingUserData.address = extracted.address.trim();
        }

        if (Array.isArray(extracted.medications) && extracted.medications.length > 0) {
          state.foundMedicines = extracted.medications;
        } else {
          state.foundMedicines = [];
        }

        state.documentExtracted = true;
        state.documentUploaded = true;
        // state.documentConfirmed = true; // Auto-confirm document
        state.currentStep = computeCurrentStep(state);
      } else if (state.documentText) {
        console.log("[OnboardingService] Processing medical document for extraction...");
        try {
          const extractionMessages = [
            { role: "system", content: ONBOARDING_SYSTEM_PROMPT },
            { role: "user", content: `Document OCR Text:\n${state.documentText}` },
          ];

          let chatResponse = await ollamaClient.chat(extractionMessages, "qwen3:32b", {
            temperature: 0.2,
            maxTokens: 1024,
            think: false,
            returnFullResponse: true,
          });

          if (chatResponse.done_reason === "length") {
            console.warn(
              "[OnboardingService] Document extraction truncated. Retrying with maxTokens 2048...",
            );
            chatResponse = await ollamaClient.chat(extractionMessages, "qwen3:32b", {
              temperature: 0.2,
              maxTokens: 2048,
              think: false,
              returnFullResponse: true,
            });
          }

          if (chatResponse.text) {
            const extracted = cleanAndParseJson(chatResponse.text);
            console.log("[OnboardingService] Extraction complete:", extracted);

            if (extracted.firstName || extracted.lastName) {
              const fullName = `${extracted.firstName || ""} ${extracted.lastName || ""}`.trim();
              const { firstName, lastName } = splitName(fullName);
              state.existingUserData.firstName = firstName || null;
              state.existingUserData.lastName = lastName || null;
            }

            if (extracted.dateOfBirth) {
              state.existingUserData.dateOfBirth = normalizeDOB(extracted.dateOfBirth);
            }

            if (extracted.gender) {
              state.existingUserData.gender = extracted.gender;
            }

            if (extracted.email) {
              state.existingUserData.email = extracted.email.trim();
            }

            if (extracted.bloodGroup) {
              state.existingUserData.bloodGroup = extracted.bloodGroup;
            }

            if (Array.isArray(extracted.allergies)) {
              state.existingUserData.allergies = extracted.allergies.map((a) => String(a).trim());
            }

            if (extracted.phoneNumber) {
              state.existingUserData.phoneNumber = extracted.phoneNumber.trim();
            }

            if (Array.isArray(extracted.medicalConditions)) {
              state.existingUserData.medicalConditions = extracted.medicalConditions.map((c) =>
                String(c).trim(),
              );
            }

            if (extracted.address) {
              state.existingUserData.address = extracted.address.trim();
            }
          }
        } catch (err) {
          console.error("[OnboardingService] Document extraction failure:", err);
        }
        state.documentExtracted = true;

        state.documentUploaded = true;
        // state.documentConfirmed = true;
        state.currentStep = computeCurrentStep(state);
      }
    }

    // 4. Resolve next step after updates
    // If the step is REGISTER_USER, mark as completed
    if (state.currentStep === "REGISTER_USER") {
      state.isOnboardingCompleted = true;
      state.currentStep = state.flowMode === "MANUAL" ? "COMPLETE" : "POST_ONBOARDING";
    }

    if (userId && state.existingUserData) {
      const updateData = {};
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
        updateData.gender = state.existingUserData.gender;
      if (state.existingUserData.email) updateData.email = state.existingUserData.email;
      if (state.existingUserData.bloodGroup)
        updateData.bloodGroup = state.existingUserData.bloodGroup;
      if (state.existingUserData.allergies && state.existingUserData.allergies.length > 0)
        updateData.allergies = state.existingUserData.allergies;

      if (state.isOnboardingCompleted) {
        updateData.status = "ACTIVE";
        updateData.isVerified = true;
        updateData.onboardingCompleted = true;

        if (
          state.medicinesConfirmed &&
          Array.isArray(state.medicinesToAdd) &&
          !state.medicinesSavedToDb
        ) {
          for (const med of state.medicinesToAdd) {
            try {
              // Only send if it has medicationName
              if (med.medicationName) {
                // Ensure ongoing is boolean and reminderBeforeMinutes is integer if present
                const payload = {
                  ...med,
                  ongoing: med.ongoing === true || med.ongoing === "true",
                  reminderBeforeMinutes: med.reminderBeforeMinutes
                    ? parseInt(med.reminderBeforeMinutes, 10)
                    : undefined,
                };
                delete payload.isConfirmed;
                delete payload.tempTimes;
                const medication = await medicationService.createMedication(userId, payload);
                await medicationReminderService.createReminder(userId, {
                  medicationId: medication.id,
                });
              }
            } catch (err) {
              console.error(
                `[OnboardingService] Error creating medication ${med.medicationName}:`,
                err,
              );
            }
          }
          // Mark as saved to prevent duplicate creation on subsequent steps, without clearing the array
          state.medicinesSavedToDb = true;
        }
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
        socialDataConfirmed: state.socialDataConfirmed,
        documentText: state.documentText,
        documentData: state.documentData,
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
    const response = createResponse(nextStep, state);

    if (state.preferredLanguage && state.preferredLanguage !== "english") {
      if (response.message) {
        response.message = await translateMessage(response.message, state.preferredLanguage);
      }
      if (response.options && Array.isArray(response.options)) {
        response.options = await Promise.all(
          response.options.map(async (opt) => ({
            ...opt,
            label: await translateMessage(opt.label, state.preferredLanguage),
          })),
        );
      }
    }

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
