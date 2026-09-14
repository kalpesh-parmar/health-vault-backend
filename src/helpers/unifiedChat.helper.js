const { eq, and } = require("drizzle-orm");
const { db } = require("../configs/db");
const { document } = require("../models/document");
const { normalizeLanguage } = require("../utils/commonUtils");
const { messageConstants } = require("../constants/messageConstants");
const medicationService = require("../services/medication.service");
const aiClient = require("../services/ai/clients/aiClient.service");
const { normalizeMedicine } = require("./medicineNormalize.helper");

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
    fromScreen = null,
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
    preferredLanguage: preferredLanguage
      ? normalizeLanguage(preferredLanguage)
      : state?.preferredLanguage
        ? normalizeLanguage(state.preferredLanguage)
        : null,
    fromScreen: fromScreen || (state && state.fromScreen) || null,
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
  title = null,
  subtitle = null,
  fields = [],
  explainer = null,
  loginSummary = null,
  documentSummary = null,
}) {
  return {
    mode,
    actionType,
    reply,
    title,
    subtitle,
    fields,
    explainer,
    loginSummary,
    documentSummary,
    sessionId,
    onboardingState,
    state: onboardingState,
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
  preferredLanguage = "english",
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
    // let isExistingProcessing = false;

    for (const fItem of filesList) {
      const currentS3Key = extractFileKey(fItem);
      if (!currentS3Key) continue;

      let existingJob = null;
      if (documentOcrJobService?.getStatus) {
        try {
          existingJob = await documentOcrJobService.getStatus({ fileKey: currentS3Key, userId });
        } catch {
          existingJob = null;
        }
      }

      let rawExtractedName =
        (typeof fItem === "object"
          ? fItem?.originalName ||
            fItem?.originalFileName ||
            fItem?.fileName ||
            fItem?.name ||
            fItem?.original_file_name ||
            fItem?.file_name
          : null) ||
        existingJob?.metadata?.originalName ||
        existingJob?.metadata?.fileName;

      if (!rawExtractedName && userId) {
        try {
          const [dbDoc] = await db
            .select({ fileName: document.fileName })
            .from(document)
            .where(and(eq(document.s3Key, currentS3Key), eq(document.userId, userId)))
            .limit(1);
          if (dbDoc && dbDoc.fileName) {
            rawExtractedName = dbDoc.fileName;
          }
        } catch {
          // ignore DB lookup error
        }
      }

      const fileName = rawExtractedName || currentS3Key.split("/").pop();
      fileNames.push(fileName);

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
          // isExistingProcessing = true;
        } else {
          normStatus = String(existingJob.status || "in_progress").toLowerCase();
        }
        const jobError = existingJob.error || existingJob.message || null;
        createdDocs.push({
          id: existingJob.id,
          fileName,
          s3Key: currentS3Key,
          currentStep: existingJob.currentStep,
          completedSteps: existingJob.completedSteps,
          pendingSteps: existingJob.pendingSteps,
          status: existingJob.status,
          stageStatus: existingJob.stageStatus,
          ocrStatus: normStatus,
          retryable: existingJob.retryable,
          extractedStructuredData: existingJob.extractedStructuredData || null,
          error: jobError,
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
          preferredLanguage,
          userId,
          originalName: fileName,
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

    const completedNames = [];
    const failedMessages = [];
    const processingNames = [];

    createdJobs.forEach((jItem, idx) => {
      const fName = fileNames[idx] || "document";
      const st = String(jItem?.status || "").toUpperCase();
      if (st === "COMPLETED") {
        completedNames.push(`'${fName}'`);
      } else if (st === "FAILED" || st === "REJECTED") {
        const err = jItem?.error || jItem?.message || "Processing failed";
        failedMessages.push(`'${fName}': ${err}`);
      } else {
        processingNames.push(`'${fName}'`);
      }
    });

    if (filesList.length === 1 && isExistingCompleted) {
      replyText = `Your document has been processed and is ready in your Vault. What can I help you next with ?`;
    } else {
      const summaryParts = [];
      if (completedNames.length > 0) {
        const countText =
          completedNames.length === 1
            ? `1 document completed (${completedNames[0]})`
            : `${completedNames.length} documents completed (${completedNames.join(", ")})`;
        summaryParts.push(countText);
      }

      if (failedMessages.length > 0) {
        const countText =
          failedMessages.length === 1
            ? `1 document failed (${failedMessages[0]})`
            : `${failedMessages.length} documents failed (${failedMessages.join("; ")})`;
        summaryParts.push(countText);
      }

      if (processingNames.length > 0) {
        const countText =
          processingNames.length === 1
            ? `1 document (${processingNames[0]}) uploaded. OCR text extraction & vector indexing started in background`
            : `${processingNames.length} documents (${processingNames.join(", ")}) uploaded. OCR text extraction & vector indexing started in background`;
        summaryParts.push(countText);
      }

      if (summaryParts.length > 0) {
        replyText = summaryParts.join(". ") + ".";
      } else {
        replyText = `Document '${fileNames[0] || "file"}' uploaded. OCR text extraction & vector indexing started in background.`;
      }
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
    const todayStr = new Date().toISOString().slice(0, 10);
    const rawList = rawMeds.map((m, idx) => {
      const { row, onboardingMed } = normalizeMedicine(m, idx, "P-TEMP", {
        startDate: todayStr,
      });
      return {
        id: m.id || m.client_med_id || onboardingMed.id,
        client_med_id: m.client_med_id || onboardingMed.client_med_id,
        name: onboardingMed.name,
        medicationName: onboardingMed.name,
        medicationType: onboardingMed.type,
        type: onboardingMed.type,
        dosePerIntake: row.dosePerIntake || 1,
        frequency: onboardingMed.frequency,
        duration: onboardingMed.duration,
        instructions: m.instructions || m.timing || row.notes || null,
        notes: row.notes || null,
        startDate: row.startDate,
        endDate: row.endDate,
        foodFrequency: row.foodFrequency,
        medicationSchedule: onboardingMed.medicationSchedule,
        totalQuantity: row.totalQuantity,
        unit: row.unit,
        dailyConsumption: row.dailyConsumption,
        prescribedBy: row.prescribedBy || null,
        refillAlert: row.refillAlert || false,
        selected: true,
        isSaved: false,
      };
    });

    if (userId) {
      extractedMedicines = await medicationService.checkDuplicateMedicationsBatch(userId, rawList);
    } else {
      extractedMedicines = rawList;
    }
  }

  const batchDocumentsName =
    fileNames.length > 0
      ? fileNames
      : [actionData?.fileName || docResult?.document?.fileName || "prescription"].filter(Boolean);

  let totalUploads = filesList.length || 0;
  let completedCount = 0;
  let failedCount = 0;
  let rejectedCount = 0;

  const summaryJobsList = Array.isArray(docResult?.job)
    ? docResult.job
    : docResult?.job
      ? [docResult.job]
      : [];

  if (summaryJobsList.length > 0) {
    totalUploads = Math.max(totalUploads, summaryJobsList.length);
    summaryJobsList.forEach((jItem) => {
      const st = String(jItem?.status || jItem?.ocrStatus || "").toUpperCase();
      if (st === "COMPLETED") {
        completedCount++;
      } else if (st === "FAILED") {
        failedCount++;
      } else if (st === "REJECTED") {
        rejectedCount++;
      }
    });
  } else if (docResult?.document) {
    const docs = Array.isArray(docResult.document) ? docResult.document : [docResult.document];
    totalUploads = Math.max(totalUploads, docs.length);
    docs.forEach((d) => {
      const st = String(d?.ocrStatus || d?.status || "").toUpperCase();
      if (st === "COMPLETED") {
        completedCount++;
      } else if (st === "FAILED") {
        failedCount++;
      } else if (st === "REJECTED") {
        rejectedCount++;
      }
    });
  }

  if (completedCount === 0 && (docResult?.document || docResult?.job)) {
    completedCount = Math.max(totalUploads - failedCount - rejectedCount, 1);
  }
  if (totalUploads === 0) {
    totalUploads = Math.max(batchDocumentsName.length, 1);
  }

  const documentSummary = {
    totalUploads,
    completed: completedCount,
    failed: failedCount,
    rejected: rejectedCount,
  };

  const documentsBatchList = [];
  const documentsStatusList = [];
  let mainDocumentSummaryText = null;

  if (docsList.length > 0) {
    for (let i = 0; i < docsList.length; i++) {
      const d = docsList[i];
      if (!d) continue;
      const struct = d.extractedStructuredData || d.structuredExtractedData || {};
      const docSum =
        struct.summary ||
        struct.summaryInPreferredLanguage ||
        d.summary ||
        d.summaryEnglish ||
        d.summaryGujarati ||
        d.remarks ||
        (d.error ? `Failed: ${d.error}` : null);

      if (docSum && !mainDocumentSummaryText) {
        mainDocumentSummaryText = docSum;
      }

      const st = String(d.ocrStatus || d.status || d.stageStatus || "COMPLETED").toUpperCase();
      documentsStatusList.push(st);
      documentsBatchList.push({
        id: d.id || d.s3Key || null,
        fileName: d.fileName || batchDocumentsName[i] || "document",
        status: st,
        ocrStatus: d.ocrStatus || d.status || "COMPLETED",
        summary: docSum || null,
        error: d.error || null,
      });
    }
  } else if (jobsList.length > 0) {
    for (let i = 0; i < jobsList.length; i++) {
      const j = jobsList[i];
      if (!j) continue;
      const struct = j.extractedStructuredData || {};
      const jobSum =
        struct.summary || j.summary || j.remarks || (j.error ? `Failed: ${j.error}` : null);

      if (jobSum && !mainDocumentSummaryText) {
        mainDocumentSummaryText = jobSum;
      }

      const st = String(j.status || j.ocrStatus || j.stageStatus || "PENDING").toUpperCase();
      documentsStatusList.push(st);
      documentsBatchList.push({
        id: j.jobId || j.s3Key || j.id || null,
        fileName: j.fileName || batchDocumentsName[i] || "document",
        status: st,
        ocrStatus: j.ocrStatus || j.status || "PENDING",
        summary: jobSum || null,
        error: j.error || null,
      });
    }
  } else if (filesList.length > 0) {
    filesList.forEach((f, i) => {
      const fn = f.fileName || batchDocumentsName[i] || "document";
      const st = failedCount > 0 ? "FAILED" : "COMPLETED";
      documentsStatusList.push(st);
      documentsBatchList.push({
        id: f.fileKey || null,
        fileName: fn,
        status: st,
        ocrStatus: st,
        summary: null,
      });
    });
  }

  const primaryDocumentStatus =
    documentsStatusList[0] || (failedCount > 0 ? "FAILED" : "COMPLETED");

  if (docResult?.document && preferredLanguage && preferredLanguage.toLowerCase() !== "english") {
    const prefLang = preferredLanguage.toLowerCase();
    const docs = Array.isArray(docResult.document) ? docResult.document : [docResult.document];
    for (const docItem of docs) {
      if (!docItem) continue;
      const struct = docItem.extractedStructuredData || docItem.structuredExtractedData;
      if (struct && typeof struct === "object") {
        if (struct.summaryInPreferredLanguage) {
          struct.summary = struct.summaryInPreferredLanguage;
        } else if (struct.summary) {
          try {
            const translated = await aiClient.translate(struct.summary, "english", prefLang);
            if (translated) {
              struct.summary = translated;
            }
          } catch (err) {
            console.warn("[executeAddDocumentAction] Summary translation failed:", err.message);
          }
        }
      }
    }
  }
  replyText = messageConstants.DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW({
    successfulCount: completedCount,
    totalCount: totalUploads,
    medicationCount: extractedMedicines.length,
    failedCount,
  });

  let activeSessionId = sessionId;
  if (!activeSessionId && isOnboardingCompleted) {
    const newSession = await chatService.createSession({
      userId,
      title: docResult?.document?.fileName || "Document Chat",
    });
    activeSessionId = newSession?.id || null;
  }

  if (userId && !isOnboardingCompleted) {
    const createdDocId =
      docResult?.document?.id ||
      (Array.isArray(docResult?.document) ? docResult.document[0]?.id : null);
    if (createdDocId) {
      try {
        const userOnboardingRepository = require("../repositories/userOnboardingRepository");
        const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
        if (onboardingRecord) {
          const updatedData = {
            ...(onboardingRecord.data || {}),
            documentId: createdDocId,
            flowMode: "UPLOAD",
            documentUploaded: true,
            uploadedMedicalDocument: true,
            documentAttachedToChat: true,
            documentConfirmed: true,
          };
          await userOnboardingRepository.updateByUserId(userId, { data: updatedData });
        }
      } catch (repoErr) {
        console.error("[executeAddDocumentAction] Failed to update onboarding record:", repoErr);
      }
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

  if (activeSessionId) {
    await chatSessionRepository.appendMessage({
      sessionId: activeSessionId,
      userId,
      role: "assistant",
      content: replyText,
      metadata: {
        mode: "ACTION",
        actionType: returnedActionType,
        documentId: docResult?.document?.id,
        document: docResult?.document,
        documentSummary,
        documentsName: batchDocumentsName,
        documentsStatus: documentsStatusList,
        documentStatus: primaryDocumentStatus,
        summary: mainDocumentSummaryText || docResult?.document?.summary || null,
        documents: documentsBatchList,
        medicines: extractedMedicines,
        suggestedAction,
        options,
      },
    });
  }

  return buildUnifiedResponse({
    mode: "ACTION",
    actionType: returnedActionType,
    reply: replyText,
    documentSummary,
    documentsName: batchDocumentsName,
    documentsStatus: documentsStatusList,
    documentStatus: primaryDocumentStatus,
    summary: mainDocumentSummaryText || docResult?.document?.summary || null,
    documents: documentsBatchList,
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
