/* eslint-disable no-console */
const { ollamaClient } = require("../clients/ollamaClient");
const { ONBOARDING_SYSTEM_PROMPT } = require("../prompts");
const patientRepository = require("../../../repositories/patientRepository");
const userOnboardingRepository = require("../../../repositories/userOnboardingRepository");

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

function normalizeGender(genderStr) {
  if (!genderStr) return "";
  const cleaned = genderStr.trim().toLowerCase();

  if (cleaned.includes("female") || cleaned === "સ્ત્રી" || cleaned === "stri") {
    return "female";
  }
  if (cleaned.includes("male") || cleaned === "પુરુષ" || cleaned === "purush") {
    return "male";
  }
  return "";
}

function normalizeBloodGroup(bgStr) {
  if (!bgStr) return "";
  const cleaned = bgStr.trim().toUpperCase();
  const valid = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
  if (valid.includes(cleaned)) {
    return cleaned;
  }
  return "";
}

function localParseInput(fieldType, text) {
  const cleaned = String(text).trim();
  const lower = cleaned.toLowerCase();

  if (fieldType === "preferredLanguage") {
    if (["en", "english", "eng"].includes(lower)) return "english";
    if (["gu", "gujarati", "guj", "ગુજરાતી"].includes(lower) || cleaned === "ગુજરાતી")
      return "gujarati";
    if (
      ["hi", "hindi", "hin", "हिन्दी", "हिंदी"].includes(lower) ||
      cleaned === "हिन्दी" ||
      cleaned === "हिंदी"
    )
      return "hindi";
    if (["mr", "marathi", "mar", "मराठी"].includes(lower) || cleaned === "मराठी") return "marathi";
    if (["ta", "tamil", "tam", "தமிழ்"].includes(lower) || cleaned === "தமிழ்") return "tamil";
  }

  if (fieldType === "flowMode") {
    if (
      ["upload", "upload medical report", "upload_document", "upload document"].includes(lower) ||
      lower.includes("upload") ||
      cleaned.includes("અપલોડ")
    ) {
      return "UPLOAD";
    }
    if (
      [
        "manual",
        "skip",
        "enter manually",
        "skip and enter manually",
        "જાતે માહિતી ભરો",
        "manual_entry",
        "manual entry",
      ].includes(lower) ||
      lower.includes("manual") ||
      lower.includes("skip") ||
      cleaned === "જાતે માહિતી ભરો"
    ) {
      return "MANUAL";
    }
  }

  if (fieldType === "documentConfirmed") {
    if (
      ["yes", "y", "yeah", "confirm", "હા", "yes (હા)", "yes(હા)", "yes_confirm"].includes(lower) ||
      lower.includes("yes") ||
      lower.includes("confirm") ||
      cleaned.includes("હા")
    ) {
      return "YES";
    }
    if (
      ["no", "n", "nope", "reject", "ના", "no (ના)", "no(ના)", "no_reject"].includes(lower) ||
      lower.includes("no") ||
      lower.includes("reject") ||
      cleaned.includes("ના")
    ) {
      return "NO";
    }
  }

  if (fieldType === "gender") {
    if (["male", "m", "પુરુષ", "purush", "males"].includes(lower) || cleaned === "પુરુષ")
      return "male";
    if (["female", "f", "સ્ત્રી", "stri", "females"].includes(lower) || cleaned === "સ્ત્રી")
      return "female";
  }

  if (fieldType === "bloodGroup") {
    const bg = normalizeBloodGroup(cleaned);
    if (bg) return bg;
  }

  return null;
}

async function extractFieldFromMessage(fieldType, text, _lang) {
  // Direct check for language independent skip patterns
  const lower = text.trim().toLowerCase();
  const skipPatterns = [
    "skip",
    "સ્કિપ",
    "skip question",
    "skip_question",
    "સ્કિપ કરો",
    "question skip",
    "skipquestion",
  ];
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

  return "REGISTER_USER";
}

function computeCurrentStep(state) {
  if (state.isOnboardingCompleted) {
    return state.flowMode === "MANUAL" ? "COMPLETE" : "POST_ONBOARDING";
  }
  if (!state.preferredLanguage) return "ASK_LANGUAGE";
  if (!state.flowMode) return "ASK_UPLOAD_OR_SKIP";

  if (state.hasSocialData && state.socialDataConfirmed === undefined) {
    return "ASK_USE_SOCIAL_LOGIN_INFO";
  }

  if (state.flowMode === "UPLOAD") {
    const isUploaded = state.documentUploaded || state.uploadedMedicalDocument || false;
    if (!isUploaded) return "ASK_UPLOAD_DOCUMENT";
  }

  return getNextRequiredOrOptionalStep(state);
}

