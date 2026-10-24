/* eslint-disable no-console */
const { db } = require("../configs/db");
const { document } = require("../models/document");
const { eq, desc, and, sql } = require("drizzle-orm");
const {
  normalizeLanguage,
  stripReasoningTags,
  isValidClinicalSummary,
  validateIndicScriptRatio,
} = require("../utils/commonUtils");
const { toDbDateOnlyString } = require("../utils/dateUtils");
const aiClient = require("../services/ai/clients/aiClient.service");

const PIPELINE_VERSION = "1.1.0";

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
const IMAGE_ONLY_DISCLOSURES = {
  x_ray: {
    english:
      "X-ray image uploaded successfully. No written report text was detected. Please upload the radiologist's report for formal clinical interpretation.",
    gujarati:
      "એક્સ-રે ઇમેજ સફળતાપૂર્વક અપલોડ થઈ. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ઔપચારિક તબીબી અર્થઘટન માટે કૃપા કરીને રેડિયોલોજિસ્ટનો રિપોર્ટ અપલોડ કરો.",
    hindi:
      "एक्स-रे छवि सफलतापूर्वक अपलोड की गई। कोई लिखित रिपोर्ट पाठ नहीं मिला। औपचारिक नैदानिक व्याख्या के लिए कृपया रेडियोलॉजिस्ट की रिपोर्ट अपलोड करें।",
    marathi:
      "क्ष-किरण (X-ray) प्रतिमा यशस्वीरित्या अपलोड केली. कोणताही लिखित अहवाल आढळला नाही. औपचारिक वैद्यकीय विश्लेषणासाठी कृपया रेडिओलॉजिस्टचा अहवाल अपलोड करा.",
    tamil:
      "எக்ஸ்-ரே படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. முறையான மருத்துவ விளக்கத்திற்கு ரேடியாலஜிஸ்ட்டின் அறிக்கையைப் பதிவேற்றவும்.",
  },
  ct: {
    english:
      "CT scan image uploaded successfully. No written report text was detected. Please upload the radiologist's report for formal clinical interpretation.",
    gujarati:
      "સીટી સ્કેન ઇમેજ સફળતાપૂર્વક અપલોડ થઈ. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ઔપચારિક તબીબી અર્થઘટન માટે કૃપા કરીને રેડિયોલોજિસ્ટનો રિપોર્ટ અપલોડ કરો.",
    hindi:
      "सीटी स्कैन छवि सफलतापूर्वक अपलोड की गई। कोई लिखित रिपोर्ट पाठ नहीं मिला। औपचारिक नैदानिक व्याख्या के लिए कृपया रेडियोलॉजिस्ट की रिपोर्ट अपलोड करें।",
    marathi:
      "सीटी (CT) स्कॅन प्रतिमा यशस्वीरित्या अपलोड केली. कोणताही लिखित अहवाल आढळला नाही. औपचारिक वैद्यकीय विश्लेषणासाठी कृपया रेडिओलॉजिस्टचा अहवाल अपलोड करा.",
    tamil:
      "சிடி ஸ்கேன் படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. முறையான மருத்துவ விளக்கத்திற்கு ரேடியாலஜிஸ்ட்டின் அறிக்கையைப் பதிவேற்றவும்.",
  },
  mri: {
    english:
      "MRI scan image uploaded successfully. No written report text was detected. Please upload the radiologist's report for formal clinical interpretation.",
    gujarati:
      "એમઆરઆઈ સ્કેન ઇમેજ સફળતાપૂર્વક અપલોડ થઈ. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ઔપચારિક તબીબી અર્થઘટન માટે કૃપા કરીને રેડિયોલોજિસ્ટનો રિપોર્ટ અપલોડ કરો.",
    hindi:
      "एमआरआई स्कैन छवि सफलतापूर्वक अपलोड की गई। कोई लिखित रिपोर्ट पाठ नहीं मिला। औपचारिक नैदानिक व्याख्या के लिए कृपया रेडियोलॉजिस्ट की रिपोर्ट अपलोड करें।",
    marathi:
      "एमआरआय (MRI) स्कॅन प्रतिमा यशस्वीरित्या अपलोड केली. कोणताही लिखित अहवाल आढळला नाही. औपचारिक वैद्यकीय विश्लेषणासाठी कृपया रेडिओलॉजिस्टचा अहवाल अपलोड करा.",
    tamil:
      "எம்ஆர்ஐ ஸ்கேன் படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. முறையான மருத்துவ விளக்கத்திற்கு ரேடியாலஜிஸ்ட்டின் அறிக்கையைப் பதிவேற்றவும்.",
  },
  ultrasound: {
    english:
      "Ultrasound sonogram uploaded successfully. No written report text was detected. Please upload the radiologist's report for formal clinical interpretation.",
    gujarati:
      "અલ્ટ્રાસાઉન્ડ સોનોગ્રામ સફળતાપૂર્વક અપલોડ થયું. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ઔપચારિક તબીબી અર્થઘટન માટે કૃપા કરીને રેડિયોલોજિસ્ટનો રિપોર્ટ અપલોડ કરો.",
    hindi:
      "अल्ट्रासाउंड सोनोग्राम सफलतापूर्वक अपलोड किया गया। कोई लिखित रिपोर्ट पाठ नहीं मिला। औपचारिक नैदानिक व्याख्या के लिए कृपया रेडियोलॉजिस्ट की रिपोर्ट अपलोड करें।",
    marathi:
      "सोनोग्राफी (Ultrasound) प्रतिमा यशस्वीरित्या अपलोड केली. कोणताही लिखित अहवाल आढळला नाही. औपचारिक वैद्यकीय विश्लेषणासाठी कृपया रेडिओलॉजिस्टचा अहवाल अपलोड करा.",
    tamil:
      "அல்ட்ராசவுண்ட் படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. முறையான மருத்துவ விளக்கத்திற்கு ரேடியாலஜிஸ்ட்டின் அறிக்கையைப் பதிவேற்றவும்.",
  },
  ecg: {
    english:
      "Electrocardiogram (ECG) tracing uploaded successfully. No written report text was detected. Clinical interpretation of ECG rhythm strips requires physician or cardiologist review.",
    gujarati:
      "ઇલેક્ટ્રોકાર્ડિયોગ્રામ (ECG) ટ્રેસિંગ સફળતાપૂર્વક અપલોડ થયું. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ECG રિધમનું તબીબી અર્થઘટન ચિકિત્સક અથવા કાર્ડિયોલોજિસ્ટ દ્વારા જરૂરી છે.",
    hindi:
      "इलेक्ट्रोकार्डियोग्राम (ईसीजी) ट्रेसिंग सफलतापूर्वक अपलोड की गई। कोई लिखित रिपोर्ट पाठ नहीं मिला। ईसीजी ताल के नैदानिक विश्लेषण के लिए चिकित्सक या हृदय रोग विशेषज्ञ की समीक्षा आवश्यक है।",
    marathi:
      "इलेक्ट्रोकार्डिओग्राम (ECG) ट्रेसिंग यशस्वीरित्या अपलोड झाले. कोणताही लिखित अहवाल आढळला नाही. ईसीजी लयीच्या वैद्यकीय विश्लेषणासाठी डॉक्टरांचे पुनरावलोकन आवश्यक आहे.",
    tamil:
      "எலக்ட்ரோ கார்டியோகிராம் (ECG) படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. ஈசிஜி விளக்கத்திற்கு மருத்துவரின் மதிப்பாய்வு தேவை.",
  },
  other_diagnostic_imaging: {
    english:
      "Diagnostic medical image uploaded successfully. No written report text was detected. Please upload the official diagnostic report for formal clinical interpretation.",
    gujarati:
      "નિદાન તબીબી ઇમેજ સફળતાપૂર્વક અપલોડ થઈ. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ઔપચારિક તબીબી અર્થઘટન માટે કૃપા કરીને અધિકૃત રિપોર્ટ અપલોડ કરો.",
    hindi:
      "नैदानिक चिकित्सा छवि सफलतापूर्वक अपलोड की गई। कोई लिखित रिपोर्ट पाठ नहीं मिला। औपचारिक नैदानिक व्याख्या के लिए कृपया आधिकारिक रिपोर्ट अपलोड करें।",
    marathi:
      "वैद्यकीय प्रतिमा यशस्वीरित्या अपलोड केली. कोणताही लिखित अहवाल आढळला नाही. औपचारिक वैद्यकीय विश्लेषणासाठी कृपया अधिकृत अहवाल अपलोड करा.",
    tamil:
      "மருத்துவ படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. முறையான விளக்கத்திற்கு அதிகாரப்பூர்வ அறிக்கையைப் பதிவேற்றவும்.",
  },
};

