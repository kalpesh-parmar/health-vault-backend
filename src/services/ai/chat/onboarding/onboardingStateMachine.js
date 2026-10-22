/* eslint-disable no-console */
const medicationService = require("../../../medication.service");
const {
  normalizeGenderLocally,
  isValidGender,
  isValidFirstName,
  isValidLastName,
  normalizeDOB,
  normalizePhone,
  normalizeName,
  isSamePhone,
  normalizeFieldVal,
} = require("../../../../helpers/onboarding.helper");

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

const REQUIRED_PROFILE_FIELDS = ["firstName", "lastName", "dateOfBirth", "gender"];

/**
 * Canonical Date of Birth Validator
 *
 * Note on Timezone (Asia/Kolkata):
 * Asia/Kolkata (IST, UTC+05:30) is the canonical platform reference timezone
 * for the Health Vault system and user base (all 5 supported Indic and Indian English languages).
 * Standardizing calendar date evaluations to Asia/Kolkata ensures that date boundaries
 * (determining "today" vs "yesterday" vs "future") are evaluated deterministically regardless
 * of whether the server node is running in UTC, US-East, or Europe, preventing midnight offset
 * race conditions where a patient selecting their birth date is rejected due to UTC lag.
 *
 * @param {string|Date} dobInput - Input date string or Date object
 * @param {string} [timezone="Asia/Kolkata"] - Canonical timezone identifier
 * @returns {{ isValid: boolean, reason: string|null, normalizedDob: string|null }}
 */
function validateDateOfBirth(dobInput, timezone = "Asia/Kolkata") {
  if (!dobInput) return { isValid: false, reason: "DOB_REQUIRED", normalizedDob: null };

  const rawStr =
    typeof dobInput === "string"
      ? dobInput
      : dobInput instanceof Date
        ? dobInput.toISOString().split("T")[0]
        : String(dobInput);

  const normDob = normalizeDOB(rawStr);
  if (!normDob || !/^\d{4}-\d{2}-\d{2}$/.test(normDob)) {
    return { isValid: false, reason: "DOB_INVALID_FORMAT", normalizedDob: null };
  }

  const [yearStr] = normDob.split("-");
  const birthYear = parseInt(yearStr, 10);

  // Determine current calendar date in canonical timezone (en-CA produces YYYY-MM-DD format)
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  const [currentYearStr] = todayStr.split("-");
  const currentYear = parseInt(currentYearStr, 10);

  // Strictly reject future dates and today's date (date-only string comparison)
  if (normDob >= todayStr) {
    return { isValid: false, reason: "DOB_MUST_BE_PAST", normalizedDob: normDob };
  }

  // Reject age > 120 or negative
  const approximateAge = currentYear - birthYear;
  if (approximateAge < 0 || approximateAge > 120) {
    return { isValid: false, reason: "DOB_AGE_LIMIT", normalizedDob: normDob };
  }

  return { isValid: true, reason: null, normalizedDob: normDob };
}

/**
 * Validates whether the patient profile contains all mandatory fields and valid values.
 * @param {object} patient - Patient profile object
 * @returns {boolean} True if complete and valid
 */
function isProfileComplete(patient) {
  if (!patient || typeof patient !== "object") return false;

  for (const field of REQUIRED_PROFILE_FIELDS) {
    const val = patient[field];
    if (val === undefined || val === null || (typeof val === "string" && val.trim().length === 0)) {
      return false;
    }
  }

  if (!isValidFirstName(patient.firstName) || !isValidLastName(patient.lastName)) {
    return false;
  }

  const dobStr =
    typeof patient.dateOfBirth === "string"
      ? patient.dateOfBirth
      : patient.dateOfBirth instanceof Date
        ? patient.dateOfBirth.toISOString().split("T")[0]
        : String(patient.dateOfBirth);

  const valDob = validateDateOfBirth(dobStr);
  if (!valDob.isValid) return false;

  const normGender = normalizeGenderLocally(String(patient.gender));
  if (!normGender || !isValidGender(normGender)) {
    return false;
  }

  const contact = patient.mobile || patient.email || patient.phoneNumber;
  if (!contact) {
    console.error(
      "[OnboardingStateMachine] Contact assertion failed: patient has neither mobile nor email:",
      patient,
    );
  }

  return true;
}

