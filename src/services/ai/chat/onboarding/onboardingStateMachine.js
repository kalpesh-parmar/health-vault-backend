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

  const normDob = normalizeDOB(dobStr);
  if (!normDob) return false;

  const dobDate = new Date(normDob);
  if (isNaN(dobDate.getTime())) return false;

  const today = new Date();
  if (dobDate > today) return false;

  const ageYears = (today.getTime() - dobDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (ageYears < 0 || ageYears > 120) return false;

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
      const normDob = normalizeDOB(String(val));
      if (!normDob) return "ASK_DOB";
      const dobDate = new Date(normDob);
      if (isNaN(dobDate.getTime()) || dobDate > new Date()) return "ASK_DOB";
      const ageYears = (new Date().getTime() - dobDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
      if (ageYears < 0 || ageYears > 120) return "ASK_DOB";
    }
    if (field === "gender") {
      const normGen = normalizeGenderLocally(String(val));
      if (!normGen || !isValidGender(normGen)) return "ASK_GENDER";
    }
  }

  return null;
}

/**
 * Calculates next required or optional step based on state completeness.
 * @param {object} state - Onboarding state object
 * @returns {string} Next step name
 */
function getNextRequiredOrOptionalStep(state) {
  const data = state.existingUserData || {};

  const useDoc =
    state.useDocumentData !== false &&
    state.flowMode === "UPLOAD" &&
    state.documentConfirmed !== false &&
    (!!state.documentData || !!state.documentId);

  const missingRequired = getMissingRequiredStep(state);
  if (missingRequired) {
    return missingRequired;
  }

  // MATRIX RULE: RESOLVE_PROFILE_SOURCE is strictly gated to UPLOAD flow when there is a Social login profile to compare with the document
  const isSocial =
    state.hasSocialData === true ||
    ["google", "facebook", "microsoft", "apple"].includes(state.loginProvider);

  if (state.flowMode === "UPLOAD" && useDoc && isSocial && !state.profileConfirmed) {
    return "RESOLVE_PROFILE_SOURCE";
  }

  // In Mobile + Upload flow (no social profile to compare against), or in MANUAL/SKIP flow: auto-confirm profile
  if (state.flowMode === "MANUAL" || state.flowMode === "SKIP" || !useDoc || !isSocial) {
    state.profileConfirmed = true;
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

    if (!state.hasSkipped) {
      state.isOnboardingCompleted = false;
    }

    if (!state.medicinesConfirmed && hasExtractedMedicines) {
      state.medicationFlowStarted = true;
      if (!Array.isArray(state.medicinesToAdd) || state.medicinesToAdd.length === 0) {
        state.medicinesToAdd = medicationService.buildFromDocument(state.foundMedicines);
      }
      return "REVIEW_MEDICINES_LIST";
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
      documentValue: rawDoc || null,
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

/**
 * Merges chosen profile source (DOCUMENT, LOGIN, or MANUAL) into existingUserData.
 * @param {object} state - Onboarding state object
 * @param {string|null} sourceChoice - Chosen source
 * @param {object|null} editedData - Manually edited data
 */
function mergeAndApplyProfile(state, sourceChoice = null, editedData = null) {
  const compareKeys = ["firstName", "lastName", "phoneNumber", "dateOfBirth", "gender", "email"];
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
    }
  }

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

    if (editedData) {
      state.selectedProfileSource = "MANUAL";
      state.useSocialData = false;
      state.useDocumentData = false;
      if (editedData[key] !== undefined && editedData[key] !== null && editedData[key] !== "") {
        state.existingUserData[key] = editedData[key];
      } else {
        state.existingUserData[key] = shownValue;
      }
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
    } else if (loginField.verified) {
      state.existingUserData[key] = rawLogin;
    } else if (isMismatch && normSource) {
      const chosenVal = normSource === "DOCUMENT" ? rawDoc : rawLogin;
      state.existingUserData[key] = chosenVal || existingVal || null;
    } else {
      state.existingUserData[key] = rawLogin || rawDoc || existingVal || null;
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
  isProfileComplete,
  getMissingRequiredStep,
  getNextRequiredOrOptionalStep,
  canSkipOnboarding,
  getProfileMismatches,
  mergeAndApplyProfile,
  computeCurrentStep,
  getNextStep,
};