/**
 * Checks whether a given string is a generic image-only disclosure
 */
function isFallbackDisclosureText(text) {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase();
  return (
    (lower.includes("uploaded successfully") && lower.includes("no written report")) ||
    (text.includes("સફળતાપૂર્વક અપલોડ") && text.includes("કોઈ લેખિત રિપોર્ટ")) ||
    (text.includes("सफलतापूर्वक अपलोड") && text.includes("कोई लिखित रिपोर्ट")) ||
    (text.includes("यशस्वीरित्या अपलोड") && text.includes("कोणताही लिखित अहवाल")) ||
    (text.includes("வெற்றிகரமாக பதிவேற்றப்பட்டது") && text.includes("எழுதப்பட்ட அறிக்கை"))
  );
}

/**
 * Retrieve localized disclosure text for verified image-only medical documents
 */
function getLocalizedFallbackDisclosure(modality, language = "english") {
  const normMod = (modality || "other_diagnostic_imaging").toLowerCase().replace(/[- ]/g, "_");
  const modDict =
    IMAGE_ONLY_DISCLOSURES[normMod] ||
    IMAGE_ONLY_DISCLOSURES.other_diagnostic_imaging ||
    IMAGE_ONLY_DISCLOSURES.x_ray;
  const normLang = normalizeLanguage(language);
  return modDict[normLang] || modDict.english;
}