/**
 * Determines if any mandatory profile fields are missing in state.
 * @param {object} state - Onboarding state object
 * @returns {string|null} Missing step name or null if all required fields are satisfied
 */
function getMissingRequiredStep(state) {
  const data = state.existingUserData || {};
  const isSocial = state.useSocialData === true || state.selectedProfileSource === "SOCIAL";
  const isDoc = state.useDocumentData === true || state.selectedProfileSource === "DOCUMENT";

  const useDoc =
    !isSocial &&
    state.useDocumentData !== false &&
    state.flowMode === "UPLOAD" &&
    state.documentConfirmed !== false &&
    (!!state.documentData || !!state.documentId);

  const docData = useDoc ? state.documentData || {} : {};
  const socialData = state.socialData || {};
  const loginData = state.loginData || {};

  const getVal = (key) => {
    if (data[key] !== undefined && data[key] !== null && data[key] !== "") {
      return data[key];
    }
    if (isSocial) {
      return socialData[key] !== undefined && socialData[key] !== null && socialData[key] !== ""
        ? socialData[key]
        : loginData[key]?.value || null;
    }
    if (isDoc) {
      return docData[key] !== undefined && docData[key] !== null && docData[key] !== ""
        ? docData[key]
        : null;
    }
    return socialData[key] || loginData[key]?.value || docData[key] || null;
  };

  const fieldToStep = {
    firstName: "ASK_FIRST_NAME",
    lastName: "ASK_LAST_NAME",
    dateOfBirth: "ASK_DOB",
    gender: "ASK_GENDER",
  };

  for (const field of REQUIRED_PROFILE_FIELDS) {
    const val = getVal(field);
    if (val === undefined || val === null || (typeof val === "string" && val.trim().length === 0)) {
      return fieldToStep[field];
    }
    if (field === "firstName" && !isValidFirstName(String(val))) return "ASK_FIRST_NAME";
    if (field === "lastName" && !isValidLastName(String(val))) return "ASK_LAST_NAME";
    if (field === "dateOfBirth") {
      const valDob = validateDateOfBirth(String(val));
      if (!valDob.isValid) return "ASK_DOB";
    }
    if (field === "gender") {
      const normGen = normalizeGenderLocally(String(val));
      if (!normGen || !isValidGender(normGen)) return "ASK_GENDER";
    }
  }

  return null;
}

/**
 * Determines whether there is a genuine unresolved conflict between profile sources.
 * A genuine conflict occurs when:
 * 1. An uploaded document has been extracted with demographic data to compare against login/existing data,
 *    and ownership was confirmed, but profile choice has not yet been resolved/confirmed.
 * 2. There is social login data AND document data or existing discrepancies that require explicit source selection.
 * In a manual flow without uploaded/extracted documents, user input is inherently authoritative and there is no conflict.
 * @param {object} state - Onboarding state object
 * @returns {boolean} True if RESOLVE_PROFILE_SOURCE is genuinely required
 */
function hasGenuineProfileConflict(state) {
  if (state.profileConfirmed) {
    return false;
  }

  // Social data with multiple conflicting profile records
  if (
    state.hasSocialData &&
    state.socialData &&
    (state.loginData || state.existingUserData || state.documentData)
  ) {
    const { hasMismatch } = getProfileMismatches(state);
    if (hasMismatch) {
      return true;
    }
  }

  // Pure manual flow or skip flow without document has no external source conflict
  if (state.flowMode === "MANUAL" || state.flowMode === "SKIP") {
    const hasDoc = Boolean(
      (state.documentUploaded || state.uploadedMedicalDocument) &&
      (state.documentExtracted ||
        (state.documentData && Object.keys(state.documentData).length > 0)),
    );
    if (!hasDoc) {
      return false;
    }
  }

  // Upload flow with extracted document awaiting profile confirmation
  const isUploadWithExtractedDoc = Boolean(
    (state.flowMode === "UPLOAD" || state.documentUploaded || state.uploadedMedicalDocument) &&
    (state.documentExtracted ||
      (state.documentData && Object.keys(state.documentData).length > 0)) &&
    state.documentOwnershipConfirmed !== false,
  );

  if (isUploadWithExtractedDoc) {
    return true;
  }

  return false;
}

