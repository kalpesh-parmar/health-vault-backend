const { normalizeLanguage } = require("../utils/commonUtils");

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
    "અહેવાલ અપલોડ",
    "દસ્તાવેજ ઉમેરો",
    "रिपोर्ट अपलोड",
  ];

  // Medicine addition intent keywords
  const medicineKeywords = [
    "add medicine",
    "add medication",
    "new medicine",
    "add drug",
    "create medicine",
    "દવા ઉમેરો",
    "દવાઓ ઉમેરો",
    "दवा जोड़ें",
    "दवाई जोड़ें",
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
  const s3Key = actionData?.s3Key || actionData?.fileKey;
  const hasOcrData = Boolean(actionData?.rawOcrData || actionData?.extractedStructuredData);

  let docResult;
  let replyText;

  if (!hasOcrData && s3Key) {
    const fileName = actionData?.fileName || s3Key.split("/").pop();

    // Check if an existing OCR job already exists for this fileKey
    let existingJob = null;
    if (documentOcrJobService?.getStatus) {
      try {
        existingJob = await documentOcrJobService.getStatus({ fileKey: s3Key, userId });
      } catch {
        existingJob = null;
      }
    }

    if (existingJob && existingJob.status === "COMPLETED") {
      console.log(`[UnifiedChatHelper] Document already completed for s3Key=${s3Key}`);
      replyText = `Document '${fileName}' has already been processed and is ready in your Health Vault.`;
      docResult = {
        document: {
          id: existingJob.id,
          fileName,
          s3Key,
          ocrStatus: ocrStatusEnum?.COMPLETED || "completed",
        },
        job: existingJob,
      };
    } else if (
      existingJob &&
      (existingJob.status === "RUNNING" ||
        existingJob.status === "QUEUED" ||
        existingJob.status === "PROCESSING")
    ) {
      const pct = existingJob.percentage != null ? `${existingJob.percentage}%` : "in progress";
      console.log(
        `[UnifiedChatHelper] Document processing in progress for s3Key=${s3Key} (${pct})`,
      );
      replyText = `Document '${fileName}' OCR processing is currently ${pct} (Stage: ${existingJob.stage || "PROCESSING"}).`;
      docResult = {
        document: {
          id: existingJob.id,
          fileName,
          s3Key,
          ocrStatus: ocrStatusEnum?.IN_PROGRESS || "in_progress",
          percentage: existingJob.percentage,
          stage: existingJob.stage,
        },
        job: existingJob,
      };
    } else {
      console.log(`[UnifiedChatHelper] Enqueueing background OCR job for s3Key=${s3Key}`);
      const ext = s3Key.includes(".") ? s3Key.split(".").pop().toLowerCase() : "";
      const inferredMime =
        ext === "pdf"
          ? "application/pdf"
          : ext === "png"
            ? "image/png"
            : ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : "application/pdf";
      const mimeType = actionData?.mimeType || actionData?.fileType || inferredMime;

      const job = await documentOcrJobService.enqueue({
        fileKey: s3Key,
        mimeType,
        userId,
      });

      replyText = `Document '${fileName}' uploaded. OCR text extraction & vector indexing started in background.`;

      docResult = {
        document: {
          id: job.id,
          fileName,
          s3Key,
          ocrStatus: ocrStatusEnum?.IN_PROGRESS || "in_progress",
        },
        job,
      };
    }
  } else {
    docResult = await documentPersistenceService.addDocument({
      userId,
      payload: actionData,
    });

    replyText = docResult?.document?.fileName
      ? `Document '${docResult.document.fileName}' has been added to your Health Vault.`
      : "Document added successfully.";
  }

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
      metadata: { actionType: "ADD_DOCUMENT", documentId: docResult?.document?.id },
    });
  }

  return buildUnifiedResponse({
    mode: "ACTION",
    actionType: "ADD_DOCUMENT",
    reply: replyText,
    sessionId: activeSessionId,
    document: docResult.document,
  });
}

module.exports = {
  buildUnifiedResponse,
  detectActionIntent,
  executeAddDocumentAction,
  normalizeUnifiedChatInput,
};
