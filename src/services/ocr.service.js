const { eq, and } = require("drizzle-orm");

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
const patientRepository = require("../repositories/patientRepository");
const userOnboardingRepository = require("../repositories/userOnboardingRepository");
const { onboardingService } = require("./ai");
const { ocrService } = require("./ai/ocr/ocr.service");
const uploadFileService = require("./uploadFile.service");
const { normalizeLanguage } = require("../utils/commonUtils");
const { messageConstants } = require("../constants/messageConstants");
const { inferFileType } = require("../helpers/document.helper");
const documentPersistenceService = require("./documentPersistence.service");
const documentOcrJobService = require("./documentOcrJob.service");
const medicationService = require("./medication.service");
const medicationReminderService = require("./medicationReminder.service");
const { chatService } = require("./ai/chat/chat.service");
const {
  buildUnifiedResponse,
  detectActionIntent,
  executeAddDocumentAction,
  normalizeUnifiedChatInput,
} = require("../helpers/unifiedChat.helper");

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

    return {
      documentId: docRow.id,
      status,
      summary: docRow.summaryInPreferredLanguage || docRow.summaryEnglish || "",
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

    await db
      .update(document)
      .set({
        ocrStatus: ocrStatus.CANCELED,
        remarks: "ERR_CODE:USER_CANCELLED",
        updatedAt: new Date(),
      })
      .where(and(eq(document.id, documentId), eq(document.userId, userId)));

    return { message: "Job cancelled successfully" };
  }

  async onboardingChat(userId, body) {
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

      // Fetch user profile and existing onboarding state
      const patient = await patientRepository.findById(userId);
      const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
      const dbState = onboardingRecord?.data || {};
      const isOnboardingCompleted =
        patient?.onboardingCompleted ||
        dbState?.isOnboardingCompleted === true ||
        dbState?.currentStep === "COMPLETE" ||
        inputState?.isOnboardingCompleted === true ||
        inputState?.currentStep === "COMPLETE";

      // CASE 1: ADD_DOCUMENT ACTION
      if (actionType === "ADD_DOCUMENT") {
        console.log(`[UnifiedChat] Executing ADD_DOCUMENT action for userId=${userId}`);
        return executeAddDocumentAction({
          userId,
          actionData,
          sessionId,
          isOnboardingCompleted,
          documentPersistenceService,
          documentOcrJobService,
          chatService,
          chatSessionRepository,
          ocrStatusEnum: ocrStatus,
        });
      }

      const effectiveState = { ...(dbState || {}), ...(inputState || {}) };
      const currentOnboardingStep = effectiveState?.currentStep || null;
      const isActiveOnboardingStep =
        Boolean(currentOnboardingStep) &&
        currentOnboardingStep !== "COMPLETE" &&
        currentOnboardingStep !== "POST_ONBOARDING" &&
        effectiveState?.medicationFlowDone !== true;

      // CASE 2: ADD_MEDICINE / SHOW_EXTRACTED_MEDICINES ACTION
      const hasMedicineActionData =
        actionData &&
        typeof actionData === "object" &&
        (actionData.medicationName || actionData.name || actionData.medicine);

      if (
        actionType === "ADD_MEDICINE" ||
        actionType === "SHOW_EXTRACTED_MEDICINES" ||
        hasMedicineActionData ||
        (actionData && Array.isArray(actionData.medicines) && actionData.medicines.length > 0)
      ) {
        console.log(
          `[UnifiedChat] Executing ADD_MEDICINE action for userId=${userId} (isActiveOnboardingStep=${isActiveOnboardingStep})`,
        );

        let createdMeds = [];
        if (Array.isArray(actionData?.medicines) && actionData.medicines.length > 0) {
          for (const medData of actionData.medicines) {
            try {
              const med = await medicationService.createMedication(userId, medData);
              if (med && med.id) {
                createdMeds.push(med);
                try {
                  await medicationReminderService.createReminder(userId, { medicationId: med.id });
                } catch (rErr) {
                  console.error("[UnifiedChat] Error creating reminder for bulk medicine:", rErr);
                }
              }
            } catch (mErr) {
              console.error("[UnifiedChat] Error creating individual medicine from list:", mErr);
            }
          }
        } else {
          const createdMed = await medicationService.createMedication(userId, actionData);
          if (createdMed && createdMed.id) {
            createdMeds.push(createdMed);
            try {
              await medicationReminderService.createReminder(userId, {
                medicationId: createdMed.id,
              });
            } catch (e) {
              console.error("[UnifiedChat] Error creating reminder:", e);
            }
          }
        }
        const createdMed = createdMeds[0] || null;

        // If patient is in active Onboarding medicine loop, redirect to MEDICINE_OPTIONS step
        if (isActiveOnboardingStep) {
          const stateToUpdate = { ...effectiveState };
          if (!stateToUpdate.medicinesToAdd) stateToUpdate.medicinesToAdd = [];
          if (createdMed) {
            const clientMedId = createdMed.id || actionData?.clientMedId || `med_${Date.now()}`;
            stateToUpdate.medicinesToAdd.push({
              ...actionData,
              id: createdMed.id,
              client_med_id: clientMedId,
              selected: true,
              isSaved: true,
              dbId: createdMed.id,
            });
          }
          stateToUpdate.currentStep = "MEDICINE_OPTIONS";

          const onboardingResult = await onboardingService.chat(
            "",
            history,
            stateToUpdate,
            userId,
            null,
            displayLabel,
          );

          return buildUnifiedResponse({
            mode: "ONBOARDING",
            actionType: onboardingResult?.action || "MEDICINE_OPTIONS",
            reply: onboardingResult?.message || onboardingResult?.reply || "",
            onboardingState: onboardingResult?.state || stateToUpdate,
            options: onboardingResult?.options || [],
            medicines: onboardingResult?.medicines || [],
          });
        }

        // Post-Onboarding (Dashboard Chat Stream): return simple action completion payload without MEDICINE_OPTIONS
        const replyText = createdMed?.name
          ? `Medication '${createdMed.name}' has been added to your active medications.`
          : "Medication added successfully.";

        let activeSessionId = sessionId;
        if (!activeSessionId && isOnboardingCompleted) {
          const newSession = await chatService.createSession({ userId, title: "Medication Chat" });
          activeSessionId = newSession?.id || null;
        }

        if (activeSessionId) {
          await chatSessionRepository.appendMessage({
            sessionId: activeSessionId,
            userId,
            role: "assistant",
            content: replyText,
            metadata: { actionType: "ADD_MEDICINE", medicationId: createdMed?.id },
          });
        }

        return buildUnifiedResponse({
          mode: "ACTION",
          actionType: "ADD_MEDICINE",
          reply: replyText,
          sessionId: activeSessionId,
          medication: createdMed,
        });
      }

      // Determine if request should route to Normal Post-Onboarding Chat vs Onboarding State Machine
      const isNormalChat =
        actionType === "NORMAL_CHAT" ||
        (isOnboardingCompleted &&
          !isActiveOnboardingStep &&
          actionType !== "ONBOARDING" &&
          actionType !== "OTHER_ACTIONS");

      // CASE 3: ONBOARDING STATE MACHINE FLOW
      if (!isNormalChat) {
        console.log(`[UnifiedChat] Executing Onboarding State Machine for userId=${userId}`);
        let state = inputState;
        if (!state || Object.keys(state).length === 0) {
          state = dbState;
        } else {
          const incomingStateCleaned = Object.fromEntries(
            Object.entries(state).filter(([_, v]) => v !== null && v !== undefined),
          );

          const dbExistingUserData = dbState?.existingUserData || {};
          const incomingExistingUserData = incomingStateCleaned.existingUserData || {};
          const incomingUserDataCleaned = Object.fromEntries(
            Object.entries(incomingExistingUserData).filter(
              ([_, v]) => v !== null && v !== undefined,
            ),
          );

          const bloodGroupSkipped =
            dbState?.bloodGroupSkipped === true || incomingStateCleaned.bloodGroupSkipped === true;
          const allergiesSkipped =
            dbState?.allergiesSkipped === true || incomingStateCleaned.allergiesSkipped === true;

          const mergedUserData = {
            ...dbExistingUserData,
            ...incomingUserDataCleaned,
            bloodGroup: incomingUserDataCleaned.bloodGroup || dbExistingUserData.bloodGroup || null,
            allergies:
              Array.isArray(incomingUserDataCleaned.allergies) &&
              incomingUserDataCleaned.allergies.length > 0
                ? incomingUserDataCleaned.allergies
                : dbExistingUserData.allergies || [],
          };

          state = {
            ...dbState,
            ...incomingStateCleaned,
            bloodGroupSkipped,
            allergiesSkipped,
            existingUserData: mergedUserData,
          };

          if (!state.currentStep && dbState.currentStep) state.currentStep = dbState.currentStep;
          if (!state.flowMode && dbState.flowMode) state.flowMode = dbState.flowMode;
          if (!state.preferredLanguage && dbState.preferredLanguage)
            state.preferredLanguage = dbState.preferredLanguage;
        }

        const onboardingResult = await onboardingService.chat(
          message,
          history,
          state,
          userId,
          null,
          displayLabel,
        );

        return buildUnifiedResponse({
          mode: "ONBOARDING",
          actionType: onboardingResult?.action || "ONBOARDING_STEP",
          reply: onboardingResult?.message || onboardingResult?.reply || "",
          onboardingState: onboardingResult?.state || state,
          options: onboardingResult?.options || [],
          medicines: onboardingResult?.medicines || [],
        });
      }

      // CASE 4: NORMAL_CHAT (Post-onboarding RAG Chat)
      console.log(`[UnifiedChat] Executing Normal Chat / RAG query for userId=${userId}`);
      const userLang = preferredLanguage || patient?.preferredLanguage || "english";
      const promptText = message && message.trim().length > 0 ? message.trim() : "Hello";

      const intentResult = detectActionIntent(promptText, userLang);

      const chatResult = await chatService.sendMessage({
        userId,
        question: promptText,
        sessionId,
        documentId,
        preferredLanguage: userLang,
      });

      return buildUnifiedResponse({
        mode: "NORMAL_CHAT",
        actionType: chatResult?.requireSelection ? "REQUIRE_DOCUMENT_SELECTION" : "NORMAL_CHAT",
        reply: chatResult?.reply || chatResult?.answer || chatResult?.message || "",
        sessionId: chatResult?.ai?.sessionId || chatResult?.sessionId || sessionId,
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

    // If onboarding is considered complete, return completed status
    if (isOnboardingCompleted) {
      if (currentStep !== "POST_ONBOARDING") {
        currentStep = "COMPLETE";
      }
      return {
        isOnboardingCompleted: true,
        currentStep,
        chatSessionId: resumableState?.chatSessionId || null,
        resumableState,
      };
    }

    return {
      isOnboardingCompleted: false,
      currentStep,
      chatSessionId: resumableState?.chatSessionId || null,
      resumableState,
    };
  }

  async getOnboardingHistory(userId) {
    if (!userId) {
      throw new UnauthorizedException("Unauthorized access");
    }

    const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
    const resumableState = onboardingRecord?.data || null;
    if (resumableState && resumableState.preferredLanguage) {
      resumableState.preferredLanguage = normalizeLanguage(resumableState.preferredLanguage);
    }
    const chatSessionId = resumableState?.chatSessionId || null;

    let messages = [];
    if (chatSessionId) {
      const result = await chatSessionRepository.listMessages({
        sessionId: chatSessionId,
        userId,
        limit: 100,
        direction: "after",
      });
      messages = result.items || [];
    }

    return {
      chatSessionId,
      messages,
      currentStep: resumableState?.currentStep || "ASK_LANGUAGE",
      resumableState,
    };
  }
}

module.exports = new V1Service();
