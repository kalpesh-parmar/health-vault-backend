const { env } = require("../configs/env");
const { db } = require("../configs/db");
// const { fileTypeValue } = require("../enums/fileType");
const { ocrStatus } = require("../enums/ocrStatus");
const {
  InvalidRequestException,
  NotFoundException,
  UnauthorizedException,
} = require("../exceptions/appError");
const { document } = require("../models/document");
const chatSessionRepository = require("../repositories/chatSessionRepository");
const documentRepository = require("../repositories/documentRepository");
const documentProcessingJobRepository = require("../repositories/documentProcessingJobRepository");
const patientRepository = require("../repositories/patientRepository");
const userOnboardingRepository = require("../repositories/userOnboardingRepository");
const authProviderRepository = require("../repositories/authProviderRepository");
const {
  onboardingService,
  canSkipOnboarding,
  saveOnboardingState,
  resolveOnboardingState,
} = require("./ai/chat/onboarding.service");
const { getNextRequiredOrOptionalStep } = require("./ai/chat/onboarding/onboardingStateMachine");
const { ocrService } = require("./ai/ocr/ocr.service");
const uploadFileService = require("./uploadFile.service");
const { getLocalizedText } = require("../helpers/onboarding.helper");
const { normalizeLanguage } = require("../utils/commonUtils");
const { normalizeCreateMedicationInput } = require("../helpers/medicineNormalize.helper");
const { messageConstants } = require("../constants/messageConstants");
const { errorConstants } = require("../constants/errorConstants");
const { inferFileType } = require("../helpers/document.helper");
const documentPersistenceService = require("./documentPersistence.service");
const documentOcrJobService = require("./documentOcrJob.service");
const medicationService = require("./medication.service");
const { chatService } = require("./ai/chat/chat.service");
const {
  buildUnifiedResponse,
  detectActionIntent,
  executeAddDocumentAction,
  normalizeUnifiedChatInput,
} = require("../helpers/unifiedChat.helper");
const { and, eq, desc, or } = require("drizzle-orm");
const { bloodGroupTypeValues } = require("../enums/bloodGroupType");
const { ToWords } = require("to-words");

function isStepAlreadySatisfied(stepName, state) {
  if (!stepName || !state) return false;
  if (state.isOnboardingCompleted === true && state.medicationFlowDone === true) return true;
  if (stepName === "ASK_BLOOD_GROUP") {
    return (
      state.bloodGroupSkipped === true ||
      (state.existingUserData?.bloodGroup !== undefined &&
        state.existingUserData?.bloodGroup !== null &&
        state.existingUserData?.bloodGroup !== "")
    );
  }
  if (stepName === "ASK_ALLERGIES") {
    return state.allergiesSkipped === true;
  }
  if (
    [
      "ASK_FIRST_NAME",
      "ASK_LAST_NAME",
      "ASK_DOB",
      "ASK_GENDER",
      "RESOLVE_PROFILE_SOURCE",
      "CONFIRM_DOCUMENT_OWNERSHIP",
      "ASK_UPLOAD_OR_SKIP",
    ].includes(stepName)
  ) {
    return state.profileConfirmed === true;
  }
  if (["MEDICINE_OPTIONS", "REVIEW_MEDICINES_LIST"].includes(stepName)) {
    return state.medicationFlowDone === true;
  }
  return false;
}

