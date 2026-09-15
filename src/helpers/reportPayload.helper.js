/* eslint-disable no-console */
const { db } = require("../configs/db");
const { document } = require("../models/document");
const { eq, desc } = require("drizzle-orm");
const {
  normalizeLanguage,
  stripReasoningTags,
  isValidClinicalSummary,
} = require("../utils/commonUtils");
const { toDbDateOnlyString } = require("../utils/dateUtils");
const aiClient = require("../services/ai/clients/aiClient.service");

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

const GENERAL_DOC_QUESTIONS_I18N = {
  english: [
    "What does this document mean?",
    "What are the key details in this document?",
    "What should I discuss with my doctor?",
  ],
  gujarati: [
    "આ દસ્તાવેજનો અર્થ શું છે?",
    "આ દસ્તાવેજમાં મુખ્ય વિગતો કઈ છે?",
    "મારે મારા ડૉક્ટર સાથે શું ચર્ચા કરવી જોઈએ?",
  ],
  hindi: [
    "इस दस्तावेज़ का क्या मतलब है?",
    "इस दस्तावेज़ में मुख्य विवरण क्या हैं?",
    "मुझे अपने डॉक्टर से क्या चर्चा करनी चाहिए?",
  ],
  marathi: [
    "या दस्तऐवजाचा अर्थ काय आहे?",
    "या दस्तऐवजात महत्त्वाचे तपशील काय आहेत?",
    "मी माझ्या डॉक्टरांशी काय चर्चा करावी?",
  ],
  tamil: [
    "இந்த ஆவணத்தின் அர்த்தம் என்ன?",
    "இந்த ஆவணத்தில் உள்ள முக்கிய விவரங்கள் என்ன?",
    "எனது மருத்துவரிடம் நான் என்ன விவாதிக்க வேண்டும்?",
  ],
};

/**
 * Builds a standardized structured report payload used across both
 * Onboarding chatbot and Dashboard chatbot.
 */