/**
 * Shared summary resolver for both Onboarding and Unified Chat (Post-Onboarding)
 * Evaluates candidate English summaries, cache validity, fallback disclosure status,
 * and executes safe on-demand localization while preserving canonical summaries.
 */
async function resolveDocumentSummary({
  activeDoc = {},
  structured = {},
  preferredLanguage = "english",
  patientName = null,
  persistCache = true,
}) {
  const normLang = normalizeLanguage(
    preferredLanguage || activeDoc?.preferredLanguage || "english",
  );
  const struct =
    structured || activeDoc?.extractedStructuredData || activeDoc?.structuredExtractedData || {};
  const resolvedPatientName =
    patientName ||
    activeDoc?.patientName ||
    struct.patientInfo?.fullName ||
    struct.patientInfo?.name ||
    null;

  const rawDocType = String(
    activeDoc?.documentType || struct.documentInfo?.documentType || struct.documentType || "",
  ).toUpperCase();
  const isPrescription = rawDocType === "PRESCRIPTION";
  const isLabReport = rawDocType === "LAB_REPORT";

  const rawEnglish =
    activeDoc?.summaryEnglish ||
    struct.summaryEnglish ||
    struct.summary ||
    activeDoc?.summary ||
    "";
  const englishCandidate = stripReasoningTags(rawEnglish).trim();
  const englishIsDisclosure = isFallbackDisclosureText(englishCandidate);

  const imageAnalysis = struct.imageAnalysis || activeDoc?.imageAnalysis || null;
  const imageAnalysisStatus = imageAnalysis?.status
    ? String(imageAnalysis.status).toUpperCase()
    : null;
  const isImageAnalysisFailed = imageAnalysisStatus === "FAILED";
  const effModality = (imageAnalysis?.modality || rawDocType || "x_ray").toLowerCase();

  const isStubEnglish =
    !englishCandidate ||
    englishCandidate.length < 80 ||
    englishCandidate === "Medical laboratory report summary.";

  const summariesByLang = struct.summariesByLanguage || {};
  const cachedVersion = struct.summaryPipelineVersion || struct.pipelineVersion;
  const isCacheValid = cachedVersion === PIPELINE_VERSION;

  let docSummary = "";
  let translationStatus = "original";
  let translationProvider = "database";
  const isNoText = Boolean(
    activeDoc?.isNoText === true ||
    activeDoc?.additionalInformation?.isNoText === true ||
    struct?.isNoText === true ||
    struct?.additionalInformation?.isNoText === true ||
    String(
      activeDoc?.subType ||
        activeDoc?.documentSubtype ||
        struct?.documentInfo?.documentSubtype ||
        "",
    )
      .toLowerCase()
      .startsWith("image_only") ||
    struct?.imagingOverview ||
    activeDoc?.imagingOverview,
  );

  // Case 1: Image-only document, image analysis failed, or English candidate itself is deterministic fallback disclosure
  if (isNoText || isImageAnalysisFailed || (englishIsDisclosure && isStubEnglish)) {
    docSummary = getLocalizedFallbackDisclosure(effModality, normLang);
    translationStatus = "FALLBACK_DISCLOSURE";
    translationProvider = "deterministic_disclosure";
    return {
      docSummary,
      summaryEnglish: getLocalizedFallbackDisclosure(effModality, "english"),
      summaryInPreferredLanguage: docSummary,
      summaryLanguage: normLang,
      translationStatus,
      translationProvider,
      isFallbackDisclosure: true,
      structured: struct,
    };
  }

  // Case 2: Target language is non-English, check cache first (valid PIPELINE_VERSION and genuine translation)
  const shortCodeMap = { gujarati: "gu", hindi: "hi", tamil: "ta", marathi: "mr" };
  const cachedCandidate =
    summariesByLang[normLang] ||
    (shortCodeMap[normLang] ? summariesByLang[shortCodeMap[normLang]] : null);

  if (isCacheValid && normLang !== "english" && cachedCandidate) {
    const candidate = stripReasoningTags(cachedCandidate).trim();
    if (
      !isFallbackDisclosureText(candidate) &&
      isValidClinicalSummary(candidate, resolvedPatientName) &&
      validateIndicScriptRatio(candidate, normLang)
    ) {
      docSummary = candidate;
      translationStatus = "cached";
      translationProvider = "cached";
    }
  }

  if (isCacheValid && !docSummary && normLang !== "english") {
    const candidate = stripReasoningTags(
      struct.summaryInPreferredLanguage || activeDoc?.summaryInPreferredLanguage || "",
    ).trim();
    const transStatus = String(
      struct.translationStatus || activeDoc?.translationStatus || "",
    ).toUpperCase();
    const candidateIsDisclosure =
      isFallbackDisclosureText(candidate) ||
      transStatus === "FALLBACK_DISCLOSURE" ||
      transStatus === "TRANSLATION_FAILED";

    if (
      !candidateIsDisclosure &&
      isValidClinicalSummary(candidate, resolvedPatientName) &&
      validateIndicScriptRatio(candidate, normLang)
    ) {
      docSummary = candidate;
      translationStatus = "cached";
      translationProvider = "cached";
    }
  }

  // Base fallback if not cached: use englishCandidate
  if (!docSummary) {
    docSummary = englishCandidate;
  }

  // If still empty, provide clean default narrative
  if (!docSummary) {
    if (isPrescription) {
      docSummary = `Prescription from ${activeDoc?.doctorName || struct.doctorName || "Doctor"} at ${activeDoc?.hospitalName || struct.hospitalName || "Clinic"}.`;
    } else if (isLabReport) {
      docSummary = "Medical laboratory report summary.";
    } else {
      docSummary = "Medical document summary.";
    }
    translationStatus = "summary_unavailable";
  }

  // On-demand translation if user requested a non-English language and target translation is not cached
  if (!isNoText && normLang !== "english") {
    const hasValidTargetTranslation =
      translationStatus === "cached" && validateIndicScriptRatio(docSummary, normLang);

    if (docSummary && !hasValidTargetTranslation && !isStubEnglish && !englishIsDisclosure) {
      const isLatinOnly = !/[\u0A80-\u0AFF\u0900-\u097F\u0B80-\u0BFF]/.test(docSummary);
      if (isLatinOnly) {
        try {
          const translated = await aiClient.translate(docSummary, "english", normLang);
          const cleanTrans = stripReasoningTags(translated).trim();
          if (
            cleanTrans &&
            isValidClinicalSummary(cleanTrans, resolvedPatientName) &&
            validateIndicScriptRatio(cleanTrans, normLang)
          ) {
            docSummary = cleanTrans;
            translationStatus = "translated";
            translationProvider = "aiClient";

            // Update cached summaries on structured object
            if (!struct.summariesByLanguage) struct.summariesByLanguage = {};
            struct.summariesByLanguage[normLang] = cleanTrans;
            if (shortCodeMap[normLang]) {
              struct.summariesByLanguage[shortCodeMap[normLang]] = cleanTrans;
            }
            if (englishCandidate) {
              struct.summariesByLanguage.english = englishCandidate;
              struct.summariesByLanguage.en = englishCandidate;
            }
            struct.summaryInPreferredLanguage = cleanTrans;
            struct.summaryLanguage = normLang;
            struct.preferredLanguage = normLang;
            struct.summaryPipelineVersion = PIPELINE_VERSION;
            struct.translationStatus = "translated";
            struct.translationProvider = "aiClient";

            // Persist structured cache to DB using atomic JSONB merge to prevent race conditions
            if (persistCache && activeDoc?.id && db) {
              try {
                const patchJson = JSON.stringify({
                  summariesByLanguage: struct.summariesByLanguage,
                  summaryInPreferredLanguage: struct.summaryInPreferredLanguage,
                  summaryLanguage: struct.summaryLanguage,
                  preferredLanguage: struct.preferredLanguage,
                  summaryPipelineVersion: struct.summaryPipelineVersion,
                  translationStatus: struct.translationStatus,
                  translationProvider: struct.translationProvider,
                });
                await db
                  .update(document)
                  .set({
                    structuredExtractedData: sql`COALESCE(${document.structuredExtractedData}, '{}'::jsonb) || ${patchJson}::jsonb`,
                  })
                  .where(eq(document.id, activeDoc.id));
              } catch (cacheErr) {
                console.warn(
                  "[resolveDocumentSummary] Failed to cache translated summary:",
                  cacheErr.message,
                );
              }
            }
          } else {
            // Translation failed validation -> preserve validated English summary
            docSummary = englishCandidate;
            translationStatus = "failed";
          }
        } catch (transErr) {
          console.warn("[resolveDocumentSummary] On-demand translation failed:", transErr.message);
          docSummary = englishCandidate;
          translationStatus = "failed";
        }
      } else {
        translationStatus = "cached";
      }
    } else if (isStubEnglish) {
      translationStatus = "summary_unavailable";
    } else if (docSummary && isCacheValid) {
      const hasIndicChars = /[\u0A80-\u0AFF\u0900-\u097F\u0B80-\u0BFF]/.test(docSummary);
      translationStatus = hasIndicChars ? "cached" : "original";
    }
  }

  const isDisclosure = isFallbackDisclosureText(docSummary);
  const canonicalEnglish = englishCandidate || docSummary;
  const canonicalPreferred =
    normLang !== "english" && (translationStatus === "translated" || translationStatus === "cached")
      ? docSummary
      : struct.summaryInPreferredLanguage &&
          !isFallbackDisclosureText(struct.summaryInPreferredLanguage)
        ? struct.summaryInPreferredLanguage
        : null;

  const fallbackSummaries = { english: canonicalEnglish };
  if (normLang !== "english" && canonicalPreferred) {
    fallbackSummaries[normLang] = canonicalPreferred;
  }

  return {
    docSummary,
    summaryEnglish: canonicalEnglish,
    summaryInPreferredLanguage: canonicalPreferred,
    summaryLanguage:
      normLang !== "english" &&
      (translationStatus === "translated" || translationStatus === "cached")
        ? normLang
        : "english",
    preferredLanguage: normLang,
    summariesByLanguage: struct.summariesByLanguage || fallbackSummaries,
    summaryPipelineVersion: struct.summaryPipelineVersion || PIPELINE_VERSION,
    translationStatus,
    translationProvider,
    isFallbackDisclosure: isDisclosure,
    keyPoints: Array.isArray(struct.keyPoints) ? struct.keyPoints : [],
    keyFindings: Array.isArray(struct.keyFindings)
      ? struct.keyFindings
      : typeof struct.keyFindings === "string" && struct.keyFindings.trim()
        ? [struct.keyFindings.trim()]
        : [],
    structured: struct,
  };
}

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
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const isUuid = uuidRegex.test(String(docIdToFetch));
      const matchCond = isUuid
        ? eq(document.id, docIdToFetch)
        : eq(document.s3Key, String(docIdToFetch));

      const query = db
        .select()
        .from(document)
        .where(
          userId
            ? and(matchCond, eq(document.userId, userId), eq(document.softDelete, false))
            : and(matchCond, eq(document.softDelete, false)),
        )
        .limit(1);
      const res = await query;
      activeDoc = Array.isArray(res) ? res[0] || null : null;
    } catch (err) {
      console.warn("[reportPayload.helper] Failed to fetch document by ID:", err.message);
    }
  }

  // NOTE: If docIdToFetch was provided but document not found, DO NOT fall back to an arbitrary
  // most recent document from DB (which causes lab_1_.jpeg to be cited instead of report.pdf).
  if (!activeDoc && !docIdToFetch && userId) {
    try {
      const docs = await db
        .select()
        .from(document)
        .where(and(eq(document.userId, userId), eq(document.softDelete, false)))
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

  const isNoText = Boolean(
    activeDoc?.isNoText === true ||
    activeDoc?.additionalInformation?.isNoText === true ||
    structured?.isNoText === true ||
    structured?.additionalInformation?.isNoText === true ||
    String(
      activeDoc?.subType ||
        activeDoc?.documentSubtype ||
        structured?.documentInfo?.documentSubtype ||
        "",
    )
      .toLowerCase()
      .startsWith("image_only") ||
    structured?.imagingOverview ||
    activeDoc?.imagingOverview,
  );

  const patientInfo = structured.patientInfo || structured.patient || {};
  const patientName =
    activeDoc.patientName ||
    structured.patientName ||
    patientInfo.name ||
    patientInfo.fullName ||
    null;

  // 3. Extract lab tests / findings
  const tests =
    Array.isArray(structured.labResults) && structured.labResults.length > 0
      ? structured.labResults
      : Array.isArray(structured.tests) && structured.tests.length > 0
        ? structured.tests
        : [];

  const rawDocType = String(
    activeDoc.documentType ||
      structured.documentInfo?.documentType ||
      structured.documentType ||
      "",
  ).toUpperCase();

  const isPrescription =
    rawDocType === "PRESCRIPTION" ||
    rawDocType === "PRESCERIPTION" ||
    (Array.isArray(structured.medications) &&
      structured.medications.length > 0 &&
      tests.length === 0);

  const isQuotation =
    rawDocType === "QUOTATION" ||
    rawDocType.includes("QUOTATION") ||
    rawDocType.includes("ESTIMATE");

  const isLabReport =
    !isPrescription &&
    !isQuotation &&
    (tests.length > 0 ||
      rawDocType === "LAB_REPORT" ||
      rawDocType.includes("LAB") ||
      (rawDocType.includes("REPORT") && !rawDocType.includes("MEDICAL_DOCUMENT")));

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

  // 5. Narrative summary resolution with on-demand localization via shared resolver
  const resolved = await resolveDocumentSummary({
    activeDoc,
    structured,
    preferredLanguage: normLang,
    patientName,
    persistCache: true,
  });
  const docSummary = resolved.docSummary;
  const translationStatus = resolved.translationStatus;

  // 6. Patient details
  const dateOnlyStr =
    toDbDateOnlyString(activeDoc.reportDate) ||
    toDbDateOnlyString(structured.documentInfo?.documentDate) ||
    toDbDateOnlyString(structured.reportDate) ||
    toDbDateOnlyString(activeDoc.createdAt) ||
    toDbDateOnlyString(new Date());

  const providerInfo = structured.providerInfo || {};
  const primaryProvider =
    providerInfo.primary ||
    (Array.isArray(providerInfo.providers) && providerInfo.providers.length === 1
      ? providerInfo.providers[0]
      : null);

  const resolvedDoctor =
    activeDoc.doctorName ||
    primaryProvider?.name ||
    structured.doctorName ||
    structured.doctorInfo?.name ||
    structured.doctor?.name ||
    patientInfo.doctorName ||
    null;

  const facilityInfo = structured.facilityInfo || {};
  const resolvedHospital =
    activeDoc.hospitalName ||
    facilityInfo.name ||
    structured.hospitalName ||
    structured.hospitalInfo?.name ||
    structured.hospital?.name ||
    patientInfo.hospitalName ||
    patientInfo.clinicName ||
    null;

  const patientDetails = {
    name: patientName || patientInfo.fullName || patientInfo.name || "Patient",
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
          : isQuotation
            ? "QUOTATION"
            : rawDocType || "OTHER_MEDICAL_DOCUMENT",
      reportDate: dateOnlyStr,
      hospitalName: resolvedHospital,
      doctorName: resolvedDoctor,
      summary: docSummary,
      summaryEnglish: resolved.summaryEnglish,
      summaryInPreferredLanguage: resolved.summaryInPreferredLanguage,
      summaryLanguage: resolved.summaryLanguage,
      preferredLanguage: normLang,
      summariesByLanguage: resolved.summariesByLanguage,
      summaryPipelineVersion: resolved.summaryPipelineVersion,
      translationStatus,
      translationProvider: resolved.translationProvider,
      keyPoints: isNoText ? [] : resolved.keyPoints,
      patientDetails,
      isLabReport,
      isPrescription,
      isQuotation,
      isOtherMedicalDoc,
      abnormalResults,
      normalResults,
      keyFindings: isNoText
        ? []
        : typeof structured.keyFindings === "string" && structured.keyFindings.trim()
          ? structured.keyFindings.trim()
          : Array.isArray(structured.keyFindings) && structured.keyFindings.length > 0
            ? structured.keyFindings
                .map((k) =>
                  typeof k === "string"
                    ? k.trim()
                    : typeof k === "object" && k?.finding
                      ? String(k.finding).trim()
                      : "",
                )
                .filter(Boolean)
                .join("\n")
            : docSummary,
      whatThisMayMean: isNoText ? "" : docSummary,
      labFindings,
      medicationFindings,
      imagingOverview: structured.imagingOverview || activeDoc.imagingOverview || null,
      isNoText: isNoText,
      s3Key: activeDoc.s3Key || null,
      fileKey: activeDoc.s3Key || activeDoc.fileKey || null,
      fileUrl: activeDoc.fileUrl || null,
      // Canonical 14-section projections
      documentInfo: structured.documentInfo || null,
      patientInfo: structured.patientInfo || null,
      providerInfo: structured.providerInfo || null,
      facilityInfo: structured.facilityInfo || null,
      imageAnalysis: structured.imageAnalysis || activeDoc.imageAnalysis || null,
      diagnosis: structured.diagnosis || [],
      symptoms: structured.symptoms || [],
      vitals: structured.vitals || [],
      labResults: structured.labResults || [],
      groupedLabResults: structured.groupedLabResults || structured.sections || [],
      sections: structured.sections || structured.groupedLabResults || [],
      medications: structured.medications || [],
      procedures: structured.procedures || [],
      treatments: structured.treatments || [],
      treatmentPlan: structured.treatmentPlan || null,
      financialSummary: structured.financialSummary || null,
      additionalInformation: structured.additionalInformation || null,
      structuredExtractedData: structured,
    },
    suggestedQuestions,
    options: [],
  };
}

module.exports = {
  buildStructuredReportPayload,
  resolveDocumentSummary,
  isFallbackDisclosureText,
  getLocalizedFallbackDisclosure,
  IMAGE_ONLY_DISCLOSURES,
  REPORT_QUESTIONS_I18N,
  GENERAL_DOC_QUESTIONS_I18N,
  PIPELINE_VERSION,
};