/**
 * Calculates next required or optional step based on state completeness.
 * @param {object} state - Onboarding state object
 * @returns {string} Next step name
 */
function getNextRequiredOrOptionalStep(state) {
  const data = state.existingUserData || {};

  const missingRequired = getMissingRequiredStep(state);
  if (missingRequired) {
    return missingRequired;
  }

  if (hasGenuineProfileConflict(state) || !state.profileConfirmed) {
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
    const hasExtractedMedicines =
      (Array.isArray(state.foundMedicines) && state.foundMedicines.length > 0) ||
      (Array.isArray(state.medicinesToAdd) && state.medicinesToAdd.length > 0);

    if (!state.hasSkipped && !state.isOnboardingCompleted) {
      state.isOnboardingCompleted = false;
    }

    if (!state.medicinesConfirmed && hasExtractedMedicines) {
      state.medicationFlowStarted = true;
      if (!Array.isArray(state.medicinesToAdd) || state.medicinesToAdd.length === 0) {
        state.medicinesToAdd = medicationService.buildFromDocument(state.foundMedicines);
      }
      return "REVIEW_MEDICINES_LIST";
    }

    if (state.currentStep === "MEDICINE_OPTIONS" || state.cancellationNotice) {
      state.medicationFlowStarted = true;
      return "MEDICINE_OPTIONS";
    }

    state.medicationFlowStarted = true;
    return "MEDICINE_OPTIONS";
  }

  return "REGISTER_USER";
}

/**
 * Checks if user is permitted to skip the rest of onboarding based on business invariants.
 * @param {object} state - Onboarding state object
 * @returns {boolean} True if skip is allowed
 */
function canSkipOnboarding(state) {
  if (!state || typeof state !== "object") {
    return false;
  }

  if (state.hasSkipped === true) {
    return true;
  }

  if (state.pendingProfileConflict === true) {
    return false;
  }

  // S1: state.preferredLanguage is a non-empty value
  if (
    !state.preferredLanguage ||
    typeof state.preferredLanguage !== "string" ||
    state.preferredLanguage.trim().length === 0
  ) {
    return false;
  }

  // S2: state.flowMode is "UPLOAD" or "MANUAL"
  if (state.flowMode !== "UPLOAD" && state.flowMode !== "MANUAL") {
    return false;
  }

  // S3: if state.flowMode === "UPLOAD": state.documentOwnershipConfirmed is strictly true or strictly false (not null/undefined)
  if (state.flowMode === "UPLOAD") {
    if (state.documentOwnershipConfirmed !== true && state.documentOwnershipConfirmed !== false) {
      return false;
    }
  }

  // S4: getMissingRequiredStep(state) === null
  if (getMissingRequiredStep(state) !== null) {
    return false;
  }

  // S5: state.profileConfirmed === true
  if (state.profileConfirmed !== true) {
    return false;
  }

  return true;
}

/**
 * Evaluates differences between login identity and extracted medical document details.
 * @param {object} state - Onboarding state object
 * @returns {{ hasMismatch: boolean, fields: Array }} Mismatch report
 */