class V1Service {
  async ocrExtract(userId, file) {
    const startTime = Date.now();
    const requestId = Math.random().toString(36).substring(7);
    console.log(`[v1Controller] [${requestId}] Entry - async ocrExtract start. User ID: ${userId}`);

    try {
      if (!userId) {
        console.warn(`[v1Controller] [${requestId}] Exit - Unauthorized access attempt`);
        throw new UnauthorizedException(messageConstants.UNAUTHORIZED_ACCESS);
      }

      if (!file) {
        console.warn(`[v1Controller] [${requestId}] Exit - No file uploaded`);
        throw new InvalidRequestException(messageConstants.NO_FILE_UPLOAD);
      }

      console.log(
        `[v1Controller] [${requestId}] File Info: OriginalName=${file.originalname}, Size=${file.size} bytes, MimeType=${file.mimetype}`,
      );

      // 1. Upload and validate synchronously (fast, throws on non-medical document)
      const uploadResult = await uploadFileService.uploadFile(file, "PATIENT_DOCUMENT", userId);

      // 2. Create the document row with status = "in_progress" (maps to "processing")
      const fileKey = uploadResult.data.fileKey;
      const bucketName =
        uploadResult.data.s3Bucket ||
        (env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName);

      const [documentRow] = await db
        .insert(document)
        .values({
          userId,
          documentType: "medical_document",
          fileName: uploadResult.data.originalFileName,
          //optional fileName from given by user
          s3Bucket: bucketName,
          s3Key: fileKey,
          fileType: inferFileType(uploadResult.data.mimeType),
          fileSize: uploadResult.data.fileSize,
          ocrStatus: ocrStatus.IN_PROGRESS,
        })
        .returning();

      // 3. Fire-and-forget background pipeline
      setImmediate(() => {
        ocrService
          .processAndStoreAsynchronously({
            documentId: documentRow.id,
            file: file,
            userId,
            uploadResult,
          })
          .catch((err) => {
            console.error(
              `[v1Controller] [${requestId}] Background pipeline error for doc ${documentRow.id}:`,
              err,
            );
          });
      });

      const duration = Date.now() - startTime;
      console.log(
        `[v1Controller] [${requestId}] Exit - async ocrExtract start success. Duration: ${duration}ms`,
      );

      return {
        document: {
          id: documentRow.id,
          fileName: documentRow.fileName,
          fileType: documentRow.fileType,
          fileSize: documentRow.fileSize,
          ocrStatus: documentRow.ocrStatus,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(
        `[v1Controller] [${requestId}] OCR Extract initiation failed after ${duration}ms:`,
        error,
      );
      if (error.stack) {
        console.error(`[v1Controller] [${requestId}] Error stack trace:`, error.stack);
      }
      throw error;
    }
  }

  async getOcrStatus(userId, documentId) {
    if (!userId) {
      throw new UnauthorizedException("Unauthorized access");
    }

    if (!documentId) {
      throw new InvalidRequestException("documentId is required");
    }

    const docRow = await documentRepository.findById(documentId);

    if (!docRow || String(docRow.userId) !== String(userId)) {
      throw new NotFoundException("Document not found");
    }

    let status = "processing";
    if (docRow.ocrStatus === "completed") {
      status = "done";
    } else if (docRow.ocrStatus === "failed") {
      status = "failed";
    }

    let structData = docRow.structuredExtractedData;
    if (typeof structData === "string") {
      try {
        structData = JSON.parse(structData);
      } catch {
        structData = {};
      }
    }
    const summary =
      docRow.summaryInPreferredLanguage ||
      docRow.summaryEnglish ||
      structData?.summaryEnglish ||
      structData?.summary ||
      structData?.remarks ||
      "";

    return {
      documentId: docRow.id,
      status,
      summary,
      document: {
        id: docRow.id,
        fileName: docRow.fileName,
        fileType: docRow.fileType,
        fileSize: docRow.fileSize,
        ocrStatus: docRow.ocrStatus,
        ocrExtractedText: docRow.ocrExtractedText,
      },
      structuredData: docRow.structuredExtractedData || {},
    };
  }

  async cancelOcr(userId, documentId) {
    if (!userId || !documentId) {
      throw new InvalidRequestException("Missing parameters");
    }

    const identifier = String(documentId);
    const isUuid =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        identifier,
      );

    let targetDocId = isUuid ? identifier : null;
    let targetFileKey = !isUuid ? identifier : null;

    // 1. Resolve from document table
    const condition = isUuid
      ? or(eq(document.id, identifier), eq(document.s3Key, identifier))
      : eq(document.s3Key, identifier);

    const [foundDoc] = await db
      .select({ id: document.id, s3Key: document.s3Key })
      .from(document)
      .where(and(condition, eq(document.userId, userId)));

    if (foundDoc) {
      targetDocId = foundDoc.id;
      targetFileKey = foundDoc.s3Key;
    }

    // 2. Resolve from documentProcessingJob table if needed
    const jobRow = await documentProcessingJobRepository
      .findByFileKey(targetFileKey || identifier, userId)
      .catch(() => null);

    const targetJobId = isUuid && !foundDoc ? identifier : jobRow?.id;
    if (jobRow) {
      if (!targetFileKey) targetFileKey = jobRow.fileKey;
      if (!targetDocId && targetFileKey) {
        const [docByFileKey] = await db
          .select({ id: document.id, s3Key: document.s3Key })
          .from(document)
          .where(and(eq(document.s3Key, targetFileKey), eq(document.userId, userId)));
        if (docByFileKey) {
          targetDocId = docByFileKey.id;
        }
      }
    }

    // 3. Update document table
    if (targetDocId || targetFileKey) {
      const docWhere = targetDocId
        ? and(eq(document.id, targetDocId), eq(document.userId, userId))
        : and(eq(document.s3Key, targetFileKey), eq(document.userId, userId));

      await db
        .update(document)
        .set({
          ocrStatus: ocrStatus.CANCELED,
          remarks: "ERR_CODE:USER_CANCELLED",
          updatedAt: new Date(),
        })
        .where(docWhere);
    }

    // 4. Update documentProcessingJob table
    if (targetJobId) {
      await documentProcessingJobRepository
        .checkpointStage(targetJobId, {
          status: "CANCELLED",
          stageStatus: "CANCELLED",
          stage: "CANCELLED",
          message: "Job cancelled by user",
          completedAt: new Date(),
        })
        .catch(() => null);
    }

    // 5. Abort active in-memory background OCR task
    if (targetDocId) ocrService.cancelJob(targetDocId);
    if (targetFileKey) ocrService.cancelJob(targetFileKey);
    if (targetJobId) ocrService.cancelJob(targetJobId);
    if (identifier) ocrService.cancelJob(identifier);

    return { message: "Job cancelled successfully" };
  }

  async onboardingChat(userId, body, onChunk = null, abortSignal = null) {
    const requestReceivedTime = Date.now();
    console.log(
      `[UnifiedChat] Request received at ${new Date(requestReceivedTime).toISOString()} for userId=${userId}`,
    );

    try {
      if (!userId) {
        throw new UnauthorizedException("Unauthorized access");
      }

      const normalizedInput = normalizeUnifiedChatInput(body);
      const {
        actionType,
        actionData,
        message,
        sessionId,
        documentId,
        state: inputState,
        history,
        displayLabel,
        preferredLanguage,
      } = normalizedInput;
      console.log("[MEDICINES]===", normalizedInput.message);

      // Fetch user profile and existing onboarding state using unified state resolver
      const patient = await patientRepository.findById(userId);
      const { state: dbState } = await resolveOnboardingState(userId, { chatSessionId: sessionId });
      if (patient) {
        if (!dbState.existingUserData) dbState.existingUserData = {};
        if (patient.bloodGroup && !dbState.existingUserData.bloodGroup) {
          dbState.existingUserData.bloodGroup = patient.bloodGroup;
        }
        if (
          Array.isArray(patient.allergies) &&
          patient.allergies.length > 0 &&
          (!dbState.existingUserData.allergies || dbState.existingUserData.allergies.length === 0)
        ) {
          dbState.existingUserData.allergies = patient.allergies;
        }
      }
      const isOnboardingCompleted =
        patient?.onboardingCompleted ||
        patient?.isOnboardingCompleted ||
        dbState?.isOnboardingCompleted === true ||
        dbState?.currentStep === "COMPLETE" ||
        dbState?.currentStep === "POST_ONBOARDING" ||
        inputState?.isOnboardingCompleted === true ||
        inputState?.currentStep === "COMPLETE" ||
        inputState?.currentStep === "POST_ONBOARDING";

      console.log(
        `[ONBOARDING PROFILE LOG] User ID: ${userId} | Patient DB Record: firstName="${patient?.firstName || ""}", lastName="${patient?.lastName || ""}", email="${patient?.email || ""}"`,
      );

      // Resolve canonical session ID for the patient
      let effectiveSessionId =
        sessionId || inputState?.chatSessionId || dbState?.chatSessionId || null;
      if (!effectiveSessionId && userId) {
        try {
          if (chatService && typeof chatService.getOrCreateCanonicalSession === "function") {
            const canonical = await chatService.getOrCreateCanonicalSession({ userId });
            effectiveSessionId = canonical?.id || null;
          }
        } catch (sErr) {
          console.warn("[UnifiedChat] Failed to get or create canonical session:", sErr.message);
        }
      }

      // CASE 1: ADD_DOCUMENT ACTION
      if (actionType === "ADD_DOCUMENT") {
        console.log(`[UnifiedChat] Executing ADD_DOCUMENT action for userId=${userId}`);
        const userPrefLang =
          patient?.preferredLanguage ||
          inputState?.preferredLanguage ||
          dbState?.preferredLanguage ||
          "english";
        return executeAddDocumentAction({
          userId,
          actionData,
          sessionId: effectiveSessionId,
          preferredLanguage: userPrefLang,
          isOnboardingCompleted,
          documentPersistenceService,
          documentOcrJobService,
          chatService,
          chatSessionRepository,
          ocrStatusEnum: ocrStatus,
        });
      }

      const cleanedInputState =
        inputState && typeof inputState === "object"
          ? Object.fromEntries(
              Object.entries(inputState).filter(([_, v]) => v !== null && v !== undefined),
            )
          : {};

      let isAddMedicineMsg = false;
      if (message || actionType === "ADD_MEDICINE") {
        try {
          const parsedMsg = typeof message === "string" ? JSON.parse(message) : message;
          if (
            parsedMsg &&
            (parsedMsg.key === "ADD" ||
              parsedMsg.value === "ADD" ||
              parsedMsg.action === "ADD" ||
              parsedMsg.actionType === "ADD_MEDICINE" ||
              parsedMsg.addNew === true)
          ) {
            isAddMedicineMsg = true;
          }
        } catch {
          // Ignore JSON parse error
        }

        const msgStr = String(message || "")
          .trim()
          .toUpperCase();
        const actStr = String(actionType || "")
          .trim()
          .toUpperCase();

        if (
          actStr === "ADD_MEDICINE" ||
          msgStr === "ADD" ||
          msgStr === "ADD_NEW" ||
          msgStr.includes("ADD ANOTHER MEDICINE") ||
          msgStr.includes("ADD MEDICINE") ||
          msgStr.includes("ADD NEW")
        ) {
          isAddMedicineMsg = true;
        }
      }

      const isAddingMedicine =
        actionType === "ADD_MEDICINE" ||
        actionType === "SAVE_AND_REVIEW" ||
        isAddMedicineMsg ||
        cleanedInputState.currentStep === "ADD_MEDICINE" ||
        cleanedInputState.currentStep === "REVIEW_MEDICINES_LIST";

      const authoritativeIsOnboardingCompleted =
        dbState?.isOnboardingCompleted === true || cleanedInputState.isOnboardingCompleted === true;
      const authoritativeHasSkipped =
        dbState?.hasSkipped === true || cleanedInputState.hasSkipped === true;
      const authoritativeMedicationFlowDone = isAddingMedicine
        ? false
        : dbState?.medicationFlowDone === true || cleanedInputState.medicationFlowDone === true;
      const authoritativeMedicinesConfirmed = isAddingMedicine
        ? false
        : dbState?.medicinesConfirmed === true || cleanedInputState.medicinesConfirmed === true;
      const authoritativeProfileConfirmed =
        dbState?.profileConfirmed === true || cleanedInputState.profileConfirmed === true;
      const authoritativeBloodGroupSkipped =
        dbState?.bloodGroupSkipped === true || cleanedInputState.bloodGroupSkipped === true;
      const authoritativeAllergiesSkipped =
        dbState?.allergiesSkipped === true || cleanedInputState.allergiesSkipped === true;
      const authoritativeCompletionMessageSent =
        dbState?.completionMessageSent === true || cleanedInputState.completionMessageSent === true;
      const authoritativeCompletionMessageId =
        dbState?.completionMessageId || cleanedInputState.completionMessageId || null;

      let authoritativeStep = dbState?.currentStep || cleanedInputState.currentStep || null;
      if (cleanedInputState.currentStep && dbState?.currentStep) {
        if (isStepAlreadySatisfied(cleanedInputState.currentStep, dbState)) {
          authoritativeStep = dbState.currentStep;
        } else {
          authoritativeStep = cleanedInputState.currentStep;
        }
      }

      let effectiveMedicinesToAdd =
        cleanedInputState.medicinesToAdd || dbState?.medicinesToAdd || [];
      if (isAddingMedicine && Array.isArray(effectiveMedicinesToAdd)) {
        effectiveMedicinesToAdd = effectiveMedicinesToAdd.filter((m) => !m.isSaved && !m.dbId);
      }

      const effectiveState = {
        ...(dbState || {}),
        ...cleanedInputState,
        isOnboardingCompleted: authoritativeIsOnboardingCompleted,
        hasSkipped: authoritativeHasSkipped,
        medicationFlowDone: authoritativeMedicationFlowDone,
        medicinesConfirmed: authoritativeMedicinesConfirmed,
        profileConfirmed: authoritativeProfileConfirmed,
        bloodGroupSkipped: authoritativeBloodGroupSkipped,
        allergiesSkipped: authoritativeAllergiesSkipped,
        completionMessageSent: authoritativeCompletionMessageSent,
        ...(Array.isArray(effectiveMedicinesToAdd)
          ? { medicinesToAdd: effectiveMedicinesToAdd }
          : {}),
        ...(authoritativeCompletionMessageId
          ? { completionMessageId: authoritativeCompletionMessageId }
          : {}),
        ...(authoritativeStep ? { currentStep: authoritativeStep } : {}),
      };

      let isMedicineSelectionMsg = false;
      if (message) {
        try {
          const parsedMsg = typeof message === "string" ? JSON.parse(message) : message;
          if (
            parsedMsg &&
            (parsedMsg.selected !== undefined ||
              parsedMsg.action === "CONFIRM" ||
              parsedMsg.value === "CONFIRM" ||
              parsedMsg.value === "CONFIRM_SELECTED")
          ) {
            isMedicineSelectionMsg = true;
          }
        } catch {
          const upper = String(message).trim().toUpperCase();
          if (upper === "CONFIRM" || upper === "CONFIRM_SELECTED") {
            isMedicineSelectionMsg = true;
          }
        }
      }

      const parsedMsgObj = (() => {
        try {
          return typeof message === "string" ? JSON.parse(message) : message;
        } catch {
          return null;
        }
      })();

      const hasMedicineActionData = Boolean(
        (actionData &&
          typeof actionData === "object" &&
          (actionData.name ||
            actionData.medicationName ||
            actionData.medicine ||
            actionData.medicines ||
            actionData.dose ||
            actionData.frequency)) ||
        (parsedMsgObj &&
          typeof parsedMsgObj === "object" &&
          (parsedMsgObj.name ||
            parsedMsgObj.medicationName ||
            parsedMsgObj.medicine ||
            parsedMsgObj.medicines ||
            parsedMsgObj.dose ||
            parsedMsgObj.frequency)),
      );

      let currentOnboardingStep = effectiveState?.currentStep || null;
      const hasUnconfirmedMedicines =
        !isOnboardingCompleted &&
        Array.isArray(effectiveState?.medicinesToAdd) &&
        effectiveState.medicinesToAdd.length > 0 &&
        effectiveState?.medicinesConfirmed !== true;

      const isReportActionMsg =
        message === "ASK_REPORT" ||
        message === "ASK_ABOUT_REPORT" ||
        actionType === "ASK_REPORT" ||
        actionType === "ASK_ABOUT_REPORT";

      if (isReportActionMsg) {
        currentOnboardingStep = "ASK_REPORT";
        effectiveState.currentStep = "ASK_REPORT";
        effectiveState.medicinesConfirmed = true;
        effectiveState.medicationFlowDone = true;
      } else if (isAddMedicineMsg) {
        currentOnboardingStep = "ADD_MEDICINE";
        effectiveState.currentStep = "ADD_MEDICINE";
      } else if (
        actionType === "SAVE_AND_REVIEW" ||
        actionType === "REVIEW_MEDICINES_LIST" ||
        isMedicineSelectionMsg ||
        (!currentOnboardingStep && hasUnconfirmedMedicines)
      ) {
        currentOnboardingStep = "REVIEW_MEDICINES_LIST";
        effectiveState.currentStep = "REVIEW_MEDICINES_LIST";
      }

      const isMedicineAction =
        actionType === "CONFIRM_MEDICINES" ||
        actionType === "SAVE_AND_REVIEW" ||
        actionType === "SKIP_MEDICINES" ||
        actionType === "REVIEW_MEDICINES_LIST" ||
        actionType === "SHOW_EXTRACTED_MEDICINES" ||
        isMedicineSelectionMsg ||
        isAddMedicineMsg ||
        hasMedicineActionData ||
        (actionData && Array.isArray(actionData.medicines) && actionData.medicines.length > 0);

      const isActiveOnboardingStep =
        !isOnboardingCompleted &&
        ((Boolean(currentOnboardingStep) &&
          currentOnboardingStep !== "COMPLETE" &&
          currentOnboardingStep !== "POST_ONBOARDING") ||
          isMedicineAction ||
          isAddMedicineMsg ||
          hasUnconfirmedMedicines);

      if (isMedicineAction) {
        console.log(
          `[UnifiedChat] Executing medicine action '${actionType}' for userId=${userId} (isActiveOnboardingStep=${isActiveOnboardingStep})`,
        );

        const isSkipAction =
          actionType === "SKIP_MEDICINES" ||
          String(message || "").toUpperCase() === "SKIP" ||
          actionData?.skipAll === true;

        if (isSkipAction && !isActiveOnboardingStep) {
          let reportSummaryPayload = null;
          let actionsPayload = null;

          if (userId) {
            try {
              const pendingSum =
                dbState?.pendingReportSummary || effectiveState?.pendingReportSummary;
              if (pendingSum && pendingSum.status !== "DELIVERED") {
                reportSummaryPayload = { ...pendingSum };
                delete reportSummaryPayload.status;

                actionsPayload = [
                  {
                    actionType: "REPORT_SUMMARY",
                    reportSummary: reportSummaryPayload,
                  },
                ];

                const updatedState = {
                  ...(dbState || {}),
                  ...(effectiveState || {}),
                  pendingReportSummary: {
                    ...pendingSum,
                    status: "DELIVERED",
                  },
                };
                await userOnboardingRepository.updateByUserId(userId, { data: updatedState });
              }
            } catch (skipErr) {
              console.warn(
                "[UnifiedChat] Failed to build report summary on skip:",
                skipErr.message,
              );
            }
          }

          const docSummaryObj = reportSummaryPayload
            ? {
                totalUploads: 1,
                completed: 1,
                failed: 0,
                rejected: 0,
                summary: reportSummaryPayload.summary || null,
                text: messageConstants.DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW({
                  successfulCount: 1,
                  totalCount: 1,
                  medicationCount: 0,
                  failedCount: 0,
                }),
              }
            : null;

          const replyText = messageConstants.MEDICATIONS_REVIEW_SKIPPED;
          const activeSessionId = effectiveSessionId;

          if (activeSessionId) {
            await chatSessionRepository.appendMessage({
              sessionId: activeSessionId,
              userId,
              role: "assistant",
              content: replyText,
              metadata: {
                actionType: "SKIP_MEDICINES",
                actions: actionsPayload,
                reportSummary: reportSummaryPayload,
                documentSummary: docSummaryObj,
              },
            });
          }

          return buildUnifiedResponse({
            mode: "ACTION",
            actionType: "SKIP_MEDICINES",
            reply: replyText,
            sessionId: activeSessionId,
            actions: actionsPayload,
            reportSummary: reportSummaryPayload,
            documentSummary: docSummaryObj,
          });
        }

        let historyMedsForAdd = null;
        if (isAddMedicineMsg && !hasMedicineActionData && effectiveSessionId) {
          try {
            const recentMsgs = await chatSessionRepository.listMessages(effectiveSessionId);
            if (Array.isArray(recentMsgs)) {
              for (const m of recentMsgs) {
                if (
                  m?.metadata &&
                  Array.isArray(m.metadata.medicines) &&
                  m.metadata.medicines.length > 0
                ) {
                  historyMedsForAdd = m.metadata.medicines;
                  break;
                }
              }
            }
          } catch (hErr) {
            console.warn(
              "[UnifiedChat] Failed to check recent message metadata for ADD_MEDICINE:",
              hErr.message,
            );
          }
        }
        const hasEffectiveMedicineData =
          hasMedicineActionData ||
          (Array.isArray(historyMedsForAdd) && historyMedsForAdd.length > 0);

        if (isAddMedicineMsg && !hasEffectiveMedicineData && !isActiveOnboardingStep) {
          let activeSessionId = effectiveSessionId;
          if (!activeSessionId && userId) {
            try {
              if (chatService && typeof chatService.getOrCreateCanonicalSession === "function") {
                const canonical = await chatService.getOrCreateCanonicalSession({ userId });
                activeSessionId = canonical?.id || null;
              }
            } catch (sErr) {
              console.warn(
                "[UnifiedChat] Failed to get canonical session for ADD_MEDICINE:",
                sErr.message,
              );
            }
          }

          const userPrefLang =
            patient?.preferredLanguage ||
            inputState?.preferredLanguage ||
            dbState?.preferredLanguage ||
            "english";

          const replyPrompt = await getLocalizedText(
            "onboarding.addMedicine.messageNew",
            "Please enter the new medication details:",
            userPrefLang,
          );

          if (activeSessionId) {
            let userContent = displayLabel;
            if (
              !userContent ||
              (typeof userContent === "string" &&
                (userContent.trim().startsWith("{") || userContent.trim().startsWith("[")))
            ) {
              userContent =
                typeof message === "string" &&
                !message.trim().startsWith("{") &&
                message.trim().length > 0
                  ? message
                  : await getLocalizedText(
                      "onboarding.medicineOptions.addMedicines",
                      "Add Medicines",
                      userPrefLang,
                    );
            }

            // Turn 1: User "Add Medicines"
            await chatSessionRepository.appendMessage({
              sessionId: activeSessionId,
              userId,
              role: "user",
              content: userContent,
              metadata: {
                action: "ADD_MEDICINE",
                actionType: "ADD_MEDICINE",
                rawValue: message || actionType,
              },
            });

            // Turn 2: Assistant ADD_MEDICINE prompt
            await chatSessionRepository.appendMessage({
              sessionId: activeSessionId,
              userId,
              role: "assistant",
              content: replyPrompt,
              metadata: {
                mode: "ACTION",
                action: "ADD_MEDICINE",
                actionType: "ADD_MEDICINE",
                options: [{ label: "Cancel", value: "CANCEL", actionType: "CANCEL" }],
              },
            });
          }

          return buildUnifiedResponse({
            mode: "ACTION",
            actionType: "ADD_MEDICINE",
            reply: replyPrompt,
            sessionId: activeSessionId,
            options: [{ label: "Cancel", value: "CANCEL", actionType: "CANCEL" }],
          });
        }

        if (actionType === "SAVE_AND_REVIEW") {
          let activeSessionId = effectiveSessionId;
          if (!activeSessionId && userId) {
            try {
              if (chatService && typeof chatService.getOrCreateCanonicalSession === "function") {
                const canonical = await chatService.getOrCreateCanonicalSession({ userId });
                activeSessionId = canonical?.id || null;
              }
            } catch (sErr) {
              console.warn(
                "[UnifiedChat] Failed to get canonical session for SAVE_AND_REVIEW:",
                sErr.message,
              );
            }
          }

          let reviewMeds =
            Array.isArray(actionData?.medicines) && actionData.medicines.length > 0
              ? actionData.medicines
              : actionData?.medicine
                ? [actionData.medicine]
                : effectiveState?.medicinesToAdd || [];

          if (userId && Array.isArray(reviewMeds) && reviewMeds.length > 0) {
            try {
              reviewMeds = await medicationService.checkDuplicateMedicationsBatch(
                userId,
                reviewMeds,
              );
            } catch (dupErr) {
              console.warn(
                "[UnifiedChat] Duplicate check warning in SAVE_AND_REVIEW:",
                dupErr.message,
              );
            }
          }

          if (!isActiveOnboardingStep) {
            const userLang =
              preferredLanguage ||
              patient?.preferredLanguage ||
              effectiveState?.preferredLanguage ||
              "english";
            const reviewPrompt = await getLocalizedText(
              "onboarding.reviewMedicinesList.reviewPrompt",
              "Please review your medicines:",
              userLang,
            );

            if (activeSessionId) {
              let userSaveContent = displayLabel;
              if (
                !userSaveContent ||
                (typeof userSaveContent === "string" &&
                  (userSaveContent.trim().startsWith("{") ||
                    userSaveContent.trim().startsWith("[")))
              ) {
                userSaveContent =
                  typeof message === "string" &&
                  !message.trim().startsWith("{") &&
                  message.trim().length > 0
                    ? message
                    : await getLocalizedText(
                        "onboarding.addMedicine.saveMedicines",
                        "Save Medicines",
                        userLang,
                      );
              }

              // Turn 3: User "Save Medicines"
              await chatSessionRepository.appendMessage({
                sessionId: activeSessionId,
                userId,
                role: "user",
                content: userSaveContent,
                metadata: {
                  action: "SAVE_AND_REVIEW",
                  actionType: "SAVE_AND_REVIEW",
                  rawValue: actionData || { action: "SAVE_AND_REVIEW", medicines: reviewMeds },
                },
              });

              // Turn 4: Assistant REVIEW_MEDICINES_LIST
              await chatSessionRepository.appendMessage({
                sessionId: activeSessionId,
                userId,
                role: "assistant",
                content: reviewPrompt,
                metadata: {
                  mode: "ACTION",
                  actionType: "REVIEW_MEDICINES_LIST",
                  action: "REVIEW_MEDICINES_LIST",
                  medicines: reviewMeds,
                },
              });
            }

            return buildUnifiedResponse({
              mode: "ACTION",
              actionType: "REVIEW_MEDICINES_LIST",
              reply: reviewPrompt,
              medicines: reviewMeds,
              sessionId: activeSessionId,
              onboardingState: {
                ...effectiveState,
                currentStep: "REVIEW_MEDICINES_LIST",
                medicinesToAdd: reviewMeds,
                isOnboardingCompleted: true,
              },
            });
          }

          // Pre-onboarding: pure in-memory state transition to REVIEW_MEDICINES_LIST without DB writes
          const stateToUpdate = { ...effectiveState };
          stateToUpdate.currentStep = "REVIEW_MEDICINES_LIST";
          stateToUpdate.medicinesConfirmed = false;
          stateToUpdate.medicinesSavedToDb = false;
          stateToUpdate.medicationFlowDone = false;
          let cleanedReviewMeds = (reviewMeds || []).filter((m) => !m.isSaved && !m.dbId);
          if (userId && Array.isArray(cleanedReviewMeds) && cleanedReviewMeds.length > 0) {
            try {
              cleanedReviewMeds = await medicationService.checkDuplicateMedicationsBatch(
                userId,
                cleanedReviewMeds,
              );
            } catch (dupErr) {
              console.warn(
                "[UnifiedChat] Duplicate check warning in pre-onboarding SAVE_AND_REVIEW:",
                dupErr.message,
              );
            }
          }
          stateToUpdate.medicinesToAdd = cleanedReviewMeds;

          const onboardingResult = await onboardingService.chat(
            message || actionData || "",
            history,
            stateToUpdate,
            userId,
            null,
            displayLabel,
          );

          const responsePayload = buildUnifiedResponse({
            mode: "ONBOARDING",
            actionType: onboardingResult?.action || "REVIEW_MEDICINES_LIST",
            reply: onboardingResult?.message || onboardingResult?.reply || "",
            onboardingState: onboardingResult?.state || stateToUpdate,
            options: onboardingResult?.options || [],
            medicines: onboardingResult?.medicines || onboardingResult?.state?.medicinesToAdd || [],
            sessionId: effectiveSessionId,
            actions: onboardingResult?.actions || null,
            reportSummary: onboardingResult?.reportSummary || null,
          });
          if (onboardingResult?.completionMessage) {
            responsePayload.completionMessage = onboardingResult.completionMessage;
            responsePayload.completionMessageId = onboardingResult.completionMessageId;
            responsePayload.completionAction = onboardingResult.completionAction;
          }
          responsePayload.canSkip =
            onboardingResult?.canSkip !== undefined
              ? onboardingResult.canSkip
              : canSkipOnboarding(onboardingResult?.state || stateToUpdate);
          return responsePayload;
        }

        let createdMeds = [];
        let medsToProcess =
          Array.isArray(actionData?.medicines) && actionData.medicines.length > 0
            ? actionData.medicines
            : Array.isArray(body?.medicines) && body.medicines.length > 0
              ? body.medicines
              : null;

        let isAddNewMsg = actionType === "ADD_MEDICINE";

        // Parse message if sent as structured object
        if (!medsToProcess && typeof message === "object" && message !== null) {
          if (Array.isArray(message.medicines) && message.medicines.length > 0) {
            medsToProcess = message.medicines;
          } else if (message.medicine && typeof message.medicine === "object") {
            medsToProcess = [message.medicine];
          } else if (Array.isArray(message.selected) && message.selected.length > 0) {
            medsToProcess = message.selected.map((sItem) =>
              typeof sItem === "object" ? sItem : { id: sItem, selected: true },
            );
          }
          if (message.addNew) {
            isAddNewMsg = true;
          }
        }

        // Check actionData.selected
        if (
          !medsToProcess &&
          Array.isArray(actionData?.selected) &&
          actionData.selected.length > 0
        ) {
          medsToProcess = actionData.selected.map((sItem) =>
            typeof sItem === "object" ? sItem : { id: sItem, selected: true },
          );
        }

        // Parse message JSON string if payload sent in message body
        if (!medsToProcess && typeof message === "string" && message.trim().startsWith("{")) {
          try {
            const parsedMsg = JSON.parse(message);
            if (Array.isArray(parsedMsg?.medicines) && parsedMsg.medicines.length > 0) {
              medsToProcess = parsedMsg.medicines;
            } else if (parsedMsg?.medicine && typeof parsedMsg.medicine === "object") {
              medsToProcess = [parsedMsg.medicine];
            } else if (Array.isArray(parsedMsg?.selected) && parsedMsg.selected.length > 0) {
              medsToProcess = parsedMsg.selected.map((sItem) =>
                typeof sItem === "object" ? sItem : { id: sItem, selected: true },
              );
            }
            if (parsedMsg?.addNew) {
              isAddNewMsg = true;
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Post-onboarding metadata fallback: if medsToProcess is still empty, check chat history metadata
        if ((!medsToProcess || medsToProcess.length === 0) && effectiveSessionId) {
          try {
            const recentMsgs = await chatSessionRepository.listMessages(effectiveSessionId);
            if (Array.isArray(recentMsgs)) {
              for (const m of recentMsgs) {
                if (
                  m?.metadata &&
                  Array.isArray(m.metadata.medicines) &&
                  m.metadata.medicines.length > 0
                ) {
                  medsToProcess = m.metadata.medicines;
                  break;
                }
              }
            }
          } catch (msgHistErr) {
            console.warn(
              "[UnifiedChat] Failed to recover medicines from chat metadata:",
              msgHistErr.message,
            );
          }
        }

        // Post-onboarding fallback: if confirming post-onboarding document medications and medsToProcess is still empty
        if (
          !isActiveOnboardingStep &&
          (!medsToProcess || medsToProcess.length === 0) &&
          userId &&
          (actionType === "CONFIRM_MEDICINES" ||
            actionType === "REVIEW_MEDICINES_LIST" ||
            String(message || "").toUpperCase() === "CONFIRM" ||
            String(message || "").toUpperCase() === "CONFIRM_SELECTED")
        ) {
          try {
            const [latestDoc] = await db
              .select()
              .from(document)
              .where(and(eq(document.userId, userId), eq(document.ocrStatus, "completed")))
              .orderBy(desc(document.createdAt))
              .limit(1);

            if (latestDoc && latestDoc.structuredExtractedData) {
              const struct = latestDoc.structuredExtractedData;
              const extracted = struct.medications || struct.structuredData?.medications || [];
              if (Array.isArray(extracted) && extracted.length > 0) {
                medsToProcess = extracted.map((m, idx) => ({
                  id: m.id || m.client_med_id || `doc_med_${idx}`,
                  name: m.name || m.medicationName || "Medical Document Medicine",
                  medicationName: m.name || m.medicationName || "Medical Document Medicine",
                  medicationType: String(m.type || m.medicationType || "TABLET").toUpperCase(),
                  type: String(m.type || m.medicationType || "TABLET").toUpperCase(),
                  dosePerIntake: m.dosage ? parseFloat(m.dosage) || 1 : 1,
                  frequency: m.frequency || "ONCE",
                  duration: m.duration || null,
                  instructions: m.instructions || m.timing || null,
                  selected: true,
                }));
              }
            }
          } catch (docLookupErr) {
            console.warn(
              "[UnifiedChat] Post-onboarding document lookup warning:",
              docLookupErr.message,
            );
          }
        }

        const isConfirmAction =
          actionType === "CONFIRM_MEDICINES" ||
          actionType === "ADD_MEDICINE" ||
          isAddNewMsg ||
          String(message || "").toUpperCase() === "CONFIRM" ||
          String(message || "").toUpperCase() === "CONFIRM_SELECTED" ||
          (Array.isArray(medsToProcess) && medsToProcess.length > 0);

        if (isConfirmAction && Array.isArray(medsToProcess) && medsToProcess.length > 0) {
          // Pre-resolve document medications if missing medicationName
          for (let i = 0; i < medsToProcess.length; i++) {
            let medData =
              typeof medsToProcess[i] === "object" && medsToProcess[i] !== null
                ? { ...medsToProcess[i] }
                : { id: medsToProcess[i], selected: true };

            if (!medData.name && !medData.medicationName && userId) {
              try {
                const [latestDoc] = await db
                  .select()
                  .from(document)
                  .where(and(eq(document.userId, userId), eq(document.ocrStatus, "completed")))
                  .orderBy(desc(document.createdAt))
                  .limit(1);

                if (latestDoc && latestDoc.structuredExtractedData) {
                  const struct = latestDoc.structuredExtractedData;
                  const docMeds = struct.medications || struct.structuredData?.medications || [];
                  const matchId =
                    typeof medsToProcess[i] === "string"
                      ? medsToProcess[i]
                      : medData.id || medData.client_med_id;
                  const foundInDoc = docMeds.find(
                    (m, idx) =>
                      m.id === matchId ||
                      m.client_med_id === matchId ||
                      `extracted_med_${idx + 1}` === matchId ||
                      `doc_med_${idx}` === matchId,
                  );

                  if (foundInDoc) {
                    medData = {
                      ...foundInDoc,
                      ...medData,
                      name:
                        foundInDoc.name || foundInDoc.medicationName || "Medical Document Medicine",
                      medicationName:
                        foundInDoc.name || foundInDoc.medicationName || "Medical Document Medicine",
                      medicationType: String(
                        foundInDoc.type || foundInDoc.medicationType || "TABLET",
                      ).toUpperCase(),
                      type: String(
                        foundInDoc.type || foundInDoc.medicationType || "TABLET",
                      ).toUpperCase(),
                      dosePerIntake: foundInDoc.dosage ? parseFloat(foundInDoc.dosage) || 1 : 1,
                      frequency: foundInDoc.frequency || "ONCE",
                      duration: foundInDoc.duration || null,
                      instructions: foundInDoc.instructions || foundInDoc.timing || null,
                    };
                  }
                }
              } catch (lookupErr) {
                console.warn("[UnifiedChat] Document lookup for med ID failed:", lookupErr.message);
              }
            }

            if (!medData.name && !medData.medicationName) {
              const matchIdStr = String(medData.id || "");
              if (matchIdStr.startsWith("extracted_med_") || matchIdStr.startsWith("doc_med_")) {
                medData.name = "Medical Document Medicine";
                medData.medicationName = "Medical Document Medicine";
              }
            }

            medsToProcess[i] = normalizeCreateMedicationInput(medData);
          }

          const bulkResult = await medicationService.bulkCreate(userId, medsToProcess);
          const rawCreated = bulkResult?.created || bulkResult || [];
          createdMeds = rawCreated.map((m) => ({
            ...m,
            name: m.name || m.medicationName,
            medicationName: m.medicationName || m.name,
          }));
        } else if (isConfirmAction && hasMedicineActionData) {
          const bulkResult = await medicationService.bulkCreate(userId, [
            normalizeCreateMedicationInput(actionData),
          ]);
          const rawCreated = bulkResult?.created || bulkResult || [];
          createdMeds = rawCreated.map((m) => ({
            ...m,
            name: m.name || m.medicationName,
            medicationName: m.medicationName || m.name,
          }));
        }
        const createdMed = createdMeds[0] || null;

        // If patient is in active Onboarding medicine loop, update state and advance onboarding
        if (isActiveOnboardingStep) {
          const stateToUpdate = { ...effectiveState };
          if (!stateToUpdate.medicinesToAdd) stateToUpdate.medicinesToAdd = [];

          if (isConfirmAction) {
            stateToUpdate.medicinesConfirmed = true;
            stateToUpdate.medicinesSavedToDb = true;
            stateToUpdate.medicationFlowDone = true;
            stateToUpdate.medicinesToAdd = [];
            stateToUpdate.currentStep = "MEDICINE_OPTIONS";
          } else {
            stateToUpdate.medicinesConfirmed = false;
            stateToUpdate.medicinesSavedToDb = false;
            stateToUpdate.medicationFlowDone = false;

            if (currentOnboardingStep === "REVIEW_MEDICINES_LIST") {
              stateToUpdate.currentStep = "REVIEW_MEDICINES_LIST";
            } else if (effectiveState.currentStep === "ADD_MEDICINE" || isAddMedicineMsg) {
              stateToUpdate.currentStep = "ADD_MEDICINE";
            } else if (
              effectiveState.currentStep &&
              effectiveState.currentStep !== "MEDICINE_OPTIONS"
            ) {
              stateToUpdate.currentStep = effectiveState.currentStep;
            } else {
              stateToUpdate.currentStep = "MEDICINE_OPTIONS";
            }
          }

          const onboardingResult = await onboardingService.chat(
            message || actionData || "",
            history,
            stateToUpdate,
            userId,
            null,
            displayLabel,
          );

          const responsePayload = buildUnifiedResponse({
            mode: "ONBOARDING",
            actionType: onboardingResult?.action || "MEDICINE_OPTIONS",
            reply: onboardingResult?.message || onboardingResult?.reply || "",
            onboardingState: onboardingResult?.state || stateToUpdate,
            options: onboardingResult?.options || [],
            medicines: onboardingResult?.medicines || [],
            sessionId: effectiveSessionId,
            actions: onboardingResult?.actions || null,
            reportSummary: onboardingResult?.reportSummary || null,
          });
          if (onboardingResult?.completionMessage) {
            responsePayload.completionMessage = onboardingResult.completionMessage;
            responsePayload.completionMessageId = onboardingResult.completionMessageId;
            responsePayload.completionAction = onboardingResult.completionAction;
          }
          responsePayload.canSkip =
            onboardingResult?.canSkip !== undefined
              ? onboardingResult.canSkip
              : canSkipOnboarding(onboardingResult?.state || stateToUpdate);
          return responsePayload;
        }

        // Post-Onboarding (Dashboard Chat Stream): return confirmation response
        const userLang = preferredLanguage || patient?.preferredLanguage || "english";
        const localeMap = {
          english: "en-IN",
          gujarati: "gu-IN",
          hindi: "hi-IN",
          marathi: "mr-IN",
          tamil: "ta-IN",
        };

        if (!createdMeds || createdMeds.length === 0) {
          const replyText = await getLocalizedText(
            "onboarding.addMedicine.saveFailed",
            "We were unable to save your medications. Please review the details and try again.",
            userLang,
          );
          return buildUnifiedResponse({
            mode: "ACTION",
            actionType: "CONFIRM_MEDICINES_ERROR",
            reply: replyText,
            sessionId: effectiveSessionId,
            medicines: medsToProcess || [],
          });
        }

        const toWords = new ToWords({
          localeCode: localeMap[userLang],
        });
        const countWard = toWords.convert(createdMeds.length);
        const replyText = await getLocalizedText(
          "onboarding.addMedicine.successWithCount",
          `${countWard} medications have been successfully added.`,
          userLang,
          { count: countWard },
        );

        const terminalOnboardingState = {
          ...effectiveState,
          medicinesConfirmed: true,
          medicinesSavedToDb: true,
          medicationFlowDone: true,
          isOnboardingCompleted: true,
          currentStep: "POST_ONBOARDING",
          medicinesToAdd: [],
          foundMedicines: [],
        };

        if (userId) {
          try {
            await saveOnboardingState(userId, terminalOnboardingState);
          } catch (persistErr) {
            console.warn(
              "[UnifiedChat] Failed to persist post-onboarding terminal state:",
              persistErr.message,
            );
          }
        }

        let activeSessionId = effectiveSessionId;
        if (!activeSessionId && userId) {
          try {
            if (chatService && typeof chatService.getOrCreateCanonicalSession === "function") {
              const canonical = await chatService.getOrCreateCanonicalSession({ userId });
              activeSessionId = canonical?.id || null;
            }
          } catch (sErr) {
            console.warn(
              "[UnifiedChat] Failed to get canonical session for CONFIRM_MEDICINES:",
              sErr.message,
            );
          }
        }

        if (activeSessionId) {
          const userLang =
            preferredLanguage ||
            patient?.preferredLanguage ||
            effectiveState?.preferredLanguage ||
            "english";

          let userConfirmContent = displayLabel;
          if (
            !userConfirmContent ||
            (typeof userConfirmContent === "string" &&
              (userConfirmContent.trim().startsWith("{") ||
                userConfirmContent.trim().startsWith("[") ||
                userConfirmContent.includes('"selected"')))
          ) {
            userConfirmContent =
              userLang === "gujarati" || userLang === "gu"
                ? "આગળ વધો"
                : await getLocalizedText(
                    "onboarding.reviewMedicinesList.confirm",
                    "Confirm Selection",
                    userLang,
                  );
          }

          await chatSessionRepository.appendMessage({
            sessionId: activeSessionId,
            userId,
            role: "user",
            content: userConfirmContent,
            metadata: {
              actionType: "CONFIRM_MEDICINES",
              action: "CONFIRM_MEDICINES",
              rawValue: actionData || { selected: (createdMeds || []).map((m) => m.id) },
            },
          });

          await chatSessionRepository.appendMessage({
            sessionId: activeSessionId,
            userId,
            role: "assistant",
            content: replyText,
            metadata: {
              mode: "ACTION",
              actionType: "CONFIRM_MEDICINES",
              isConfirmed: true,
              medicationIds: createdMeds.map((m) => m.id),
              medicines: createdMeds,
              medication: createdMed,
            },
          });
        }

        let reportSummaryPayload = null;
        let actionsPayload = null;
        if (userId) {
          try {
            const pendingSum =
              dbState?.pendingReportSummary || effectiveState?.pendingReportSummary;
            if (pendingSum && pendingSum.status !== "DELIVERED") {
              reportSummaryPayload = { ...pendingSum };
              delete reportSummaryPayload.status;

              actionsPayload = [
                {
                  actionType: "REPORT_SUMMARY",
                  reportSummary: reportSummaryPayload,
                },
              ];

              const updatedState = {
                ...terminalOnboardingState,
                pendingReportSummary: {
                  ...pendingSum,
                  status: "DELIVERED",
                },
              };
              await saveOnboardingState(userId, updatedState);
            }
          } catch (reportErr) {
            console.warn(
              "[UnifiedChat] Failed to build report summary payload after confirmation:",
              reportErr.message,
            );
          }
        }

        const docSummaryObj = reportSummaryPayload
          ? {
              totalUploads: 1,
              completed: 1,
              failed: 0,
              rejected: 0,
              summary: reportSummaryPayload.summary || null,
              text: messageConstants.DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW({
                successfulCount: 1,
                totalCount: 1,
                medicationCount: createdMeds ? createdMeds.length : 0,
                failedCount: 0,
              }),
            }
          : null;

        return buildUnifiedResponse({
          mode: "ACTION",
          actionType:
            isAddNewMsg || actionType === "ADD_MEDICINE" ? "ADD_MEDICINE" : "CONFIRM_MEDICINES",
          reply: replyText,
          sessionId: activeSessionId,
          medication: createdMed,
          medicines: createdMeds,
          onboardingState: terminalOnboardingState,
          actions: actionsPayload,
          reportSummary: reportSummaryPayload,
          documentSummary: docSummaryObj,
        });
      }

      let parsedMsg = null;
      if (typeof message === "string" && message.trim().startsWith("{")) {
        try {
          parsedMsg = JSON.parse(message);
        } catch {
          // Ignore JSON parse error
        }
      }

      // Determine if request should route to Normal Post-Onboarding Chat vs Onboarding State Machine
      const isCompletedStep =
        effectiveState?.currentStep === "COMPLETE" ||
        effectiveState?.currentStep === "POST_ONBOARDING";

      const data = dbState?.existingUserData || inputState?.existingUserData || {};
      const bloodGroup = patient?.bloodGroup || data?.bloodGroup;
      const allergies = patient?.allergies || data?.allergies;
      const bloodGroupSkipped =
        dbState?.bloodGroupSkipped === true || inputState?.bloodGroupSkipped === true;
      const allergiesSkipped =
        dbState?.allergiesSkipped === true || inputState?.allergiesSkipped === true;

      const isSkippedValid =
        (dbState?.hasSkipped === true ||
          inputState?.hasSkipped === true ||
          effectiveState?.hasSkipped === true) &&
        canSkipOnboarding(effectiveState || dbState || inputState);

      const isMedicationFlowPending =
        effectiveState?.medicationFlowDone !== true &&
        dbState?.medicationFlowDone !== true &&
        inputState?.medicationFlowDone !== true &&
        effectiveState?.hasSkipped !== true &&
        dbState?.hasSkipped !== true;

      const hasUnansweredOptional =
        (!bloodGroup && !bloodGroupSkipped) ||
        ((!allergies || (Array.isArray(allergies) && allergies.length === 0)) &&
          !allergiesSkipped) ||
        isMedicationFlowPending;

      const isExplicitReportActionMsg =
        message === "ASK_REPORT" ||
        message === "ASK_ABOUT_REPORT" ||
        actionType === "ASK_REPORT" ||
        actionType === "ASK_ABOUT_REPORT";

      const isForcedOnboardingAction =
        isExplicitReportActionMsg ||
        actionType === "ADD_MEDICINE" ||
        actionType === "SAVE_AND_REVIEW" ||
        actionType === "CONFIRM_MEDICINES" ||
        message === "ADD_MEDICINE" ||
        message === "DASHBOARD" ||
        message === "GO_TO_DASHBOARD" ||
        actionType === "DASHBOARD" ||
        actionType === "ASK_ALLERGIES" ||
        actionType === "ASK_BLOOD_GROUP" ||
        actionType === "MEDICINE_OPTIONS";

      const isIncomingOnboardingStep =
        actionType === "ASK_ALLERGIES" ||
        actionType === "ASK_BLOOD_GROUP" ||
        actionType === "MEDICINE_OPTIONS" ||
        effectiveState?.currentStep === "ASK_ALLERGIES" ||
        effectiveState?.currentStep === "ASK_BLOOD_GROUP" ||
        effectiveState?.currentStep === "MEDICINE_OPTIONS" ||
        inputState?.currentStep === "ASK_ALLERGIES" ||
        inputState?.currentStep === "ASK_BLOOD_GROUP" ||
        inputState?.currentStep === "MEDICINE_OPTIONS" ||
        dbState?.currentStep === "ASK_ALLERGIES" ||
        dbState?.currentStep === "ASK_BLOOD_GROUP" ||
        dbState?.currentStep === "MEDICINE_OPTIONS";

      const isNormalChat =
        !isMedicineAction &&
        !isForcedOnboardingAction &&
        !isIncomingOnboardingStep &&
        actionType !== "SKIP_ONBOARDING" &&
        !hasUnansweredOptional &&
        !isMedicationFlowPending &&
        (actionType === "NORMAL_CHAT" ||
          ((isOnboardingCompleted ||
            isCompletedStep ||
            isSkippedValid ||
            dbState?.currentStep === "ASK_REPORT" ||
            inputState?.currentStep === "ASK_REPORT") &&
            !isActiveOnboardingStep &&
            !isExplicitReportActionMsg &&
            (actionType !== "ONBOARDING" ||
              isCompletedStep ||
              isSkippedValid ||
              dbState?.currentStep === "ASK_REPORT" ||
              inputState?.currentStep === "ASK_REPORT") &&
            actionType !== "OTHER_ACTIONS"));

      // CASE 3: ONBOARDING STATE MACHINE FLOW
      if (!isNormalChat) {
        console.log(`[UnifiedChat] Executing Onboarding State Machine for userId=${userId}`);
        let state = inputState;
        let isStaleDuplicateSubmission = false;
        if (!state || Object.keys(state).length === 0) {
          state = dbState;
        } else {
          const incomingStateCleaned = Object.fromEntries(
            Object.entries(state).filter(([_, v]) => v !== null && v !== undefined && v !== ""),
          );

          const dbExistingUserData = dbState?.existingUserData || {};
          const incomingExistingUserData = incomingStateCleaned.existingUserData || {};
          const incomingUserDataCleaned = Object.fromEntries(
            Object.entries(incomingExistingUserData).filter(
              ([_, v]) => v !== null && v !== undefined && v !== "",
            ),
          );

          const bloodGroupSkipped =
            dbState?.bloodGroupSkipped === true || incomingStateCleaned.bloodGroupSkipped === true;
          const allergiesSkipped =
            dbState?.allergiesSkipped === true || incomingStateCleaned.allergiesSkipped === true;

          const documentOwnershipConfirmed =
            dbState?.documentOwnershipConfirmed !== undefined &&
            dbState?.documentOwnershipConfirmed !== null
              ? dbState.documentOwnershipConfirmed
              : incomingStateCleaned.documentOwnershipConfirmed;

          const documentConfirmed =
            documentOwnershipConfirmed === true ||
            dbState?.documentConfirmed === true ||
            incomingStateCleaned.documentConfirmed === true;

          const useDocumentData =
            dbState?.useDocumentData === true ||
            incomingStateCleaned.useDocumentData === true ||
            (documentConfirmed && dbState?.useDocumentData !== false);

          const isProfileConfirmedInDb =
            dbState?.profileConfirmed === true || !!dbState?.selectedProfileSource;

          const sanitizeAllergies = (list) => {
            if (!Array.isArray(list)) return undefined;
            return list.filter(
              (item) =>
                typeof item === "string" &&
                !bloodGroupTypeValues.includes(item.trim().toUpperCase().replace(/\s+/g, "")),
            );
          };

          const rawAllergies = Array.isArray(incomingUserDataCleaned.allergies)
            ? incomingUserDataCleaned.allergies
            : Array.isArray(dbExistingUserData.allergies)
              ? dbExistingUserData.allergies
              : undefined;
          const mergedAllergies =
            rawAllergies !== undefined ? sanitizeAllergies(rawAllergies) : undefined;

          const mergedUserData =
            isProfileConfirmedInDb && !incomingStateCleaned.edited
              ? {
                  ...incomingUserDataCleaned,
                  ...dbExistingUserData,
                  ...(incomingUserDataCleaned.bloodGroup
                    ? { bloodGroup: incomingUserDataCleaned.bloodGroup }
                    : {}),
                  ...(mergedAllergies !== undefined ? { allergies: mergedAllergies } : {}),
                }
              : {
                  ...dbExistingUserData,
                  ...incomingUserDataCleaned,
                  ...(incomingUserDataCleaned.bloodGroup
                    ? { bloodGroup: incomingUserDataCleaned.bloodGroup }
                    : {}),
                  ...(mergedAllergies !== undefined ? { allergies: mergedAllergies } : {}),
                };

          const case3AuthoritativeIsOnboardingCompleted =
            dbState?.isOnboardingCompleted === true ||
            incomingStateCleaned.isOnboardingCompleted === true;
          const case3AuthoritativeHasSkipped =
            dbState?.hasSkipped === true || incomingStateCleaned.hasSkipped === true;
          const case3AuthoritativeMedicationFlowDone =
            dbState?.medicationFlowDone === true ||
            incomingStateCleaned.medicationFlowDone === true;
          const case3AuthoritativeMedicinesConfirmed =
            dbState?.medicinesConfirmed === true ||
            incomingStateCleaned.medicinesConfirmed === true;
          const case3AuthoritativeCompletionMessageSent =
            dbState?.completionMessageSent === true ||
            incomingStateCleaned.completionMessageSent === true;
          const case3AuthoritativeCompletionMessageId =
            dbState?.completionMessageId || incomingStateCleaned.completionMessageId || null;

          isStaleDuplicateSubmission = false;
          let case3AuthoritativeStep = dbState?.currentStep || incomingStateCleaned.currentStep;
          const isExplicitIncomingStep =
            actionType === "ASK_ALLERGIES" ||
            actionType === "ASK_BLOOD_GROUP" ||
            actionType === "MEDICINE_OPTIONS" ||
            actionType === "REVIEW_MEDICINES_LIST" ||
            actionType === "CONFIRM_MEDICINES" ||
            (incomingStateCleaned.currentStep && actionType === incomingStateCleaned.currentStep);

          if (incomingStateCleaned.currentStep && dbState?.currentStep) {
            if (isStepAlreadySatisfied(incomingStateCleaned.currentStep, dbState)) {
              case3AuthoritativeStep = dbState.currentStep;
              if (incomingStateCleaned.currentStep !== dbState.currentStep) {
                isStaleDuplicateSubmission = true;
              }
            } else {
              case3AuthoritativeStep = incomingStateCleaned.currentStep;
            }
          }

          state = {
            ...dbState,
            ...incomingStateCleaned,
            medicinesToAdd:
              isStaleDuplicateSubmission && Array.isArray(dbState?.medicinesToAdd)
                ? dbState.medicinesToAdd
                : Array.isArray(incomingStateCleaned.medicinesToAdd) &&
                    incomingStateCleaned.medicinesToAdd.length > 0
                  ? incomingStateCleaned.medicinesToAdd
                  : dbState?.medicinesToAdd || [],
            currentStep: case3AuthoritativeStep,
            isOnboardingCompleted: case3AuthoritativeIsOnboardingCompleted,
            hasSkipped: case3AuthoritativeHasSkipped,
            medicationFlowDone: case3AuthoritativeMedicationFlowDone,
            medicinesConfirmed: case3AuthoritativeMedicinesConfirmed,
            completionMessageSent: case3AuthoritativeCompletionMessageSent,
            ...(case3AuthoritativeCompletionMessageId
              ? { completionMessageId: case3AuthoritativeCompletionMessageId }
              : {}),
            bloodGroupSkipped,
            allergiesSkipped,
            ...(documentConfirmed !== undefined && documentConfirmed !== null
              ? { documentConfirmed }
              : {}),
            ...(documentOwnershipConfirmed !== undefined && documentOwnershipConfirmed !== null
              ? { documentOwnershipConfirmed }
              : {}),
            ...(useDocumentData !== undefined && useDocumentData !== null
              ? { useDocumentData }
              : {}),
            existingUserData: mergedUserData,
          };

          if (!state.currentStep && dbState.currentStep) state.currentStep = dbState.currentStep;
          if (!state.flowMode && dbState.flowMode) state.flowMode = dbState.flowMode;
          if (!state.preferredLanguage && dbState.preferredLanguage)
            state.preferredLanguage = dbState.preferredLanguage;

          const explicitActionStep =
            actionType === "ASK_ALLERGIES" || actionType === "ASK_BLOOD_GROUP"
              ? actionType
              : parsedMsg &&
                  (parsedMsg.action === "ASK_ALLERGIES" || parsedMsg.action === "ASK_BLOOD_GROUP")
                ? parsedMsg.action
                : null;

          if (explicitActionStep && !isStepAlreadySatisfied(explicitActionStep, dbState)) {
            state.currentStep = explicitActionStep;
          }

          // Generic forward transition: If currentStep is already satisfied in the authoritative persistent state (dbState), advance to next step.
          // Note: We check dbState, NOT merged state, because merged state contains the client's current submission for currentStep.
          // Checking merged state caused premature step advancement before onboardingService.chat executed, causing the Blood Group answer
          // to be executed against ASK_ALLERGIES.
          if (
            !isExplicitIncomingStep &&
            !explicitActionStep &&
            isStepAlreadySatisfied(state.currentStep, dbState)
          ) {
            isStaleDuplicateSubmission = true;
            state.currentStep = getNextRequiredOrOptionalStep(state);
          }
        }

        if (hasUnansweredOptional && !state.currentStep && actionType !== "SKIP_ONBOARDING") {
          state.currentStep = null;
        }

        if (actionType === "SKIP_ONBOARDING") {
          if (!canSkipOnboarding(state)) {
            throw new InvalidRequestException(errorConstants.REQUIRED_PROFILE_DETAILS_MISSING);
          }
          state.isOnboardingCompleted = true;
          state.hasSkipped = true;
          if (userId) {
            try {
              await patientRepository.updateById(userId, { onboardingCompleted: true });
            } catch (err) {
              console.warn(
                "[OcrService] Failed to update patient onboardingCompleted flag on skip:",
                err.message,
              );
            }
          }
          if (!state.currentStep && dbState && dbState.currentStep) {
            state.currentStep = dbState.currentStep;
          }

          await saveOnboardingState(userId, state);

          const responsePayload = buildUnifiedResponse({
            mode: "ONBOARDING",
            actionType: "SKIP_ONBOARDING",
            reply: "",
            onboardingState: state,
            options: [],
            medicines: [],
          });
          responsePayload.canSkip = true;
          return responsePayload;
        }

        let effectiveMessage = message;
        let effectiveDisplayLabel = displayLabel;
        if (isStaleDuplicateSubmission) {
          effectiveMessage = null;
          effectiveDisplayLabel = null;
          if (dbState && Object.keys(dbState).length > 0) {
            state = {
              ...dbState,
              ...state,
              existingUserData: {
                ...(state.existingUserData || {}),
                ...(dbState.existingUserData || {}),
                ...(patient?.bloodGroup ? { bloodGroup: patient.bloodGroup } : {}),
                ...(patient?.allergies && patient.allergies.length > 0
                  ? { allergies: patient.allergies }
                  : {}),
              },
              currentStep: state.currentStep,
            };
          }
        }

        if (
          effectiveSessionId &&
          (!state.chatSessionId || state.chatSessionId !== effectiveSessionId)
        ) {
          state.chatSessionId = effectiveSessionId;
        }

        const onboardingResult = await onboardingService.chat(
          effectiveMessage,
          history,
          state,
          userId,
          effectiveSessionId,
          effectiveDisplayLabel,
        );

        const replyText =
          onboardingResult?.title && onboardingResult?.message
            ? `${onboardingResult.title}\n\n${onboardingResult.message}`
            : onboardingResult?.message || onboardingResult?.reply || "";
        console.log(replyText);

        const responsePayload = buildUnifiedResponse({
          mode: onboardingResult?.mode || "ONBOARDING",
          actionType:
            actionType === "SKIP_ONBOARDING"
              ? "SKIP_ONBOARDING"
              : onboardingResult?.action || "ONBOARDING_STEP",
          reply: onboardingResult.message,
          title: onboardingResult?.title || null,
          subtitle: onboardingResult?.subtitle || null,
          fields: onboardingResult?.fields || [],
          explainer: onboardingResult?.explainer || null,
          loginSummary: onboardingResult?.loginSummary || null,
          documentSummary: onboardingResult?.documentSummary || null,
          loginProvider: onboardingResult?.loginProvider || null,
          sourceComparison: onboardingResult?.sourceComparison || null,
          sessionId: onboardingResult?.state?.chatSessionId || effectiveSessionId,
          onboardingState: onboardingResult?.state || state,
          options: onboardingResult?.options || [],
          medicines: onboardingResult?.medicines || [],
          document: onboardingResult?.document || null,
          actions: onboardingResult?.actions || null,
          reportSummary: onboardingResult?.reportSummary || null,
        });
        responsePayload.state = onboardingResult?.state || state;
        responsePayload.mode = onboardingResult?.mode || responsePayload.mode;
        responsePayload.loginProvider =
          onboardingResult?.loginProvider || responsePayload.loginProvider || null;
        responsePayload.sourceComparison =
          onboardingResult?.sourceComparison || responsePayload.sourceComparison || null;
        if (onboardingResult?.completionMessage) {
          responsePayload.completionMessage = onboardingResult.completionMessage;
          responsePayload.completionMessageId = onboardingResult.completionMessageId;
          responsePayload.completionAction = onboardingResult.completionAction;
        }
        responsePayload.suggestedQuestions = onboardingResult?.suggestedQuestions || [];
        if (onboardingResult?.totalBuffered !== undefined) {
          responsePayload.totalBuffered = onboardingResult.totalBuffered;
        }
        if (onboardingResult?.isSilent !== undefined) {
          responsePayload.isSilent = onboardingResult.isSilent;
        }
        responsePayload.canSkip =
          onboardingResult?.canSkip !== undefined
            ? onboardingResult.canSkip
            : canSkipOnboarding(onboardingResult?.state || state);
        return responsePayload;
      }

      // CASE 4: NORMAL_CHAT (Post-onboarding RAG Chat)
      console.log(`[UnifiedChat] Executing Normal Chat / RAG query for userId=${userId}`);
      const userLang = preferredLanguage || patient?.preferredLanguage || "english";
      const promptText = message && message.trim().length > 0 ? message.trim() : "Hello";

      const intentResult = detectActionIntent(promptText, userLang);

      const targetDocId = documentId || inputState?.documentId || dbState?.documentId || null;

      const chatResult = await chatService.sendMessage({
        userId,
        question: promptText,
        sessionId: effectiveSessionId,
        documentId: targetDocId,
        preferredLanguage: userLang,
        onChunk,
        abortSignal,
      });

      return buildUnifiedResponse({
        mode: "NORMAL_CHAT",
        actionType: chatResult?.requireSelection ? "REQUIRE_DOCUMENT_SELECTION" : "NORMAL_CHAT",
        reply: chatResult?.reply || chatResult?.answer || chatResult?.message || "",
        sessionId: chatResult?.ai?.sessionId || chatResult?.sessionId || effectiveSessionId,
        citations: chatResult?.citations || [],
        suggestedAction: chatResult?.requireSelection
          ? "REQUIRE_DOCUMENT_SELECTION"
          : intentResult.suggestedAction,
        options: intentResult.options.length > 0 ? intentResult.options : chatResult?.options || [],
        requireSelection: chatResult?.requireSelection || false,
        reports: chatResult?.reports || [],
        allowMultiSelect: chatResult?.allowMultiSelect || false,
        selectionType: chatResult?.selectionType || null,
      });
    } catch (error) {
      console.error(`[UnifiedChat] Unified chat processing error for userId=${userId}:`, error);
      throw error;
    }
  }

  // TODO: move onboarding status/history out of ocr.service.js
  async getOnboardingStatus(userId) {
    if (!userId) {
      throw new UnauthorizedException("Unauthorized access");
    }

    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException("Patient not found");
    }

    // Get saved onboarding state for resumption
    const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
    const resumableState = onboardingRecord?.data || null;
    if (resumableState && resumableState.preferredLanguage) {
      resumableState.preferredLanguage = normalizeLanguage(resumableState.preferredLanguage);
    }
    let currentStep = resumableState?.currentStep || "ASK_LANGUAGE";

    const isStateCompleted = resumableState?.isOnboardingCompleted === true;

    const isBasicProfileComplete = !!(
      patient.firstName &&
      patient.firstName !== "User" &&
      patient.lastName &&
      patient.gender &&
      patient.dateOfBirth
    );

    let isOnboardingCompleted = false;

    // If we have an onboarding record, trust its completion status
    if (resumableState) {
      isOnboardingCompleted = patient.onboardingCompleted || isStateCompleted;
    } else {
      // Fallback for users without an onboarding record (legacy)
      isOnboardingCompleted = patient.onboardingCompleted || isBasicProfileComplete;
    }

    const canSkip = resumableState ? canSkipOnboarding(resumableState) : false;

    // If onboarding is considered complete, return completed status
    if (isOnboardingCompleted) {
      const data = resumableState?.existingUserData || {};
      const bloodGroup = patient.bloodGroup || data?.bloodGroup;
      const allergies = patient.allergies || data?.allergies;
      const bloodGroupSkipped = resumableState?.bloodGroupSkipped === true;
      const allergiesSkipped = resumableState?.allergiesSkipped === true;

      let effectivePendingStep = "COMPLETE";
      if (!bloodGroup && !bloodGroupSkipped) {
        effectivePendingStep = "ASK_BLOOD_GROUP";
      } else if (
        (!allergies || (Array.isArray(allergies) && allergies.length === 0)) &&
        !allergiesSkipped
      ) {
        effectivePendingStep = "ASK_ALLERGIES";
      } else if (
        resumableState?.medicationFlowDone !== true &&
        resumableState?.hasSkipped !== true &&
        resumableState?.medicinesConfirmed !== true
      ) {
        const hasExtractedMedicines =
          (Array.isArray(resumableState?.foundMedicines) &&
            resumableState.foundMedicines.length > 0) ||
          (Array.isArray(resumableState?.medicinesToAdd) &&
            resumableState.medicinesToAdd.length > 0);
        if (!resumableState?.medicinesConfirmed && hasExtractedMedicines) {
          effectivePendingStep = "REVIEW_MEDICINES_LIST";
        } else {
          effectivePendingStep = "MEDICINE_OPTIONS";
        }
      }

      if (currentStep !== "POST_ONBOARDING") {
        currentStep = effectivePendingStep;
      }
      return {
        isOnboardingCompleted: true,
        currentStep,
        chatSessionId: resumableState?.chatSessionId || null,
        resumableState: resumableState ? { ...resumableState, currentStep, canSkip } : null,
        canSkip,
      };
    }

    return {
      isOnboardingCompleted: false,
      currentStep,
      chatSessionId: resumableState?.chatSessionId || null,
      resumableState: resumableState ? { ...resumableState, canSkip } : null,
      canSkip,
    };
  }

  async getOnboardingHistory(userId) {
    if (!userId) {
      throw new UnauthorizedException("Unauthorized access");
    }

    const { state: resolvedState } = await resolveOnboardingState(userId);
    let resumableState = resolvedState || null;

    let patient = null;
    try {
      patient = await patientRepository.findById(userId);
    } catch {
      // ignore
    }

    if (patient?.onboardingCompleted) {
      const data = resumableState?.existingUserData || {};
      const bloodGroup = patient?.bloodGroup || data?.bloodGroup;
      const allergies = patient?.allergies || data?.allergies;
      const bloodGroupSkipped = resumableState?.bloodGroupSkipped === true;
      const allergiesSkipped = resumableState?.allergiesSkipped === true;

      let effectivePendingStep = "COMPLETE";
      if (!bloodGroup && !bloodGroupSkipped) {
        effectivePendingStep = "ASK_BLOOD_GROUP";
      } else if (
        (!allergies || (Array.isArray(allergies) && allergies.length === 0)) &&
        !allergiesSkipped
      ) {
        effectivePendingStep = "ASK_ALLERGIES";
      } else if (
        resumableState?.medicationFlowDone !== true &&
        resumableState?.hasSkipped !== true &&
        resumableState?.medicinesConfirmed !== true
      ) {
        const hasExtractedMedicines =
          (Array.isArray(resumableState?.foundMedicines) &&
            resumableState.foundMedicines.length > 0) ||
          (Array.isArray(resumableState?.medicinesToAdd) &&
            resumableState.medicinesToAdd.length > 0);
        if (!resumableState?.medicinesConfirmed && hasExtractedMedicines) {
          effectivePendingStep = "REVIEW_MEDICINES_LIST";
        } else {
          effectivePendingStep = "MEDICINE_OPTIONS";
        }
      }

      if (!resumableState) {
        resumableState = { isOnboardingCompleted: true, currentStep: effectivePendingStep };
      } else {
        resumableState.isOnboardingCompleted = true;
        if (resumableState.currentStep !== "POST_ONBOARDING") {
          resumableState.currentStep = effectivePendingStep;
        }
      }
    }

    if (resumableState && resumableState.preferredLanguage) {
      resumableState.preferredLanguage = normalizeLanguage(resumableState.preferredLanguage);
    }
    if (resumableState && !resumableState.loginProvider && userId) {
      try {
        const providers = (await authProviderRepository.findByUserId(userId)) || [];
        const providerNames = Array.isArray(providers) ? providers.map((p) => p.provider) : [];
        let primaryProvider = "email";
        if (providerNames.includes("google")) primaryProvider = "google";
        else if (providerNames.includes("facebook")) primaryProvider = "facebook";
        else if (providerNames.includes("microsoft")) primaryProvider = "microsoft";
        else if (providerNames.includes("apple")) primaryProvider = "apple";
        else if (providerNames.includes("mobile")) primaryProvider = "mobile";
        resumableState.loginProvider = primaryProvider;
      } catch {
        // ignore
      }
    }
    let chatSessionId = resumableState?.chatSessionId || null;
    if (!chatSessionId && userId) {
      try {
        if (chatService && typeof chatService.getOrCreateCanonicalSession === "function") {
          const canonical = await chatService.getOrCreateCanonicalSession({ userId });
          chatSessionId = canonical?.id || null;
        }
      } catch {
        // ignore
      }
    }

    let messages = [];
    if (chatSessionId) {
      let cursor = null;
      let hasMore = true;
      const seenCursors = new Set();
      const allRawMessages = [];

      while (hasMore) {
        const result = await chatSessionRepository.listMessages({
          sessionId: chatSessionId,
          userId,
          limit: 100,
          direction: "after",
          cursor,
        });

        const items = result?.items || [];
        allRawMessages.push(...items);

        if (result?.nextCursor && !seenCursors.has(result.nextCursor)) {
          seenCursors.add(result.nextCursor);
          cursor = result.nextCursor;
        } else {
          hasMore = false;
        }
      }

      messages = allRawMessages.filter((m) => {
        if (m.role === "assistant") {
          const action = m.metadata?.action;
          const text = (m.content || "").toLowerCase();
          if (
            action === "COMPLETE" ||
            action === "POST_ONBOARDING" ||
            text.includes("thank you! onboarding is complete") ||
            text.includes("thank you! your onboarding is complete")
          ) {
            return false;
          }
        }
        return true;
      });
    }

    let documentsName = [];
    let documentSummary = { totalUploads: 0, completed: 0, failed: 0, rejected: 0 };
    try {
      const jobNames = await documentProcessingJobRepository.findUserJobDocumentNames(userId);
      if (jobNames && jobNames.length > 0) {
        documentsName = jobNames;
      } else {
        const userDocs = await documentRepository.findAllByFilterAndSort({
          filter: {},
          sort: { sortBy: "createdAt", sortOrder: "desc" },
          userId,
        });
        documentsName = (userDocs || []).map((doc) => doc.fileName).filter(Boolean);
      }

      const summaryFromDb = await documentProcessingJobRepository.getUserJobSummary(userId);
      if (summaryFromDb) {
        documentSummary = {
          totalUploads: summaryFromDb.totalUploads || 0,
          completed: summaryFromDb.completed || 0,
          failed: summaryFromDb.failed || 0,
          rejected: summaryFromDb.rejected || 0,
        };
      }
    } catch (_err) {
      console.log(_err);

      documentsName = [];
    }

    return {
      chatSessionId,
      messages,
      documentsName,
      documentSummary,
      currentStep:
        resumableState?.currentStep || (patient?.onboardingCompleted ? "COMPLETE" : "ASK_LANGUAGE"),
      canSkip: resumableState
        ? canSkipOnboarding(resumableState)
        : Boolean(patient?.onboardingCompleted),
      resumableState,
    };
  }
}
module.exports = new V1Service();
