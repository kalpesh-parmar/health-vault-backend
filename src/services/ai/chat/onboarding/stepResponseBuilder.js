/* eslint-disable no-console */
const { db } = require("../../../../configs/db");
const { document } = require("../../../../models/document");
const { eq, desc } = require("drizzle-orm");
const { getLocalizedText } = require("../../../../helpers/onboarding.helper");
const { toDbDateOnlyString } = require("../../../../utils/dateUtils");
const { languageTypeValues, languageNativeLabels } = require("../../../../enums/languageType");
const { bloodGroupTypeValues } = require("../../../../enums/bloodGroupType");
const aiClient = require("../../clients/aiClient.service");
const { getProfileMismatches, getMissingRequiredStep } = require("./onboardingStateMachine");

const REPORT_QUESTIONS_I18N = {
  english: [
    "What does my report mean?",
    "Are there any abnormal values?",
    "What should I discuss with my doctor?",
    "Can you explain this report in simple language?",
  ],
  gujarati: [
    "મારા રિપોર્ટનો અર્થ શું છે?",
    "શું કોઈ અસામાન્ય મૂલ્યો છે?",
    "મારે મારા ડૉક્ટર સાથે શું ચર્ચા કરવી જોઈએ?",
    "શું તમે આ રિપોર્ટ સરળ ભાષામાં સમજાવી શકો છો?",
  ],
  hindi: [
    "मेरी रिपोर्ट का क्या मतलब है?",
    "क्या कोई असामान्य मूल्य हैं?",
    "मुझे अपने डॉक्टर से क्या चर्चा करनी चाहिए?",
    "क्या आप इस रिपोर्ट को सरल भाषा में समझा सकते हैं?",
  ],
  marathi: [
    "माझ्या रिपोर्टचा अर्थ काय आहे?",
    "काही असामान्य मूल्ये आहेत का?",
    "मी माझ्या डॉक्टरांशी काय चर्चा करावी?",
    "तुम्ही हा रिपोर्ट सोप्या भाषेत समजावून सांगू शकता का?",
  ],
  tamil: [
    "எனது அறிக்கையின் அர்த்தம் என்ன?",
    "ஏதேனும் அசாதாரண மதிப்புகள் உள்ளதா?",
    "எனது மருத்துவரிடம் நான் என்ன விவாதிக்க வேண்டும்?",
    "இந்த அறிக்கையை எளிய மொழியில் விளக்க முடியுமா?",
  ],
};

