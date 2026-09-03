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
const {
  onboardingService,
  canSkipOnboarding,
  saveOnboardingState,
} = require("./ai/chat/onboarding.service");
const { ocrService } = require("./ai/ocr/ocr.service");
const uploadFileService = require("./uploadFile.service");
const { normalizeLanguage } = require("../utils/commonUtils");
const { normalizeCreateMedicationInput } = require("../helpers/medicineNormalize.helper");
const { messageConstants } = require("../constants/messageConstants");
const { errorConstants } = require("../constants/errorConstants");
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

      // Fetch user profile and existing onboarding state
      const patient = await patientRepository.findById(userId);
      const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
      const dbState = onboardingRecord?.data || {};
      const isOnboardingCompleted =
        patient?.onboardingCompleted ||
        dbState?.isOnboardingCompleted === true ||
        dbState?.currentStep === "COMPLETE" ||
        dbState?.currentStep === "POST_ONBOARDING" ||
        inputState?.isOnboardingCompleted === true ||
        inputState?.currentStep === "COMPLETE" ||
        inputState?.currentStep === "POST_ONBOARDING";

      console.log(
        `[ONBOARDING PROFILE LOG] User ID: ${userId} | Patient DB Record: firstName="${patient?.firstName || ""}", lastName="${patient?.lastName || ""}", email="${patient?.email || ""}"`,
      );

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

      const cleanedInputState =
        inputState && typeof inputState === "object"
          ? Object.fromEntries(
              Object.entries(inputState).filter(([_, v]) => v !== null && v !== undefined),
            )
          : {};
      const effectiveState = { ...(dbState || {}), ...cleanedInputState };

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

      let currentOnboardingStep = effectiveState?.currentStep || null;
      const hasUnconfirmedMedicines =
        !isOnboardingCompleted &&
        Array.isArray(effectiveState?.medicinesToAdd) &&
        effectiveState.medicinesToAdd.length > 0 &&
        effectiveState?.medicinesConfirmed !== true;

      if (isAddMedicineMsg) {
        currentOnboardingStep = "ADD_MEDICINE";
        effectiveState.currentStep = "ADD_MEDICINE";
      } else if (!currentOnboardingStep && (isMedicineSelectionMsg || hasUnconfirmedMedicines)) {
        currentOnboardingStep = "REVIEW_MEDICINES_LIST";
        effectiveState.currentStep = "REVIEW_MEDICINES_LIST";
      }

      const isActiveOnboardingStep =
        (!isOnboardingCompleted ||
          (isOnboardingCompleted && !effectiveState?.medicationFlowDone)) &&
        ((Boolean(currentOnboardingStep) &&
          currentOnboardingStep !== "COMPLETE" &&
          currentOnboardingStep !== "POST_ONBOARDING" &&
          effectiveState?.medicationFlowDone !== true) ||
          isMedicineSelectionMsg ||
          isAddMedicineMsg ||
          hasUnconfirmedMedicines);

      // CASE 2: MEDICINE ACTIONS (ADD_MEDICINE, CONFIRM_MEDICINES, SKIP_MEDICINES, REVIEW_MEDICINES_LIST, SHOW_EXTRACTED_MEDICINES)
      const hasMedicineActionData =
        actionData &&
        typeof actionData === "object" &&
        (actionData.medicationName || actionData.name || actionData.medicine);

      const isMedicineAction =
        actionType === "CONFIRM_MEDICINES" ||
        actionType === "SKIP_MEDICINES" ||
        actionType === "REVIEW_MEDICINES_LIST" ||
        actionType === "SHOW_EXTRACTED_MEDICINES" ||
        hasMedicineActionData ||
        (actionData && Array.isArray(actionData.medicines) && actionData.medicines.length > 0);

      if (isMedicineAction) {
        console.log(
          `[UnifiedChat] Executing medicine action '${actionType}' for userId=${userId} (isActiveOnboardingStep=${isActiveOnboardingStep})`,
        );

        const isSkipAction =
          actionType === "SKIP_MEDICINES" ||
          String(message || "").toUpperCase() === "SKIP" ||
          actionData?.skipAll === true;

        if (isSkipAction && !isActiveOnboardingStep) {
          const replyText = messageConstants.MEDICATIONS_REVIEW_SKIPPED;
          let activeSessionId = sessionId;
          if (!activeSessionId && isOnboardingCompleted) {
            const newSession = await chatService.createSession({
              userId,
              title: "Medication Chat",
            });
            activeSessionId = newSession?.id || null;
          }

          if (activeSessionId) {
            await chatSessionRepository.appendMessage({
              sessionId: activeSessionId,
              userId,
              role: "assistant",
              content: replyText,
              metadata: { actionType: "SKIP_MEDICINES" },
            });
          }

          return buildUnifiedResponse({
            mode: "ACTION",
            actionType: "SKIP_MEDICINES",
            reply: replyText,
            sessionId: activeSessionId,
          });
        }

        let createdMeds = [];
        const medsToProcess =
          Array.isArray(actionData?.medicines) && actionData.medicines.length > 0
            ? actionData.medicines
            : Array.isArray(body?.medicines) && body.medicines.length > 0
              ? body.medicines
              : null;

        if (Array.isArray(medsToProcess) && medsToProcess.length > 0) {
          for (const medData of medsToProcess) {
            if (
              medData.selected === false ||
              medData.resolution === "KEEP_EXISTING" ||
              medData.resolution === "REMOVE_NEW"
            ) {
              continue;
            }

            if (
              medData.resolution === "REPLACE" &&
              (medData.replaceMedicationId || medData.targetMedicationId)
            ) {
              const targetId = medData.replaceMedicationId || medData.targetMedicationId;
              try {
                await medicationService.deleteMedication(targetId, userId);
              } catch (delErr) {
                console.warn(
                  `[UnifiedChat] Soft-delete warning for replaced med ${targetId}:`,
                  delErr.message,
                );
              }
            }

            try {
              const normalizedMedData = normalizeCreateMedicationInput(medData);
              const med = await medicationService.createMedication(userId, normalizedMedData);
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
        } else if (hasMedicineActionData) {
          const normalizedActionData = normalizeCreateMedicationInput(actionData);
          const createdMed = await medicationService.createMedication(userId, normalizedActionData);
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

        // If patient is in active Onboarding medicine loop, update state and advance onboarding
        if (isActiveOnboardingStep) {
          const stateToUpdate = { ...effectiveState };
          if (!stateToUpdate.medicinesToAdd) stateToUpdate.medicinesToAdd = [];

          if (createdMeds.length > 0) {
            for (const med of createdMeds) {
              stateToUpdate.medicinesToAdd.push({
                name: med.medicationName,
                id: med.id,
                client_med_id: med.clientMedId || med.id,
                selected: true,
                isSaved: true,
                dbId: med.id,
              });
            }
            stateToUpdate.medicinesConfirmed = true;
            stateToUpdate.medicinesSavedToDb = true;
            stateToUpdate.medicationFlowDone = true;
          }

          if (actionType === "CONFIRM_MEDICINES" || stateToUpdate.medicinesConfirmed) {
            stateToUpdate.medicinesConfirmed = true;
            stateToUpdate.medicationFlowDone = true;
          } else {
            stateToUpdate.currentStep = "MEDICINE_OPTIONS";
          }

          const onboardingResult = await onboardingService.chat(
            "",
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
          });
          responsePayload.canSkip =
            onboardingResult?.canSkip !== undefined
              ? onboardingResult.canSkip
              : canSkipOnboarding(onboardingResult?.state || stateToUpdate);
          return responsePayload;
        }

        // Post-Onboarding (Dashboard Chat Stream): return confirmation response
        const replyText =
          createdMeds.length > 0
            ? messageConstants.MEDICATIONS_CONFIRMED_SUCCESS
            : createdMed?.name
              ? `Medication '${createdMed.name}' has been added to your active medications.`
              : "Medication processed successfully.";

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
            metadata: {
              actionType: "CONFIRM_MEDICINES",
              medicationIds: createdMeds.map((m) => m.id),
            },
          });
        }

        return buildUnifiedResponse({
          mode: "ACTION",
          actionType: "CONFIRM_MEDICINES",
          reply: replyText,
          sessionId: activeSessionId,
          medication: createdMed,
          medicines: createdMeds,
        });
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

      const hasUnansweredOptional =
        isOnboardingCompleted &&
        ((!bloodGroup && !bloodGroupSkipped) ||
          ((!allergies || allergies.length === 0) && !allergiesSkipped));

      const isForcedOnboardingAction =
        message === "ASK_REPORT" ||
        message === "ASK_ABOUT_REPORT" ||
        actionType === "ASK_REPORT" ||
        inputState?.currentStep === "ASK_REPORT";

      const isNormalChat =
        !isForcedOnboardingAction &&
        actionType !== "SKIP_ONBOARDING" &&
        !hasUnansweredOptional &&
        (actionType === "NORMAL_CHAT" ||
          ((isOnboardingCompleted ||
            isCompletedStep ||
            isSkippedValid ||
            dbState?.currentStep === "ASK_REPORT" ||
            inputState?.currentStep === "ASK_REPORT") &&
            !isActiveOnboardingStep &&
            message !== "ASK_REPORT" &&
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

          const documentConfirmed =
            dbState?.documentConfirmed === true ||
            dbState?.documentOwnershipConfirmed === true ||
            incomingStateCleaned.documentConfirmed === true ||
            incomingStateCleaned.documentOwnershipConfirmed === true;

          const documentOwnershipConfirmed =
            dbState?.documentOwnershipConfirmed === true ||
            incomingStateCleaned.documentOwnershipConfirmed === true;

          const useDocumentData =
            dbState?.useDocumentData === true ||
            incomingStateCleaned.useDocumentData === true ||
            (documentConfirmed && dbState?.useDocumentData !== false);

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
            ...(documentConfirmed ? { documentConfirmed: true } : {}),
            ...(documentOwnershipConfirmed ? { documentOwnershipConfirmed: true } : {}),
            ...(useDocumentData ? { useDocumentData: true } : {}),
            existingUserData: mergedUserData,
          };

          if (!state.currentStep && dbState.currentStep) state.currentStep = dbState.currentStep;
          if (!state.flowMode && dbState.flowMode) state.flowMode = dbState.flowMode;
          if (!state.preferredLanguage && dbState.preferredLanguage)
            state.preferredLanguage = dbState.preferredLanguage;
        }

        if (hasUnansweredOptional && actionType !== "SKIP_ONBOARDING") {
          state.currentStep = null;
        }

        if (actionType === "SKIP_ONBOARDING") {
          if (!canSkipOnboarding(state)) {
            throw new InvalidRequestException(errorConstants.REQUIRED_PROFILE_DETAILS_MISSING);
          }
          state.hasSkipped = true;
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

        const onboardingResult = await onboardingService.chat(
          message,
          history,
          state,
          userId,
          null,
          displayLabel,
        );

        const responsePayload = buildUnifiedResponse({
          mode: "ONBOARDING",
          actionType: onboardingResult?.action || "ONBOARDING_STEP",
          reply: onboardingResult?.message || onboardingResult?.reply || "",
          onboardingState: onboardingResult?.state || state,
          options: onboardingResult?.options || [],
          medicines: onboardingResult?.medicines || [],
          document: onboardingResult?.document || null,
        });
        if (onboardingResult?.completionMessage) {
          responsePayload.completionMessage = onboardingResult.completionMessage;
        }
        responsePayload.suggestedQuestions = onboardingResult?.suggestedQuestions || [];
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

      const chatResult = await chatService.sendMessage({
        userId,
        question: promptText,
        sessionId,
        documentId,
        preferredLanguage: userLang,
        onChunk,
        abortSignal,
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
      if (currentStep !== "POST_ONBOARDING") {
        currentStep = "COMPLETE";
      }
      return {
        isOnboardingCompleted: true,
        currentStep,
        chatSessionId: resumableState?.chatSessionId || null,
        resumableState: resumableState ? { ...resumableState, canSkip } : null,
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

    const canSkip = resumableState ? canSkipOnboarding(resumableState) : false;

    return {
      chatSessionId,
      messages,
      currentStep: resumableState?.currentStep || "ASK_LANGUAGE",
      resumableState: resumableState ? { ...resumableState, canSkip } : null,
      canSkip,
    };
  }
}

module.exports = new V1Service();
