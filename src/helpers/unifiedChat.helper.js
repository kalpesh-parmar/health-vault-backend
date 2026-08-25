const { eq, and } = require("drizzle-orm");
const { db } = require("../configs/db");
const { document } = require("../models/document");
const { normalizeLanguage } = require("../utils/commonUtils");
const { messageConstants } = require("../constants/messageConstants");
const medicationService = require("../services/medication.service");

/**
 * Normalizes input body for unified chat endpoint.
 * Handles fallback between `message` and `question`.
 */
function normalizeUnifiedChatInput(body = {}) {
  const {
    actionType = null,
    actionData = null,
    message,
    question,
    sessionId = null,
    documentId = null,
    state = null,
    history = [],
    displayLabel = null,
    preferredLanguage,
  } = body || {};

  const normalizedMessage =
    message !== undefined && message !== null
      ? typeof message === "object"
        ? JSON.stringify(message)
        : String(message).trim()
      : question !== undefined && question !== null
        ? typeof question === "object"
          ? JSON.stringify(question)
          : String(question).trim()
        : "";

  return {
    actionType: actionType ? String(actionType).trim().toUpperCase() : null,
    actionData: actionData && typeof actionData === "object" ? actionData : {},
    message: normalizedMessage,
    sessionId: sessionId || null,
    documentId: Array.isArray(documentId) ? documentId : documentId ? [documentId] : null,
    state: state && typeof state === "object" ? state : null,
    history: Array.isArray(history) ? history : [],
    displayLabel: displayLabel || null,
    preferredLanguage: preferredLanguage ? normalizeLanguage(preferredLanguage) : null,
  };
}

/**
 * Builds a standardized unified chat response payload.
 */
function buildUnifiedResponse({
  mode = "NORMAL_CHAT",
  actionType = null,
  reply = "",
  sessionId = null,
  onboardingState = null,
  medicines = [],
  citations = [],
  document = null,
  medication = null,
  suggestedAction = null,
  options = [],
  requireSelection = false,
  reports = [],
  allowMultiSelect = false,
  selectionType = null,
}) {
  return {
    mode,
    actionType,
    reply,
    sessionId,
    onboardingState,
    medicines,
    citations,
    document,
    medication,
    suggestedAction,
    options,
    requireSelection,
    reports,
    allowMultiSelect,
    selectionType,
  };
}

/**
 * Detects if a user message in post-onboarding chat implies adding a document or medicine,
 * returning suggested action metadata and interactive UI options.
 */
function detectActionIntent(text = "", language = "english") {
  if (!text || typeof text !== "string") {
    return { suggestedAction: null, options: [] };
  }

  const lower = text.toLowerCase().trim();

  // Document upload intent keywords
  const documentKeywords = [
    "add document",
    "upload document",
    "upload report",
    "add report",
    "upload prescription",
    "add prescription",
    "upload lab test",
    "new report",
    "new document",
    "અહેવાલ અપલોડ",
    "દસ્તાવેજ ઉમેરો",
    "રિપોર્ટ ઉમેરો",
    "કોઈ દસ્તાવેજ ઉમેરો",
    "रिपोर्ट अपलोड",
    "दस्तावेज़ जोड़ें",
    "कागदपत्रे जोडा",
    "ஆவணத்தைப் பதிવેற்று",
  ];

  // Medicine addition intent keywords
  const medicineKeywords = [
    "add medicine",
    "add medication",
    "new medicine",
    "add drug",
    "create medicine",
    "add new medicine",
    "દવા ઉમેરો",
    "દવાઓ ઉમેરો",
    "નવી દવા",
    "દવા જોડો",
    "દવા લખો",
    "दवा जोड़ें",
    "दवाई जोड़ें",
    "नवीन औषध",
    "மருந்தைச் சேர்",
    "ADD",
    "Add Another Medicine",
  ];

  if (documentKeywords.some((kw) => lower.includes(kw))) {
    const uploadLabel = language === "gujarati" ? "દસ્તાવેજ અપલોડ કરો" : "Upload Document";
    return {
      suggestedAction: "ADD_DOCUMENT",
      options: [
        {
          label: ` ${uploadLabel}`,
          value: "ADD_DOCUMENT",
          actionType: "ADD_DOCUMENT",
        },
      ],
    };
  }

  if (medicineKeywords.some((kw) => lower.includes(kw))) {
    const addMedLabel = language === "gujarati" ? "નવી દવા ઉમેરો" : "Add New Medicine";
    return {
      suggestedAction: "ADD_MEDICINE",
      options: [
        {
          label: ` ${addMedLabel}`,
          value: "ADD_MEDICINE",
          actionType: "ADD_MEDICINE",
        },
      ],
    };
  }

  return { suggestedAction: null, options: [] };
}