function getProfileMismatches(state) {
  console.log("[RAW LOGIN DATA] loginData:", JSON.stringify(state.loginData, null, 2));
  console.log("[RAW DOCUMENT DATA] documentData:", JSON.stringify(state.documentData, null, 2));

  const isUpload =
    state.useDocumentData !== false &&
    state.flowMode === "UPLOAD" &&
    state.documentConfirmed !== false &&
    !!state.documentData;

  const compareTarget = isUpload ? state.documentData || {} : state.existingUserData || {};
  const sourceComparison = isUpload ? "DOCUMENT_VS_LOGIN" : "MANUAL_VS_LOGIN";

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
    let loginField = state.loginData?.[item.key];
    if (
      state.socialData &&
      state.socialData[item.key] !== undefined &&
      state.socialData[item.key] !== null
    ) {
      loginField = { value: state.socialData[item.key], verified: false };
    } else if (!loginField) {
      loginField = { value: null, verified: false };
    }
    const rawLogin = typeof loginField === "object" ? loginField?.value : loginField;
    const isVerified = typeof loginField === "object" ? Boolean(loginField?.verified) : false;

    let rawCompare = compareTarget[item.key];
    if (item.key === "phoneNumber" && rawCompare === undefined) {
      rawCompare = compareTarget.mobile || compareTarget.phoneNumber;
    }

    const normalizedLogin = normalizeFieldVal(rawLogin, item.type);
    const normalizedCompare = normalizeFieldVal(rawCompare, item.type);

    let isMismatch = false;
    if (isVerified) {
      // Verified fields are never marked as mismatch
      isMismatch = false;
    } else if (normalizedLogin && normalizedCompare) {
      if (item.type === "phone") {
        isMismatch = !isSamePhone(normalizedLogin, normalizedCompare);
      } else {
        isMismatch = normalizedLogin !== normalizedCompare;
      }
    }

    console.log("[INSTRUMENTATION] getProfileMismatches field evaluation:", {
      key: item.key,
      verified: isVerified,
      rawLogin,
      rawCompare,
      normalizedLogin,
      normalizedCompare,
      isMismatch,
    });

    fields.push({
      key: item.key,
      label: item.label,
      loginValue: rawLogin || null,
      documentValue: rawCompare || null,
      isMismatch,
      verified: isVerified,
    });
  }

  const hasMismatch = fields.some((f) => f.isMismatch === true);
  console.log("[INSTRUMENTATION] getProfileMismatches final decision:", {
    hasMismatch,
    sourceComparison,
    computedMode: hasMismatch ? "CONFLICT" : "CONFIRM",
  });

  return { hasMismatch, fields, sourceComparison };
}

/**
 * Merges chosen profile source (DOCUMENT, LOGIN, or MANUAL) into existingUserData.
 * @param {object} state - Onboarding state object
 * @param {string|null} sourceChoice - Chosen source
 * @param {object|null} editedData - Manually edited data
 */