async function updateStateFromMessage(state, message) {
  const msg = (message || "").trim();
  const lower = msg.toLowerCase();
  const isSkip = [
    "skip",
    "સ્કિપ",
    "skip question",
    "skip_question",
    "સ્કિપ કરો",
    "question skip",
    "skipquestion",
  ].includes(lower);

  if (!state.currentStep) return;

  switch (state.currentStep) {
    case "ASK_LANGUAGE": {
      const langVal = localParseInput("preferredLanguage", msg);
      if (
        langVal === "english" ||
        langVal === "gujarati" ||
        langVal === "hindi" ||
        langVal === "marathi" ||
        langVal === "tamil"
      ) {
        state.preferredLanguage = langVal;
        state.currentStep = "ASK_UPLOAD_OR_SKIP";
      } else {
        const extractedLang = await extractFieldFromMessage("preferredLanguage", msg, "english");
        if (
          extractedLang === "gujarati" ||
          extractedLang === "english" ||
          extractedLang === "hindi" ||
          extractedLang === "marathi" ||
          extractedLang === "tamil"
        ) {
          state.preferredLanguage = extractedLang;
          state.currentStep = "ASK_UPLOAD_OR_SKIP";
        }
      }
      break;
    }

    case "ASK_UPLOAD_OR_SKIP": {
      const fmVal = localParseInput("flowMode", msg);
      if (fmVal === "UPLOAD" || fmVal === "MANUAL") {
        state.flowMode = fmVal;
        state.currentStep = computeCurrentStep(state);
      } else {
        const extractedFM = await extractFieldFromMessage("flowMode", msg, state.preferredLanguage);
        if (extractedFM === "UPLOAD" || extractedFM === "MANUAL") {
          state.flowMode = extractedFM;
          state.currentStep = computeCurrentStep(state);
        }
      }
      break;
    }
    case "ASK_USE_SOCIAL_LOGIN_INFO": {
      const isYes =
        msg.toLowerCase().includes("yes") ||
        msg.toLowerCase().includes("હા") ||
        msg.toLowerCase().includes("हाँ") ||
        msg.toLowerCase().includes("हो") ||
        msg.toLowerCase().includes("ஆம்");
      const isNo =
        msg.toLowerCase().includes("no") ||
        msg.toLowerCase().includes("ના") ||
        msg.toLowerCase().includes("नहीं") ||
        msg.toLowerCase().includes("नाही") ||
        msg.toLowerCase().includes("இல்லை");

      if (isYes) {
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
      } else if (isNo) {
        state.socialDataConfirmed = false;
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

    case "ASK_DOCUMENT_CONFIRMATION": {
      const confVal = localParseInput("documentConfirmed", msg);
      if (
        confVal === "YES" ||
        msg.toUpperCase() === "YES" ||
        msg.toUpperCase() === "YES (હા)" ||
        msg.toUpperCase() === "YES(હા)"
      ) {
        state.documentConfirmed = true;
        state.currentStep = getNextRequiredOrOptionalStep(state);
      } else if (
        confVal === "NO" ||
        msg.toUpperCase() === "NO" ||
        msg.toUpperCase() === "NO (ના)" ||
        msg.toUpperCase() === "NO(ના)"
      ) {
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
          state.currentStep = getNextRequiredOrOptionalStep(state);
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
      const dobVal =
        localParseInput("dateOfBirth", msg) ||
        (await extractFieldFromMessage("dateOfBirth", msg, state.preferredLanguage));
      const dob = normalizeDOB(dobVal);
      if (dob) {
        state.existingUserData.dateOfBirth = dob;
      }
      state.currentStep = getNextRequiredOrOptionalStep(state);
      break;
    }

    case "ASK_GENDER": {
      const genVal =
        localParseInput("gender", msg) ||
        (await extractFieldFromMessage("gender", msg, state.preferredLanguage));
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
        const bgVal =
          localParseInput("bloodGroup", msg) ||
          (await extractFieldFromMessage("bloodGroup", msg, state.preferredLanguage));
        if (bgVal) {
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
  }
}

function getNextStep(state) {
  const step = state.currentStep || computeCurrentStep(state);

  switch (step) {
    case "ASK_LANGUAGE":
      return {
        action: "ASK_LANGUAGE",
        message_en: "Which language do you prefer?",
        options: [
          { label: "English", value: "english" },
          { label: "ગુજરાતી", value: "gujarati" },
          { label: "हिन्दी", value: "hindi" },
          { label: "मराठी", value: "marathi" },
          { label: "தமிழ்", value: "tamil" },
        ],
      };

    case "ASK_UPLOAD_OR_SKIP":
      return {
        action: "ASK_UPLOAD_OR_SKIP",
        message_en: "Would you like to upload your medical report or enter details manually?",
        message_gu: "શું તમે મેડિકલ રિપોર્ટ અપલોડ કરવા માંગો છો કે માહિતી જાતે ભરવા માંગો છો?",
        message_hi:
          "क्या आप अपनी मेडिकल रिपोर्ट अपलोड करना चाहेंगे या मैन्युअल रूप से विवरण दर्ज करना चाहेंगे?",
        message_mr:
          "तुम्ही तुमचा वैद्यकीय अहवाल अपलोड करू इच्छिता की व्यक्तिशः माहिती प्रविष्ट करू इच्छिता?",
        message_ta:
          "உங்கள் மருத்துவ அறிக்கையை பதிவேற்ற விரும்புகிறீர்களா அல்லது விவரங்களை கைமுறையாக உள்ளிட விரும்புகிறீர்களா?",
        options: [
          {
            label_en: "Upload Medical Report",
            label_gu: "મેડિકલ રિપોર્ટ અપલોડ કરો",
            label_hi: "मेडिकल रिपोर्ट अपलोड करें",
            label_mr: "वैद्यकीय अहवाल अपलोड करा",
            label_ta: "மருத்துவ அறிக்கையை பதிவேற்றவும்",
            value: "UPLOAD",
          },
          {
            label_en: "Skip and Enter Manually",
            label_gu: "જાતે માહિતી ભરો",
            label_hi: "मैन्युअल रूप से दर्ज करें",
            label_mr: "व्यक्तिशः माहिती प्रविष्ट करा",
            label_ta: "கைமுறையாக உள்ளிடவும்",
            value: "MANUAL",
          },
        ],
      };

    case "ASK_USE_SOCIAL_LOGIN_INFO":
      return {
        action: "ASK_USE_SOCIAL_LOGIN_INFO",
        message_en:
          "We found your existing profile details from your social login. Would you like to use this information?",
        message_gu:
          "અમને સોશિયલ લોગિન પરથી તમારી પ્રોફાઇલ માહિતી મળી છે. શું તમે આ માહિતીનો ઉપયોગ કરવા માંગો છો?",
        message_hi:
          "हमें सोशल लॉगिन से आपकी प्रोफ़ाइल जानकारी मिली है। क्या आप इस जानकारी का उपयोग करना चाहेंगे?",
        message_mr:
          "आम्हाला सोशल लॉगिनवरून तुमची प्रोफाइल माहिती मिळाली आहे. तुम्ही ही माहिती वापरू इच्छिता का?",
        message_ta:
          "உங்கள் சமூக உள்நுழைவிலிருந்து உங்கள் சுயவிவர விவரங்களை நாங்கள் கண்டறிந்துள்ளோம். இந்த தகவலை பயன்படுத்த விரும்புகிறீர்களா?",
        options: [
          {
            label_en: "Yes",
            label_gu: "હા",
            label_hi: "हाँ",
            label_mr: "होय",
            label_ta: "ஆம்",
            value: "YES",
          },
          {
            label_en: "No",
            label_gu: "ના",
            label_hi: "नहीं",
            label_mr: "नाही",
            label_ta: "இல்லை",
            value: "NO",
          },
        ],
      };

    case "ASK_UPLOAD_DOCUMENT":
      return {
        action: "ASK_UPLOAD_DOCUMENT",
        message_en: "Please upload your medical document.",
        message_gu: "કૃપા કરીને તમારો મેડિકલ રિપોર્ટ અપલોડ કરો.",
        message_hi: "कृपया अपना मेडिकल दस्तावेज़ अपलोड करें।",
        message_mr: "कृपया तुमचा वैद्यकीय दस्तऐवज अपलोड करा.",
        message_ta: "தயவுசெய்து உங்கள் மருத்துவ ஆவணத்தை பதிவேற்றவும்.",
      };

    case "ASK_DOCUMENT_CONFIRMATION":
      return {
        action: "ASK_DOCUMENT_CONFIRMATION",
        message_en: "Is this your document?",
        message_gu: "શું આ તમારો રિપોર્ટ છે?",
        message_hi: "क्या यह आपका दस्तावेज़ है?",
        message_mr: "हा तुमचा दस्तऐवज आहे का?",
        message_ta: "இது உங்கள் ஆவணமா?",
        options: [
          {
            label_en: "Yes",
            label_gu: "હા",
            label_hi: "हाँ",
            label_mr: "होय",
            label_ta: "ஆம்",
            value: "YES",
          },
          {
            label_en: "No",
            label_gu: "ના",
            label_hi: "नहीं",
            label_mr: "नाही",
            label_ta: "இல்லை",
            value: "NO",
          },
        ],
      };

    case "ASK_FIRST_NAME":
      return {
        action: "ASK_FIRST_NAME",
        message_en: "What is your first name?",
        message_gu: "તમારું પ્રથમ નામ શું છે?",
        message_hi: "आपका प्रथम नाम क्या है?",
        message_mr: "तुमचे पहिले नाव काय आहे?",
        message_ta: "உங்கள் முதல் பெயர் என்ன?",
      };

    case "ASK_LAST_NAME":
      return {
        action: "ASK_LAST_NAME",
        message_en: "What is your last name?",
        message_gu: "તમારું છેલ્લું નામ શું છે?",
        message_hi: "आपका अंतिम नाम क्या है?",
        message_mr: "तुमचे आडनाव काय आहे?",
        message_ta: "உங்கள் கடைசி பெயர் என்ன?",
      };

    case "ASK_DOB":
      return {
        action: "ASK_DOB",
        message_en: "What is your date of birth? (Example: 1989-01-01)",
        message_gu: "તમારી જન્મ તારીખ શું છે? (ઉદાહરણ: 1989-01-01)",
        message_hi: "आपकी जन्म तिथि क्या है? (उदाहरण: 1989-01-01)",
        message_mr: "तुमची जन्मतारीख काय आहे? (उदा: 1989-01-01)",
        message_ta: "உங்கள் பிறந்த தேதி என்ன? (உதாரணம்: 1989-01-01)",
      };

    case "ASK_GENDER":
      return {
        action: "ASK_GENDER",
        message_en: "What is your gender?",
        message_gu: "તમારું લિંગ શું છે?",
        message_hi: "आपका लिंग क्या है?",
        message_mr: "तुमचे लिंग काय आहे?",
        message_ta: "உங்கள் பாலினம் என்ன?",
        options: [
          {
            label_en: "Male",
            label_gu: "પુરુષ",
            label_hi: "पुरुष",
            label_mr: "पुरुष",
            label_ta: "ஆண்",
            value: "male",
          },
          {
            label_en: "Female",
            label_gu: "સ્ત્રી",
            label_hi: "महिला",
            label_mr: "स्त्री",
            label_ta: "பெண்",
            value: "female",
          },
        ],
      };

    case "ASK_BLOOD_GROUP":
      return {
        action: "ASK_BLOOD_GROUP",
        message_en: "What is your blood group? You can skip this question.",
        message_gu: "તમારું બ્લડ ગ્રુપ શું છે? તમે આ પ્રશ્ન સ્કિપ પણ કરી શકો છો.",
        message_hi: "आपका रक्त समूह क्या है? आप इस प्रश्न को छोड़ सकते हैं।",
        message_mr: "तुमचा रक्तगट कोणता आहे? तुम्ही हा प्रश्न वगळू शकता.",
        message_ta: "உங்கள் இரத்த வகை என்ன? நீங்கள் இந்த கேள்வியை தவிர்க்கலாம்.",
        options: [
          {
            label_en: "Skip",
            label_gu: "સ્કિપ",
            label_hi: "स्किप करें",
            label_mr: "वगळा",
            label_ta: "தவிர்",
            value: "SKIP",
          },
        ],
      };

    case "ASK_ALLERGIES":
      return {
        action: "ASK_ALLERGIES",
        message_en: "Do you have any allergies? You can skip this question.",
        message_gu: "શું તમને કોઈ એલર્જી છે? તમે આ પ્રશ્ન સ્કિપ પણ કરી શકો છો.",
        message_hi: "क्या आपको कोई एलर्जी है? आप इस प्रश्न को छोड़ सकते हैं।",
        message_mr: "तुम्हाला कोणतीही ऍलर्जी आहे का? तुम्ही हा प्रश्न वगळू शकता.",
        message_ta: "உங்களுக்கு ஏதேனும் ஒவ்வாமை உள்ளதா? நீங்கள் இந்த கேள்வியை தவிர்க்கலாம்.",
        options: [
          {
            label_en: "Skip",
            label_gu: "સ્કિપ",
            label_hi: "स्किप करें",
            label_mr: "वगळा",
            label_ta: "தவிர்",
            value: "SKIP",
          },
        ],
      };

    case "REGISTER_USER":
      return {
        action: "REGISTER_USER",
        message_en: "Registration is processing...",
        message_gu: "નોંધણી પ્રક્રિયા ચાલુ છે...",
        message_hi: "पंजीकरण प्रक्रिया चल रही है...",
        message_mr: "नोंदणी प्रक्रिया सुरू आहे...",
        message_ta: "பதிவு செய்யப்படுகிறது...",
      };

    case "COMPLETE":
      return {
        action: "GO_TO_DASHBOARD",
        message_en: "Your onboarding is complete. Redirecting to dashboard...",
        message_gu: "તમારું ઓનબોર્ડિંગ પૂર્ણ થયું છે. ડેશબોર્ડ પર રીડાયરેક્ટ કરી રહ્યા છીએ...",
        message_hi: "आपकी ऑनबोर्डिंग पूरी हो गई है। डैशबोर्ड पर रीडायरेक्ट कर रहे हैं...",
        message_mr: "तुमची ऑनबोर्डिंग पूर्ण झाली आहे. डॅशबोर्डवर पुनर्निर्देशित करत आहे...",
        message_ta: "உங்கள் பதிவு நிறைவடைந்தது. டாஷ்போர்டுக்கு செல்கிறது...",
      };

    case "POST_ONBOARDING":
    default:
      return {
        action: "POST_ONBOARDING",
        message_en: "Would you like to view your report summary or ask health related questions?",
        message_gu:
          "શું તમે રિપોર્ટનો સારાંશ જોવા માંગો છો કે રિપોર્ટ સંબંધિત પ્રશ્ન પૂછવા માંગો છો?",
        message_hi:
          "क्या आप अपनी रिपोर्ट का सारांश देखना चाहेंगे या स्वास्थ्य संबंधी प्रश्न पूछना चाहेंगे?",
        message_mr:
          "तुम्ही तुमच्या अहवालाचा सारांश पाहू इच्छिता की आरोग्याशी संबंधित प्रश्न विचारू इच्छिता?",
        message_ta:
          "உங்கள் அறிக்கை சுருக்கத்தைக் காண விரும்புகிறீர்களா அல்லது உடல்நலம் தொடர்பான கேள்வியைக் கேட்க விரும்புகிறீர்களா?",
        options: [
          {
            label_en: "Go To Dashboard",
            label_gu: "Dashboard પર જાઓ",
            label_hi: "डैशबोर्ड पर जाएं",
            label_mr: "डॅशबोर्डवर जा",
            label_ta: "டாஷ்போர்டுக்குச் செல்லவும்",
            value: "DASHBOARD",
          },
          {
            label_en: "Report Summary",
            label_gu: "રિપોર્ટ સારાંશ",
            label_hi: "रिपोर्ट सारांश",
            label_mr: "अहवाल सारांश",
            label_ta: "அறிக்கை சுருக்கம்",
            value: "REPORT_SUMMARY",
          },
          {
            label_en: "Ask Health Questions",
            label_gu: "આરોગ્ય પ્રશ્ન પૂછો",
            label_hi: "स्वास्थ्य प्रश्न पूछें",
            label_mr: "आरोग्य प्रश्न विचारा",
            label_ta: "உடல்நலக் கேள்விகளைக் கேளுங்கள்",
            value: "HEALTH_CHAT",
          },
        ],
      };
  }
}

function createResponse(stepResponse, state) {
  return {
    ...stepResponse,
    state,
    data: state.existingUserData,
  };
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

    // 3. If Medical Document uploaded in UPLOAD flow, perform extraction using Qwen3
    if (
      state.flowMode === "UPLOAD" &&
      (state.uploadedMedicalDocument || state.documentUploaded) &&
      state.documentText &&
      !state.documentExtracted
    ) {
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
            state.existingUserData.gender = normalizeGender(extracted.gender);
          }

          if (extracted.email) {
            state.existingUserData.email = extracted.email.trim();
          }

          if (extracted.bloodGroup) {
            state.existingUserData.bloodGroup = normalizeBloodGroup(extracted.bloodGroup);
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
      state.documentConfirmed = true;
      state.currentStep = getNextRequiredOrOptionalStep(state);
    }

    // 4. Resolve next step after updates
    // 4. Resolve next step after updates
    // If the step is REGISTER_USER, mark as completed
    if (state.currentStep === "REGISTER_USER") {
      state.isOnboardingCompleted = true;
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
    return createResponse(nextStep, state);
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