/**
 * Helper to process ADD_DOCUMENT action for unified chat API.
 * If rawOcrData is present, persists document synchronously.
 * If only s3Key is present, enqueues background OCR job and pipeline.
 */
function extractFileKey(item) {
  if (!item) return null;
  if (typeof item === "string") return item.trim() || null;
  if (typeof item === "object") {
    return (
      item.fileKey ||
      item.s3Key ||
      item.key ||
      item.file_key ||
      item.s3_key ||
      item.filePath ||
      item.path ||
      null
    );
  }
  return null;
}

async function executeAddDocumentAction({
  userId,
  actionData,
  sessionId,
  isOnboardingCompleted,
  documentPersistenceService,
  documentOcrJobService,
  chatService,
  chatSessionRepository,
  ocrStatusEnum,
}) {
  let filesList = [];
  if (Array.isArray(actionData?.files) && actionData.files.length > 0) {
    filesList = actionData.files;
  } else if (actionData && typeof actionData === "object") {
    const singleKey = extractFileKey(actionData);
    if (singleKey) {
      filesList = [actionData];
    }
  }

  const hasOcrData = Boolean(actionData?.rawOcrData || actionData?.extractedStructuredData);

  let docResult;
  let replyText;
  const fileNames = [];

  if (!hasOcrData && filesList.length > 0) {
    const createdDocs = [];
    const createdJobs = [];

    let isExistingCompleted = false;
    let isExistingProcessing = false;

    for (const fItem of filesList) {
      const currentS3Key = extractFileKey(fItem);
      if (!currentS3Key) continue;
      const fileName =
        (typeof fItem === "object" ? fItem?.fileName || fItem?.originalFileName : null) ||
        currentS3Key.split("/").pop();
      fileNames.push(fileName);

      let existingJob = null;
      if (documentOcrJobService?.getStatus) {
        try {
          existingJob = await documentOcrJobService.getStatus({ fileKey: currentS3Key, userId });
        } catch {
          existingJob = null;
        }
      }

      if (existingJob) {
        let normStatus = "completed";
        if (existingJob.status === "COMPLETED" || existingJob.status === "completed") {
          normStatus = ocrStatusEnum?.COMPLETED || "completed";
          isExistingCompleted = true;
        } else if (
          existingJob.status === "RUNNING" ||
          existingJob.status === "QUEUED" ||
          existingJob.status === "PROCESSING" ||
          existingJob.status === "in_progress"
        ) {
          normStatus = ocrStatusEnum?.IN_PROGRESS || "in_progress";
          isExistingProcessing = true;
        } else {
          normStatus = String(existingJob.status || "in_progress").toLowerCase();
        }

        createdDocs.push({
          id: existingJob.id,
          fileName,
          s3Key: currentS3Key,
          ocrStatus: normStatus,
          extractedStructuredData: existingJob.extractedStructuredData || null,
        });
        createdJobs.push(existingJob);
      } else {
        const ext = currentS3Key.includes(".") ? currentS3Key.split(".").pop().toLowerCase() : "";
        const inferredMime =
          ext === "pdf"
            ? "application/pdf"
            : ext === "png"
              ? "image/png"
              : ext === "jpg" || ext === "jpeg"
                ? "image/jpeg"
                : "application/pdf";
        const mimeType = fItem?.mimeType || fItem?.fileType || inferredMime;

        const job = await documentOcrJobService.enqueue({
          fileKey: currentS3Key,
          mimeType,
          userId,
        });

        createdDocs.push({
          id: job.id,
          fileName,
          s3Key: currentS3Key,
          ocrStatus: ocrStatusEnum?.IN_PROGRESS || "in_progress",
        });
        createdJobs.push(job);
      }
    }

    if (filesList.length === 1 && isExistingCompleted) {
      replyText = `Document '${fileNames[0]}' has already been processed and is ready in your Health Vault.`;
    } else if (filesList.length === 1 && isExistingProcessing) {
      const firstJob = createdJobs[0] || {};
      const pct = firstJob.percentage != null ? `${firstJob.percentage}%` : "in progress";
      replyText = `Document '${fileNames[0]}' OCR processing is currently ${pct} (Stage: ${firstJob.stage || "PROCESSING"}).`;
    } else if (filesList.length > 1) {
      replyText = `${filesList.length} documents (${fileNames.map((n) => `'${n}'`).join(", ")}) uploaded. OCR text extraction & vector indexing started in background.`;
    } else {
      replyText = `Document '${fileNames[0] || "file"}' uploaded. OCR text extraction & vector indexing started in background.`;
    }

    docResult = {
      document: createdDocs.length === 1 ? createdDocs[0] : createdDocs,
      job: createdJobs.length === 1 ? createdJobs[0] : createdJobs,
    };
  } else {
    docResult = await documentPersistenceService.addDocument({
      userId,
      payload: actionData,
    });

    replyText = docResult?.document?.fileName
      ? `Document '${docResult.document.fileName}' has been added to your Health Vault.`
      : "Document added successfully.";
  }

  let extractedMedicines = [];
  const rawMeds = [];

  const extractMedsFromStructured = (struct) => {
    if (!struct || typeof struct !== "object") return [];
    if (Array.isArray(struct.medications) && struct.medications.length > 0)
      return struct.medications;
    if (
      Array.isArray(struct.structuredData?.medications) &&
      struct.structuredData.medications.length > 0
    )
      return struct.structuredData.medications;
    return [];
  };

  const jobsList = Array.isArray(docResult?.job)
    ? docResult.job
    : docResult?.job
      ? [docResult.job]
      : [];
  const docsList = Array.isArray(docResult?.document)
    ? docResult.document
    : docResult?.document
      ? [docResult.document]
      : [];

  if (jobsList.length > 0) {
    for (const jobItem of jobsList) {
      const meds = extractMedsFromStructured(jobItem?.extractedStructuredData);
      if (meds.length > 0) rawMeds.push(...meds);
    }
  } else {
    for (const docItem of docsList) {
      const meds = extractMedsFromStructured(
        docItem?.structuredExtractedData || docItem?.extractedStructuredData,
      );
      if (meds.length > 0) rawMeds.push(...meds);
    }
  }

  if (rawMeds.length === 0 && actionData?.rawOcrData) {
    const meds = extractMedsFromStructured(
      actionData.rawOcrData.extractedStructuredData || actionData.rawOcrData,
    );
    if (meds.length > 0) rawMeds.push(...meds);
  }

  // DB Fallback: Check documents table for completed documents if rawMeds is still empty
  if (rawMeds.length === 0 && filesList.length > 0 && userId) {
    for (const fItem of filesList) {
      const currentS3Key = extractFileKey(fItem);
      if (!currentS3Key) continue;
      try {
        const [docRow] = await db
          .select()
          .from(document)
          .where(and(eq(document.s3Key, currentS3Key), eq(document.userId, userId)));
        if (docRow && docRow.structuredExtractedData) {
          const meds = extractMedsFromStructured(docRow.structuredExtractedData);
          if (meds.length > 0) rawMeds.push(...meds);
        }
      } catch (dbErr) {
        // Ignore DB lookup error
        console.log(dbErr);
      }
    }
  }

  if (Array.isArray(rawMeds) && rawMeds.length > 0) {
    const rawList = rawMeds.map((m, idx) => ({
      id: m.id || m.client_med_id || `extracted_med_${idx + 1}`,
      name: m.name || m.medicationName || "Unknown Medicine",
      medicationName: m.name || m.medicationName || "Unknown Medicine",
      medicationType: String(m.type || m.medicationType || "TABLET").toUpperCase(),
      type: String(m.type || m.medicationType || "TABLET").toUpperCase(),
      dosePerIntake: m.dosage ? parseFloat(m.dosage) || 1 : 1,
      frequency: m.frequency || "ONCE",
      duration: m.duration || null,
      instructions: m.instructions || m.timing || null,
      selected: true,
      isSaved: false,
    }));

    if (userId) {
      extractedMedicines = await medicationService.checkDuplicateMedicationsBatch(userId, rawList);
    } else {
      extractedMedicines = rawList;
    }

    const docFileName =
      fileNames.length > 0
        ? fileNames.join(", ")
        : actionData?.fileName || docResult?.document?.fileName || "prescription";
    if (isOnboardingCompleted) {
      replyText = messageConstants.DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW(
        docFileName,
        extractedMedicines.length,
      );
    } else {
      replyText = `Document '${docFileName}' has been processed. Found ${extractedMedicines.length} medications in your documents.`;
    }
  }

  const isPostOnboardingReview = isOnboardingCompleted && extractedMedicines.length > 0;
  const returnedActionType = isPostOnboardingReview ? "REVIEW_MEDICINES_LIST" : "ADD_DOCUMENT";
  const suggestedAction = isPostOnboardingReview
    ? "REVIEW_MEDICINES_LIST"
    : extractedMedicines.length > 0
      ? "SHOW_EXTRACTED_MEDICINES"
      : null;

  const options = isPostOnboardingReview
    ? [
        { label: "Confirm Selected", value: "CONFIRM", actionType: "CONFIRM_MEDICINES" },
        { label: "Add New", value: "ADD", actionType: "ADD_MEDICINE" },
        { label: "Skip All", value: "SKIP", actionType: "SKIP_MEDICINES" },
      ]
    : extractedMedicines.length > 0
      ? [
          {
            label: `Add ${extractedMedicines.length} Extracted Medicines`,
            value: "SHOW_EXTRACTED_MEDICINES",
            actionType: "ADD_MEDICINE",
          },
        ]
      : [];

  let activeSessionId = sessionId;
  if (!activeSessionId && isOnboardingCompleted) {
    const newSession = await chatService.createSession({
      userId,
      title: docResult?.document?.fileName || "Document Chat",
    });
    activeSessionId = newSession?.id || null;
  }

  if (activeSessionId) {
    await chatSessionRepository.appendMessage({
      sessionId: activeSessionId,
      userId,
      role: "assistant",
      content: replyText,
      metadata: {
        mode: "ACTION",
        actionType: returnedActionType,
        suggestedAction,
        options,
        medicines: extractedMedicines,
        document: docResult?.document,
        documentId: docResult?.document?.id,
      },
    });
  }

  return buildUnifiedResponse({
    mode: "ACTION",
    actionType: returnedActionType,
    reply: replyText,
    sessionId: activeSessionId,
    document: docResult.document,
    medicines: extractedMedicines,
    suggestedAction,
    options,
  });
}

module.exports = {
  buildUnifiedResponse,
  detectActionIntent,
  executeAddDocumentAction,
  normalizeUnifiedChatInput,
};