function mergeAndApplyProfile(state, sourceChoice = null, editedData = null) {
  const compareKeys = ["firstName", "lastName", "phoneNumber", "dateOfBirth", "gender", "email"];

  // const useDoc =
  //   state.useDocumentData !== false &&
  //   state.flowMode === "UPLOAD" &&
  //   state.documentConfirmed !== false &&
  //   !!state.documentData;

  const docData = state.documentData || {};

  let normSource = null;
  if (typeof sourceChoice === "string" && sourceChoice.trim()) {
    const upper = sourceChoice.trim().toUpperCase();
    if (
      [
        "DOCUMENT",
        "DOC",
        "MEDICAL_DOCUMENT",
        "USE_DOCUMENT",
        "USE DOCUMENT",
        "USE_DOCUMENT_DATA",
        "DOCUMENT_DATA",
        "MEDICAL DOCUMENT",
      ].includes(upper) ||
      upper.includes("DOCUMENT")
    ) {
      normSource = "DOCUMENT";
    } else if (
      [
        "LOGIN",
        "SOCIAL",
        "SOCIAL_LOGIN",
        "GOOGLE",
        "FACEBOOK",
        "APPLE",
        "MICROSOFT",
        "MOBILE",
        "USE_SOCIAL",
        "USE SOCIAL",
        "USE_SOCIAL_LOGIN",
      ].includes(upper) ||
      upper.includes("SOCIAL") ||
      upper.includes("LOGIN")
    ) {
      normSource = "LOGIN";
    } else if (
      [
        "MANUAL",
        "MANUAL_ENTRY",
        "ENTERED",
        "ENTERED_DETAILS",
        "USE_ENTERED",
        "USE ENTERED",
      ].includes(upper) ||
      upper.includes("MANUAL") ||
      upper.includes("ENTERED")
    ) {
      normSource = "MANUAL";
    }
  }

  if (!normSource && state.selectedProfileSource) {
    const upperSel = String(state.selectedProfileSource).trim().toUpperCase();
    if (upperSel === "DOCUMENT" || state.useDocumentData === true) {
      normSource = "DOCUMENT";
    } else if (upperSel === "SOCIAL" || upperSel === "LOGIN" || state.useSocialData === true) {
      normSource = "LOGIN";
    } else if (upperSel === "MANUAL") {
      normSource = "MANUAL";
    }
  }

  for (const key of compareKeys) {
    let loginField = state.loginData?.[key];
    if (state.socialData && state.socialData[key] !== undefined && state.socialData[key] !== null) {
      loginField = { value: state.socialData[key], verified: false };
    } else if (!loginField) {
      loginField = { value: null, verified: false };
    }
    const rawLogin = typeof loginField === "object" ? loginField?.value : loginField;

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

    if (
      editedData &&
      editedData[key] !== undefined &&
      editedData[key] !== null &&
      editedData[key] !== ""
    ) {
      state.existingUserData[key] = editedData[key];
    } else if (normSource === "DOCUMENT") {
      const docVal = state.documentData?.[key] !== undefined ? state.documentData[key] : rawDoc;
      const validDocVal = docVal !== undefined && docVal !== null && docVal !== "" ? docVal : null;
      state.existingUserData[key] = validDocVal || existingVal || rawLogin || null;
      state.selectedProfileSource = "DOCUMENT";
      state.useDocumentData = true;
      state.useSocialData = false;
    } else if (normSource === "LOGIN") {
      const socialVal = state.socialData?.[key] !== undefined ? state.socialData[key] : rawLogin;
      const validSocialVal =
        socialVal !== undefined && socialVal !== null && socialVal !== "" ? socialVal : null;
      state.existingUserData[key] = validSocialVal || existingVal || rawDoc || null;
      state.selectedProfileSource = "SOCIAL";
      state.useSocialData = true;
      state.useDocumentData = false;
    } else if (normSource === "MANUAL") {
      state.existingUserData[key] = existingVal || null;
      state.selectedProfileSource = "MANUAL";
    } else if (editedData) {
      state.existingUserData[key] = existingVal || shownValue;
    } else if (loginField.verified) {
      state.existingUserData[key] = existingVal || rawLogin;
    } else if (isMismatch && normSource) {
      const chosenVal = normSource === "DOCUMENT" ? rawDoc : rawLogin;
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
  console.log(`[PROFILE DEBUG] RESULT existingUserData=`, JSON.stringify(state.existingUserData));
}

/**
 * Computes the active current step from state flags and data completeness.
 * @param {object} state - Onboarding state object
 * @returns {string} Step name
 */
function computeCurrentStep(state) {
  if (state.hasSkipped) {
    return state.flowMode === "MANUAL" ? "COMPLETE" : "POST_ONBOARDING";
  }
  if (state.isOnboardingCompleted && state.medicationFlowDone) {
    if (state.currentStep === "COMPLETE" || state.currentStep === "POST_ONBOARDING") {
      return state.currentStep;
    }
    const data = state.existingUserData || {};
    const hasUnansweredOptional =
      ((data.bloodGroup === undefined || data.bloodGroup === null || data.bloodGroup === "") &&
        !state.bloodGroupSkipped) ||
      ((!Array.isArray(data.allergies) || data.allergies.length === 0) && !state.allergiesSkipped);
    if (hasUnansweredOptional) {
      return getNextRequiredOrOptionalStep(state);
    }
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

/**
 * Convenience getter for current or next step.
 * @param {object} state - Onboarding state object
 * @returns {string} Step name
 */
function getNextStep(state) {
  return state.currentStep || computeCurrentStep(state);
}

module.exports = {
  OnboardingStep,
  REQUIRED_PROFILE_FIELDS,
  validateDateOfBirth,
  isProfileComplete,
  getMissingRequiredStep,
  getNextRequiredOrOptionalStep,
  hasGenuineProfileConflict,
  canSkipOnboarding,
  getProfileMismatches,
  mergeAndApplyProfile,
  computeCurrentStep,
  getNextStep,
};