/**
 * Builds localized response object for current onboarding step.
 * @param {string} step - Onboarding step key
 * @param {object} state - Active onboarding state
 * @returns {Promise<object>} Localized response payload
 */
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
              "onboarding.manual",
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
        console.log("[DOCUMENT DETAILS]====", useDocText);
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
        "Document processing failed. Please try again or enter details manually.",
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

    case "ASK_BLOOD_GROUP": {
      if (
        getMissingRequiredStep(state) === null &&
        state.profileConfirmed === true &&
        !state.profileGreetingShown
      ) {
        state.profileGreetingShown = true;
      }

      return {
        action: "ASK_BLOOD_GROUP",
        title: null,
        subtitle: await getLocalizedText(
          "onboarding.askBloodGroup.message",
          "What is your blood group? You can skip this question.",
          state.preferredLanguage,
        ),
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
    }

    case "ASK_ALLERGIES": {
      if (
        getMissingRequiredStep(state) === null &&
        state.profileConfirmed === true &&
        !state.profileGreetingShown
      ) {
        state.profileGreetingShown = true;
      }

      return {
        action: "ASK_ALLERGIES",
        title: null,
        subtitle: await getLocalizedText(
          "onboarding.askAllergies.message",
          "Do you have any allergies? You can skip this question.",
          state.preferredLanguage,
        ),
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
    }

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
      const med =
        idx !== undefined && idx !== null && state.medicinesToAdd
          ? state.medicinesToAdd[idx]
          : null;
      const emptyMedTemplate = {
        id: "",
        client_med_id: "",
        name: "",
        type: "TABLET",
        dose: { count: 1 },
        frequency: "ONCE",
        duration: "",
        notes: "",
        prescribed_by: "",
        refill_alert: false,
        total_quantity: 30,
      };
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
        renderType: "MEDICINE_FORM",
        message,
        medicine: med || emptyMedTemplate,
      };
    }
    case "MEDICINE_OPTIONS": {
      const options = [
        {
          key: "ADD",
          label: await getLocalizedText(
            "onboarding.medicineOptions.addAnother",
            "Add Another Medicine",
            state.preferredLanguage,
          ),
          primary: true,
        },
      ];

      const hasDocument =
        state.flowMode === "UPLOAD" ||
        state.documentUploaded === true ||
        state.uploadedMedicalDocument === true ||
        !!state.documentId ||
        !!state.loadedDocumentId ||
        (state.documentData && Object.keys(state.documentData).length > 0);

      if (
        state.fromScreen !== "AIChat" &&
        state.fromScreen !== "AIChatScreen" &&
        !state.hasSkipped
      ) {
        options.push({
          key: "DASHBOARD",
          label: await getLocalizedText(
            "onboarding.medicineOptions.goToDashboard",
            "Go to Dashboard",
            state.preferredLanguage,
          ),
          primary: false,
        });
      }

      if (hasDocument) {
        options.push({
          key: "ASK_REPORT",
          label: await getLocalizedText(
            "onboarding.medicineOptions.askAboutReport",
            "Ask About My Report",
            state.preferredLanguage,
          ),
          primary: false,
        });
      }

      return {
        action: "MEDICINE_OPTIONS",
        message: await getLocalizedText(
          "onboarding.medicineOptions.message",
          "What would you like to do next?",
          state.preferredLanguage,
        ),
        options,
        medicines: state.medicinesToAdd || [],
      };
    }

    case "ASK_REPORT": {
      let docRecord = null;
      const targetDocId = Array.isArray(state.documentId) ? state.documentId[0] : state.documentId;
      if (targetDocId) {
        try {
          const [doc] = await db.select().from(document).where(eq(document.id, targetDocId));
          docRecord = doc;
        } catch (err) {
          console.warn("[OnboardingService] Failed to fetch document for ASK_REPORT:", err.message);
        }
      }

      const effectiveUserId = state.userId || state.existingUserData?.id;
      if (!docRecord && effectiveUserId) {
        try {
          const docs = await db
            .select()
            .from(document)
            .where(eq(document.userId, effectiveUserId))
            .orderBy(desc(document.createdAt))
            .limit(1);
          if (docs && docs.length > 0) {
            docRecord = docs[0];
          }
        } catch (err) {
          console.warn(
            "[OnboardingService] Failed to fetch latest document for ASK_REPORT:",
            err.message,
          );
        }
      }

      if (!docRecord && !targetDocId) {
        return {
          action: "NORMAL_CHAT",
          message: await getLocalizedText(
            "chat.noReportsUploaded",
            "You haven't uploaded any medical reports yet.",
            state.preferredLanguage,
          ),
          document: null,
          suggestedQuestions: [],
          options: [],
        };
      }

      const structured = docRecord?.structuredExtractedData || {};
      const patientInfo = structured.patientInfo || structured.patient || {};
      const tests =
        Array.isArray(structured.tests) && structured.tests.length > 0
          ? structured.tests
          : Array.isArray(structured.labResults) && structured.labResults.length > 0
            ? structured.labResults
            : [];

      const lang = state.preferredLanguage || "english";
      let docSummary =
        (lang !== "english" &&
          (structured.summaryInPreferredLanguage || docRecord?.summaryInPreferredLanguage)) ||
        docRecord?.summaryEnglish ||
        structured.summaryEnglish ||
        structured.summary ||
        structured.summaryInPreferredLanguage ||
        docRecord?.remarks ||
        "";

      const isPrescription =
        docRecord?.documentType === "PRESCERIPTION" ||
        docRecord?.documentType === "PRESCRIPTION" ||
        structured.documentType === "PRESCRIPTION" ||
        structured.documentType === "PRESCERIPTION" ||
        (Array.isArray(structured.medications) &&
          structured.medications.length > 0 &&
          tests.length === 0);

      const REPORT_QUESTIONS_I18N = {
        english: [
          "What does my report mean?",
          "Are there any abnormal values?",
          "What should I discuss with my doctor?",
          "Can you explain this report in simple language?",
        ],
        gujarati: [
          "મારા રિપોર્ટનો અર્થ શું છે?",
          "શું કોઈ અસામાન્ય મૂલ્યો છે?",
          "મારે મારા ડૉક્ટર સાથે શું ચર્ચા કરવી જોઈએ?",
          "શું તમે આ રિપોર્ટ સરળ ભાષામાં સમજાવી શકો છો?",
        ],
        hindi: [
          "मेरी रिपोर्ट का क्या मतलब है?",
          "क्या कोई असामान्य मूल्य हैं?",
          "मुझे अपने डॉक्टर से क्या चर्चा करनी चाहिए?",
          "क्या आप इस रिपोर्ट को सरल भाषा में समझा सकते हैं?",
        ],
        marathi: [
          "माझ्या रिपोर्टचा अर्थ काय आहे?",
          "काही असामान्य मूल्ये आहेत का?",
          "मी माझ्या डॉक्टरांशी काय चर्चा करावी?",
          "तुम्ही हा रिपोर्ट सोप्या भाषेत समजावून सांगू शकता का?",
        ],
        tamil: [
          "எனது அறிக்கையின் அர்த்தம் என்ன?",
          "ஏதேனும் அசாதாரண மதிப்புகள் உள்ளதா?",
          "எனது மருத்துவரிடம் நான் என்ன விவாதிக்க வேண்டும்?",
          "இந்த அறிக்கையை எளிய மொழியில் விளக்க முடியுமா?",
        ],
      };

      if (!docSummary) {
        if (isPrescription) {
          docSummary = `Prescription from ${docRecord?.doctorName || structured.doctorName || "Doctor"} at ${docRecord?.hospitalName || structured.hospitalName || "Clinic"}.`;
        } else {
          docSummary = "Medical report summary.";
        }
      }

      if (
        lang !== "english" &&
        docSummary &&
        !structured.summaryInPreferredLanguage &&
        !docRecord?.summaryInPreferredLanguage
      ) {
        try {
          const translatedSummary = await aiClient.translate(docSummary, "english", lang);
          if (translatedSummary) {
            docSummary = translatedSummary;
          }
        } catch (err) {
          console.warn(
            "[OnboardingService] Failed to translate docSummary for ASK_REPORT:",
            err.message,
          );
        }
      }

      const suggestedQuestions = REPORT_QUESTIONS_I18N[lang] || REPORT_QUESTIONS_I18N.english;

      const labFindings =
        tests.length > 0
          ? tests.map((t) => ({
              name: t.name || t.testName || t.parameter || "Test",
              value: t.value || t.result || "",
              unit: t.unit || "",
              status: t.status || (t.isAbnormal ? "Abnormal" : "Normal"),
              referenceRange: t.normalRange || t.referenceRange || t.range || "",
            }))
          : [];

      const medicationFindings = Array.isArray(structured.medications)
        ? structured.medications.map((m) => ({
            name: m.name || "Medicine",
            dosage: m.dosage || m.dose || "",
            timeOfDay: m.timeOfDay || m.timing || "",
            frequency: m.frequency || "",
            duration: m.duration || "",
            quantity: m.quantity || m.qty || "",
            instructions: m.instructions || m.notes || "",
            type: m.type || "",
            foodContext: m.food_context || "",
          }))
        : [];

      const docTypeResolved = isPrescription
        ? "PRESCRIPTION"
        : docRecord?.documentType || structured.documentType || "MEDICAL_REPORT";

      const resolvedDoctor =
        docRecord?.doctorName ||
        structured.doctorName ||
        structured.doctorInfo?.name ||
        structured.doctor?.name ||
        patientInfo.doctorName ||
        null;

      const resolvedHospital =
        docRecord?.hospitalName ||
        structured.hospitalName ||
        structured.hospitalInfo?.name ||
        structured.hospital?.name ||
        patientInfo.hospitalName ||
        patientInfo.clinicName ||
        null;

      const dateOnlyStr =
        toDbDateOnlyString(docRecord?.reportDate) ||
        toDbDateOnlyString(structured.reportDate) ||
        toDbDateOnlyString(new Date());

      return {
        action: "ASK_REPORT",
        message: "",
        document: {
          id: docRecord?.id || targetDocId,
          fileName: docRecord?.fileName || (isPrescription ? "Prescription" : "Medical Report"),
          documentType: docTypeResolved,
          reportDate: dateOnlyStr,
          hospitalName: resolvedHospital,
          doctorName: resolvedDoctor,
          summary: docSummary,
          labFindings,
          medicationFindings,
          keyFindings: labFindings.length > 0 ? labFindings : medicationFindings,
          s3Key: docRecord?.s3Key || null,
          fileUrl: docRecord?.fileUrl || null,
        },
        suggestedQuestions,
        options: [],
      };
    }

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

/**
 * Creates step response by delegating to localized response builder.
 * @param {string} step - Onboarding step key
 * @param {object} state - Active onboarding state
 * @returns {Promise<object>} Response payload
 */
async function createResponse(step, state) {
  return await getLocalizedResponse(step, state);
}

module.exports = {
  REPORT_QUESTIONS_I18N,
  getLocalizedResponse,
  createResponse,
};