async function buildStructuredReportPayload({
  docRecord = null,
  targetDocId = null,
  userId = null,
  preferredLanguage = "english",
}) {
  const normLang = normalizeLanguage(preferredLanguage || "english");

  // 1. Resolve document record from database if not provided
  let activeDoc = docRecord;
  const docIdToFetch = targetDocId || (docRecord ? docRecord.id : null);

  if (!activeDoc && docIdToFetch) {
    try {
      const res = await db.select().from(document).where(eq(document.id, docIdToFetch));
      if (Array.isArray(res)) {
        activeDoc = res[0] || null;
      } else if (res && typeof res.limit === "function") {
        const limited = await res.limit(1);
        activeDoc = Array.isArray(limited) ? limited[0] : limited;
      } else if (res && res.orderBy) {
        const ordered = await res.orderBy(desc(document.createdAt)).limit(1);
        activeDoc = Array.isArray(ordered) ? ordered[0] : ordered;
      }
    } catch (err) {
      console.warn("[reportPayload.helper] Failed to fetch document by ID:", err.message);
    }
  }

  if (!activeDoc && userId) {
    try {
      const docs = await db
        .select()
        .from(document)
        .where(eq(document.userId, userId))
        .orderBy(desc(document.createdAt))
        .limit(1);
      if (docs && docs.length > 0) {
        activeDoc = docs[0];
      }
    } catch (err) {
      console.warn("[reportPayload.helper] Failed to fetch latest document for user:", err.message);
    }
  }

  if (!activeDoc) {
    return {
      action: "ASK_REPORT",
      document: null,
      suggestedQuestions: [],
      options: [],
      error: "NO_REPORT_FOUND",
    };
  }

  // 2. Extract structured data safely
  let structured = activeDoc.structuredExtractedData || {};
  if (typeof structured === "string") {
    try {
      structured = JSON.parse(structured);
    } catch {
      structured = {};
    }
  }

  const patientInfo = structured.patientInfo || structured.patient || {};
  const patientName =
    activeDoc.patientName ||
    structured.patientName ||
    patientInfo.name ||
    patientInfo.fullName ||
    null;

  // 3. Extract lab tests / findings
  const tests =
    Array.isArray(structured.tests) && structured.tests.length > 0
      ? structured.tests
      : Array.isArray(structured.labResults) && structured.labResults.length > 0
        ? structured.labResults
        : [];

  const rawDocType = String(activeDoc.documentType || structured.documentType || "").toUpperCase();
  const isPrescription =
    rawDocType === "PRESCRIPTION" ||
    rawDocType === "PRESCERIPTION" ||
    (Array.isArray(structured.medications) &&
      structured.medications.length > 0 &&
      tests.length === 0);

  const isLabReport =
    !isPrescription &&
    (tests.length > 0 ||
      rawDocType === "LAB_REPORT" ||
      rawDocType.includes("LAB") ||
      rawDocType.includes("REPORT"));

  const isOtherMedicalDoc = !isPrescription && !isLabReport;

  // 4. Lab results partitioning
  const labFindings = isLabReport
    ? tests.map((t) => ({
        name: t.name || t.testName || t.parameter || "Test",
        value:
          t.value !== undefined ? String(t.value) : t.result !== undefined ? String(t.result) : "",
        unit: t.unit || "",
        status: t.status || (t.isAbnormal ? "Abnormal" : "Normal"),
        referenceRange: t.normalRange || t.referenceRange || t.range || "",
        isAbnormal: Boolean(
          t.isAbnormal ||
          String(t.status || "")
            .toLowerCase()
            .includes("abnormal") ||
          String(t.status || "")
            .toLowerCase()
            .includes("high") ||
          String(t.status || "")
            .toLowerCase()
            .includes("low") ||
          String(t.status || "")
            .toLowerCase()
            .includes("elevated") ||
          String(t.status || "")
            .toLowerCase()
            .includes("positive") ||
          String(t.status || "")
            .toLowerCase()
            .includes("diabetes"),
        ),
      }))
    : [];

  const abnormalResults = labFindings.filter((item) => item.isAbnormal);
  const normalResults = labFindings.filter((item) => !item.isAbnormal);

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

  // 5. Narrative summary resolution with on-demand localization
  let docSummary = "";
  const summariesByLang = structured.summariesByLanguage || {};

  // Check language specific cached summary
  if (normLang !== "english" && summariesByLang[normLang]) {
    const candidate = stripReasoningTags(summariesByLang[normLang]).trim();
    if (isValidClinicalSummary(candidate, patientName)) {
      docSummary = candidate;
    }
  }

  // Check structured summaryInPreferredLanguage if not English
  if (!docSummary && normLang !== "english") {
    const candidate = stripReasoningTags(
      structured.summaryInPreferredLanguage || activeDoc.summaryInPreferredLanguage || "",
    ).trim();
    if (isValidClinicalSummary(candidate, patientName)) {
      docSummary = candidate;
    }
  }

  // Base English summary
  const englishCandidate = stripReasoningTags(
    activeDoc.summaryEnglish ||
      structured.summaryEnglish ||
      structured.summary ||
      activeDoc.summary ||
      "",
  ).trim();

  if (!docSummary) {
    docSummary = englishCandidate;
  }

  // If still empty, provide clean default narrative
  if (!docSummary) {
    if (isPrescription) {
      docSummary = `Prescription from ${activeDoc.doctorName || structured.doctorName || "Doctor"} at ${activeDoc.hospitalName || structured.hospitalName || "Clinic"}.`;
    } else if (isLabReport) {
      docSummary = "Medical laboratory report summary.";
    } else {
      docSummary = "Medical document summary.";
    }
  }

  // On-demand translation if user requested a non-English language and summary is in English
  if (normLang !== "english" && docSummary) {
    const isLatinOnly = !/[\u0A80-\u0AFF\u0900-\u097F\u0B80-\u0BFF]/.test(docSummary);
    if (isLatinOnly) {
      try {
        const translated = await aiClient.translate(docSummary, "english", normLang);
        const cleanTrans = stripReasoningTags(translated).trim();
        if (cleanTrans && isValidClinicalSummary(cleanTrans, patientName)) {
          docSummary = cleanTrans;

          // Update cached summaries asynchronously
          try {
            if (!structured.summariesByLanguage) structured.summariesByLanguage = {};
            structured.summariesByLanguage[normLang] = cleanTrans;
            structured.summaryInPreferredLanguage = cleanTrans;
            if (activeDoc.id) {
              await db
                .update(document)
                .set({
                  structuredExtractedData: structured,
                  summaryInPreferredLanguage: cleanTrans,
                })
                .where(eq(document.id, activeDoc.id));
            }
          } catch (cacheErr) {
            console.warn(
              "[reportPayload.helper] Failed to cache translated summary:",
              cacheErr.message,
            );
          }
        }
      } catch (transErr) {
        console.warn("[reportPayload.helper] On-demand translation failed:", transErr.message);
      }
    }
  }

  // 6. Patient details
  const dateOnlyStr =
    toDbDateOnlyString(activeDoc.reportDate) ||
    toDbDateOnlyString(structured.reportDate) ||
    toDbDateOnlyString(activeDoc.createdAt) ||
    toDbDateOnlyString(new Date());

  const resolvedDoctor =
    activeDoc.doctorName ||
    structured.doctorName ||
    structured.doctorInfo?.name ||
    structured.doctor?.name ||
    patientInfo.doctorName ||
    null;

  const resolvedHospital =
    activeDoc.hospitalName ||
    structured.hospitalName ||
    structured.hospitalInfo?.name ||
    structured.hospital?.name ||
    patientInfo.hospitalName ||
    patientInfo.clinicName ||
    null;

  const patientDetails = {
    name: patientName || "Patient",
    age: patientInfo.age || activeDoc.patientAge || structured.patientAge || null,
    gender: patientInfo.gender || activeDoc.patientGender || structured.patientGender || null,
    uhid: patientInfo.uhid || patientInfo.id || patientInfo.patientId || activeDoc.uhid || null,
    reportDate: dateOnlyStr,
    doctorName: resolvedDoctor,
    hospitalName: resolvedHospital,
  };

  const questionsDict = isLabReport ? REPORT_QUESTIONS_I18N : GENERAL_DOC_QUESTIONS_I18N;
  const suggestedQuestions = questionsDict[normLang] || questionsDict.english;

  return {
    action: "ASK_REPORT",
    message: "",
    document: {
      id: activeDoc.id || docIdToFetch,
      fileName: activeDoc.fileName || "Medical Document",
      documentType: isPrescription
        ? "PRESCRIPTION"
        : isLabReport
          ? "LAB_REPORT"
          : rawDocType || "OTHER_MEDICAL_DOCUMENT",
      reportDate: dateOnlyStr,
      hospitalName: resolvedHospital,
      doctorName: resolvedDoctor,
      summary: docSummary,
      patientDetails,
      isLabReport,
      isPrescription,
      isOtherMedicalDoc,
      abnormalResults,
      normalResults,
      keyFindings: docSummary,
      whatThisMayMean: docSummary,
      labFindings,
      medicationFindings,
      s3Key: activeDoc.s3Key || null,
      fileKey: activeDoc.s3Key || activeDoc.fileKey || null,
      fileUrl: activeDoc.fileUrl || null,
    },
    suggestedQuestions,
    options: [],
  };
}

module.exports = {
  buildStructuredReportPayload,
  REPORT_QUESTIONS_I18N,
  GENERAL_DOC_QUESTIONS_I18N,
};
